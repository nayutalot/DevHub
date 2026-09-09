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
import com.devhub.mobile.core.TlsPinningConfig
import com.devhub.mobile.core.relay.BoundedSeenSet
import com.devhub.mobile.core.relay.RelayAckVerdict
import com.devhub.mobile.core.relay.RelayActions
import com.devhub.mobile.core.relay.RelayCodec
import com.devhub.mobile.core.relay.RelayCommandClassifier
import com.devhub.mobile.core.relay.RelayEndpoint
import com.devhub.mobile.core.relay.RelayFrame
import com.devhub.mobile.core.relay.RelaySyncEngine
import com.devhub.mobile.core.relay.RelayTokenRotation
import com.devhub.mobile.core.relay.RotationOutcome
import com.devhub.mobile.core.relay.SelfRevokeFlow
import com.devhub.mobile.core.relay.StoredToken
import com.devhub.mobile.core.relay.TokenStore
import com.devhub.mobile.data.SecureStore
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.EventAckStateEntity
import com.devhub.mobile.data.db.PendingCommandEntity
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.GatewayApi
import com.devhub.mobile.data.remote.ProtocolHeadersInterceptor
import com.devhub.mobile.data.remote.RelayTlsTrust
import com.devhub.mobile.ws.WsFrames
import com.devhub.mobile.ws.WsServerFrame
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
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
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
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
 * M3-E1 managed spawn 提交结果（docs/18 §5.3 spawn_session；relay 面专用——
 * local 面保持 AgentsScreen 既有 REST 路径零改动）。
 */
sealed class ManagedSpawnSubmit {
    /** 已执行并取得新会话 id（UI 跳转会话详情）。 */
    data class Executed(val sessionId: Long, val commandId: String) : ManagedSpawnSubmit()

    /** 已受理但无会话 id（accepted/无 sessionId executed；会话列表稍后出现）。 */
    data class AcceptedNoSession(val commandId: String, val status: String) : ManagedSpawnSubmit()

    /** queued:true（主机离线）→ 行挂起，upstream 恢复后同 key 续跑（偏离⑤）。 */
    data object Queued : ManagedSpawnSubmit()

    /** 结构化拒绝（文案经 InteractionHonesty.spawnRejectionText 按 errorCode 分叉）。 */
    data class Rejected(val code: String, val message: String) : ManagedSpawnSubmit()
}

/**
 * M3-E1 设备自撤销提交结果（docs/18 §5.3 revoke_device；relay 面专用——local 面保持
 * DeviceScreen 既有 REST 路径零改动）。收口 = disconnect(revoked)，非 command_result。
 */
sealed class SelfRevokeSubmit {
    /** 收口完成：凭据已清 + 连接已停（onAuthFatal 路径回配对页；不得自动重连 §3.15）。 */
    data object Revoked : SelfRevokeSubmit()

    /** queued:true（主机离线）→ 行挂起，主机上线后自动完成撤销。 */
    data object Queued : SelfRevokeSubmit()

    /** 结构化拒绝 / 收口超时（如实呈现，绝不伪报撤销成功——m3c6c 修②纪律）。 */
    data class Rejected(val code: String, val message: String) : SelfRevokeSubmit()
}

/**
 * ConnectionManager —— WS 长连 + 重连 + sync/ack + 事件通知 + 离线队列补发 + 401 处理。
 *
 * M2-R3 双模式（docs/19 §7.2 / docs/18 §10，模式**显式选择、绝不字段嗅探**）：
 * - local = docs/14 原样：`ws://host:port/v1/events`（内网明文前提），WsFrames 帧族，
 *   REST 13 端点全量；
 * - relay = docs/18：`wss://<relay>/relay/device`（**代码层强制 wss**，ws:// 拒绝——
 *   docs/19 §11 时间盒属部署期例外，客户端拒绝规则不变），RelayCodec 16 帧族，
 *   ack 语义 = 累计游标（Room row2 持久化推进），REST 面仅 5 端点读 +
 *   命令走 WS `command` 帧（REST POST → 405 RELAY_REST_READONLY，docs/18 §7.2）；
 * - **双连接互斥**（W-R6）：单 `webSocket` 槽位，同一时刻仅一条活跃连接；
 *   切模式 = stop（断旧）→ start（连新），绝不并存两条腿；
 * - 降级信标：hello/heartbeat 的 `upstream` 字段 → [upstreamBeacon]；
 *   `disconnected` = 「Relay 已连接，电脑离线（命令将排队）」结构化降级态，绝不显示为正常态。
 */
object ConnectionManager {
    private const val TAG = "ConnManager"
    private const val ACK_BATCH_MAX = 400 // 服务端 ack.seqs ≤500，留余量
    private const val ACK_FLUSH_INTERVAL_MS = 1_000L

    /** command 帧等 command_ack 超时（docs/18 §3.0 #8：10s）。 */
    private const val COMMAND_ACK_TIMEOUT_MS = 10_000L

    /**
     * M3-E1 revoke_device 收口窗（ack 后等 disconnect(revoked)；撤销链为受理即踢，
     * 正常亚秒级，15s 窗仅覆盖极端排队回程——超时如实上报，绝不伪报撤销成功）。
     */
    private const val REVOKE_CLOSURE_TIMEOUT_MS = 15_000L

    /**
     * RW1 wake_result 等待窗（docs/18 §3.17）：20s > relay 执行上限 15s（进程硬顶），
     * 超时如实展示 timeout 文案（与 relay timeout 态同文案，绝不谎报 sent）。
     */
    private const val WAKE_TIMEOUT_MS = 20_000L

    /** R5.3 事件驱动刷新信号的节流窗（事件风暴 → 至多每 500ms 一次 UI 拉取触发）。 */
    private const val REFRESH_BUMP_THROTTLE_MS = 500L

    /** R5.3 事件驱动为主后，轮询兜底周期（仅连接健康与补偿；原 2s/3s 全部退役）。 */
    const val FALLBACK_POLL_MS = 120_000L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private var appContext: Context? = null

    private var db: DevHubDb? = null
    private var api: GatewayApi? = null
    private var wsClient: OkHttpClient? = null

    // relay 模式专用通道（refreshCachedConfig 时按 mode 构建语义一致；pinning 注入仅在此生效）
    @Volatile
    private var relayApi: GatewayApi? = null

    @Volatile
    private var relayWsClient: OkHttpClient? = null

    @Volatile
    private var relayEndpointDisplay: String? = null

    private val backoff = BackoffCalculator()

    private val _state = MutableStateFlow<ConnState>(ConnState.Idle)
    val state: StateFlow<ConnState> = _state

    /** 当前活跃连接模式（local | relay；null = 未连接。UI 徽标分叉维度）。 */
    private val _activeMode = MutableStateFlow<String?>(null)
    val activeMode: StateFlow<String?> = _activeMode

    /** relay 降级信标（docs/18 §3.1/§3.13 upstream；local 模式恒 null）。 */
    private val _upstreamBeacon = MutableStateFlow<String?>(null)
    val upstreamBeacon: StateFlow<String?> = _upstreamBeacon

