package com.devhub.mobile.connect

import com.devhub.mobile.core.relay.RelayAckVerdict
import com.devhub.mobile.core.relay.RelayCommandClassifier
import org.json.JSONObject

/**
 * S 批 workspace_link 提交结果（docs/18 §5.3 注记；X-L §5.3.2 本地面就位）。
 * 拉取模型：App 需要时取，桌面磁盘实时重建（t=时间戳 nonce），永远新鲜且有效。
 */
sealed class WorkspaceLinkSubmit {
    /** 已取得当前有效链接（url 形态由桌面保证；App 仍走 RemoteWorkspaceUrl.parse 白名单复检）。 */
    data class Executed(val url: String, val provider: String, val deviceName: String?) : WorkspaceLinkSubmit()

    /** queued:true / 离线 / 发送失败（行已入队同 key 补发）→ UI 排队提示照 relay 语义。 */
    data object Queued : WorkspaceLinkSubmit()

    /** 结构化拒绝 / 终态失败（含 ZCODE_LINK_UNAVAILABLE——桌面三文件缺失或解密失败）。 */
    data class Failed(val code: String, val message: String) : WorkspaceLinkSubmit()
}

/**
 * S 批 workspace_link 提交判定（docs/18 §3.9/§3.10；纯逻辑，ConnectionManager 消费、
 * :app 单测面——与 ManagedSpawnOutcome 同一命名域，绝不另造语义）：
 * - phase：ack 分类（accepted → 等终态；queued:true/未知 → 排队挂起；rejected → 失败）；
 * - timeout()：终态 10s 未回（docs/18 §3.0 #8 同窗）→ 行入队同 key 补发 → Queued（relay 面）；
 * - localTimeout()/localNotConnected()：X-L 本地面（docs/18 §5.3.2）——本地**零排队面**，
 *   超时/未连接一律结构化 Failed 如实落卡（绝不入离线队列、绝不假成功；「结构性恒
 *   Queued」失败类整体消灭）；
 * - fromResult：command_result 终态 → 提交结果（executed 且 result.url 非空 = Executed；
 *   executed 无 url = 结构化失败不猜；failed → Failed(errorCode)——ZCODE_LINK_UNAVAILABLE
 *   点名桌面链接不可用）。
 */
object WorkspaceLinkOutcome {
    enum class Phase { AWAIT_RESULT, QUEUED, FAILED }

    fun phaseFromAck(status: String, queued: Boolean): Phase = when (
        RelayCommandClassifier.classifyAck(status, queued)
    ) {
        RelayAckVerdict.ACCEPTED -> Phase.AWAIT_RESULT
        RelayAckVerdict.QUEUED_HOLD, RelayAckVerdict.RETRY -> Phase.QUEUED
        RelayAckVerdict.REJECTED_DROP -> Phase.FAILED
    }

    fun timeout(): WorkspaceLinkSubmit = WorkspaceLinkSubmit.Queued

    /** X-L 本地面（docs/18 §5.3.2）：10s 终态未回 → 结构化超时（本地无补发面，绝不排队）。 */
    fun localTimeout(): WorkspaceLinkSubmit =
        WorkspaceLinkSubmit.Failed("TIMEOUT", "电脑未在时限内返回页面链接（请确认电脑上的 DevHub 正在运行）")

    /** X-L 本地面（docs/18 §5.3.2）：本地网关未连接 → 结构化不可用（绝不排队、绝不伪成功）。 */
    fun localNotConnected(): WorkspaceLinkSubmit =
        WorkspaceLinkSubmit.Failed("NOT_CONNECTED", "还没连上电脑（请确认电脑上的 DevHub 正在运行且设备已配对）")

    fun fromResult(status: String, result: JSONObject?, errorCode: String?): WorkspaceLinkSubmit = when {
        status == "executed" && result != null && !result.optString("url").isBlank() ->
            WorkspaceLinkSubmit.Executed(
                url = result.optString("url"),
                provider = result.optString("provider").ifBlank { "zcode" },
                deviceName = result.optString("deviceName").takeIf { it.isNotBlank() },
            )

        status == "executed" ->
            // executed 却无 url：投影不完整——结构化失败，绝不猜（绝不造 URL）
            WorkspaceLinkSubmit.Failed("BAD_PAYLOAD", "电脑返回的链接数据不完整")

        else ->
            WorkspaceLinkSubmit.Failed(
                errorCode ?: "COMMAND_REJECTED",
                when (errorCode) {
                    "ZCODE_LINK_UNAVAILABLE" -> "电脑暂无法获取 ZCode 页面链接（ZCode 未运行或凭据不可读）"
                    else -> "电脑没接受这个请求"
                },
            )
    }
}
