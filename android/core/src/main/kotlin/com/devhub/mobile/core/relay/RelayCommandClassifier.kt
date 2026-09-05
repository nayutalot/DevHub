package com.devhub.mobile.core.relay

/**
 * command_ack / error 帧补发判定（docs/18 §3.8/§3.9 + 偏离单⑤，M2-R3 Block 4 纯逻辑面）。
 *
 * 偏离⑤（R2 裁定）：离线 `command_ack{status:'accepted', queued:true}` → **挂起重试**：
 * ECS 已持久排队（内存帧 + 状态行，重启由设备同 key 补发恢复），App 端保留队列行并暂停
 * 补发轮，直到 upstream 恢复 connected（hello/heartbeat 信标翻转）再续跑——同 key 重发
 * 幂等（ECS 以 (deviceId, idempotencyKey) 去重，Windows 同 key 幂等兜底）。
 */
enum class RelayAckVerdict {
    /** 受理且已送达 Windows（accepted 且非 queued）：等价 REST 202 → 出队。 */
    ACCEPTED,

    /** ECS 排队受理（queued:true）：保留队列行 + 挂起重试（upstream 恢复后按同 key 续发）。 */
    QUEUED_HOLD,

    /** 结构化拒绝（rejected + errorCode）：落败保留供 UI 展示，不阻塞后续指令。 */
    REJECTED_DROP,

    /** 未知 status / 连接层异常：不猜语义，保留队列行待重试。 */
    RETRY,
}

object RelayCommandClassifier {
    fun classifyAck(status: String, queued: Boolean): RelayAckVerdict = when {
        status == "accepted" && !queued -> RelayAckVerdict.ACCEPTED
        status == "accepted" && queued -> RelayAckVerdict.QUEUED_HOLD
        status == "rejected" -> RelayAckVerdict.REJECTED_DROP
        else -> RelayAckVerdict.RETRY // 绝不猜：未知枚举值不当作成功
    }

    /**
     * error 帧（requestId 关联的补发期错误）分类：retryable/限流/排队满 → 留队重试；
     * 结构化确定性拒绝 → 落败。与 REST 面 QueueReplayPlanner.classify 同一状态机家族。
     */
    fun classifyError(code: String, retryable: Boolean): RelayAckVerdict = when {
        retryable -> RelayAckVerdict.RETRY
        code == "RELAY_QUEUE_FULL" -> RelayAckVerdict.RETRY // 暂时性（上限窗口），留队慢速重试
        code in setOf(
            "AGENT_CAPABILITY_MISSING",
            "COMMAND_NOT_EXECUTABLE",
            "COMMAND_KEY_CONFLICT",
            "COMMAND_EXPIRED",
            "NOT_FOUND",
            "BAD_PAYLOAD",
        ) -> RelayAckVerdict.REJECTED_DROP

        else -> RelayAckVerdict.RETRY // 兜底：不猜 → 保留待重试
    }
}

/** command 帧的 action 值域（docs/18 §5.1 五值锁死；reply ≡ send_message 改名映射）。 */
object RelayActions {
    const val SEND_MESSAGE = "send_message"
    const val APPROVE = "approve"
    const val PAUSE = "pause"
    const val RESUME = "resume"
    const val INTERRUPT = "interrupt"

    val ALL = setOf(SEND_MESSAGE, APPROVE, PAUSE, RESUME, INTERRUPT)

    /** 队列 kind（docs/14 命名域）→ relay action（docs/18 命名域）。 */
    fun fromKind(kind: String): String? = when (kind) {
        "reply" -> SEND_MESSAGE
        "pause" -> PAUSE
        "resume" -> RESUME
        "approve" -> APPROVE
        "interrupt" -> INTERRUPT
        else -> null
    }
}
