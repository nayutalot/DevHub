package com.devhub.mobile.core.relay

/**
 * relay 模式 WS 裸连接配对流状态机（M3-C3a 修 1，C2 #1；docs/18 §2/§3.2/§3.3/§8.2，
 * docs/19 §7.1「UI 复用现 Pairing 页，仅传输层换」）。
 *
 * 协议时序（docs/18 §2 未配对例外）：
 * 1. 无 Authorization 裸连接 `wss://<relay>/relay/device`（首帧必须为 `pair` 且 10s 内发出，
 *    否则服务端 close(1000, "pair required")）；
 * 2. E→D 服务端首帧 `hello`（裸 pair 连接 deviceId 缺省）；
 * 3. D→E 发 `pair{requestId, code, deviceName, platform:'android', clientVersion}`（§3.2
 *    设备视图——pairingId 不由设备发送，属 E→H 中继变体字段，偏离②容忍解析）；
 * 4. E→D `pair_accepted{requestId, deviceId, deviceToken, tokenVersion, heartbeatSec}`（§3.3
 *    设备视图；deviceToken 明文唯一两次过境之一，红线受控面）；
 * 5. 失败路径 → E→D `error{requestId, code, message}`（码域 §8.2：PAIRING_INVALID_CODE /
 *    PAIRING_CODE_EXPIRED / PAIRING_CODE_VOIDED / AUTH_RATE_LIMITED / RELAY_UPSTREAM_OFFLINE…）。
 *
 * 纯逻辑落 :core（零 Android 依赖）：传输（OkHttp WS、计时器）由 app 层驱动——传输层把
 * 收到的帧/超时/关闭翻译成 [RelayPairEvent] 喂进状态机，机器产出 [RelayPairStep]（发帧 /
 * 成功凭据 / 结构化失败）。绝不猜：非法迁移按结构化失败落地，绝不静默吞帧。
 */
class RelayPairingMachine(
    code: String,
    private val deviceName: String,
    private val platform: String = "android",
    clientVersion: String? = null,
) {

    /** 配对全程唯一 requestId（pair / pair_accepted 关联；docs/18 §3.2）。 */
    val requestId: String = java.util.UUID.randomUUID().toString()

    /** D→E pair 帧（构造期一次性成形；复用 RelayFrame.Pair codec 编码）。 */
    val pairRequestJson: String = RelayCodec.encode(
        RelayFrame.Pair(
            requestId = requestId,
            code = code,
            deviceName = deviceName,
            platform = platform,
            clientVersion = clientVersion,
        ),
    )

    var state: State = State.AwaitingHello
        private set

    /** 状态面：等 hello → 已发 pair 等 pair_accepted → 终态（成功/失败）。 */
    enum class State { AwaitingHello, AwaitingPairAccepted, Succeeded, Failed }

    /** 配对成功凭据（SecureStore 落库前仅在内存一次性存在；零日志红线适用）。 */
    data class Credentials(
        val requestId: String,
        val deviceId: Long,
        val deviceToken: String,
        val tokenVersion: Int,
        val heartbeatSec: Int?,
    )

    /**
     * 结构化失败（code 优先取协议帧错误码 §8.2；传输层失败用本机码
     * RELAY_PAIR_TIMEOUT / RELAY_UNREACHABLE / BAD_PAYLOAD）。
     */
    data class Failure(val code: String, val message: String)

    /**
     * 事件入口。返回值语义：
     * - [Step.SendPair]：hello 已收，传输层应立即发送 [pairRequestJson]；
     * - [Step.Succeeded]：配对成功（凭据在 [Credentials]，UI 落 SecureStore 后以新 token 重连）；
     * - [Step.Failed]：终态失败（结构化文案已按 §8.2 映射，UI 直显）；
     * - null：帧已消化（如未知类型静默），状态不变。
     * 终态后任何事件一律 null（幂等，绝不二次转移）。
     */
    fun onEvent(event: RelayPairEvent): Step? {
        when (state) {
            State.Succeeded, State.Failed -> return null
            State.AwaitingHello -> return onAwaitingHello(event)
            State.AwaitingPairAccepted -> return onAwaitingAccepted(event)
        }
    }

    private fun onAwaitingHello(event: RelayPairEvent): Step? = when (event) {
        is RelayPairEvent.Hello -> {
            state = State.AwaitingPairAccepted
            Step.SendPair
        }

        // hello 未到即 error：连接级错误（§3.16 requestId 可省）——按码映射直落失败
        is RelayPairEvent.Error -> failMapped(event.code, event.message)

        is RelayPairEvent.Timeout -> failDirect(
            "RELAY_PAIR_TIMEOUT",
            "配对超时：Relay 10s 内未发 hello（裸连接超时）——确认 Relay 地址可达后重试 [RELAY_PAIR_TIMEOUT]",
        )

        is RelayPairEvent.Closed -> failDirect(
            "RELAY_UPSTREAM_OFFLINE",
            "Relay 连接在收到 pair 应答前中断/关闭（ws close ${event.wsCode} ${event.reason}）[RELAY_PAIR_CLOSED_EARLY]",
        )

        is RelayPairEvent.PairAccepted ->
            failDirect("BAD_PAYLOAD", "协议违例：hello 之前收到 pair_accepted [BAD_PAYLOAD]")
    }

    private fun onAwaitingAccepted(event: RelayPairEvent): Step? = when (event) {
        is RelayPairEvent.PairAccepted -> {
            state = State.Succeeded
            Step.Succeeded(
                Credentials(
                    requestId = event.frame.requestId ?: requestId,
                    deviceId = event.frame.deviceId,
                    deviceToken = event.frame.deviceToken,
                    tokenVersion = event.frame.tokenVersion,
                    heartbeatSec = event.frame.heartbeatSec,
                ),
            )
        }

        is RelayPairEvent.Error -> failMapped(event.code, event.message)

        is RelayPairEvent.Timeout -> failDirect(
            "RELAY_UPSTREAM_TIMEOUT",
            "配对超时：电脑端未在 10s 内应答 pair（RELAY_UPSTREAM_TIMEOUT）——确认桌面 DevHub 在线后重试",
        )

        is RelayPairEvent.Closed -> failDirect(
            "RELAY_UPSTREAM_OFFLINE",
            "Relay 连接在收到 pair 应答前中断/关闭（ws close ${event.wsCode} ${event.reason}）[RELAY_PAIR_CLOSED_MIDWAY]",
        )

        // 重复 hello：容忍（保活态帧），状态不变继续等
        is RelayPairEvent.Hello -> null
    }

    /**
     * error 帧 → §8.2 码域结构化文案（docs/18 §8.2；本地 claim 同码域语义上移）。
     * 仅协议 error 帧走此映射；传输层失败（超时/关闭）用 [failDirect] 保留现场细节。
     */
    private fun failMapped(code: String?, message: String?): Step.Failed {
        state = State.Failed
        return Step.Failed(RelayPairing.failureMessage(code, message))
    }

    /** 传输层失败：code 与文案均由状态机成形（含现场细节），不经 §8.2 重写。 */
    private fun failDirect(code: String, message: String): Step.Failed {
        state = State.Failed
        return Step.Failed(RelayPairingMachine.Failure(code, message))
    }

    sealed interface Step {
        /** hello 已收：发送 pair 帧（[RelayPairingMachine.pairRequestJson]）。 */
        data object SendPair : Step

        data class Succeeded(val credentials: Credentials) : Step

        data class Failed(val failure: Failure) : Step
    }
}

