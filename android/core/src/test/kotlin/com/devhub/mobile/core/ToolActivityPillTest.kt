package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * UX-Z3 运行态层（docs/28 §6.2 E19a 收紧版）：工具活动 pill 聚合口径锁。
 *
 * 用例形态全部取自真实事件样本（2026-09-15 实查，先测后定纪律）：
 * - zcode：真库 tool_usage 37,273 行 / 52 工具名全集；App 投影面 toolInvocation 段
 *   16,874 段全挂 role='assistant' 行（role='tool' 行为 0）；
 * - deepseek managed：firehose 真机 e2e（acceptance/deepseek-managed-e2e t2-messages），
 *   一次 bash 调用 = assistant 折叠行 + role='tool' tool/call 行各一 toolInvocation 段；
 * - deepseek/claude observed：role='tool' 行全为 [tool_result] 无 segments。
 */
class ToolActivityPillTest {

    private fun row(role: String, vararg labels: String) = ToolActivityPill.Row(role, labels.toList())

    // —— 载体裁定 ——

    @Test
    fun `zcode projection counts assistant-carried tool segments`() {
        // 真实 zcode 会话形态：toolInvocation 段在 assistant 行（label=工具名），无 role='tool' 行
        val rows = listOf(
            row("user"),
            row("assistant", "Read", "Bash"),
            row("assistant"),
            row("assistant", "Edit", "Write", "TodoWrite"),
        )
        val c = ToolActivityPill.counts(rows)!!
        assertEquals(5, c.invocations)
        // 白名单：Read/Edit/Write 命中；Bash/TodoWrite 不猜 → 不入文件数
        assertEquals(3, c.fileOps)
    }

    @Test
    fun `deepseek managed counts tool rows only - no double counting with folded assistant rows`() {
        // 真实 e2e 形态：2 次 bash 调用 = 折叠 assistant 行 2 段 + role='tool' 行各 1 段。
        // 载体裁定：存在 role='tool' 带段行 → 只按 role='tool' 计（docs/28 口径），= 2 不 = 4。
        val rows = listOf(
            row("user", ),
            row("assistant", "bash", "bash"), // 折叠行（同一次调用，不计）
            row("tool", "bash"),
            row("tool"), // tool/result 无 segments
            row("tool", "bash"),
            row("tool"),
        )
        val c = ToolActivityPill.counts(rows)!!
        assertEquals(2, c.invocations)
        assertEquals(0, c.fileOps) // bash 非文件工具（判定不了，绝不猜）
    }

    @Test
    fun `observed tool-result rows yield no data`() {
        // deepseek/claude observed：role='tool' 全为 [tool_result] 无 segments → 不可得
        val rows = listOf(row("user"), row("assistant"), row("tool"), row("tool"))
        assertNull(ToolActivityPill.counts(rows))
        assertNull(ToolActivityPill.counts(emptyList()))
    }

    // —— 白名单 ——

    @Test
    fun `file whitelist matches real sample names case-insensitively`() {
        val rows = listOf(row("assistant", "Read", "edit", "WRITE", "MultiEdit", "apply_patch", "NotebookEdit"))
        val c = ToolActivityPill.counts(rows)!!
        assertEquals(6, c.invocations)
        assertEquals(6, c.fileOps)
    }

    @Test
    fun `unknown and non-file tool names count as invocations but not file ops`() {
        // mcp__* 前缀 / WebSearch / Bash / PowerShell / 未来新工具：计入步数不入文件数
        val rows = listOf(row("assistant", "mcp__plugin_android-emulator_android-emulator__android_ui_tap", "WebSearch", "Bash", "PowerShell"))
        val c = ToolActivityPill.counts(rows)!!
        assertEquals(4, c.invocations)
        assertEquals(0, c.fileOps)
    }

    @Test
    fun `non-file tools are not deduped - counted as-is`() {
        // 非文件不去重：同工具多次调用如实逐次计数
        val rows = listOf(row("assistant", "Bash", "Bash", "Bash", "Bash"))
        val c = ToolActivityPill.counts(rows)!!
        assertEquals(4, c.invocations)
        assertEquals(0, c.fileOps)
    }

    // —— 文案 ——

    @Test
    fun `running text prefers file ops then generic step count`() {
        assertEquals("已进行 3 次文件操作", ToolActivityPill.runningText(ToolActivityPill.Counts(5, 3)))
        assertEquals("运行中 · 第 4 步", ToolActivityPill.runningText(ToolActivityPill.Counts(4, 0)))
    }

    @Test
    fun `stop transition texts cover the terminal family`() {
        assertEquals(
            "本轮完成 · 2 次操作",
            ToolActivityPill.stopText("waiting_input", ToolActivityPill.Counts(2, 1)),
        )
        assertEquals(
            "本轮完成 · 2 次操作",
            ToolActivityPill.stopText("completed", ToolActivityPill.Counts(2, 0)),
        )
        assertEquals("本轮出错结束", ToolActivityPill.stopText("failed", ToolActivityPill.Counts(2, 1)))
        assertEquals("本轮已取消", ToolActivityPill.stopText("paused", ToolActivityPill.Counts(2, 1)))
        assertEquals("本轮已结束", ToolActivityPill.stopText("connection_lost", ToolActivityPill.Counts(2, 1)))
    }
}
