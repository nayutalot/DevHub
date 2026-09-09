package com.devhub.mobile.connect

import com.devhub.mobile.core.relay.RelayAckVerdict
import com.devhub.mobile.core.relay.RelayCommandClassifier

/**
 * M3-E1 spawn_session 提交判定（docs/18 §5.3/§3.9/§3.10；纯逻辑，ConnectionManager
 * 消费、:app 单测面——与 RelayCommandClassifier 同一命名域，绝不另造语义）：
 * - phase：ack 分类（accepted → 等终态；queued:true/未知 → 排队挂起；rejected → 失败）；
 * - fromResult：command_result 终态 → 提交结果（executed 带 sessionId>0 = Executed；
 *   executed 无会话 id = AcceptedNoSession；其余按 errorCode 结构化拒绝，绝不猜成功）。
 */
object ManagedSpawnOutcome {
    enum class Phase { AWAIT_RESULT, QUEUED, FAILED }

    fun phaseFromAck(status: String, queued: Boolean): Phase = when (
        RelayCommandClassifier.classifyAck(status, queued)
    ) {
        RelayAckVerdict.ACCEPTED -> Phase.AWAIT_RESULT
        RelayAckVerdict.QUEUED_HOLD, RelayAckVerdict.RETRY -> Phase.QUEUED
        RelayAckVerdict.REJECTED_DROP -> Phase.FAILED
    }

    fun fromResult(status: String, sessionId: Long?, commandId: String, errorCode: String?): ManagedSpawnSubmit = when {
        status == "executed" && (sessionId ?: 0L) > 0 ->
            ManagedSpawnSubmit.Executed(sessionId ?: 0L, commandId)

        status == "executed" ->
            ManagedSpawnSubmit.AcceptedNoSession(commandId, status)

        else ->
            ManagedSpawnSubmit.Rejected(
                errorCode ?: "COMMAND_REJECTED",
                errorCode?.let { "命令被拒绝 [$it]" } ?: "命令被拒绝",
            )
    }
}
