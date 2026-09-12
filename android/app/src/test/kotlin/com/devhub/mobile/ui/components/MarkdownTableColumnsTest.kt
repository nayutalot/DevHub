package com.devhub.mobile.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * U3 批（AUDIT P3#1）表格列宽启发式纯决策单测：
 * CJK 记 2 单位、其余记 1；列宽 = 列内最大值，夹在 [4, 32]；行数不足按空串兜底。
 * 确定性、零渲染环境依赖（横向滚动兜底由组合层承担）。
 */
class MarkdownTableColumnsTest {

    @Test
    fun `narrow cells clamp to minimum width`() {
        val units = markdownTableColumnUnits(listOf("a", "b"), listOf(listOf("1", "2")))
        assertEquals(listOf(4, 4), units)
    }

    @Test
    fun `cjk cells count double width`() {
        // "收敛点" = 6 单位 → 列宽 6
        val units = markdownTableColumnUnits(listOf("收敛点", "结果"), emptyList())
        assertEquals(listOf(6, 4), units)
    }

    @Test
    fun `widest cell in column wins across header and rows`() {
        val units = markdownTableColumnUnits(
            header = listOf("短", "列"),
            rows = listOf(listOf("一个很长的单元格内容", "x"), listOf("中等", "y")),
        )
        // 第一列最宽 = "一个很长的单元格内容"（10 字 × 2 = 20）；第二列最长 "列" = 2 → 夹到 4
        assertEquals(listOf(20, 4), units)
    }

    @Test
    fun `very wide cell clamps to maximum width for horizontal scroll`() {
        val longCell = "x".repeat(500)
        val units = markdownTableColumnUnits(listOf(longCell), listOf(listOf("a")))
        assertEquals(listOf(32), units)
    }

    @Test
    fun `ragged rows use empty string fallback`() {
        val units = markdownTableColumnUnits(
            header = listOf("h1", "h2", "h3"),
            rows = listOf(listOf("只", "有", "两", "个", "多", "格")),
        )
        assertEquals(3, units.size) // 列数跟随 header（3 列）；越界单元格不影响
        assertTrue(units.all { it in 4..32 })
    }

    @Test
    fun `deterministic same input same output`() {
        val header = listOf("收敛点", "结果")
        val rows = listOf(listOf("P4 表 11 vs 表 4", "已统一"))
        assertEquals(
            markdownTableColumnUnits(header, rows),
            markdownTableColumnUnits(header, rows),
        )
    }
}
