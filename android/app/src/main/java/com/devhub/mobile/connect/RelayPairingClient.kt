package com.devhub.mobile.connect

import android.content.Context
import android.util.Log
import com.devhub.mobile.core.LogRedactor
import com.devhub.mobile.core.TlsPinningConfig
import com.devhub.mobile.core.relay.RelayCodec
import com.devhub.mobile.core.relay.RelayEndpoint
import com.devhub.mobile.core.relay.RelayFrame
import com.devhub.mobile.core.relay.RelayPairEvent
import com.devhub.mobile.core.relay.RelayPairingMachine
import com.devhub.mobile.core.relay.RelayPairingMachine.Step
import com.devhub.mobile.core.relay.RelayTokenRotation
import com.devhub.mobile.core.relay.RotationOutcome
import com.devhub.mobile.core.relay.StoredToken
import com.devhub.mobile.core.relay.TokenStore
import com.devhub.mobile.data.SecureStore
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.remote.RelayTlsTrust
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * relay 模式 WS 裸连接 pair 客户端（M3-C3a 修 1，C2 #1；docs/18 §2/§3.2/§3.3，
 * docs/19 §7.1「UI 复用现 Pairing 页，仅传输层换」）。
 *
 * 流程（状态机 = :core [RelayPairingMachine]，本类只做传输与计时）：
 * 1. 读 Room GatewayConfig（mode 必须为 relay；relayUrl 经 [RelayEndpoint.parse] 强制 wss）；
 * 2. 构建专用 OkHttpClient（**无 Authorization 头、无 ProtocolHeadersInterceptor**——
 *    裸连接例外是配对专属路径，绝不复用带 token 注入的常驻客户端）；
 *    配置了指纹 → RelayTlsTrust pin-TM 信任锚（M3-C6c bug#1：pin-TM 激活时**不装**
 *    CertificatePinner——docs/19 §10.2 实现层勘误；具体 host pattern 语义不变）；
 * 3. 裸连 `wss://<relay>/relay/device` → 收 hello（10s 超时）→ 发 pair 帧 →
 *    pair_accepted（10s 超时）→ 凭据交调用方落 SecureStore（token 明文零日志红线）；
 * 4. 失败/超时 → 结构化 [RelayPairingClient.Outcome.Failure]（§8.2 码域文案），UI 直显。
 *
 * 真实公网 pair 联调归 C2b 重跑批；本批门禁为 :core 状态机单测 + 模拟器不崩冒烟。
 */
object RelayPairingClient {
    private const val TAG = "RelayPairing"

    /** 阶段超时（docs/18 §2：裸连接首帧 10s；brief 裁定 hello / pair 应答各 10s 上限）。 */
    const val STAGE_TIMEOUT_MS = 10_000L

    /**
     * pair_accepted 后的 rotation 排空窗（M3-C6c bug#3）：C2c 时间线实录 token_rotation 与
     * pair_accepted **同秒**背靠背到达（Windows post-pairing 自动轮换）；窗口收齐尾随帧，
     * 服务端主动关闭或首枚 rotation 后 [ROTATION_SETTLE_MS] 沉降即止。
     */
    const val ROTATION_DRAIN_WINDOW_MS = 3_000L

    /** 首枚 rotation 捕获后的短沉降窗（兜住同秒连发的第二枚版本）。 */
    const val ROTATION_SETTLE_MS = 500L

    /** 客户端版本（pair 帧 clientVersion；与 app/build.gradle.kts versionName 对齐）。 */
    const val APP_VERSION = "1.0"

    /** 配对结果（Success 凭据由调用方立即落 SecureStore；[Credentials] 同 :core 机器）。 */
    sealed class Outcome {
        data class Success(
            val deviceId: Long,
            val token: String,
            val tokenVersion: Int,
            val heartbeatSec: Int?,
            /** relay endpoint host（设备页 gateway 展示用；非机密）。 */
            val relayHost: String,
            /**
             * pair 腿捕获的 token_rotation 帧（M3-C6c bug#3；帧本就发给该设备，docs/18 §3.14）。
             * 调用方在 v1 凭据落 SecureStore **之后**逐帧 [applyRotation]（tokenVersion 单调门
             * 防旧帧/重放）。内存一次性面：newToken 明文零日志红线适用。
             */
            val pendingRotations: List<RelayFrame.TokenRotation> = emptyList(),
        ) : Outcome()

        data class Failure(val code: String, val message: String) : Outcome()
    }

