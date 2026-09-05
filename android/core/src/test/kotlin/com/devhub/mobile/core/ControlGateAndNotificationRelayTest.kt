package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M2-R3 门控与通知分叉（docs/18 §4.2/§5.1、docs/19 §7.3）：
 * approve/interrupt 门控路径（能力恒空 → 按钮恒不显示）+ requiresUserAction 文案分叉。
 */
class ControlGateAndNotificationRelayTest {

    // ---- ControlGate：approve/interrupt 门控路径 ----

    @Test
    fun `relay granted without approve never shows the approve button`() {
        // fixture agent_list granted = ["reply","pause","resume"]——当前协议面 approve 恒缺
        val caps = ControlGate.CapabilitySnapshot(mode = "managed", granted = setOf("reply", "pause", "resume"))
        val v = ControlGate.visibleControls(caps, sessionMode = "managed")
        assertTrue(v.reply)
        assertTrue(v.pause)
        assertTrue(v.resume)
        assertFalse(v.approve)
        assertFalse(v.interrupt)
    }

    @Test
    fun `approve interrupt path is data driven only`() {
        // 门控代码路径本身正确：若未来 granted 真实含 approve/interrupt（判定源+执行通道双验证
        // 且经主控复核），按钮才会出现——当前协议恒不授予（docs/18 §5.1 风险声明）。
        val caps = ControlGate.CapabilitySnapshot(mode = "managed", granted = setOf("approve", "interrupt"))
        val v = ControlGate.visibleControls(caps, sessionMode = "managed")
        assertTrue(v.approve)
        assertTrue(v.interrupt)
        assertFalse(v.reply) // 未授予的动作各自独立判定
    }

    @Test
    fun `observed sessions keep zero controls including approve`() {
        val caps = ControlGate.CapabilitySnapshot(mode = "managed", granted = setOf("approve", "interrupt"))
        val v = ControlGate.visibleControls(caps, sessionMode = "observed")
        assertFalse(v.approve)
        assertFalse(v.interrupt)
        assertFalse(v.reply)
    }

    // ---- EventNotificationMapper：requiresUserAction 分叉（docs/19 §7.3） ----

    @Test
    fun `waiting input status keeps waiting-for-input label`() {
        val n = EventNotificationMapper.decide(
            eventType = "session.waiting_input",
            payloadStatus = "waiting_input",
            statusChangedTo = null,
            summary = "摘要（脱敏）",
            sessionTitle = "修复 relay 编解码",
            sessionId = 337L,
            requiresUserAction = true,
        )
        assertEquals("DevHub：等待你的输入", n?.title)
        assertTrue(n?.requiresUserAction == true)
    }

    @Test
    fun `approval required status keeps waiting-for-approval label`() {
        val n = EventNotificationMapper.decide(
            eventType = "session.waiting_input",
            payloadStatus = "approval_required",
            statusChangedTo = null,
            summary = null,
            sessionTitle = null,
            sessionId = 337L,
            requiresUserAction = true,
        )
        assertEquals("DevHub：等待工具批准", n?.title)
    }

    @Test
    fun `requiresUserAction without payload status degrades to generic waiting label`() {
        // relay 帧 requiresUserAction=true 但 payload 缺 status（缓存降级投影可能缺字段）——
        // 通用「等待你的处理」，绝不猜具体哪种等待。
        val n = EventNotificationMapper.decide(
            eventType = "session.waiting_input",
            payloadStatus = null,
            statusChangedTo = null,
            summary = "摘要（脱敏）",
            sessionTitle = null,
            sessionId = 337L,
            requiresUserAction = true,
        )
        assertEquals("DevHub：等待你的处理", n?.title)
    }

    @Test
    fun `local mode frames without the flag keep legacy behavior`() {
        // requiresUserAction 未提供（null）= local 帧路径：缺 status 不产生通知（现状不回归）
        assertNull(
            EventNotificationMapper.decide(
                eventType = "session.waiting_input",
                payloadStatus = null,
                statusChangedTo = null,
                summary = "摘要",
                sessionTitle = null,
                sessionId = 1L,
            ),
        )
    }

    @Test
    fun `status_changed terminal notifications ignore requiresUserAction for label`() {
        val n = EventNotificationMapper.decide(
            eventType = "session.status_changed",
            payloadStatus = null,
            statusChangedTo = "failed",
            summary = "摘要",
            sessionTitle = "会话甲",
            sessionId = 5L,
            requiresUserAction = false,
        )
        assertEquals("DevHub：会话已失败", n?.title)
        assertFalse(n?.requiresUserAction == true)
    }
}
