package com.devhub.mobile.core

/**
 * WS 事件帧 → 系统通知的映射（docs/11 §7 通知触发条件 / docs/12 §6 语义 6）。
 *
 * 通知触发（唯一两族）：
 * - `session.waiting_input` 且 payload.status ∈ {waiting_input, approval_required}
 *   （两种 status 均通知，且徽标语义区分：等文本输入 vs 等工具批准）；
 * - `session.status_changed` 且 payload.to ∈ {completed, failed}。
 * 其余事件静默：照常参与 sync/ack 序列，但不产生系统通知。
 *
 * 红线（docs/15 §6）：通知正文 = 服务端脱敏 summary 直显（App 绝不拼接未脱敏的
 * 上下文；完整内容点进会话详情才按需加载）。
 */
data class EventNotification(
    val title: String,
    val body: String,
    val sessionId: Long?,
    /** M2-R3（docs/18 §4.2 / docs/19 §7.3）：relay 事件帧显式白名单布尔，通知文案分叉维度。 */
    val requiresUserAction: Boolean = false,
)

object EventNotificationMapper {
    const val EVENT_WAITING_INPUT = "session.waiting_input"
    const val EVENT_STATUS_CHANGED = "session.status_changed"

    // UX-P1（docs/25 N5-N7）：「等待你的输入」终稿锁定；N6/N7 人话化（语义不变）。
    private val waitingLabels = mapOf(
        "waiting_input" to "等待你的输入",
        "approval_required" to "请求你批准一个操作",
    )
    private val terminalLabels = mapOf(
        "completed" to "任务已完成",
        "failed" to "任务已失败",
    )

    /**
     * @param eventType    WS 事件帧 eventType（local=docs/14；relay=docs/18 §4.1 投影后同名）
     * @param payloadStatus session.waiting_input 的 payload.status（两值）
     * @param statusChangedTo session.status_changed 的 payload.to
     * @param summary      服务端脱敏摘要（直显；可为 null）
     * @param sessionTitle 会话标题（仅用于标题行拼装，可为 null）
     * @param sessionId    会话 id（通知点击 deep link 目标）
     * @param requiresUserAction relay 帧显式布尔（docs/18 §4.2 白名单投影；null = local 帧/未提供）。
     *   分叉规则：true 且 waiting_input 族缺 status → 通用「等待你的处理」；true 且 status 可辨
     *   → 沿用两值文案（等待输入/等待批准）；false/not provided → 不改变既有判定。
     * @return null = 不通知
     */
    fun decide(
        eventType: String,
        payloadStatus: String?,
        statusChangedTo: String?,
        summary: String?,
        sessionTitle: String?,
        sessionId: Long?,
        requiresUserAction: Boolean? = null,
    ): EventNotification? {
        val label = when (eventType) {
            EVENT_WAITING_INPUT -> payloadStatus?.let { waitingLabels[it] }
                ?: if (requiresUserAction == true) "等待你的处理" else null

            EVENT_STATUS_CHANGED -> statusChangedTo?.let { terminalLabels[it] }
            else -> null
        } ?: return null
        val subject = sessionTitle?.takeIf { it.isNotBlank() } ?: (sessionId?.let { "对话 #$it" } ?: "对话") // UX-P1（会话→对话随行）
        val title = "DevHub：$label"
        val body = summary?.takeIf { it.isNotBlank() } ?: (subject + " " + label)
        return EventNotification(
            title = title,
            body = body,
            sessionId = sessionId,
            requiresUserAction = requiresUserAction == true,
        )
    }
}
