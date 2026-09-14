package com.devhub.mobile.core.relay

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M3-E1 设备自管理两 action 的 :core 帧面测试（docs/18 §5.3，用户裁决 2026-09-07 #9=B）：
 * - spawn_session / revoke_device 的 command 帧编解码 round-trip（sessionId 缺省帧形）；
 * - revoke 收口状态机（SelfRevokeFlow）+ InteractionHonesty.spawnRejection 文案分叉（headline 人话+原码进技术细节）
 *   （含 SPAWN_REJECTED 新码，docs/18 §8.2 WS 专属）。
 * 帧形零扩展纪律：两 action 只是 §3.8 command 帧的 action 值域追加（§5.3），
 * 编解码面绝无新字段、绝无缺省值伪造（sessionId 缺省 = 帧面不带该字段）。
 */
class RelaySelfMgmtCodecTest {

    private fun command(action: String, sessionId: Long?, payload: String): RelayFrame.Command =
        RelayFrame.Command(
            requestId = "req-m3e1",
            idempotencyKey = "key-m3e1",
            sessionId = sessionId,
            action = action,
            payload = JSONObject(payload),
            token = "e2e-token",
            tsSec = 1_757_000_000,
            nonce = "nonce-m3e1",
            createdAtSec = 1_757_000_000,
        )

    @Test
    fun `spawn_session command round-trips without sessionId (absent on the wire)`() {
        val frame = command(RelayActions.SPAWN_SESSION, sessionId = null, payload = """{"providerId":"7","task":"fixture turn"}""")
        val decoded = RelayCodec.parse(RelayCodec.encode(frame))
        assertTrue(decoded is RelayFrame.Command)
        val cmd = decoded as RelayFrame.Command
        assertEquals(RelayActions.SPAWN_SESSION, cmd.action)
        assertNull("sessionId 缺省帧形：解析侧不得伪造缺省值", cmd.sessionId)
        assertEquals("7", cmd.payload.optString("providerId"))
        assertEquals("fixture turn", cmd.payload.optString("task"))
        assertFalse("sessionId 缺省时帧面绝不写出该字段", RelayCodec.encode(frame).contains("sessionId"))
    }

    @Test
    fun `revoke_device command round-trips with empty payload and no sessionId`() {
        val frame = command(RelayActions.REVOKE_DEVICE, sessionId = null, payload = "{}")
        val decoded = RelayCodec.parse(RelayCodec.encode(frame))
        assertTrue(decoded is RelayFrame.Command)
        val cmd = decoded as RelayFrame.Command
        assertEquals(RelayActions.REVOKE_DEVICE, cmd.action)
        assertNull(cmd.sessionId)
        assertTrue("revoke_device payload = {}（自指无目标，零目标字段承载面）", cmd.payload.length() == 0)
        // 会话级 action 携带 sessionId 的形态不受影响（§5.1 原语义零变化）
        val withSession = RelayCodec.parse(RelayCodec.encode(command(RelayActions.REVOKE_DEVICE, sessionId = 337, payload = "{}")))
        assertEquals(337L, (withSession as RelayFrame.Command).sessionId)
    }

    @Test
    fun `self revoke closure state machine follows ack and disconnect semantics`() {
        assertEquals(SelfRevokeFlow.Step.AWAIT_CLOSURE, SelfRevokeFlow.onAck("accepted", queued = false))
        assertEquals(SelfRevokeFlow.Step.QUEUED_HOLD, SelfRevokeFlow.onAck("accepted", queued = true))
        assertEquals(SelfRevokeFlow.Step.FAILED, SelfRevokeFlow.onAck("rejected", queued = false))
        assertEquals(SelfRevokeFlow.Step.AWAIT_ACK, SelfRevokeFlow.onAck("unknown", queued = false))
        assertTrue(SelfRevokeFlow.isClosure("DEVICE_REVOKED"))
        assertFalse(SelfRevokeFlow.isClosure("AUTH_INVALID_TOKEN"))
    }

    @Test
    fun `spawn rejection forks by error code with human headline and technical code`() {
        // UX-P1 H19：headline 人话（原码退出用户面）；technical 承载原码+原样 raw（绝不吞码）
        val r = com.devhub.mobile.core.InteractionHonesty.spawnRejection("SPAWN_REJECTED", null)
        assertTrue("SPAWN_REJECTED 文案须点名对话通道/上限原因", r.headline.contains("创建失败") && r.headline.contains("上限"))
        assertEquals("[SPAWN_REJECTED]", r.technical)
        assertTrue(
            com.devhub.mobile.core.InteractionHonesty.spawnRejection("COMMAND_NOT_EXECUTABLE", null)
                .headline.contains("暂不支持在手机上开始对话"),
        )
        assertTrue(
            com.devhub.mobile.core.InteractionHonesty.spawnRejection("AGENT_CAPABILITY_MISSING", null)
                .headline.contains("请先在电脑端刷新"),
        )
        // 其余码：通用人话头 + 原码进 technical（绝不吞码）
        val passthrough = com.devhub.mobile.core.InteractionHonesty.spawnRejection("NOT_FOUND", "provider ghost")
        assertTrue(passthrough.headline.contains("创建失败"))
        assertTrue(passthrough.technical!!.contains("NOT_FOUND") && passthrough.technical!!.contains("provider ghost"))
    }
}
