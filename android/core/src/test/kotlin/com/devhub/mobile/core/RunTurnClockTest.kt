package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * UX-Z3 运行态层（docs/28 §6.1）：运行计时器纯函数锁——
 * 开始沿 to:'running' / 停沿五终态；锚点不可考降级「运行中…」不伪造；
 * 停沿冻结实测区间；文案「已工作 X 分 Y 秒」。
 */
class RunTurnClockTest {

    // —— 沿判定 ——

    @Test
    fun `start edge is running only`() {
        assertTrue(RunTurnClock.isStartEdge("running"))
        assertTrue(RunTurnClock.isStartEdge(" RUNNING ")) // 大小写/空白归一同一事实
        assertFalse(RunTurnClock.isStartEdge("waiting_input"))
        assertFalse(RunTurnClock.isStartEdge("approval_required"))
        assertFalse(RunTurnClock.isStartEdge("unknown"))
    }

    @Test
    fun `stop edge is exactly the five terminal values`() {
        for (s in listOf("waiting_input", "completed", "failed", "paused", "connection_lost")) {
            assertTrue(RunTurnClock.isStopEdge(s))
        }
        // approval_required 属运行中等待，不构成停沿（docs/28 §6.1 逐字）
        assertFalse(RunTurnClock.isStopEdge("approval_required"))
        assertFalse(RunTurnClock.isStopEdge("running"))
        assertFalse(RunTurnClock.isStopEdge("stopped"))
        assertFalse(RunTurnClock.isStopEdge("unknown"))
    }

    // —— 显示投影 ——

    @Test
    fun `running with anchor ticks elapsed`() {
        val d = RunTurnClock.display("running", anchorAtMs = 1_000L, frozenElapsedSec = null, nowMs = 61_000L)
        assertTrue(d is RunTurnClock.Display.Worked)
        assertEquals(60L, (d as RunTurnClock.Display.Worked).elapsedSec)
    }

    @Test
    fun `running without anchor degrades to no-number state`() {
        val d = RunTurnClock.display("running", anchorAtMs = null, frozenElapsedSec = null, nowMs = 61_000L)
        assertEquals(RunTurnClock.Display.RunningNoAnchor, d)
    }

    @Test
    fun `frozen value wins after stop edge`() {
        val d = RunTurnClock.display("waiting_input", anchorAtMs = null, frozenElapsedSec = 403L, nowMs = 999_999L)
        assertTrue(d is RunTurnClock.Display.Worked)
        assertEquals(403L, (d as RunTurnClock.Display.Worked).elapsedSec)
    }

    @Test
    fun `terminal without any observed interval draws nothing`() {
        // 进详情时已 completed、从未见过 running 沿：无据不画（不伪造）
        assertNull(RunTurnClock.display("completed", anchorAtMs = null, frozenElapsedSec = null, nowMs = 1L))
        assertNull(RunTurnClock.display("waiting_input", anchorAtMs = null, frozenElapsedSec = null, nowMs = 1L))
        // 冻结值优先于 running 锚点残留（新沿未开时不应沿用旧锚点）
        assertNull(RunTurnClock.display("failed", anchorAtMs = null, frozenElapsedSec = null, nowMs = 1L))
    }

    // —— 文案 ——

    @Test
    fun `worked format matches E16 wording`() {
        assertEquals("已工作 6 分 43 秒", RunTurnClock.formatWorked(403L))
        assertEquals("已工作 45 秒", RunTurnClock.formatWorked(45L))
        assertEquals("已工作 0 秒", RunTurnClock.formatWorked(0L))
        assertEquals("已工作 60 分 0 秒", RunTurnClock.formatWorked(3600L))
    }
}
