package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** R4 固定色板：五家各一色、稳定确定、首字母徽标（含 user 固定"我"由 BubbleSides 负责）。 */
class ProviderPaletteTest {

    @Test
    fun `five known providers resolve to distinct fixed colors`() {
        val specs = listOf("codex", "claude", "kimi", "zcode", "deepseek")
            .map { ProviderPalette.resolve(it, null) }
        assertEquals(5, specs.map { it.argb }.toSet().size)
        assertEquals(0xFF2E7D32, specs[0].argb)
        assertEquals(0xFFE64A19, specs[1].argb)
        assertEquals(0xFF1565C0, specs[2].argb)
        assertEquals(0xFF6A1B9A, specs[3].argb)
        assertEquals(0xFFAD1457, specs[4].argb)
    }

    @Test
    fun `label containing known key matches same color`() {
        // providerLabel 形态如 "Claude Code"（含 claude）应与 key=claude 同色
        val byLabel = ProviderPalette.resolve(null, "Claude Code")
        val byKey = ProviderPalette.resolve("claude", null)
        assertEquals(byKey.argb, byLabel.argb)
        assertEquals("C", byLabel.initial)
    }

    @Test
    fun `unknown provider gets stable deterministic color`() {
        val a1 = ProviderPalette.resolve("mystery", null)
        val a2 = ProviderPalette.resolve("mystery", null)
        assertEquals(a1.argb, a2.argb)
        val b = ProviderPalette.resolve("other", null)
        // 不同未知 key 落进同一扩展色板也应可复现（不随机）
        assertTrue(ProviderPalette.fallbackColorCount() > 0)
        assertNotEquals(-1L, a1.argb)
        assertNotEquals(b.argb, -1L)
    }

    @Test
    fun `initial extraction handles label key and blank`() {
        assertEquals("Z", ProviderPalette.initialOf(null, "ZCode"))
        assertEquals("C", ProviderPalette.initialOf("claude", "Claude Code"))
        assertEquals("D", ProviderPalette.initialOf("deepseek", null))
        assertEquals("?", ProviderPalette.initialOf(null, null))
        assertEquals("?", ProviderPalette.initialOf("", "-"))
    }

    @Test
    fun `null key and label still resolves without exception`() {
        val spec = ProviderPalette.resolve(null, null)
        assertTrue(spec.argb != 0L)
        assertEquals("?", spec.initial)
    }
}
