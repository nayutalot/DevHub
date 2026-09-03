package com.devhub.mobile.connect

import android.content.Context
import android.util.Log
import com.devhub.mobile.core.BackoffCalculator
import com.devhub.mobile.core.ControlGate
import com.devhub.mobile.core.EventNotificationMapper
import com.devhub.mobile.core.IdempotencyKeys
import com.devhub.mobile.core.LogRedactor
import com.devhub.mobile.core.QueueReplayPlanner
import com.devhub.mobile.core.QueuedCommand
import com.devhub.mobile.core.ReplayVerdict
import com.devhub.mobile.data.SecureStore
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.EventAckStateEntity
import com.devhub.mobile.data.db.PendingCommandEntity
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.GatewayApi
import com.devhub.mobile.data.remote.ProtocolHeadersInterceptor
import com.devhub.mobile.ws.WsFrames
import com.devhub.mobile.ws.WsServerFrame
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.withContext
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 连接状态机（UI 与前台服务共同消费）。 */
sealed class ConnState {
    /** 未启动（无凭据或服务未运行）。 */
    data object Idle : ConnState()

    /** WebSocket 连接中。 */
    data object Connecting : ConnState()

    /** 已连接（hello 已收）。 */
    data class Connected(val heartbeatSec: Int, val helloSequence: Long) : ConnState()

    /** 断线退避中（docs/14 §B.2 指数退避 + jitter；连续失败 ≥10 次 UI 提示手动重试）。 */
    data class Backing(val attempt: Int, val nextDelayMs: Long, val lastError: String?) : ConnState()

    /** 凭据失效/被撤销：已清凭据并停服务，UI 应回配对页（结构化提示）。 */
    data class Unpaired(val code: String, val message: String) : ConnState()
}

/** 指令提交结果（UI 展示；QueuedOffline = 离线队列已收，重连后按序补发）。 */
sealed class SubmitResult {
    data class Accepted(val commandId: String) : SubmitResult()
    data object QueuedOffline : SubmitResult()
    data class Rejected(val code: String, val message: String) : SubmitResult()
}

/**
 * ConnectionManager —— WS 长连 + 重连 + sync/ack + 事件通知 + 离线队列补发 + 401 处理。
 *
 * 协议（docs/14 §B.2）：hello 记 sequence → 发 {type:'sync',after:lastAckedSeq} 补齐 →
 * 事件帧（waiting_input 两 status / status_changed 终态触发通知，仅脱敏 summary 直显）→
 * 批量 {type:'ack',seqs}；断线指数退避 1s→…→60s 封顶 ±20% jitter；重连成功必发 sync；
 * App 重启后 lastAckedSeq 从 Room 持久化恢复（EventAckState）。WS 升级鉴权 =
 * Authorization: Bearer <token> 头；REST 统一拦截器生成 X-DevHub-Timestamp/X-DevHub-Nonce。
 */
object ConnectionManager {
    private const val TAG = "ConnManager"
    private const val ACK_BATCH_MAX = 400 // 服务端 ack.seqs ≤500，留余量
    private const val ACK_FLUSH_INTERVAL_MS = 1_000L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private var appContext: Context? = null

    private var db: DevHubDb? = null
    private var api: GatewayApi? = null
    private var wsClient: OkHttpClient? = null

    private val backoff = BackoffCalculator()

    private val _state = MutableStateFlow<ConnState>(ConnState.Idle)
    val state: StateFlow<ConnState> = _state

    /** 最近一次收到 WS 事件的时间（unix 毫秒；诊断页投影）。 */
    private val _lastEventAtMs = MutableStateFlow(0L)
    val lastEventAtMs: StateFlow<Long> = _lastEventAtMs

    /** 最近一次断线/失败原因（诊断页投影；写入日志前经 LogRedactor 护栏）。 */
    private val _lastWsError = MutableStateFlow<String?>(null)
    val lastWsError: StateFlow<String?> = _lastWsError

    private var webSocket: WebSocket? = null
    private var helloSequence = 0L
    private var heartbeatSec = 30