    /**
     * 执行一次裸连接配对（挂起直至成功/失败；调用方在 IO 协程调用）。
     * @param code 8 位配对码（PairingScreen 已做大写归一）
     * @param deviceName 设备名（Build.MODEL）
     */
    suspend fun pair(context: Context, code: String, deviceName: String): Outcome = withContext(Dispatchers.IO) {
        val config = runCatching { DevHubDb.get(context).gatewayConfigDao().get() }.getOrNull()
            ?: return@withContext Outcome.Failure(
                "BAD_CONFIG",
                "未找到 Gateway 配置：请先在「Gateway 配置」页选择 Relay 模式并保存",
            )
        if (config.mode != "relay") {
            return@withContext Outcome.Failure(
                "BAD_CONFIG",
                "当前为本地模式：配对应走桌面 REST claim（模式不匹配，绝不混用传输层）",
            )
        }
        val endpoint = try {
            RelayEndpoint.parse(config.relayUrl ?: "")
        } catch (err: IllegalArgumentException) {
            return@withContext Outcome.Failure("BAD_CONFIG", err.message ?: RelayEndpoint.REJECT_REASON)
        }

        // 专用客户端：裸连接（无 Authorization/防重放头）；指纹配置 → 具体 host pattern pin
        val pinning = try {
            ConnectionManager.parsePinning(config.pinFingerprints)
        } catch (err: IllegalArgumentException) {
            return@withContext Outcome.Failure(
                "BAD_CONFIG",
                "relay TLS 指纹配置非法：${err.message}",
            )
        }
        val pinPattern = if (pinning != null) TlsPinningConfig.pinPatternFor(endpoint.host) else null
        if (pinning != null && pinPattern == null) {
            return@withContext Outcome.Failure(
                "BAD_CONFIG",
                "relay TLS 指纹已配置但 endpoint host 为空/非法，无法构造 pin pattern（fail-fast 不注入）",
            )
        }
        // 专用客户端：裸连接（无 Authorization/防重放头）；指纹配置 → pin-TM 信任锚（不装 pinner）
        val client = relayPairClient(pinning, pinPattern)

        val machine = RelayPairingMachine(
            code = code,
            deviceName = deviceName,
            clientVersion = APP_VERSION,
        )
        val events = Channel<RelayPairEvent>(Channel.UNLIMITED)

        // M3-C6c bug#3：token_rotation 帧本就发给该设备（docs/18 §3.14），pair 腿不再走丢弃
        // 分支——捕获待应用（配对成功 + v1 凭据落 SecureStore 后逐帧应用，保序消竞态）
        val rotations = java.util.Collections.synchronizedList(mutableListOf<RelayFrame.TokenRotation>())
        val router = PairLegFrameRouter(
            onMachineEvent = { events.trySend(it) },
            onRotation = { frame -> rotations.add(frame) },
        )

        val request = Request.Builder().url(endpoint.deviceWsUrl).build()
        val ws: WebSocket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = try {
                        RelayCodec.parse(text)
                    } catch (err: Exception) {
                        Log.w(TAG, "pair frame parse failed: ${LogRedactor.scrub(err.message ?: "?")}")
                        return // 畸形帧绝不猜：丢弃继续等
                    }
                    router.onFrame(frame)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    val detail = t.message ?: response?.let { "http ${it.code}" } ?: "connection failed"
                    Log.w(TAG, "pair ws failure: ${LogRedactor.scrub(detail)}")
                    events.trySend(RelayPairEvent.Closed(wsCode = -1, reason = detail))
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    // docs/18 §2：首帧非 pair / 10s 未发 → 服务端 close(1000, "pair required")
                    events.trySend(RelayPairEvent.Closed(wsCode = code, reason = reason))
                }
            },
        )

        try {
            // —— 阶段 1：等 hello（10s）——
            var step: Step? = awaitStep(machine, events) { it is Step.SendPair || it is Step.Failed }
            if (step is Step.Failed) return@withContext step.toOutcome()

            // —— 阶段 2：发 pair 帧，等 pair_accepted（10s）——
            if (!ws.send(machine.pairRequestJson)) {
                return@withContext Outcome.Failure(
                    "RELAY_UPSTREAM_OFFLINE",
                    "pair 帧发送失败：连接已被对端关闭 [RELAY_PAIR_SEND_FAILED]",
                )
            }
            step = awaitStep(machine, events) { it is Step.Succeeded || it is Step.Failed }
            when (step) {
                is Step.Succeeded -> {
                    // M3-C6c bug#3：pair_accepted 与 token_rotation 同秒背靠背（C2c 时间线实录）
                    // ——短排空窗收齐尾随 rotation 帧后一并交调用方（v1 落库后应用，保序）
                    drainPairLegRotations(events, rotations)
                    Outcome.Success(
                        deviceId = step.credentials.deviceId,
                        token = step.credentials.deviceToken,
                        tokenVersion = step.credentials.tokenVersion,
                        heartbeatSec = step.credentials.heartbeatSec,
                        relayHost = endpoint.host,
                        pendingRotations = rotations.toList(),
                    )
                }

                is Step.Failed -> step.toOutcome()
                else -> Outcome.Failure("INTERNAL", "配对流意外终止（状态机未产出终态）")
            }
        } finally {
            runCatching { ws.close(1000, "pairing done") }
            // 配对连接一次性：不给 OkHttp 留存活回调（避免泄漏 awaiting 线程）
            runCatching { ws.cancel() }
            client.dispatcher.executorService.shutdown()
        }
    }

    /**
     * pair 专用客户端构建（M3-C6c bug#1，docs/19 §10.2 实现层勘误）：
     * - pin-TM 激活（指纹已配置）→ 信任判定**单点** = [RelayTlsTrust] PinTrustManager
     *   checkServerTrusted；**绝不叠加 CertificatePinner**——Android 对非 Conscrypt 自定义
     *   X509TrustManager 的链清洗 fallback 经 X509TrustManagerExtensions 委托同一
     *   checkServerTrusted，通过后返回**空链**，而 okhttp 4.12 `check$okhttp` 只对清洁链配
     *   pin → 空链即拒（空洞拒连：正确指纹也握手失败，C2c 实证）；HostnameVerifier 保持
     *   默认（IP SAN）作第二保险；
     * - 无指纹 → 全默认（裸连接无 pinning 面）。
     * 抽出为纯构建函数：JVM 单测直证「pin-TM 激活时 builder 不装 pinner」。
     */
    internal fun relayPairClient(pinning: TlsPinningConfig?, pinPattern: String?): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .apply {
                if (pinning != null && pinPattern != null) {
                    val (factory, trustManager) = RelayTlsTrust.sslSocketFactory(pinning)
                    sslSocketFactory(factory, trustManager)
                }
            }
            .build()

    /**
     * pair_accepted 后的短排空窗（M3-C6c bug#3）：token_rotation 与 pair_accepted 同秒
     * 背靠背到达（C2c 实录；服务端窗口 300s 宽限内 App 必须带走新 Token）。窗口内消化
     * 帧流：服务端主动关闭（Closed）或首枚 rotation 后 [ROTATION_SETTLE_MS] 沉降或
     * [ROTATION_DRAIN_WINDOW_MS] 到期即止。rotation 由 router 直接捕获进 sink；状态机已
     * 终态，其余事件一律消化丢弃（绝不喂机器——终态幂等合同）。
     */
    private suspend fun drainPairLegRotations(
        events: Channel<RelayPairEvent>,
        rotations: MutableList<RelayFrame.TokenRotation>,
    ) {
        var deadline = System.currentTimeMillis() + ROTATION_DRAIN_WINDOW_MS
        var sawRotation = false
        while (System.currentTimeMillis() < deadline) {
            val event = try {
                withTimeout(deadline - System.currentTimeMillis()) { events.receive() }
            } catch (_: TimeoutCancellationException) {
                break
            } catch (_: ClosedReceiveChannelException) {
                break
            }
            if (event is RelayPairEvent.Closed) break // 服务端先关：不会再有帧
            if (!sawRotation && rotations.isNotEmpty()) {
                sawRotation = true
                deadline = System.currentTimeMillis() + ROTATION_SETTLE_MS
            }
        }
    }

    /**
     * pair 腿 token_rotation 应用（M3-C6c bug#3；调用方在 v1 凭据落 SecureStore **之后**
     * 调用，保序：先 v1 后 v2，绝不倒挂）。复用 :core [RelayTokenRotation] 原子决策
     * （tokenVersion 单调门：Stale/NoCurrentToken 零写入）+ [SecureStore.rotateToken]
     * 原子写入（失败保留旧值，docs/18 §3.14）+ 设备行 tokenVersion 推进。与
     * ConnectionManager.applyTokenRotation 同一合同，仅为 pair 腿时序单列（确认信道 =
     * 下一帧 heartbeat 携带新 tokenVersion）。
     * @return true = 已应用（Accepted）；false = Stale/NoCurrentToken/写入失败（旧值原样保留）。
     */
    internal fun applyRotation(context: Context, db: DevHubDb, frame: RelayFrame.TokenRotation): Boolean {
        val store = object : TokenStore {
            override fun read(): StoredToken? {
                val token = SecureStore.loadToken(context) ?: return null
                val version = runCatching { db.deviceDao().get()?.tokenVersion }.getOrNull() ?: 1
                return StoredToken(token = token, tokenVersion = version, deviceId = SecureStore.loadDeviceId(context))
            }

            // 合同（docs/18 §3.14）：原子写入 + 写后读回校验；失败 = 旧值原样保留
            override fun write(token: String, tokenVersion: Int, deviceId: Long?): Boolean =
                SecureStore.rotateToken(context, token)
        }
        return when (val outcome = RelayTokenRotation.apply(store, frame.newToken, frame.tokenVersion, frame.deviceId)) {
            is RotationOutcome.Accepted -> {
                runCatching {
                    db.deviceDao().get()?.let { device ->
                        db.deviceDao().upsert(device.copy(tokenVersion = outcome.written.tokenVersion))
                    }
                }
                Log.i(TAG, "pair-leg token rotated → v${outcome.written.tokenVersion} (heartbeat will confirm)")
                true
            }

            is RotationOutcome.Stale, is RotationOutcome.NoCurrentToken -> false // 零写入零副作用

            is RotationOutcome.FailedPreservedOld -> {
                Log.w(TAG, "pair-leg token rotation write failed → old value preserved")
                false
            }
        }
    }

    /** 消费事件直至状态机产出目标终态/发送步；阶段超时翻译为 machine Timeout 事件（10s）。 */
    private suspend fun awaitStep(
        machine: RelayPairingMachine,
        events: Channel<RelayPairEvent>,
        wanted: (Step) -> Boolean,
    ): Step? {
        while (true) {
            val event = try {
                withTimeout(STAGE_TIMEOUT_MS) { events.receive() }
            } catch (_: TimeoutCancellationException) {
                return machine.onEvent(RelayPairEvent.Timeout)
            }
            machine.onEvent(event)?.let { step ->
                if (wanted(step)) return step
                // 非目标步（如 AwaitingHello 阶段的重复 hello）：继续等
            }
        }
    }

    private fun Step.Failed.toOutcome(): Outcome.Failure = Outcome.Failure(failure.code, failure.message)
}

