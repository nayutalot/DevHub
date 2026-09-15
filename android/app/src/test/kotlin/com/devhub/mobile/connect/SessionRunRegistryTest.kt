package com.devhub.mobile.connect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * UX-Z3 运行态层（docs/28 §6.1）：运行 turn 锚点登记语义锁——
 * WS 实时沿 / 轮询补偿双路同轨；首观测即 running = 锚点不可考（降级，不伪造）；
 * 停沿冻结实测区间；进程重启（clear）后降级路径真实可走。
 */
class SessionRunRegistryTest {

    @Before
    fun reset() = SessionRunRegistry.clear()

    @Test
    fun `running edge anchors the turn`() {
        val t = SessionRunRegistry.observeStatus(1, "waiting_input", 1_000L)
        assertEquals("waiting_input", t.lastStatus)
        val t2 = SessionRunRegistry.observeStatus(1, "running", 5_000L)
        assertEquals(5_000L, t2.anchorAtMs)
        assertNull(t2.frozenElapsedSec)
    }

    @Test
    fun `first sight running has no anchor - honest degrade`() {
        // 进程启动后从未见过非 running 沿：锚点不可考 → anchor=null（UI 降级「运行中…」）
        val t = SessionRunRegistry.observeStatus(2, "running", 9_000L)
        assertNull(t.anchorAtMs)
        assertEquals("running", t.lastStatus)
    }

    @Test
    fun `stop edge freezes measured interval and keeps anchor for turn window`() {
        SessionRunRegistry.observeStatus(3, "waiting_input", 1_000L)
        SessionRunRegistry.observeStatus(3, "running", 10_000L)
        val t = SessionRunRegistry.observeStatus(3, "waiting_input", 73_500L)
        assertEquals(10_000L, t.anchorAtMs) // 锚点保留：停沿转场 pill 的窗口右端 = anchor + frozen
        assertEquals(63L, t.frozenElapsedSec) // (73500-10000)/1000 floor
    }

    @Test
    fun `stop edge without anchor freezes nothing`() {
        // 全程未见过 running 沿 → 停沿无区间可冻结（无据不画）
        val t = SessionRunRegistry.observeStatus(4, "completed", 50_000L)
        assertNull(t.anchorAtMs)
        assertNull(t.frozenElapsedSec)
    }

    @Test
    fun `approval_required keeps the clock - not a stop edge`() {
        SessionRunRegistry.observeStatus(5, "waiting_input", 1_000L)
        SessionRunRegistry.observeStatus(5, "running", 10_000L)
        val t = SessionRunRegistry.observeStatus(5, "approval_required", 20_000L)
        // approval_required 非 stop 沿：锚点保持，区间继续（docs/28 §6.1 五终态逐字）
        assertNotNull(t.anchorAtMs)
        assertNull(t.frozenElapsedSec)
        // 批准后回 running：重复沿，锚点保持首观测值
        val t2 = SessionRunRegistry.observeStatus(5, "running", 30_000L)
        assertEquals(10_000L, t2.anchorAtMs)
    }

    @Test
    fun `new running edge after freeze opens a fresh interval`() {
        SessionRunRegistry.observeStatus(6, "completed", 1_000L)
        SessionRunRegistry.observeStatus(6, "running", 10_000L)
        SessionRunRegistry.observeStatus(6, "waiting_input", 40_000L)
        val t = SessionRunRegistry.observeStatus(6, "running", 120_000L)
        assertEquals(120_000L, t.anchorAtMs)
        assertNull(t.frozenElapsedSec) // 旧冻结值不带入新区间
    }

    @Test
    fun `same-status re-observation is a no-op`() {
        SessionRunRegistry.observeStatus(7, "waiting_input", 1_000L)
        val t = SessionRunRegistry.observeStatus(7, "waiting_input", 90_000L)
        assertNull(t.anchorAtMs)
        assertNull(t.frozenElapsedSec)
    }

    @Test
    fun `case and whitespace variants normalize to the same token`() {
        SessionRunRegistry.observeStatus(8, "Running", 1_000L) // 首观测 running：仍无锚点
        val t = SessionRunRegistry.observeStatus(8, "RUNNING ", 2_000L)
        assertNull(t.anchorAtMs) // 同一事实的不同写法：no-op，不重锚
        SessionRunRegistry.clear()
        SessionRunRegistry.observeStatus(8, "waiting_input", 3_000L)
        val t2 = SessionRunRegistry.observeStatus(8, " Running", 4_000L)
        assertEquals(4_000L, t2.anchorAtMs)
    }

    @Test
    fun `process restart clears anchors - degrade path is real`() {
        SessionRunRegistry.observeStatus(9, "waiting_input", 1_000L)
        SessionRunRegistry.observeStatus(9, "running", 5_000L)
        SessionRunRegistry.clear() // 进程重启等价面
        val t = SessionRunRegistry.observeStatus(9, "running", 999_000L)
        assertNull(t.anchorAtMs) // 重启后已在跑 → 降级，绝不伪造计时
    }

    @Test
    fun `version bumps only on real changes`() {
        val v0 = SessionRunRegistry.version.value
        SessionRunRegistry.observeStatus(10, "waiting_input", 1_000L)
        val v1 = SessionRunRegistry.version.value
        SessionRunRegistry.observeStatus(10, "waiting_input", 2_000L) // no-op 零 bump
        val v2 = SessionRunRegistry.version.value
        SessionRunRegistry.observeStatus(10, "running", 3_000L)
        val v3 = SessionRunRegistry.version.value
        assertEquals(1L, v1 - v0)
        assertEquals(0L, v2 - v1)
        assertEquals(1L, v3 - v2)
    }
}
