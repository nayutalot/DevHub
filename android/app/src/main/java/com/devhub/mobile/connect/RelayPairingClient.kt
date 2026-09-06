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
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.remote.RelayTlsTrust
import com.devhub.mobile.data.remote.toCertificatePinner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
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
 *    配置了指纹 → RelayTlsTrust + 具体 host pattern pin（M3-C3a 修 2，绝不通配符）；
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
                "relay TLS 指纹配置非法（docs/19 §10.2）：${err.message}",
            )
        }
        val pinPattern = if (pinning != null) TlsPinningConfig.pinPatternFor(endpoint.host) else null
        if (pinning != null && pinPattern == null) {
            return@withContext Outcome.Failure(
                "BAD_CONFIG",
                "relay TLS 指纹已配置但 endpoint host 为空/非法，无法构造 pin pattern（fail-fast 不注入）",
            )
        }
        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .apply {
                if (pinning != null && pinPattern != null) {
                    val (factory, trustManager) = RelayTlsTrust.sslSocketFactory(pinning)
                    sslSocketFactory(factory, trustManager)
                    certificatePinner(pinning.toCertificatePinner(pinPattern))
                }
            }
            .build()

        val machine = RelayPairingMachine(
            code = code,
            deviceName = deviceName,
            clientVersion = APP_VERSION,
        )
        val events = Channel<RelayPairEvent>(Channel.UNLIMITED)

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
                    when (frame) {
                        is RelayFrame.Hello -> events.trySend(RelayPairEvent.Hello(frame))
                        is RelayFrame.PairAccepted -> events.trySend(RelayPairEvent.PairAccepted(frame))
                        is RelayFrame.Error -> events.trySend(RelayPairEvent.Error(frame))
                        is RelayFrame.Disconnect ->
                            events.trySend(RelayPairEvent.Closed(wsCode = 1000, reason = "disconnect:${frame.reason}"))

                        else -> Unit // register_pairing/heartbeat 等：配对流无关帧，静默
                    }
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
                is Step.Succeeded -> Outcome.Success(
                    deviceId = step.credentials.deviceId,
                    token = step.credentials.deviceToken,
                    tokenVersion = step.credentials.tokenVersion,
                    heartbeatSec = step.credentials.heartbeatSec,
                    relayHost = endpoint.host,
                )

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