/** 传输层 → 状态机事件（帧/超时/关闭的三类翻译）。 */
sealed class RelayPairEvent {
    /** E→D hello（RelayCodec.parse 产物）。 */
    data class Hello(val frame: RelayFrame.Hello) : RelayPairEvent()

    /** E→D pair_accepted。 */
    data class PairAccepted(val frame: RelayFrame.PairAccepted) : RelayPairEvent()

    /** E→D error 帧（code/message/retryable 按 §3.16）。 */
    data class Error(val code: String?, val message: String?, val retryable: Boolean = false) : RelayPairEvent() {
        constructor(frame: RelayFrame.Error) : this(frame.code, frame.message, frame.retryable)
    }

    /** 阶段超时（hello 等待 / pair 应答等待各 10s；docs/18 §2 + M3-C3a brief）。 */
    data object Timeout : RelayPairEvent()

    /** WS 关闭（含服务端 close(1000,"pair required") 等）。 */
    data class Closed(val wsCode: Int, val reason: String) : RelayPairEvent()
}

/**
 * §8.2 码域 → 用户可读结构化文案（配对面失败码全表；未知码兜底透传 message）。
 * UX-P1（docs/25 X10）：保留人话头；「[$code]」尾注退役——原码由 [RelayPairingMachine.Failure.code]
 * 结构化承载（UI「技术细节」折叠区可达，翻译不删除）；TTL/gateway_enabled/upstream/Relay
 * 等工程词随行人话化（云端连接定名，主控裁决）。
 */
object RelayPairing {
    fun failureMessage(code: String?, message: String?): RelayPairingMachine.Failure {
        val m = message?.takeIf { it.isNotBlank() }
        return when (code) {
            "PAIRING_INVALID_CODE" ->
                RelayPairingMachine.Failure(code, "配对失败：码不存在或不正确（计入失败 5 次作废）——请在电脑上重新生成")

            "PAIRING_CODE_EXPIRED" ->
                RelayPairingMachine.Failure(code, "配对失败：码已过期（5 分钟内有效），请在电脑上重新生成")

            "PAIRING_CODE_VOIDED" ->
                RelayPairingMachine.Failure(code, "配对失败：码已作废（失败次数过多或已被新码废止），请在电脑上重新生成")

            "AUTH_RATE_LIMITED" ->
                RelayPairingMachine.Failure(code, "尝试过于频繁（5 次/5 分钟），请稍后重试")

            "RELAY_UPSTREAM_OFFLINE" ->
                RelayPairingMachine.Failure(
                    code,
                    "云端连接已连上，但电脑不在线——请确认电脑上的 DevHub 在线后重试",
                )

            "RELAY_UPSTREAM_TIMEOUT" ->
                RelayPairingMachine.Failure(code, "电脑应答超时——请确认电脑上的 DevHub 在线后重试")

            "GATEWAY_DISABLED" ->
                RelayPairingMachine.Failure(code, "电脑上的 DevHub 没有打开「允许手机连接」开关，请到电脑端设置打开后重试")

            "DEVICE_REVOKED", "AUTH_INVALID_TOKEN" ->
                RelayPairingMachine.Failure(code, "设备凭据被拒绝：请重新配对")

            null ->
                RelayPairingMachine.Failure("RELAY_PAIR_FAILED", "配对失败：${m ?: "连接未完成，请重试"}")

            else ->
                RelayPairingMachine.Failure(code, "配对失败：${m ?: "（无详细信息）"}")
        }
    }
}