    /** 最近一次收到 WS 事件的时间（unix 毫秒；诊断页投影）。 */
    private val _lastEventAtMs = MutableStateFlow(0L)
    val lastEventAtMs: StateFlow<Long> = _lastEventAtMs

    /** 最近一次断线/失败原因（诊断页投影；写入日志前经 LogRedactor 护栏）。 */
    private val _lastWsError = MutableStateFlow<String?>(null)
    val lastWsError: StateFlow<String?> = _lastWsError

    /**
     * R5.3 事件驱动刷新信号（M3-C3a 修 3）：WS 收帧（event / sync_response / 命令回执 /
     * hello 重连补偿）即自增；UI 各列表页收集该信号触发**立即**拉取（会话/事件/设备投影），
     * 原轮询降为 120s 低频兜底（仅连接健康与补偿）。500ms 节流：事件风暴不放大为 REST 风暴。
     */
    private val _refreshSignal = MutableStateFlow(0L)
    val refreshSignal: StateFlow<Long> = _refreshSignal

    @Volatile
    private var lastRefreshBumpMs = 0L

    private fun bumpRefreshSignal() {
        val now = System.currentTimeMillis()
        if (now - lastRefreshBumpMs < REFRESH_BUMP_THROTTLE_MS) return
        lastRefreshBumpMs = now
        _refreshSignal.value = now
    }

    private var webSocket: WebSocket? = null
    private var helloSequence = 0L
    private var heartbeatSec = 30
    private var heartbeatJob: Job? = null

    // ack 缓冲（local：事件收到即缓冲，节流批量发送）
    // AC7b 编译修复：bufferAck 由 WS 帧回调（非 suspend）调用，kotlinx Mutex.withLock
    // 是 suspend 不能在此用——改 monitor 对象锁（临界区零挂起，语义等价）。
    private val ackLock = Any()
    private val ackBuffer = ArrayDeque<Long>()
    private var lastAckedSeq: Long = 0L

    @Volatile
    private var ackFlushScheduled = false

    // relay 同步引擎（docs/18 §3.11/§6.2：after = max(连续已处理)；持久化 row2，ack 只前进）。
    // M3-C8a：游标 + sync 引导出帧决策委托 RelaySyncEngine（纯逻辑 :core 单测直测）——
    // 旧实现在 sendRelaySyncRequest 对 after<=0 早退 → fresh 游标永 0 → sync_request 永不发
    // → 补发永不启动 → held 只增、ack 不落盘（C2e 实证死锁链，修复见 helloSyncFrame 出帧处）。
    @Volatile
    private var relaySync = RelaySyncEngine()

    @Volatile
    private var relayAckScheduled = false

    // command_result / command.result 事件双通道去重（docs/18 §3.10）
    private val relaySeenResults = BoundedSeenSet()

    // 挂起的 command → command_ack 关联（key = idempotencyKey；docs/18 §3.9）
    private val pendingAcks = ConcurrentHashMap<String, CompletableDeferred<RelayFrame.CommandAck>>()

    // M3-E1：spawn 的 command → command_result 关联（key = idempotencyKey；docs/18 §3.10）
    private val pendingResults = ConcurrentHashMap<String, CompletableDeferred<RelayFrame.CommandResult>>()

    // M3-E1：revoke_device 收口信号（onAuthFatal(DEVICE_REVOKED) 时完成；§5.3 收口语义）
    @Volatile
    private var selfRevokeClosure: CompletableDeferred<Unit>? = null

    // RW1：wake_host → wake_result 挂起表（key = requestId，ECS 原样回显；docs/18 §3.17）。
    // 不入 QueueReplay/幂等体系——relay 侧唯一去重面 = 每设备冷却窗，排队重放会撞窗且语义撒谎。
    private val pendingWakes = ConcurrentHashMap<String, CompletableDeferred<RelayFrame.WakeResult>>()

    /** RW1 wake 提交序列（20s 等待窗 > relay 执行上限 15s；超时如实展示 timeout，不谎报 sent）。 */
    private val wakeSubmitter = WakeHostSubmitter(WAKE_TIMEOUT_MS, pendingWakes)

