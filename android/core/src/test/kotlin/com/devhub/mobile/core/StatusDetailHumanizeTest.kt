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

    // —— UX-Z3 运行态层（任务书 #4）：终态族补全（zcode managed 面两形态）——

    @Test
    fun `zcode turn completed resultType family is humanized`() {
        // 形态源 = zcodeProvider.handleManagedEvent 实产；resultType 七值 = evalZcodeEventStatus 实产
        assertEquals("本轮已完成", StatusDetailHumanize.display("turn completed (resultType: success)"))
        assertEquals("本轮已取消", StatusDetailHumanize.display("turn completed (resultType: cancelled)"))
        assertEquals("本轮出错结束：达到轮次上限", StatusDetailHumanize.display("turn completed (resultType: error_max_turns)"))
        assertEquals("本轮出错结束：达到预算上限", StatusDetailHumanize.display("turn completed (resultType: error_max_budget)"))
        assertEquals("本轮执行中出错", StatusDetailHumanize.display("turn completed (resultType: error_during_execution)"))
        assertEquals("本轮出错结束：达到工具调用次数上限", StatusDetailHumanize.display("turn completed (resultType: error_max_tool_calls)"))
    }

    @Test
    fun `zcode unknown resultType falls back neutral without guessing`() {
        assertEquals("本轮已结束", StatusDetailHumanize.display("turn completed (resultType: future_kind)"))
    }

    @Test
    fun `zcode event prefix shape is humanized for known types`() {
        assertEquals("新一轮任务开始", StatusDetailHumanize.display("zcode event: turn.started"))
        assertEquals("本轮出错结束", StatusDetailHumanize.display("zcode event: turn.failed"))
        assertEquals("等待工具批准", StatusDetailHumanize.display("zcode event: permission.requested"))
        assertEquals("等待你的输入", StatusDetailHumanize.display("zcode event: userInput.requested"))
        assertEquals("会话已关闭", StatusDetailHumanize.display("zcode event: session.closed"))
        // 表外事件型原样透出（零吞码）
        assertEquals("zcode event: future.type", StatusDetailHumanize.display("zcode event: future.type"))
    }
}
