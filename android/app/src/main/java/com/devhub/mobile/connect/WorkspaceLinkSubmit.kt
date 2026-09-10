package com.devhub.mobile.connect

import com.devhub.mobile.core.relay.RelayAckVerdict
import com.devhub.mobile.core.relay.RelayCommandClassifier
import org.json.JSONObject

/**
 * S 批 workspace_link 提交结果（docs/18 §5.3 注记；relay 面专用——local 面无此命令）。
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
 * - timeout()：终态 10s 未回（docs/18 §3.0 #8 同窗）→ 行入队同 key 补发 → Queued；
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

    fun fromResult(status: String, result: JSONObject?, errorCode: String?): WorkspaceLinkSubmit = when {
        status == "executed" && result != null && !result.optString("url").isBlank() ->
            WorkspaceLinkSubmit.Executed(
                url = result.optString("url"),
                provider = result.optString("provider").ifBlank { "zcode" },
                deviceName = result.optString("deviceName").takeIf { it.isNotBlank() },
            )

        status == "executed" ->
            // executed 却无 url：投影不完整——结构化失败，绝不猜（绝不造 URL）
            WorkspaceLinkSubmit.Failed("BAD_PAYLOAD", "workspace_link 终态缺少链接载荷")

        else ->
            WorkspaceLinkSubmit.Failed(
                errorCode ?: "COMMAND_REJECTED",
                when (errorCode) {
                    "ZCODE_LINK_UNAVAILABLE" -> "桌面暂无法获取 ZCode 工作区链接（ZCode 未运行或凭据不可读）"
                    else -> errorCode?.let { "命令被拒绝 [$it]" } ?: "命令被拒绝"
                },
            )
    }
}