    /**
     * 初始化（幂等）：Application.onCreate 调用。
     * U1 注入缝（docs/21 §1.1 / docs/19 §10.2）：[tlsPinning] 可选指纹配置（无域名 IP TLS）——
     * null（默认）= 现行为不变（local 模式零回归）；本参数只影响 local api/ws 客户端（历史签名），
     * relay 模式的 pinning 自 Room pinFingerprints 注入（refreshCachedConfig → rebuildRelayClients）。
     */
    fun init(context: Context, tlsPinning: TlsPinningConfig? = null) {
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
            tlsPinning = tlsPinning,
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

    /** 连接面展示（前台常驻通知/诊断）：local = host:port；relay = wss endpoint。 */
    fun connectionDisplay(): String =
        if (_activeMode.value == "relay") {
            relayEndpointDisplay ?: "relay（未配置）"
        } else {
            baseUrl()
        }

    /** 连接配置快照（IO 协程填充；模式显式选择，绝不字段嗅探）。 */
    private data class ConnConfig(
        val mode: String,
        val host: String,
        val port: Int,
        val relayUrl: String?,
        val pinFingerprints: String?,
    )

    @Volatile
    private var cachedConfig: ConnConfig? = null

    /**
     * 当前持久化配置模式（local | relay；null = 配置未就绪）。M3-E1 命令面分支依据
     * （docs/14 REST 面 vs docs/18 WS 命令面，显式选择、绝不字段嗅探）——UI 层经此
     * 选择 spawn/自撤销的通道，与连接态解耦（relay 模式暂断时仍走 WS 排队路径）。
     */
    fun configuredMode(): String? = cachedConfig?.mode

    /** IO 协程刷新配置缓存（start 时与配置保存后调用；幂等，绝不阻塞主线程）。 */
    fun refreshCachedConfig() {        scope.launch {
            val c = runCatching { db?.gatewayConfigDao()?.get() }.getOrNull()
            if (c != null) {
                cachedBase = c.host to c.port
                cachedConfig = ConnConfig(
                    mode = c.mode,
                    host = c.host,
                    port = c.port,
                    relayUrl = c.relayUrl?.trim()?.takeIf { it.isNotEmpty() },
                    pinFingerprints = c.pinFingerprints?.trim()?.takeIf { it.isNotEmpty() },
                )
                rebuildRelayClients(cachedConfig!!)
            }
        }
    }

    /**
     * relay 模式 OkHttp 通道构建（R3 接缝，docs/19 §10.2/§7.2）：
     * - endpoint 解析经 [RelayEndpoint.parse]（**wss 强制**：ws:// 抛 IllegalArgumentException，
     *   docs/19 §11 文案）——非法 = relay 通道不可用（连接层报配置错误，绝不静默降级明文）；
     * - pinFingerprints（docs/19 §10.2 注入式，非机密物料）非空 → 构造 SPKI 指纹锁定
     *   （信任判定单点 = RelayTlsTrust PinTrustManager；pinner 强制层已全量退役）；
     *   空/缺省 = 系统默认信任（fail-fast 纪律：指纹本身非法属配置错误，走 _lastWsError 暴露）。
     */
    private fun rebuildRelayClients(cfg: ConnConfig) {
        relayEndpointDisplay = null
        relayApi = null
        relayWsClient = null
        if (cfg.mode != "relay") return
        val endpoint = try {
            RelayEndpoint.parse(cfg.relayUrl ?: "")
        } catch (err: IllegalArgumentException) {
            _lastWsError.value = err.message ?: RelayEndpoint.REJECT_REASON
            return
        }
        val pinning = try {
            parsePinning(cfg.pinFingerprints)
        } catch (err: IllegalArgumentException) {
            _lastWsError.value = "relay TLS 指纹配置非法（docs/19 §10.2）：${err.message}"
            return
        }
        // M3-C3a 修 2（C2 #3）：pin pattern = 具体 host（IP 字面量直接用）。空/非法 host
        // → fail-fast 不构建 relay 通道（信任锚缺失时宁可不连，绝不静默降级明文/通配符——
        // 曾用 `'*'` 令 OkHttp 抛 IllegalArgumentException，重连协程反复构建致进程死循环）。
        // pattern 现仅作 GatewayApi（M3-C6d 起同为 pin-TM 面）注入与 fail-fast 判定；
        // WS 客户端 pin-TM 激活时不装 pinner（M3-C6c bug#1，docs/19 §10.2 勘误）。
        val pinPattern = if (pinning != null) TlsPinningConfig.pinPatternFor(endpoint.host) else null
        if (pinning != null && pinPattern == null) {
            _lastWsError.value = "relay TLS 指纹已配置但 endpoint host 为空/非法，无法构造 pin pattern（fail-fast 不注入）"
            return
        }
        relayEndpointDisplay = endpoint.url
        relayApi = GatewayApi(
            baseUrlProvider = { "https://${endpoint.host}:${endpoint.port}" },
            tokenProvider = { appContext?.let { SecureStore.loadToken(it) } },
            tlsPinning = pinning,
            pinHost = pinPattern,
        )
        relayWsClient = OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .addInterceptor(
                ProtocolHeadersInterceptor { appContext?.let { SecureStore.loadToken(it) } },
            )
            .apply {
                if (pinning != null && pinPattern != null) {
                    // 信任锚 = 指纹（自签 IP 证书不受系统信任，docs/19 §10.5 属预期）：
                    // TrustManager 就地裁决 SPKI 比对（R-B9 三拒语义）。M3-C6c bug#1
                    // （docs/19 §10.2 实现层勘误）：**绝不并装 CertificatePinner**——Android 对
                    // 自定义 TM 的链清洗 fallback 返回空链，pinner 只对清洁链配 pin → 空链即拒
                    // （空洞拒连）；信任判定单点 = checkServerTrusted，HostnameVerifier 默认
                    // （IP SAN）保留第二保险。
                    val (factory, trustManager) = RelayTlsTrust.sslSocketFactory(pinning)
                    sslSocketFactory(factory, trustManager)
                }
            }
            .build()
    }

    /** pinFingerprints 拆分（逗号/换行/分号）；空 → null（不启用 pinning）；非法条目 fail-fast。
     *  M3-C3a 修 1 起供 RelayPairingClient（裸连接 pair 的 WS 客户端）复用（internal 同模块）。 */
    internal fun parsePinning(raw: String?): TlsPinningConfig? {
        val entries = raw
            ?.split(',', '\n', ';')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()
        if (entries.isEmpty()) return null
        return TlsPinningConfig(entries)
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
            var waited = 0
            while (cachedConfig == null && waited < 2_000) {
                delay(50)
                waited += 50
            }
            lastAckedSeq = runCatching { db!!.eventAckStateDao().get()?.lastAckedSeq ?: 0L }.getOrDefault(0L)
            // relay 累计游标恢复（row2 独立 sequence 空间；ack 只前进，docs/18 §6.2）
            val relayRestored = runCatching { db!!.eventAckStateDao().getRelay()?.lastAckedSeq ?: 0L }.getOrDefault(0L)
            relaySync = RelaySyncEngine(relayRestored)
            runLoop()
        }
    }

    /** 停止连接循环并断开当前连接（双连接互斥的「断旧」半程）。 */
    fun stop() {
        loopJob?.cancel()
        loopJob = null
        heartbeatJob?.cancel()
        heartbeatJob = null
        webSocket?.close(1000, "client stop")
        webSocket = null
        _upstreamBeacon.value = null
        _state.value = ConnState.Idle
    }

    /** UI「立即重试」/ 模式切换（断旧连新，单连接互斥）。 */
    fun reconnectNow() {
        stop()
        start()
    }

    /**
     * 主循环：连接 → hello → sync → 事件消费 → 失败退避（1s→…→60s ±20% jitter）→ 重连。
     * 每轮迭代显式读取当前模式（切模式后 reconnectNow 即刻生效；同轮内不漂移）。
     */
    private suspend fun runLoop() {
        var attempt = 0
        while (scope.isActive) {
            if (cachedConfig == null) {
                refreshCachedConfig()
                delay(200)
                continue
            }
            val cfg = cachedConfig!!
            val token = appContext?.let { SecureStore.loadToken(it) }
            if (token == null) {
                _activeMode.value = null
                _state.value = ConnState.Idle
                return // 未配对：循环退出（配对成功后 start() 重新拉起）
            }
            _activeMode.value = cfg.mode
            _state.value = ConnState.Connecting
            val opened = CompletableDeferred<Boolean>()
            val closed = CompletableDeferred<Unit>()
            val launched = if (cfg.mode == "relay") {
                connectRelay(token, opened, closed)
            } else {
                openLocalWebSocket(token, opened, closed)
                true
            }
            if (launched && opened.await()) {
                attempt = 0
                backoff.reset()
                // 连接建立（hello → sync 已发）后：按序补发离线队列（mode-aware）
                flushPendingCommands()
                closed.await() // 挂起直到连接关闭
            } else if (!launched) {
                // relay 配置不可用：按退避节奏等待（绝不静默降级明文/无 pinning）
                closed.await()
            }
            heartbeatJob?.cancel()
            heartbeatJob = null
            _upstreamBeacon.value = null
            if (_state.value is ConnState.Unpaired) return // 401 已处理：停循环
            attempt += 1
            val delayMs = backoff.nextDelayMs()
            _state.value = ConnState.Backing(attempt, delayMs, _lastWsError.value)
            _lastWsError.value?.let { Log.w(TAG, "ws reconnect in ${delayMs}ms: ${LogRedactor.scrub(it)}") }
            delay(delayMs)
        }
    }

