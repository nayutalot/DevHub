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

/**
 * command 帧的 action 值域（docs/18 §5.1 五值 + §5.3 设备自管理两值 + S 批查询一值
 * 锁死；reply ≡ send_message 改名映射；N-R3 纪律：白名单封闭枚举，未知值绝不猜）。
 */
object RelayActions {
    const val SEND_MESSAGE = "send_message"
    const val APPROVE = "approve"
    const val PAUSE = "pause"
    const val RESUME = "resume"
    const val INTERRUPT = "interrupt"

    /** docs/18 §5.3（M3-E，用户裁决 2026-09-07 #9=B）：managed spawn / 设备自撤销。 */
    const val SPAWN_SESSION = "spawn_session"
    const val REVOKE_DEVICE = "revoke_device"

    /** docs/18 §5.3 注记（S 批）：ZCode 工作区链接查询（payload {}；拉取模型）。 */
    const val WORKSPACE_LINK = "workspace_link"

    val ALL = setOf(SEND_MESSAGE, APPROVE, PAUSE, RESUME, INTERRUPT, SPAWN_SESSION, REVOKE_DEVICE, WORKSPACE_LINK)

    /** 队列 kind（docs/14 命名域）→ relay action（docs/18 命名域）。 */
    fun fromKind(kind: String): String? = when (kind) {
        "reply" -> SEND_MESSAGE
        "pause" -> PAUSE
        "resume" -> RESUME
        "approve" -> APPROVE
        "interrupt" -> INTERRUPT
        "spawn_session" -> SPAWN_SESSION
        "revoke_device" -> REVOKE_DEVICE
        "workspace_link" -> WORKSPACE_LINK
        else -> null
    }
}

/**
 * revoke_device 自撤销收口状态机（M3-E1，docs/18 §5.3/§3.15；纯逻辑供 ConnectionManager
 * 与单测共用）。收口语义：**成功 = disconnect(reason=revoked) 到达（onAuthFatal 清凭据、
 * 停重连），而非 command_result**；accepted(queued:true) = ECS 排队挂起（主机上线后
 * 自动完成，同 key 幂等兜底）。
 */
object SelfRevokeFlow {
    enum class Step {
        /** 已发出 command，等 command_ack。 */
        AWAIT_ACK,

        /** ack accepted（host 已见）→ 等 disconnect(revoked) 收口。 */
        AWAIT_CLOSURE,

        /** ack accepted + queued:true（主机离线）→ 行挂起，upstream 恢复后自动续跑。 */
        QUEUED_HOLD,

        /** 收口完成：凭据已清、连接已停（不得自动重连，§3.15）。 */
        DONE_REVOKED,

        /** 结构化拒绝（rejected + errorCode）。 */
        FAILED,
    }

    /** command_ack 分类（accepted 语义与 RelayCommandClassifier.classifyAck 同一命名域）。 */
    fun onAck(status: String, queued: Boolean): Step = when {
        status == "accepted" && !queued -> Step.AWAIT_CLOSURE
        status == "accepted" && queued -> Step.QUEUED_HOLD
        status == "rejected" -> Step.FAILED
        else -> Step.AWAIT_ACK // 绝不猜：未知 status 留在等待，超时由调用方收口
    }

    /** onAuthFatal 错误码 → 收口判定（仅 DEVICE_REVOKED 为撤销收口；其余非本机撤销）。 */
    fun isClosure(code: String): Boolean = code == "DEVICE_REVOKED"
}
