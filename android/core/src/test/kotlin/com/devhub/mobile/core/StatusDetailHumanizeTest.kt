package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * UX-Z2 结构层（任务书 §2.4 杂项）：statusDetail 工程串人话化收口词表锁——
 * 「turn/end (seq N)」等 wire-scan 沿形态、「turn ended (reason: …)」managed 形态；
 * 未命中原样透出（零吞码）；null/空白透 null。
 */
class StatusDetailHumanizeTest {

    @Test
    fun `wire-scan seq shape is humanized`() {
        assertEquals("本轮已结束（第 806 条事件）", StatusDetailHumanize.display("turn/end (seq 806)"))
        assertEquals("新一轮任务开始（第 12 条事件）", StatusDetailHumanize.display("turn/start (seq 12)"))
        assertEquals("等待工具批准（第 3 条事件）", StatusDetailHumanize.display("approval/asked (seq 3)"))
    }

    @Test
    fun `managed turn-end reason shape is humanized`() {
        assertEquals("本轮已完成", StatusDetailHumanize.display("turn ended (reason: completed)"))
        assertEquals("本轮结束：输出达到长度上限（内容可能不完整）", StatusDetailHumanize.display("turn ended (reason: max-tokens; output truncated)"))
        assertEquals("本轮已中止", StatusDetailHumanize.display("turn ended (reason: aborted)"))
        assertEquals("本轮出错结束", StatusDetailHumanize.display("turn ended (reason: error)"))
    }

    @Test
    fun `unknown reason falls back to neutral phrase without guessing`() {
        assertEquals("本轮已结束", StatusDetailHumanize.display("turn ended (reason: something-new)"))
    }

    @Test
    fun `unknown engineering strings pass through verbatim (zero code swallowing)`() {
        assertEquals("pause command executed (DevHub-initiated)", StatusDetailHumanize.display("pause command executed (DevHub-initiated)"))
        assertEquals("自定义未知串", StatusDetailHumanize.display("自定义未知串"))
    }

    @Test
    fun `null and blank pass through as null`() {
        assertNull(StatusDetailHumanize.display(null))
        assertNull(StatusDetailHumanize.display(""))
        assertNull(StatusDetailHumanize.display("   "))
    }

    @Test
    fun `dsh event prefix shape is humanized for known types`() {
        assertEquals("新一轮任务开始", StatusDetailHumanize.display("dsh event: turn/start"))
        // 表外事件型原样透出
        assertEquals("dsh event: future/type", StatusDetailHumanize.display("dsh event: future/type"))
    }
}
