package com.devhub.mobile.connect

import com.devhub.mobile.core.InteractionHonesty
import com.devhub.mobile.core.QueueReplayPlanner
import com.devhub.mobile.core.QueuedCommand
import com.devhub.mobile.core.relay.RelayActions
import com.devhub.mobile.core.relay.SelfRevokeFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M3-E1（docs/18 §5.3，用户裁决 2026-09-07 #9=B）：App relay 命令面分支单测——
 * spawn 面板 relay 分支（ManagedSpawnOutcome 判定 + 文案分叉）与自撤销 relay 分支
 * （SelfRevokeFlow 收口状态机 + kind 路由）。local REST 分支零改动回归由既有
 * QueueReplayPlannerTest / RelayCodecFixtureTest 等覆盖。
 */
class SelfManageSubmitTest {

    // ---- spawn 面板 relay 分支：ack 分类（ManagedSpawnOutcome 与 classifier 同命名域） ----

    @Test
    fun `spawn ack accepted without queued flag awaits the terminal result`() {
        assertEquals(ManagedSpawnOutcome.Phase.AWAIT_RESULT, ManagedSpawnOutcome.phaseFromAck("accepted", queued = false))
    }

    @Test
    fun `spawn ack queued or unknown holds the row for replay`() {
        assertEquals(ManagedSpawnOutcome.Phase.QUEUED, ManagedSpawnOutcome.phaseFromAck("accepted", queued = true))
        assertEquals(ManagedSpawnOutcome.Phase.QUEUED, ManagedSpawnOutcome.phaseFromAck("maybe", queued = false))
    }

    @Test
    fun `spawn ack rejected folds to failure`() {
        assertEquals(ManagedSpawnOutcome.Phase.FAILED, ManagedSpawnOutcome.phaseFromAck("rejected", queued = false))
    }

    // ---- spawn 面板 relay 分支：command_result 终态投影 ----

    @Test
    fun `executed result with session id resolves to Executed`() {
        val r = ManagedSpawnOutcome.fromResult("executed", 337, "cmd-1", null)
        assertEquals(ManagedSpawnSubmit.Executed(337, "cmd-1"), r)
    }

    @Test
    fun `executed result without session id stays honest as AcceptedNoSession`() {
        val r = ManagedSpawnOutcome.fromResult("executed", null, "cmd-2", null)
        assertEquals(ManagedSpawnSubmit.AcceptedNoSession("cmd-2", "executed"), r)
    }

    @Test
    fun `rejected result surfaces the structured error code (incl SPAWN_REJECTED)`() {
        val r = ManagedSpawnOutcome.fromResult("rejected", null, "cmd-3", "SPAWN_REJECTED")
        assertEquals(ManagedSpawnSubmit.Rejected("SPAWN_REJECTED", "命令被拒绝 [SPAWN_REJECTED]"), r)
        // UI 文案分叉（UX-P1 H19）：SPAWN_REJECTED 点名对话通道/上限原因，原码收技术细节，绝不吞码
        val presentable = InteractionHonesty.spawnRejection((r as ManagedSpawnSubmit.Rejected).code, r.message)
        assertTrue(presentable.headline.contains("上限"))
        assertTrue(presentable.technical!!.contains("SPAWN_REJECTED"))
    }

    // ---- 自撤销 relay 分支：收口状态机（成功 = disconnect(revoked)，非 command_result） ----

    @Test
    fun `self revoke awaits closure after accepted ack and never trusts other codes`() {
        assertEquals(SelfRevokeFlow.Step.AWAIT_CLOSURE, SelfRevokeFlow.onAck("accepted", queued = false))
        assertEquals(SelfRevokeFlow.Step.QUEUED_HOLD, SelfRevokeFlow.onAck("accepted", queued = true))
        assertTrue(SelfRevokeFlow.isClosure("DEVICE_REVOKED"))
        assertTrue(!SelfRevokeFlow.isClosure("AUTH_INVALID_TOKEN"))
    }

    // ---- 离线队列 kind 路由（M3-E1 两值入队面/出队面按模式分派） ----

    @Test
    fun `self-management kinds join the replay whitelist and map to relay actions`() {
        assertEquals("spawn_session", RelayActions.fromKind(QueueReplayPlanner.KIND_SPAWN_SESSION))
        assertEquals("revoke_device", RelayActions.fromKind(QueueReplayPlanner.KIND_REVOKE_DEVICE))
        assertNull(RelayActions.fromKind("exec"))
        val batch = QueueReplayPlanner.nextBatch(
            listOf(
                QueuedCommand(id = 1, kind = QueueReplayPlanner.KIND_SPAWN_SESSION, sessionId = 0, idempotencyKey = "k1", createdAtMs = 1),
                QueuedCommand(id = 2, kind = QueueReplayPlanner.KIND_REVOKE_DEVICE, sessionId = 0, idempotencyKey = "k2", createdAtMs = 2),
            ),
        )
        assertEquals(2, batch.size)
    }
}