    /**
     * local 模式 WS（docs/14 §B.2：升级鉴权 = Authorization Bearer 头）。
     * onOpen → opened；onFailure/onClosed → closed（含 401 升级拒绝 → onAuthFatal）。
     */
    private fun openLocalWebSocket(token: String, opened: CompletableDeferred<Boolean>, closed: CompletableDeferred<Unit>): WebSocket {
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
                    handleLocalFrame(text)
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

    /**
     * relay 模式 WS（docs/18 §2：`wss://<relay>/relay/device` + Bearer 端到端 Token）。
     * endpoint 非法（非 wss 等）→ 不发起连接，按退避重试（连接层强制 wss，docs/19 §11）。
     */
    private fun connectRelay(token: String, opened: CompletableDeferred<Boolean>, closed: CompletableDeferred<Unit>): Boolean {
        val client = relayWsClient
        val endpoint = try {
            RelayEndpoint.parse(cachedConfig?.relayUrl ?: "")
        } catch (err: IllegalArgumentException) {
            _lastWsError.value = err.message ?: RelayEndpoint.REJECT_REASON
            opened.complete(false)
            closed.complete(Unit)
            return false
        }
        if (client == null) {
            // rebuild 失败（endpoint/指纹非法）已写 _lastWsError
            if (_lastWsError.value == null) _lastWsError.value = "relay 通道未就绪"
            opened.complete(false)
            closed.complete(Unit)
            return false
        }
        val request = Request.Builder()
            .url(endpoint.deviceWsUrl)
            .header("Authorization", "Bearer $token")
            .build()
        webSocket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    opened.complete(true)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleRelayFrame(text)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    _lastWsError.value =
                        t.message ?: (response?.let { "relay http ${it.code}" } ?: "relay ws failure")
                    if (response?.code == 401) {
                        // relay 升级鉴权拒绝（docs/18 §2：无效/已撤销 → 401 拒绝升级）
                        onAuthFatal("AUTH_INVALID_TOKEN", "Relay 拒绝连接（401）：设备 Token 已失效或被撤销")
                    }
                    opened.complete(false)
                    closed.complete(Unit)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    _lastWsError.value = "relay closed: $code $reason"
                    closed.complete(Unit)
                }
            },
        )
        return true
    }

    /** local 帧处理：hello（记 sequence + 必发 sync）/ event / token_rotation（预留）/ unknown（静默）。 */
    private fun handleLocalFrame(text: String) {
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
                bumpRefreshSignal() // R5.3：重连补偿——断线期遗漏的投影变化立即回补
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

    // ---------------------------------------------------------------------------
    // relay 帧（docs/18 16 帧 E→D 面；模式显式选择，绝不与 local 帧混解析）
    // ---------------------------------------------------------------------------

    private fun handleRelayFrame(text: String) {
        val frame = try {
            RelayCodec.parse(text)
        } catch (err: Exception) {
            Log.w(TAG, "relay frame parse failed: ${LogRedactor.scrub(err.message ?: "?")}")
            return
        }
        when (frame) {
            is RelayFrame.Hello -> {
                helloSequence = frame.sequence
                heartbeatSec = frame.heartbeatSec
                _upstreamBeacon.value = frame.upstream
                _state.value = ConnState.Connected(frame.heartbeatSec, frame.sequence)
                Log.i(TAG, "relay hello seq=${frame.sequence}, upstream=${frame.upstream}, sync after=${relaySync.after}")
                // M3-C8a 引导修复（docs/18 §6.1.2）：hello 后必发 sync_request {after = 本地游标}——
                // fresh install（after=0）也必须发出（ECS 以 sequence>after 升序补页 + upTo/hasGaps
                // 暴露水位，§3.12/forwarder.ts 实证）。旧实现 sendRelaySyncRequest 对 after<=0 早退
                // → fresh 引导死锁（sync_request 永不发 → 补发永不启动 → held 只增、ack 不落盘）。
                if (webSocket?.send(relaySync.helloSyncFrame()) == true) persistRelayCursor()
                startRelayHeartbeat()
                if (frame.upstream != "disconnected") scheduleRelayFlush()
                bumpRefreshSignal() // R5.3：重连补偿
            }

            is RelayFrame.Event -> handleRelayEvent(frame)

            is RelayFrame.SyncResponse -> {
                // 补发页（docs/18 §3.12）：内嵌事件同形处理；hasGaps = 缓存洞 → 显式 gapFill（§6.3）
                for (event in frame.events) handleRelayEvent(event)
                if (frame.hasGaps) {
                    Log.w(TAG, "relay sync_response hasGaps upTo=${frame.upTo} → explicit gapFill")
                    if (relaySync.gapFill(frame.upTo)) persistRelayCursor()
                    scheduleRelayAck()
                }
                bumpRefreshSignal() // R5.3：补发页即投影变化信号
            }

            is RelayFrame.Heartbeat -> {
                val previous = _upstreamBeacon.value
                if (frame.upstream != null) _upstreamBeacon.value = frame.upstream
                // 信标翻转 disconnected → connected：续跑被挂起的排队补发（偏离⑤挂起-恢复语义）
                if (previous == "disconnected" && frame.upstream == "connected") {
                    Log.i(TAG, "relay upstream recovered → resume held queue")
                    scheduleRelayFlush()
                }
            }

            is RelayFrame.TokenRotation -> applyTokenRotation(frame)

            is RelayFrame.Disconnect -> {
                if (frame.reason == "revoked") {
                    // docs/18 §3.15：reason=revoked → 不得自动重连（撤销即断，凭据已失效）
                    onAuthFatal("DEVICE_REVOKED", "Relay 通知设备已被撤销（disconnect reason=revoked）")
                } else {
                    _lastWsError.value = "relay disconnect: ${frame.reason}"
                    webSocket?.close(1000, "ack disconnect")
                }
            }

            is RelayFrame.CommandAck -> settleCommandAck(frame)

            is RelayFrame.CommandResult -> settleCommandResult(frame)

            is RelayFrame.WakeResult -> settleWakeResult(frame)

            is RelayFrame.Error -> {
                _lastWsError.value = "relay error [${frame.code}] ${frame.message ?: ""}" +
                    (frame.retryAfterSec?.let { "（retry after ${it}s）" } ?: "")
                Log.w(TAG, "relay error frame: ${LogRedactor.scrub(frame.code)}")
            }

            is RelayFrame.Unknown -> Unit // 未知类型静默；register_pairing 等 host 腿控制帧亦在此（偏离③）
            else -> Unit // D→E 方向帧绝不由服务端发来：静默（绝不猜）
        }
    }

    /** relay 事件帧 → 通知/缓存推进（与 local 同映射面；requiresUserAction 白名单布尔直通分叉）。 */
    private fun handleRelayEvent(frame: RelayFrame.Event) {
        _lastEventAtMs.value = System.currentTimeMillis()
        bumpRefreshSignal() // R5.3：事件即刷新信号（UI 立即拉取，轮询只作 120s 兜底）
        // 累计游标（docs/18 §3.11/§6.2）：仅接续前进；空洞挂起（held），重复/旧序绝不回退
        if (relaySync.observe(frame.sequence)) {
            scheduleRelayAck()
        } else {
            Log.d(TAG, "relay seq=${frame.sequence} not contiguous (cursor=${relaySync.after}, held=${relaySync.heldCount()})")
        }

        // 事件 → 通知映射（waiting_input 两 status / status_changed 终态；relay 帧带
        // requiresUserAction 白名单布尔 → 缺 status 时降级为「等待你的处理」，docs/18 §4.2）
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
            requiresUserAction = frame.requiresUserAction,
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

    /** relay 应用层心跳发送（docs/18 §3.13：30s 双向 + lastAckedSeq/tokenVersion 进度）。 */
    private fun startRelayHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive && _state.value is ConnState.Connected) {
                delay(heartbeatSec.coerceIn(5, 120) * 1_000L)
                val ws = webSocket ?: break
                val tokenVersion = runCatching { db?.deviceDao()?.get()?.tokenVersion }.getOrNull()
                val sent = ws.send(
                    RelayCodec.encode(
                        RelayFrame.Heartbeat(
                            ts = System.currentTimeMillis() / 1000,
                            lastAckedSeq = relaySync.after,
                            tokenVersion = tokenVersion,
                        ),
                    ),
                )
                if (!sent) break
            }
        }
    }

    /** 累计游标推进 → 节流发 sync_request（after = 游标；兼任 ACK，docs/18 §3.11）。 */
    private fun scheduleRelayAck() {
        if (relayAckScheduled) return
        relayAckScheduled = true
        scope.launch {
            delay(ACK_FLUSH_INTERVAL_MS)
            relayAckScheduled = false
            sendRelaySyncRequest()
        }
    }

    /**
     * 节流回调的 sync_request 发送（after = 游标；兼任累计 ACK，docs/18 §3.11）。
     * M3-C8a：hello 引导出帧已改走 [relaySync.helloSyncFrame]（after=0 必发，§6.1.2）——本函数
     * 只服务「游标前进/hasGaps 推进」后的 ACK 面（此时 after>0 由 observe/gapFill 前进语义保证）。
     */
    private fun sendRelaySyncRequest() {
        val ws = webSocket ?: return
        if (ws.send(relaySync.ackSyncFrame())) {
            persistRelayCursor()
        }
    }

    /** 游标持久化（row2；与 local row1 分空间，防模式串扰）。 */
    private fun persistRelayCursor() {
        val value = relaySync.after
        runCatching { db?.eventAckStateDao()?.upsert(EventAckStateEntity(id = 2, lastAckedSeq = value)) }
            .onFailure { Log.w(TAG, "relay cursor persist failed: ${LogRedactor.scrub(it.message ?: "?")}") }
    }

    /** token_rotation（docs/18 §3.14）：原子决策 → Keystore 写入 → 设备行版本推进 → 心跳确认。 */
    private fun applyTokenRotation(frame: RelayFrame.TokenRotation) {
        val context = appContext ?: return
        val store = object : TokenStore {
            override fun read(): StoredToken? {
                val token = SecureStore.loadToken(context) ?: return null
                val version = runCatching { db?.deviceDao()?.get()?.tokenVersion }.getOrNull() ?: 1
                return StoredToken(token = token, tokenVersion = version, deviceId = SecureStore.loadDeviceId(context))
            }

            // 合同（docs/18 §3.14）：原子写入 + 写后读回校验；失败 = 旧值原样保留
            override fun write(token: String, tokenVersion: Int, deviceId: Long?): Boolean =
                SecureStore.rotateToken(context, token)
        }
        when (val outcome = RelayTokenRotation.apply(store, frame.newToken, frame.tokenVersion, frame.deviceId)) {
            is RotationOutcome.Accepted -> {
                scope.launch(Dispatchers.IO) {
                    runCatching {
                        db?.deviceDao()?.get()?.let { device ->
                            db?.deviceDao()?.upsert(device.copy(tokenVersion = outcome.written.tokenVersion))
                        }
                    }
                }
                // 确认信道：下一帧 heartbeat 携带新 tokenVersion（发送侧现读 Device 行）
                Log.i(TAG, "relay token rotated → v${outcome.written.tokenVersion} (heartbeat will confirm)")
            }

            is RotationOutcome.Stale -> Unit // 旧帧/重复帧：零写入零副作用（tokenVersion 单调门）

            is RotationOutcome.NoCurrentToken -> Unit // 未配对态：忽略并保持未配对

            is RotationOutcome.FailedPreservedOld -> {
                // 失败回退旧值：按旧值继续重连（docs/18 §3.14 回退路径）
                Log.w(TAG, "relay token rotation write failed → reconnect with preserved old value")
                _lastWsError.value = "Token 轮换写入失败：已回退旧值并重连"
                webSocket?.close(1000, "rotation failed; reconnect with old token")
            }
        }
    }

    /** command_ack 落账：挂起请求结算；无挂起请求的迟到 ack 按 ACCEPTED 兜底清理队列行。 */
    private fun settleCommandAck(ack: RelayFrame.CommandAck) {
        bumpRefreshSignal() // R5.3：命令回执亦为刷新信号（brief 明列）
        val deferred = pendingAcks.remove(ack.idempotencyKey)
        if (deferred != null) {
            deferred.complete(ack)
            return
        }
        // 迟到 ack（补发轮已超时放弃等）：仍按分类清理（幂等合同：accepted = 已受理）
        if (RelayCommandClassifier.classifyAck(ack.status, ack.queued) == RelayAckVerdict.ACCEPTED) {
            scope.launch(Dispatchers.IO) {
                runCatching {
                    db?.pendingCommandDao()?.getByKey(ack.idempotencyKey)?.let { row ->
                        if (row.status == "pending") db?.pendingCommandDao()?.delete(row.id)
                    }
                }
            }
        }
    }

    /** command_result 终态（docs/18 §3.10 双通道去重：按 commandId 先到为准）。 */
    private fun settleCommandResult(frame: RelayFrame.CommandResult) {
        if (relaySeenResults.seenAndRecord(frame.commandId)) return
        bumpRefreshSignal() // R5.3：命令回执亦为刷新信号（brief 明列）
        // M3-E1：spawn 的挂起终态结算（register 先于发送；无挂起请求的迟到帧按去重清理）
        frame.idempotencyKey?.let { key ->
            pendingResults.remove(key)?.let { deferred ->
                if (deferred.isActive) deferred.complete(frame)
            }
        }
        frame.idempotencyKey?.let { key ->
            scope.launch(Dispatchers.IO) {
                runCatching {
                    db?.pendingCommandDao()?.getByKey(key)?.let { row ->
                        if (row.status == "pending") db?.pendingCommandDao()?.delete(row.id)
                    }
                }
            }
        }
    }

    /** wake_result 终态（docs/18 §3.17 单帧结算）：requestId 匹配挂起请求；无主迟到帧即弃。 */
    private fun settleWakeResult(frame: RelayFrame.WakeResult) {
        pendingWakes.remove(frame.requestId)?.let { deferred ->
            if (deferred.isActive) deferred.complete(frame)
        }
    }

    /**
     * RW1 relay 模式唤醒 Windows（docs/18 §3.17 wake_host/wake_result；仅 relay 面——
     * 本地面无此能力，UI 不渲染按钮）。已鉴权 relay WS 会话直发单帧，requestId 挂起单帧结算；
     * **不入队**：非 Connected → NotConnected 如实返回（不排队不伪成功，排队重放会撞
     * relay 每设备冷却窗）；20s 等待窗超时 → Timeout（> relay 15s 执行上限）。
     */
    suspend fun submitWakeHost(): WakeSubmit = withContext(Dispatchers.IO) {
        val ws = webSocket
        val connected = ws != null && _state.value is ConnState.Connected
        wakeSubmitter.submit(connected) { ws?.send(it) == true }
    }

    // ---------------------------------------------------------------------------
    // local 事件路径（docs/14 原样）
    // ---------------------------------------------------------------------------

    private fun handleEvent(frame: WsServerFrame.Event) {
        _lastEventAtMs.value = System.currentTimeMillis()
        bumpRefreshSignal() // R5.3：事件即刷新信号（UI 立即拉取，轮询只作 120s 兜底）
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
    // relay 模式：命令面 = WS command 帧（REST POST → 405，docs/18 §7.2）；
    // queued:true（偏离⑤）= ECS 排队受理 → 保留队列行挂起重试，upstream 恢复后续跑。
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
            if (cachedConfig?.mode == "relay") {
                submitRelayCommand(sessionId, kind, text, idempotencyKey)
            } else {
                submitLocalCommand(sessionId, kind, text, idempotencyKey)
            }
        }

    /** local 命令面（docs/14 REST：reply/actions，202 accepted）。 */
    private suspend fun submitLocalCommand(sessionId: Long, kind: String, text: String?, idempotencyKey: String): SubmitResult {
        // approve/interrupt 仅 Relay 命令面存在（docs/18 §5.1 五值锁死；docs/19 §7.4 双模式矩阵）：
        // local REST 无此端点——结构化拒绝，绝不伪装成功（UI 门能力恒空，正常不可达）。
        if (kind == QueueReplayPlanner.KIND_APPROVE || kind == QueueReplayPlanner.KIND_INTERRUPT) {
            return SubmitResult.Rejected(
                "COMMAND_NOT_EXECUTABLE",
                "$kind 仅 Relay 命令面可用（docs/18 §5.1）；当前为本地模式",
            )
        }
        try {
            val accept = when (kind) {
                QueueReplayPlanner.KIND_REPLY -> api!!.reply(sessionId, text ?: "", idempotencyKey)
                QueueReplayPlanner.KIND_PAUSE -> api!!.action(sessionId, "pause", idempotencyKey)
                QueueReplayPlanner.KIND_RESUME -> api!!.action(sessionId, "resume", idempotencyKey)
                else -> return SubmitResult.Rejected("BAD_PAYLOAD", "unknown kind $kind")
            }
            return SubmitResult.Accepted(accept.commandId)
        } catch (err: ApiError) {
            if (err.isAuthFatal) onAuthFatal(err.code, err.message)
            return SubmitResult.Rejected(err.code, err.message)
        } catch (err: IOException) {
            // 断网/断连：入离线队列（status=pending + idempotencyKey；重连后按序补发）
            enqueuePending(sessionId, kind, text, idempotencyKey)
            return SubmitResult.QueuedOffline
        }
    }

    /** relay 命令发送结果（区分 ack / 已入队 / kind 非法，绝不混叠）。 */
    private sealed class CommandSendOutcome {
        data class Ack(val ack: RelayFrame.CommandAck) : CommandSendOutcome()

        /** 发送失败/超时：行已入队（同 key 复用），按 QueuedOffline 语义返回。 */
        data object Enqueued : CommandSendOutcome()

        /** kind 不在 action 五值域：不入队，结构化拒绝。 */
        data object UnknownKind : CommandSendOutcome()
    }

    /**
     * relay 命令面（docs/18 §3.8/§3.9 + §5.1 五值 action）：WS command 帧 + 内嵌端到端
     * auth{token,ts,nonce}；10s 等 command_ack（§3.0 #8）；超时/断连 → 入队待补发。
     */
    private suspend fun submitRelayCommand(sessionId: Long, kind: String, text: String?, idempotencyKey: String): SubmitResult {
        val ws = webSocket
        if (ws == null || _state.value !is ConnState.Connected) {
            enqueuePending(sessionId, kind, text, idempotencyKey)
            return SubmitResult.QueuedOffline
        }
        return when (val outcome = sendRelayCommandFrame(ws, sessionId, kind, text, idempotencyKey)) {
            is CommandSendOutcome.Ack -> when (RelayCommandClassifier.classifyAck(outcome.ack.status, outcome.ack.queued)) {
                RelayAckVerdict.ACCEPTED -> SubmitResult.Accepted(outcome.ack.commandId ?: idempotencyKey)

                RelayAckVerdict.QUEUED_HOLD -> {
                    // 偏离⑤：ECS 排队受理（Windows 尚未见到）→ 保留队列行挂起重试（同 key 幂等）
                    enqueuePending(sessionId, kind, text, idempotencyKey)
                    SubmitResult.QueuedOffline
                }

                RelayAckVerdict.REJECTED_DROP -> SubmitResult.Rejected(
                    outcome.ack.errorCode ?: "COMMAND_REJECTED",
                    outcome.ack.errorCode?.let { "命令被拒绝 [$it]" } ?: "命令被拒绝",
                )

                RelayAckVerdict.RETRY -> {
                    enqueuePending(sessionId, kind, text, idempotencyKey)
                    SubmitResult.QueuedOffline
                }
            }

            is CommandSendOutcome.Enqueued -> SubmitResult.QueuedOffline
            is CommandSendOutcome.UnknownKind ->
                SubmitResult.Rejected("BAD_PAYLOAD", "unknown kind $kind")
        }
    }

    // ---------------------------------------------------------------------------
    // M3-E1 设备自管理命令面（docs/18 §5.3，用户裁决 2026-09-07 #9=B；仅 relay 面——
    // local 面保持两 Screen 既有 REST 路径零改动，docs/14 零改动不变式）
    // ---------------------------------------------------------------------------

    /**
     * relay 模式 managed spawn（替换 AgentsScreen 的 REST 误走面，docs/18 §10 通道迁移）：
     * WS command `spawn_session`（payload {providerId, task}，sessionId 缺省）→ ack(accepted)
     * → 等 command_result(executed) 取 sessionId；queued:true → 入队挂起；超时 → 入队同 key
     * 补发（Windows 幂等返回原结果）；rejected → errorCode 结构化上抛（UI 文案分叉）。
     */
    suspend fun submitManagedSpawnRelay(providerId: Long, task: String): ManagedSpawnSubmit =
        withContext(Dispatchers.IO) {
            val ws = webSocket
            if (ws == null || _state.value !is ConnState.Connected) {
                enqueuePending(0L, QueueReplayPlanner.KIND_SPAWN_SESSION, task, IdempotencyKeys.newKey(), providerId.toString())
                return@withContext ManagedSpawnSubmit.Queued
            }
            val idempotencyKey = IdempotencyKeys.newKey()
            val resultDeferred = CompletableDeferred<RelayFrame.CommandResult>()
            pendingResults[idempotencyKey] = resultDeferred
            when (val outcome = sendRelayCommandFrame(ws, null, QueueReplayPlanner.KIND_SPAWN_SESSION, task, idempotencyKey, providerId.toString())) {
                is CommandSendOutcome.Ack -> when (ManagedSpawnOutcome.phaseFromAck(outcome.ack.status, outcome.ack.queued)) {
                    ManagedSpawnOutcome.Phase.AWAIT_RESULT -> {
                        val result: RelayFrame.CommandResult? = try {
                            withTimeout(COMMAND_ACK_TIMEOUT_MS) { resultDeferred.await() }
                        } catch (err: TimeoutCancellationException) {
                            null
                        }
                        if (result == null) {
                            // 终态未回（投递竞态/连接中断）：入队同 key 补发，Windows 幂等兜底
                            enqueuePending(0L, QueueReplayPlanner.KIND_SPAWN_SESSION, task, idempotencyKey, providerId.toString())
                            return@withContext ManagedSpawnSubmit.Queued
                        }
                        ManagedSpawnOutcome.fromResult(result.status, result.sessionId, result.commandId, result.errorCode)
                    }

                    ManagedSpawnOutcome.Phase.QUEUED -> {
                        enqueuePending(0L, QueueReplayPlanner.KIND_SPAWN_SESSION, task, idempotencyKey, providerId.toString())
                        ManagedSpawnSubmit.Queued
                    }

                    ManagedSpawnOutcome.Phase.FAILED -> ManagedSpawnSubmit.Rejected(
                        outcome.ack.errorCode ?: "COMMAND_REJECTED",
                        outcome.ack.errorCode?.let { "命令被拒绝 [$it]" } ?: "命令被拒绝",
                    )
                }

                is CommandSendOutcome.Enqueued -> ManagedSpawnSubmit.Queued
                is CommandSendOutcome.UnknownKind -> ManagedSpawnSubmit.Rejected("BAD_PAYLOAD", "unknown kind spawn_session")
            }.also {
                // 终态已结算（成功/拒绝）→ 清挂起；Queued 路径的挂起在终态帧到达时结算
                if (it !is ManagedSpawnSubmit.Queued) pendingResults.remove(idempotencyKey)
            }
        }

    /**
     * relay 模式设备自撤销（docs/18 §5.3 revoke_device）：WS command（自指无目标字段）；
     * **成功收口 = disconnect(reason=revoked) 到达**（onAuthFatal 清凭据 + 停重连 §3.15），
     * 非 command_result——§5.3 终态语义。queued:true → 行挂起（主机上线后自动完成）；
     * 收口窗超时 → 如实上抛（绝不伪报撤销成功，m3c6c 修②纪律）；重试在连接被踢后自然终止
     * （幂等键兜底）。
     */
    suspend fun submitSelfRevokeRelay(): SelfRevokeSubmit = withContext(Dispatchers.IO) {
        val ws = webSocket
        if (ws == null || _state.value !is ConnState.Connected) {
            enqueuePending(0L, QueueReplayPlanner.KIND_REVOKE_DEVICE, null, IdempotencyKeys.newKey())
            return@withContext SelfRevokeSubmit.Queued
        }
        val closure = CompletableDeferred<Unit>()
        selfRevokeClosure = closure
        val idempotencyKey = IdempotencyKeys.newKey()
        val outcome = sendRelayCommandFrame(ws, null, QueueReplayPlanner.KIND_REVOKE_DEVICE, null, idempotencyKey)
        val ackErrorCode = (outcome as? CommandSendOutcome.Ack)?.ack?.errorCode
        val step = when (outcome) {
            is CommandSendOutcome.Ack -> SelfRevokeFlow.onAck(outcome.ack.status, outcome.ack.queued)
            is CommandSendOutcome.Enqueued -> {
                selfRevokeClosure = null
                return@withContext SelfRevokeSubmit.Queued
            }

            is CommandSendOutcome.UnknownKind -> {
                selfRevokeClosure = null
                return@withContext SelfRevokeSubmit.Rejected("BAD_PAYLOAD", "unknown kind revoke_device")
            }
        }
        when (step) {
            SelfRevokeFlow.Step.AWAIT_ACK, SelfRevokeFlow.Step.AWAIT_CLOSURE, SelfRevokeFlow.Step.DONE_REVOKED -> {
                val closed = try {
                    withTimeout(REVOKE_CLOSURE_TIMEOUT_MS) { closure.await() }
                    true
                } catch (err: TimeoutCancellationException) {
                    false
                }
                selfRevokeClosure = null
                val state = _state.value
                if (closed || (state is ConnState.Unpaired && SelfRevokeFlow.isClosure(state.code))) {
                    SelfRevokeSubmit.Revoked
                } else {
                    SelfRevokeSubmit.Rejected("RELAY_UPSTREAM_TIMEOUT", "撤销回执未送达（连接状态异常，请检查连接）")
                }
            }

            SelfRevokeFlow.Step.QUEUED_HOLD -> {
                selfRevokeClosure = null
                enqueuePending(0L, QueueReplayPlanner.KIND_REVOKE_DEVICE, null, idempotencyKey)
                SelfRevokeSubmit.Queued
            }

            SelfRevokeFlow.Step.FAILED -> {
                selfRevokeClosure = null
                SelfRevokeSubmit.Rejected(ackErrorCode ?: "COMMAND_REJECTED", "撤销被拒绝 [${ackErrorCode ?: ""}]".trimEnd())
            }
        }
    }

    /**
     * 发送 command 帧并等待 command_ack（10s 超时 docs/18 §3.0 #8；失败/超时 → 入队）。
     * M3-E1（docs/18 §5.3）：spawn_session/revoke_device 的 sessionId 缺省合法 → 传 null
     * 时帧面不带 sessionId；spawn 的 payload = {providerId, task}，revoke 的 payload = {}
     * （自指无目标，绝不携带任何目标字段）。
     */
    private suspend fun sendRelayCommandFrame(
        ws: WebSocket,
        sessionId: Long?,
        kind: String,
        text: String?,
        idempotencyKey: String,
        providerId: String? = null,
    ): CommandSendOutcome {
        val action = RelayActions.fromKind(kind) ?: return CommandSendOutcome.UnknownKind
        val payload = JSONObject().apply {
            when (kind) {
                QueueReplayPlanner.KIND_REPLY -> put("text", text ?: "")
                QueueReplayPlanner.KIND_SPAWN_SESSION -> {
                    put("providerId", providerId ?: "")
                    put("task", text ?: "")
                }

                QueueReplayPlanner.KIND_REVOKE_DEVICE -> {
                    // payload {}：目标 = auth Token 对应设备自身（帧无目标字段天然自指）
                }
            }
        }
        val nowSec = System.currentTimeMillis() / 1000
        val frame = RelayFrame.Command(
            requestId = UUID.randomUUID().toString(),
            idempotencyKey = idempotencyKey,
            sessionId = sessionId,
            action = action,
            payload = payload,
            token = appContext?.let { SecureStore.loadToken(it) }, // 端到端 Bearer：ECS 不解释只转发
            tsSec = nowSec,
            nonce = UUID.randomUUID().toString(),
            createdAtSec = nowSec,
        )
        val deferred = CompletableDeferred<RelayFrame.CommandAck>()
        pendingAcks[idempotencyKey] = deferred
        if (!ws.send(RelayCodec.encode(frame))) {
            pendingAcks.remove(idempotencyKey)
            enqueuePending(sessionId ?: 0L, kind, text, idempotencyKey, providerId)
            return CommandSendOutcome.Enqueued
        }
        return try {
            CommandSendOutcome.Ack(withTimeout(COMMAND_ACK_TIMEOUT_MS) { deferred.await() })
        } catch (err: TimeoutCancellationException) {
            pendingAcks.remove(idempotencyKey)
            enqueuePending(sessionId ?: 0L, kind, text, idempotencyKey, providerId)
            CommandSendOutcome.Enqueued
        }
    }

    /** 入队（同幂等 key 复用既有行，绝不重复入队）。 */
    private fun enqueuePending(sessionId: Long, kind: String, text: String?, idempotencyKey: String, providerId: String? = null) {
        runCatching {
            val dao = db!!.pendingCommandDao()
            if (dao.getByKey(idempotencyKey) == null) {
                dao.insert(
                    PendingCommandEntity(
                        sessionId = sessionId,
                        kind = kind,
                        text = text,
                        idempotencyKey = idempotencyKey,
                        status = "pending",
                        createdAtMs = System.currentTimeMillis(),
                        lastError = null,
                        providerId = providerId,
                    ),
                )
            }
        }
    }

    /** 重连成功 / App 启动后：按序补发离线队列（mode-aware：local=REST / relay=WS command）。 */
    suspend fun flushPendingCommands() {
        if (cachedConfig?.mode == "relay") {
            flushPendingCommandsRelay()
        } else {
            flushPendingCommandsLocal()
        }
    }

    private suspend fun flushPendingCommandsLocal() {
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
                        QueueReplayPlanner.KIND_APPROVE, QueueReplayPlanner.KIND_INTERRUPT -> {
                            // local REST 无 approve/interrupt（docs/18 §5.1）：结构化落败，绝不伪装 202
                            db!!.pendingCommandDao().update(
                                row.copy(status = "failed", lastError = "COMMAND_NOT_EXECUTABLE (local face)"),
                            )
                            continue
                        }

                        QueueReplayPlanner.KIND_SPAWN_SESSION, QueueReplayPlanner.KIND_REVOKE_DEVICE -> {
                            // M3-E1：设备自管理两值仅 relay 命令面存在（docs/18 §5.3/§7.2）；
                            // relay 源队列行漏入 local 面（模式切换残留）→ 结构化落败，绝不伪装
                            db!!.pendingCommandDao().update(
                                row.copy(status = "failed", lastError = "COMMAND_NOT_EXECUTABLE (local face)"),
                            )
                            continue
                        }

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

    /**
     * relay 补发轮（docs/18 §3.8 + 偏离⑤）：
     * - upstream disconnected → 整轮挂起（upstream 信标恢复 connected 再续跑）；
     * - 同幂等 key 重发（ECS (deviceId, idempotencyKey) 去重 + Windows 幂等兜底）；
     * - queued:true → 保留队列行 + 本轮终止（挂起）；
     * - 结构化拒绝 → 落败保留（UI 展示），继续后续指令。
     */
    private suspend fun flushPendingCommandsRelay() {
        if (_upstreamBeacon.value == "disconnected") {
            Log.i(TAG, "relay flush held: upstream disconnected")
            return
        }
        val ws = webSocket ?: return
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
                // M3-E1（docs/18 §5.3）：spawn_session/revoke_device 的 sessionId 缺省合法 → 帧面不带；
                // spawn 补发的 providerId 从队列行 providerId 列还原（Room v4）
                val sessionRef: Long? = if (queued.kind == QueueReplayPlanner.KIND_SPAWN_SESSION || queued.kind == QueueReplayPlanner.KIND_REVOKE_DEVICE) null else queued.sessionId
                when (val outcome = sendRelayCommandFrame(ws, sessionRef, queued.kind, row.text, queued.idempotencyKey, row.providerId)) {
                    is CommandSendOutcome.Ack -> when (
                        RelayCommandClassifier.classifyAck(outcome.ack.status, outcome.ack.queued)
                    ) {
                        RelayAckVerdict.ACCEPTED -> db!!.pendingCommandDao().delete(queued.id)

                        RelayAckVerdict.QUEUED_HOLD -> {
                            Log.i(TAG, "relay queued ack → hold row ${queued.id}, suspend retry until upstream recovers")
                            return // 偏离⑤：挂起重试（保留队列行）
                        }

                        RelayAckVerdict.REJECTED_DROP -> db!!.pendingCommandDao().update(
                            row.copy(status = "failed", lastError = outcome.ack.errorCode ?: "COMMAND_REJECTED"),
                        )

                        RelayAckVerdict.RETRY -> return // 未知 status/连接异常：不猜，保留待重试
                    }

                    is CommandSendOutcome.Enqueued -> {
                        // 发送失败/超时（行已入队/保留）：连接可能已断，终止本轮
                        return
                    }

                    is CommandSendOutcome.UnknownKind -> {
                        // action 五值之外的 kind（不该发生）：落败标记
                        db!!.pendingCommandDao().update(row.copy(status = "failed", lastError = "BAD_KIND ${queued.kind}"))
                        continue
                    }
                }
            }
        }
    }

    /** relay 信标/重连触发补发轮（hello connected / heartbeat 信标翻转）。 */
    private fun scheduleRelayFlush() {
        scope.launch {
            runCatching { flushPendingCommands() }
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
        heartbeatJob?.cancel()
        heartbeatJob = null
        webSocket?.cancel()
        webSocket = null
        val context = appContext
        if (context != null) {
            SecureStore.clear(context)
            db!!.deviceDao().clear()
            GatewayConnectionService.stop(context)
        }
        _state.value = ConnState.Unpaired(code, message)
        // M3-E1：revoke_device 收口（§5.3：成功 = disconnect(revoked) → 凭据已清 + 停重连）
        if (SelfRevokeFlow.isClosure(code)) {
            selfRevokeClosure?.let { c -> if (c.isActive) c.complete(Unit) }
        }
    }

    /** 诊断页投影：本机 WS 连接状态 / 最近错误 / 退避状态（区分模式与 relay 降级信标）。 */
    fun diagnosticsSnapshot(): String = when (val s = _state.value) {
        is ConnState.Connected -> when {
            _activeMode.value == "relay" && _upstreamBeacon.value == "disconnected" ->
                "Relay 已连接（心跳 ${s.heartbeatSec}s，服务端 seq ${s.helloSequence}）· 电脑离线：命令将排队（upstream disconnected）"

            _activeMode.value == "relay" ->
                "Relay 已连接（心跳 ${s.heartbeatSec}s，服务端 seq ${s.helloSequence}，upstream connected）"

            else -> "已连接（心跳 ${s.heartbeatSec}s，服务端 seq ${s.helloSequence}）"
        }

        is ConnState.Connecting ->
            if (_activeMode.value == "relay") "Relay 连接中…" else "连接中…"

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
