package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 事件 → 通知映射（docs/11 §7）：waiting_input 两种 status 均通知；
 * status_changed 仅 to ∈ {completed, failed} 通知；summary 脱敏直显。
 */
class EventNotificationMapperTest {

    @Test
    fun `waiting_input payload status notifies`() {
        val n = EventNotificationMapper.decide(
            eventType = "session.waiting_input",
            payloadStatus = "waiting_input",
            statusChangedTo = null,
            summary = "等待用户输入：请确认下一步操作",
            sessionTitle = "重构登录模块",
            sessionId = 315,
        )
        assertEquals("DevHub：等待你的输入", n!!.title)
        assertEquals("等待用户输入：请确认下一步操作", n.body) // summary 直显
        assertEquals(315L, n.sessionId)
    }

    @Test
    fun `approval_required payload status also notifies`() {
        val n = EventNotificationMapper.decide(
            eventType = "session.waiting_input",
            payloadStatus = "approval_required",
            statusChangedTo = null,
            summary = "工具执行待批准",
            sessionTitle = null,
            sessionId = 7,
        )
        assertEquals("DevHub：请求你批准一个操作", n!!.title)
        assertEquals(7L, n.sessionId)
    }

    @Test
    fun `waiting_input with unexpected payload status stays silent`() {
        val n = EventNotificationMapper.decide(
            eventType = "session.waiting_input",
            payloadStatus = "running",
            statusChangedTo = null,
            summary = "x",
            sessionTitle = null,
            sessionId = 1,
        )
        assertNull(n)
    }

    @Test
    fun `status_changed to completed and failed notify`() {
        for (to in listOf("completed", "failed")) {
            val n = EventNotificationMapper.decide(
                eventType = "session.status_changed",
                payloadStatus = null,
                statusChangedTo = to,
                summary = null,
                sessionTitle = "任务 A",
                sessionId = 9,
            )
            val expectedLabel = if (to == "completed") "任务已完成" else "任务已失败"
            assertEquals("DevHub：$expectedLabel", n!!.title)
            assertEquals("任务 A $expectedLabel", n.body) // summary 缺省时兜底文案
        }
    }

    @Test
    fun `status_changed to non terminal stays silent`() {
        for (to in listOf("running", "paused", "waiting_input", "connection_lost", "unknown")) {
            val n = EventNotificationMapper.decide(
                eventType = "session.status_changed",
                payloadStatus = null,
                statusChangedTo = to,
                summary = "x",
                sessionTitle = null,
                sessionId = 1,
            )
            assertNull("to=$to should not notify", n)
        }
    }

    @Test
    fun `other event types never notify`() {
        for (type in listOf("session.started", "session.finished", "provider.health_changed", "command.result")) {
            val n = EventNotificationMapper.decide(
                eventType = type,
                payloadStatus = "waiting_input",
                statusChangedTo = "failed",
                summary = "x",
                sessionTitle = null,
                sessionId = 1,
            )
            assertNull("type=$type should not notify", n)
        }
    }

    @Test
    fun `blank summary falls back to subject plus label`() {
        val n = EventNotificationMapper.decide(
            eventType = "session.waiting_input",
            payloadStatus = "waiting_input",
            statusChangedTo = null,
            summary = "",
            sessionTitle = null,
            sessionId = 42,
        )
        assertEquals("对话 #42 等待你的输入", n!!.body)
    }
}
