package com.devhub.mobile.connect

import com.devhub.mobile.core.QueueReplayPlanner
import com.devhub.mobile.core.QueuedCommand
import com.devhub.mobile.core.relay.RelayActions
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * S 批 workspace_link 提交分支单测（docs/18 §5.3 注记；任务书 §2.3）——
 * ack/result 映射 + 超时 + NotConnected 排队语义（ConnectionManager 的
 * WS 帧路径以 WorkspaceLinkOutcome/WorkspaceLinkCard 纯逻辑承载并直锁，
 * 与 SelfManageSubmitTest（M3-E1）同一测试面口径）。链接值全程 fake，
 * 断言只对状态机投影，不对 URL 值。
 */
class WorkspaceLinkSubmitTest {

    // ---- ack 分类（WorkspaceLinkOutcome 与 classifier 同命名域） ----

    @Test
    fun `ack accepted without queued flag awaits the terminal result`() {
        assertEquals(WorkspaceLinkOutcome.Phase.AWAIT_RESULT, WorkspaceLinkOutcome.phaseFromAck("accepted", queued = false))
    }

    @Test
    fun `ack queued or unknown holds the row for replay`() {
        assertEquals(WorkspaceLinkOutcome.Phase.QUEUED, WorkspaceLinkOutcome.phaseFromAck("accepted", queued = true))
        assertEquals(WorkspaceLinkOutcome.Phase.QUEUED, WorkspaceLinkOutcome.phaseFromAck("maybe", queued = false))
    }

    @Test
    fun `ack rejected folds to failure`() {
        assertEquals(WorkspaceLinkOutcome.Phase.FAILED, WorkspaceLinkOutcome.phaseFromAck("rejected", queued = false))
    }

    // ---- 超时（10s 终态未回）→ 排队同 key 补发，绝不伪成功 ----

    @Test
    fun `terminal timeout resolves to Queued`() {
        assertEquals(WorkspaceLinkSubmit.Queued, WorkspaceLinkOutcome.timeout())
    }

    // ---- command_result 终态投影 ----

    @Test
    fun `executed result with url resolves to Executed`() {
        val result = JSONObject().put("provider", "zcode").put("url", "https://example.test/remote/v4?sid=fake").put("deviceName", "desk-1")
        val r = WorkspaceLinkOutcome.fromResult("executed", result, null)
        assertTrue(r is WorkspaceLinkSubmit.Executed)
        r as WorkspaceLinkSubmit.Executed
        assertEquals("zcode", r.provider)
        assertEquals("desk-1", r.deviceName)
    }

    @Test
    fun `executed result without url stays honest as Failed (never guesses a link)`() {
        val r = WorkspaceLinkOutcome.fromResult("executed", JSONObject().put("provider", "zcode"), null)
        assertTrue(r is WorkspaceLinkSubmit.Failed)
        assertEquals("BAD_PAYLOAD", (r as WorkspaceLinkSubmit.Failed).code)
        val noResult = WorkspaceLinkOutcome.fromResult("executed", null, null)
        assertTrue(noResult is WorkspaceLinkSubmit.Failed)
    }

    @Test
    fun `failed result surfaces ZCODE_LINK_UNAVAILABLE with the desktop-unavailable wording`() {
        val r = WorkspaceLinkOutcome.fromResult("failed", null, "ZCODE_LINK_UNAVAILABLE")
        assertTrue(r is WorkspaceLinkSubmit.Failed)
        val f = r as WorkspaceLinkSubmit.Failed
        assertEquals("ZCODE_LINK_UNAVAILABLE", f.code)
        assertTrue(f.message.contains("无法获取") && f.message.contains("ZCode"))
    }

    @Test
    fun `failed result with unknown code keeps the structured code`() {
        val r = WorkspaceLinkOutcome.fromResult("failed", null, "COMMAND_EXPIRED")
        assertEquals("COMMAND_EXPIRED", (r as WorkspaceLinkSubmit.Failed).code)
    }

    // ---- 卡片状态机投影（WorkspaceLinkCard.reduce；URL 白名单复检不豁免桌面来源） ----

    @Test
    fun `reduce maps queued and failed submits directly`() {
        assertEquals(WorkspaceLinkCard.State.Queued, WorkspaceLinkCard.reduce(WorkspaceLinkSubmit.Queued, entryId = null))
        val reduced = WorkspaceLinkCard.reduce(WorkspaceLinkSubmit.Failed("ZCODE_LINK_UNAVAILABLE", "x"), entryId = null)
        assertTrue(reduced is WorkspaceLinkCard.State.Unavailable)
        assertEquals("ZCODE_LINK_UNAVAILABLE", (reduced as WorkspaceLinkCard.State.Unavailable).code)
    }

    @Test
    fun `reduce executed with entry resolves to Ready with entry id`() {
        val submit = WorkspaceLinkSubmit.Executed("https://example.test/remote/v4?sid=fake", "zcode", "desk-1")
        val reduced = WorkspaceLinkCard.reduce(submit, entryId = 7L)
        assertEquals(WorkspaceLinkCard.State.Ready(7L, "desk-1"), reduced)
    }

    @Test
    fun `reduce executed without entry id degrades to Unavailable (never fabricates navigation)`() {
        val submit = WorkspaceLinkSubmit.Executed("https://example.test/remote/v4?sid=fake", "zcode", null)
        val reduced = WorkspaceLinkCard.reduce(submit, entryId = null)
        assertTrue(reduced is WorkspaceLinkCard.State.Unavailable)
    }

    @Test
    fun `reduce executed re-checks the http(s) whitelist on desktop-sourced urls`() {
        // 桌面来源不豁免 App 侧白名单：非 http(s) scheme → 结构化拒绝
        val submit = WorkspaceLinkSubmit.Executed("file:///etc/passwd", "zcode", null)
        val reduced = WorkspaceLinkCard.reduce(submit, entryId = 3L)
        assertTrue(reduced is WorkspaceLinkCard.State.Unavailable)
        assertEquals("BAD_PAYLOAD", (reduced as WorkspaceLinkCard.State.Unavailable).code)
    }

    // ---- 离线队列 kind 路由（S 批八值面：入队白名单 + action 映射） ----

    @Test
    fun `workspace_link kind joins the replay whitelist and maps to the relay action`() {
        assertEquals("workspace_link", RelayActions.fromKind(QueueReplayPlanner.KIND_WORKSPACE_LINK))
        assertEquals(RelayActions.WORKSPACE_LINK, RelayActions.fromKind("workspace_link"))
        assertNull(RelayActions.fromKind("paste_link"))
        val batch = QueueReplayPlanner.nextBatch(
            listOf(
                QueuedCommand(id = 1, kind = QueueReplayPlanner.KIND_WORKSPACE_LINK, sessionId = 0, idempotencyKey = "w1", createdAtMs = 1),
                QueuedCommand(id = 2, kind = "unknown-kind", sessionId = 0, idempotencyKey = "w2", createdAtMs = 2),
            ),
        )
        assertEquals(1, batch.size)
        assertEquals("w1", batch.single().idempotencyKey)
    }

    @Test
    fun `relay action whitelist holds the closed eight-value set`() {
        assertEquals(8, RelayActions.ALL.size)
        assertTrue(RelayActions.ALL.contains(RelayActions.WORKSPACE_LINK))
    }
}