    // ack 缓冲（事件收到即缓冲，节流批量发送）
    // AC7b 编译修复：bufferAck 由 WS 帧回调（非 suspend）调用，kotlinx Mutex.withLock
    // 是 suspend 不能在此用——改 monitor 对象锁（临界区零挂起，语义等价）。
    private val ackLock = Any()
    private val ackBuffer = ArrayDeque<Long>()
    private var lastAckedSeq: Long = 0L

    @Volatile
    private var ackFlushScheduled = false

    /** 初始化（幂等）：Application.onCreate 调用。 */
    fun init(context: Context) {
        if (db != null) return
        appContext = context.applicationContext
        db = DevHubDb.get(context)
        api = GatewayApi(
            // AC8 e2e 修复：baseUrlProvider 曾同步读 Room（db!!.gatewayConfigDao().get()），
            // submitReply/submitAction 在主线程协程调用时触发 IllegalStateException
            // "Cannot access database on the main thread"（真机崩溃，logcat crash buffer
            // 2026-09-03 实录）。改读 cachedBase 内存缓存（start 时 refreshCachedConfig
            // 已在 IO 协程填充；未填充时回落 10.0.2.2:8746 默认值），与 baseUrl() 同源。
            baseUrlProvider = {
                val c = cachedBase
                "http://${c?.first ?: "10.0.2.2"}:${c?.second ?: 8746}"
            },
            tokenProvider = { appContext?.let { SecureStore.loadToken(it) } },
        )
        wsClient = OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS) // 客户端 30s 保活 ping；服务端 ping 由 OkHttp 自动回 pong
            .connectTimeout(10, TimeUnit.SECONDS)
            .addInterceptor(
                ProtocolHeadersInterceptor { appContext?.let { SecureStore.loadToken(it) } },
            )
            .build()
    }

    /** base-url 内存缓存（AC7b 运行时修复：DB 同步读只在 IO 协程，主线程 UI/前台服务通知只读缓存）。 */
    @Volatile
    private var cachedBase: Pair<String, Int>? = null

    fun baseUrl(): String {
        val c = cachedBase
        return if (c != null) "${c.first}:${c.second}" else "10.0.2.2:8746"
    }

    /** IO 协程刷新 base-url 缓存（start 时与配置保存后调用；幂等，绝不阻塞主线程）。 */
    fun refreshCachedConfig() {
        scope.launch {
            val c = runCatching { db?.gatewayConfigDao()?.get() }.getOrNull()
            if (c != null) cachedBase = c.host to c.port
        }
    }

    /** 启动连接循环（已配对才真正连接；未配对保持 Idle）。 */
    fun start() {
        init(appContext ?: return)
        if (loopJob?.isActive == true) return
        backoff.reset()
        loopJob = scope.launch {
            // AC7b 运行时修复：Room 同步读原在主线程触发（配对成功后 IllegalStateException
            // Cannot access database on the main thread）——移入 IO 协程。
            refreshCachedConfig()
            lastAckedSeq = runCatching { db!!.eventAckStateDao().get()?.lastAckedSeq ?: 0L }.getOrDefault(0L)
            runLoop()
        }
    }

    fun stop() {
        loopJob?.cancel()
        loopJob = null
        webSocket?.close(1000, "client stop")
        webSocket = null
        _state.value = ConnState.Idle
    }

    /** UI「立即重试」。 */
    fun reconnectNow() {
        stop()
        start()
    }

    /**
     * 主循环：连接 → hello → sync → 事件消费 → 失败退避（1s→…→60s ±20% jitter）→ 重连。
     */
    private suspend fun runLoop() {
        var attempt = 0
        while (scope.isActive) {
            val token = appContext?.let { SecureStore.loadToken(it) }
            if (token == null) {
                _state.value = ConnState.Idle
                return // 未配对：循环退出（配对成功后 start() 重新拉起）
            }
            _state.value = ConnState.Connecting
            val opened = CompletableDeferred<Boolean>()
            val closed = CompletableDeferred<Unit>()
            webSocket = openWebSocket(token, opened, closed)
            val openedOk = opened.await()
            if (openedOk) {
                attempt = 0
                backoff.reset()
                // 连接建立（hello → sync 已发）后：按序补发离线队列
                flushPendingCommands()
                closed.await() // 挂起直到连接关闭
            }
            if (_state.value is ConnState.Unpaired) return // 401 已处理：停循环
            attempt += 1
            val delayMs = backoff.nextDelayMs()
            _state.value = ConnState.Backing(attempt, delayMs, _lastWsError.value)
            _lastWsError.value?.let { Log.w(TAG, "ws reconnect in ${delayMs}ms: ${LogRedactor.scrub(it)}") }
            delay(delayMs)
        }
    }

    /**
     * 建立 WebSocket（升级鉴权 = Authorization Bearer 头，docs/14 §B.2）。
     * onOpen → opened；onFailure/onClosed → closed（含 401 升级拒绝 → onAuthFatal）。
     */
    private fun openWebSocket(token: String, opened: CompletableDeferred<Boolean>, closed: CompletableDeferred<Unit>): WebSocket {
        val request: Request = Request.Builder()
            .url("ws://${baseUrl()}/v1/events")
            .header("Authorization", "Bearer $token")
            .build()
        return wsClient!!.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    opened.complete(true)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleFrame(text)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    _lastWsError.value = t.message ?: (response?.let { "http ${it.code}" } ?: "ws failure")
                    if (response?.code == 401) {
                        onAuthFatal("AUTH_INVALID_TOKEN", "网关拒绝连接（401）：设备 Token 已失效或被撤销")
                    }
                    opened.complete(false)
                    closed.complete(Unit)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    _lastWsError.value = "server closed: $code $reason"
                    closed.complete(Unit)
                }
            },
        )
    }

    /** 帧处理：hello（记 sequence + 必发 sync）/ event / token_rotation（预留）/ unknown（静默）。 */
    private fun handleFrame(text: String) {
        val frame = try {
            WsFrames.parse(text)
        } catch (err: Exception) {
            Log.w(TAG, "ws frame parse failed: ${LogRedactor.scrub(err.message ?: "?")}")
            return
        }
        when (frame) {
            is WsServerFrame.Hello -> {
                helloSequence = frame.sequence
                heartbeatSec = frame.heartbeatSec
                _state.value = ConnState.Connected(frame.heartbeatSec, frame.sequence)
                // 重连成功必发 sync（after = lastAckedSeq；App 重启后从 Room 恢复）
                val after = lastAckedSeq
                Log.i(TAG, "ws hello seq=${frame.sequence}, sync after=$after")
                webSocket?.send(WsFrames.sync(after))
            }

            is WsServerFrame.Event -> handleEvent(frame)

            is WsServerFrame.TokenRotation -> {
                // 协议预留帧（v1 服务端绝不发送）：持久化新 Token（Keystore 加密），旧 Token 失效
                val context = appContext
                val deviceId = context?.let { SecureStore.loadDeviceId(it) }
                if (context != null && deviceId != null) {
                    SecureStore.savePairing(context, deviceId, frame.newToken)
                }
            }

            is WsServerFrame.Unknown -> Unit // 未知类型静默（与对端语义对称）
        }
    }

    private fun handleEvent(frame: WsServerFrame.Event) {
        _lastEventAtMs.value = System.currentTimeMillis()
        bufferAck(frame.seq)

        // 事件 → 通知映射（waiting_input 两值 / status_changed 终态；summary 脱敏直显）
        val payloadStatus = if (frame.eventType == EventNotificationMapper.EVENT_WAITING_INPUT) {
            frame.payload.optString("status").takeIf { it.isNotEmpty() }
        } else {
            null
        }
        val statusTo = if (frame.eventType == EventNotificationMapper.EVENT_STATUS_CHANGED) {
            frame.payload.optString("to").takeIf { it.isNotEmpty() }
        } else {
            null
        }
        val payloadSessionId = frame.payload.optLong("sessionId", -1).takeIf { it > 0 }
        val sessionId = frame.sessionId ?: payloadSessionId
        val notification = EventNotificationMapper.decide(
            eventType = frame.eventType,
            payloadStatus = payloadStatus,
            statusChangedTo = statusTo,
            summary = frame.summary,
            sessionTitle = sessionId?.let { db?.sessionCacheDao()?.get(it)?.title },
            sessionId = sessionId,
        )
        val context = appContext
        if (notification != null && context != null && Notifier.canPostNotifications(context)) {
            Notifier.postEventNotification(context, notification)
        }

        // 会话缓存行状态随事件推进（事件即服务端权威投影，非本地伪造）
        val newStatus = statusTo ?: payloadStatus
        if (sessionId != null && newStatus != null) {
            val cached = db?.sessionCacheDao()?.get(sessionId)
            if (cached != null && newStatus != cached.status) {
                db?.sessionCacheDao()?.upsertAll(listOf(cached.copy(status = newStatus)))
            }
        }
    }

    /** ack 缓冲 + 节流批量发送（≤400/批，服务端 ≤500）。 */
    private fun bufferAck(seq: Long) {
        var overflow: List<Long>? = null
        synchronized(ackLock) {
            ackBuffer.addLast(seq)
            if (ackBuffer.size >= ACK_BATCH_MAX) overflow = drainAckLocked()
        }
        if (overflow != null) {
            sendAck(overflow!!)
        } else {
            scheduleAckFlush()
        }
    }

    private fun drainAckLocked(): List<Long> {
        val batch = ArrayList<Long>(ackBuffer.size)
        while (ackBuffer.isNotEmpty()) batch.add(ackBuffer.removeFirst())
        return batch
    }

    private fun scheduleAckFlush() {
        if (ackFlushScheduled) return
        ackFlushScheduled = true
        scope.launch {
            delay(ACK_FLUSH_INTERVAL_MS)
            ackFlushScheduled = false
            val batch = synchronized(ackLock) { drainAckLocked() }
            if (batch.isNotEmpty()) sendAck(batch)
        }
    }

    /** 发送批量 ack 并推进本地 lastAckedSeq（持久化，供重启后 sync 补齐）。 */
    private fun sendAck(seqs: List<Long>) {
        val ws = webSocket ?: return
        if (seqs.isEmpty()) return
        if (ws.send(WsFrames.ack(seqs))) {
            val max = seqs.max()
            if (max > lastAckedSeq) {
                lastAckedSeq = max
                db?.eventAckStateDao()?.upsert(EventAckStateEntity(lastAckedSeq = max))
            }
        }
    }

    // ---------------------------------------------------------------------------
    // 离线命令队列（断网期间 reply/actions 入 Room；重连后按序补发，同幂等 key）
    // ---------------------------------------------------------------------------

    /** UI 提交 reply：在线直发；网络失败入队（QueuedOffline）。 */
    suspend fun submitReply(sessionId: Long, text: String): SubmitResult =
        submitCommand(sessionId, QueueReplayPlanner.KIND_REPLY, text)

    /** UI 提交 pause/resume。 */
    suspend fun submitAction(sessionId: Long, action: String): SubmitResult =
        submitCommand(sessionId, action, null)

    private suspend fun submitCommand(sessionId: Long, kind: String, text: String?): SubmitResult =
        // AC8 e2e 修复：本函数被 UI 主线程协程直接调用（SessionDetailScreen 发送/暂停/恢复），
        // 而 GatewayApi.post 为同步 OkHttp execute——曾抛 NetworkOnMainThreadException
        //（am_crash 2026-09-03 实录；此前被 baseUrlProvider 的主线程 Room 崩溃先行掩盖）。
        // 整体移入 IO：网络调用 + 断网时的 pendingCommandDao 入队（Room）一并覆盖。
        withContext(Dispatchers.IO) {
            val idempotencyKey = IdempotencyKeys.newKey() // 首次提交生成；入队后重试全程复用
            try {
                val accept = when (kind) {
                    QueueReplayPlanner.KIND_REPLY -> api!!.reply(sessionId, text ?: "", idempotencyKey)
                    QueueReplayPlanner.KIND_PAUSE -> api!!.action(sessionId, "pause", idempotencyKey)
                    QueueReplayPlanner.KIND_RESUME -> api!!.action(sessionId, "resume", idempotencyKey)
                    else -> return@withContext SubmitResult.Rejected("BAD_PAYLOAD", "unknown kind $kind")
                }
                SubmitResult.Accepted(accept.commandId)
            } catch (err: ApiError) {
                if (err.isAuthFatal) onAuthFatal(err.code, err.message)
                SubmitResult.Rejected(err.code, err.message)
            } catch (err: IOException) {
                // 断网/断连：入离线队列（status=pending + idempotencyKey；重连后按序补发）
                db!!.pendingCommandDao().insert(
                    PendingCommandEntity(
                        sessionId = sessionId,
                        kind = kind,
                        text = text,
                        idempotencyKey = idempotencyKey,
                        status = "pending",
                        createdAtMs = System.currentTimeMillis(),
                        lastError = null,
                    ),
                )
                SubmitResult.QueuedOffline
            }
        }

    /** 重连成功 / App 启动后：按序补发离线队列（状态机见 QueueReplayPlanner）。 */
    suspend fun flushPendingCommands() {
        while (true) {
            val batch = QueueReplayPlanner.nextBatch(
                db!!.pendingCommandDao().listPending().map { cmd ->
                    QueuedCommand(
                        id = cmd.id,
                        kind = cmd.kind,
                        sessionId = cmd.sessionId,
                        idempotencyKey = cmd.idempotencyKey,
                        createdAtMs = cmd.createdAtMs,
                    )
                },
            )
            if (batch.isEmpty()) return
            for (queued in batch) {
                val row = db!!.pendingCommandDao().listPending().firstOrNull { it.id == queued.id } ?: continue
                val httpCode: Int? = try {
                    when (queued.kind) {
                        QueueReplayPlanner.KIND_REPLY -> api!!.reply(queued.sessionId, row.text ?: "", queued.idempotencyKey)
                        QueueReplayPlanner.KIND_PAUSE -> api!!.action(queued.sessionId, "pause", queued.idempotencyKey)
                        QueueReplayPlanner.KIND_RESUME -> api!!.action(queued.sessionId, "resume", queued.idempotencyKey)
                        else -> null
                    }
                    202
                } catch (err: ApiError) {
                    err.httpCode
                } catch (err: IOException) {
                    null
                }
                when (QueueReplayPlanner.classify(httpCode)) {
                    ReplayVerdict.SENT -> db!!.pendingCommandDao().delete(queued.id)

                    ReplayVerdict.DROP_FAILED -> db!!.pendingCommandDao().update(
                        row.copy(status = "failed", lastError = "HTTP $httpCode"),
                    )

                    ReplayVerdict.RETRY_LATER -> return // 网络/限流：停止本轮，队列保留

                    ReplayVerdict.AUTH_INVALID -> {
                        onAuthFatal("DEVICE_REVOKED", "补发离线指令时 Token 已失效（401）")
                        return
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------------------
    // 401 全局处理（docs/14 Part C DEVICE_REVOKED / AUTH_INVALID_TOKEN）：
    // 停连接循环 + 清凭据（Keystore 密文 + 设备行）+ 停前台服务 + UI 回配对页
    // ---------------------------------------------------------------------------

    private fun onAuthFatal(code: String, message: String) {
        Log.w(TAG, "auth fatal ($code): ${LogRedactor.scrub(message)}")
        loopJob?.cancel()
        loopJob = null
        webSocket?.cancel()
        webSocket = null
        val context = appContext
        if (context != null) {
            SecureStore.clear(context)
            db!!.deviceDao().clear()
            GatewayConnectionService.stop(context)
        }
        _state.value = ConnState.Unpaired(code, message)
    }

    /** 诊断页投影：本机 WS 连接状态 / 最近错误 / 退避状态。 */
    fun diagnosticsSnapshot(): String = when (val s = _state.value) {
        is ConnState.Connected -> "已连接（心跳 ${s.heartbeatSec}s，服务端 seq ${s.helloSequence}）"
        is ConnState.Connecting -> "连接中…"
        is ConnState.Backing ->
            "退避重连：第 ${s.attempt} 次，${s.nextDelayMs / 1000}s 后重试" + (s.lastError?.let { "；最近错误：$it" } ?: "")

        is ConnState.Unpaired -> "未配对（${s.code}）"
        ConnState.Idle -> "未启动"
    }

    /** UI 门：详情页控制按钮可见性（ControlGate 纯逻辑 + 服务端 CapabilitySet 双输入）。 */
    fun visibleControls(capsMode: String, sessionMode: String, granted: List<String>): ControlGate.VisibleControls =
        ControlGate.visibleControls(
            ControlGate.CapabilitySnapshot(mode = capsMode, granted = granted.toSet()),
            sessionMode = sessionMode,
        )
}
