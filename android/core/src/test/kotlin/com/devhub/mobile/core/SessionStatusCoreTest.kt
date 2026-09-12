package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * U2-M4（AUDIT P2#8 + P3#3）：状态归一 + 标题提取纯函数直锁。
 */
class SessionStatusCoreTest {

    @Test
    fun `all nine canonical statuses pass through`() {
        val expected = listOf(
            "running", "completed", "failed", "waiting_input", "approval_required",
            "paused", "connection_lost", "stopped", "unknown",
        )
        for (s in expected) assertEquals(s, SessionStatusCore.normalize(s))
        assertEquals(expected.toSet(), SessionStatusCore.CANONICAL)
    }

    @Test
    fun `case and whitespace variants normalize to same token`() {
        assertEquals("completed", SessionStatusCore.normalize("COMPLETED"))
        assertEquals("running", SessionStatusCore.normalize("  Running "))
        assertEquals("waiting_input", SessionStatusCore.normalize("Waiting_Input"))
    }

    @Test
    fun `out of vocabulary values fall back to unknown honestly`() {
        assertEquals("unknown", SessionStatusCore.normalize("done"))
        assertEquals("unknown", SessionStatusCore.normalize("in_progress"))
        assertEquals("unknown", SessionStatusCore.normalize("terminé"))
        assertEquals("unknown", SessionStatusCore.normalize(""))
        assertEquals("unknown", SessionStatusCore.normalize("   "))
        assertEquals("unknown", SessionStatusCore.normalize(null))
        assertEquals("unknown", SessionStatusCore.normalize("complete")) // 近似词不猜
    }
}

/**
 * U2-M4（AUDIT P3#3）：子会话标题任务语义提取直锁。
 * 语料取自实时桌面 DB 子会话 title 真实形态（脱敏改造：路径/项目名替换）。
 */
class SessionTitleOpsTest {

    @Test
    fun `role assignment first line yields first task sentence`() {
        // 「你是…。工作树 = …。纯 X 面：只动 …」→ 跳过角色句与工作区句，取任务句
        val title = SessionTitleOps.extractTitle(
            "你是 DevHub 项目 U2 批执行智能体。工作树 = F:/Proj/worktrees/u2ux（分支 agent/ux）。纯 Android 面：只动 android/ 目录，桌面 src/ 零触碰。",
        )
        assertEquals("纯 Android 面：只动 android/ 目录，桌面 src/ 零触碰", title)
    }

    @Test
    fun `vision prompt second sentence is the task`() {
        val title = SessionTitleOps.extractTitle(
            "你有原生视觉能力。用 Read 工具查看两页论文渲染 PNG（110DPI）：输出页码与问题清单。",
        )
        assertEquals("用 Read 工具查看两页论文渲染 PNG（110DPI）：输出页码与问题清单", title)
    }

    @Test
    fun `plain task first sentence passes through unchanged`() {
        val title = SessionTitleOps.extractTitle(
            "对数学建模竞赛论文 PDF 的 8 个渲染页做视觉验收。页面 PNG 位于目录 F:/render/ 下。",
        )
        assertEquals("对数学建模竞赛论文 PDF 的 8 个渲染页做视觉验收", title)
    }

    @Test
    fun `newline separated prompt extracts task line`() {
        val title = SessionTitleOps.extractTitle(
            "你是 DevHub 项目 X 批执行智能体。\n主仓 = F:/Proj。\n修复会话列表排序缺陷，并补单测。",
        )
        assertEquals("修复会话列表排序缺陷，并补单测", title)
    }

    @Test
    fun `display markers stripped before extraction`() {
        val title = SessionTitleOps.extractTitle("你是执行智能体。**修复气泡组件**的边距。")
        assertEquals("修复气泡组件的边距", title)
    }

    @Test
    fun `all system sentences yields null fallback`() {
        // 全部句子均为角色/上下文交代 → 提不出任务语义，如实回退（调用方保留原截断）
        assertNull(
            SessionTitleOps.extractTitle("你是 DevHub 项目执行智能体。工作树 = F:/Proj/wt（分支 agent/x）。"),
        )
        assertNull(SessionTitleOps.extractTitle(""))
        assertNull(SessionTitleOps.extractTitle(null))
    }

    @Test
    fun `english role prefix sentence is skipped`() {
        val title = SessionTitleOps.extractTitle("You are a coding agent. Fix the flaky scrollbar test.")
        assertEquals("Fix the flaky scrollbar test", title)
    }

    @Test
    fun `long extracted sentence is capped for safety`() {
        val longTask = "修".repeat(200)
        val title = SessionTitleOps.extractTitle("你是执行智能体。$longTask。")
        assertEquals(80, title!!.length)
    }
}