/**
 * pair 腿帧路由（M3-C6c bug#3）：传输层 onMessage 的帧分类纯逻辑（零 Android 依赖，
 * JVM 单测以 fake WS 帧泵直喂）。协议空白点处理（见类尾注）：
 * - Hello / PairAccepted / Error / Disconnect → 状态机事件（原语义零回退）；
 * - TokenRotation → [onRotation] 捕获（**不再走 else 丢弃分支**——C2c 实录：Windows
 *   post-pairing 自动轮换使 token_rotation 与 pair_accepted 同秒背靠背到达 pair WS，
 *   旧实现丢弃 → App 恒持 v1，300s 宽限到期系统性自毁，三设备 #38/39/40 确定性复现）；
 * - register_pairing / heartbeat / 未知帧 → 静默（原 else 面，配对流无关）。
 *
 * 协议文档空白点（docs/18 §3.14 未定义帧投递通道）：该节只写「Android 收帧：Keystore
 * 原子更新…」，未限定 token_rotation 必须走已鉴权常规 WS——C2c 实证其可先于常规 WS 建立
 * 到达 pair 裸连接。本实现按「两腿都处理」落地（帧本就发给该设备，持久化 SecureStore），
 * 不扩协议面；建议 docs/18 §3.14 增补「E→D token_rotation 允许投递于该设备任一活跃
 * device-leg 连接（含裸 pair 连接的配对完成窗口）」。
 */
internal class PairLegFrameRouter(
    private val onMachineEvent: (RelayPairEvent) -> Unit,
    private val onRotation: (RelayFrame.TokenRotation) -> Unit,
) {
    fun onFrame(frame: RelayFrame) {
        when (frame) {
            is RelayFrame.Hello -> onMachineEvent(RelayPairEvent.Hello(frame))
            is RelayFrame.PairAccepted -> onMachineEvent(RelayPairEvent.PairAccepted(frame))
            is RelayFrame.Error -> onMachineEvent(RelayPairEvent.Error(frame))
            is RelayFrame.Disconnect ->
                onMachineEvent(RelayPairEvent.Closed(wsCode = 1000, reason = "disconnect:${frame.reason}"))

            is RelayFrame.TokenRotation -> onRotation(frame)
            else -> Unit // register_pairing/heartbeat 等：配对流无关帧，静默
        }
    }
}
