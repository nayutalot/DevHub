package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * UX-Z2 结构层（docs/28 §5）：composer-first 纯文案表与模型弹层三态锁——
 * 问候语时段边界（无称呼不伪造）、chips 预设表、三态判定（可选面/托管停用/
 * observed 不画入口=null）。
 */
class ComposerFirstTest {

    @Test
    fun `greeting follows time-of-day buckets`() {
        assertEquals("早上好", ComposerFirst.greetingForHour(5))
        assertEquals("早上好", ComposerFirst.greetingForHour(10))
        assertEquals("中午好", ComposerFirst.greetingForHour(11))
        assertEquals("中午好", ComposerFirst.greetingForHour(12))
        assertEquals("下午好", ComposerFirst.greetingForHour(13))
        assertEquals("下午好", ComposerFirst.greetingForHour(17))
        assertEquals("晚上好呀，今天辛苦啦", ComposerFirst.greetingForHour(18))
        assertEquals("晚上好呀，今天辛苦啦", ComposerFirst.greetingForHour(22))
        assertEquals("夜深了，注意休息", ComposerFirst.greetingForHour(23))
        assertEquals("夜深了，注意休息", ComposerFirst.greetingForHour(0))
        assertEquals("夜深了，注意休息", ComposerFirst.greetingForHour(4))
    }

    @Test
    fun `greeting never contains a fabricated user name`() {
        // 无个性化数据 → 固定文案池，绝不显称呼（docs/28 §5.2 纪律）
        for (h in 0..23) {
            val phrase = ComposerFirst.greetingForHour(h)
            assertTrue(phrase.isNotEmpty())
            assertTrue(!phrase.contains("用户") && !phrase.contains("先生") && !phrase.contains("女士"))
        }
    }

    @Test
    fun `chip presets are the four DevHub-context entries`() {
        val labels = ComposerFirst.CHIP_PRESETS.map { it.label }
        assertEquals(listOf("报错修复", "代码解读", "写个脚本", "继续上次"), labels)
        // 每枚都有非空填入文案（点击仅填入，不发送——发送由 UI 门收敛）
        ComposerFirst.CHIP_PRESETS.forEach { assertTrue(it.fillText.isNotBlank()) }
    }

    @Test
    fun `model sheet tri-state — available when managed model configured`() {
        val state = ComposerFirst.modelSheetState(
            listOf(
                ComposerFirst.ManagedProviderRef("ZCode", isManaged = true, managedModel = "zcode/glm-5-turbo"),
                ComposerFirst.ManagedProviderRef("Codex", isManaged = false, managedModel = null),
            ),
        )
        val available = state as ComposerFirst.ModelSheetState.Available
        assertEquals(1, available.rows.size)
        assertEquals("ZCode", available.rows[0].providerName)
        assertEquals("zcode/glm-5-turbo", available.rows[0].model)
        assertTrue(available.candidates.isNotEmpty())
    }

    @Test
    fun `model sheet tri-state — disabled when managed but key missing`() {
        val state = ComposerFirst.modelSheetState(
            listOf(ComposerFirst.ManagedProviderRef("DeepSeek Harness", isManaged = true, managedModel = null)),
        )
        val disabled = state as ComposerFirst.ModelSheetState.ManagedDisabled
        assertEquals(listOf("DeepSeek Harness"), disabled.providerNames)
    }

    @Test
    fun `model sheet tri-state — no managed provider means no entry at all`() {
        assertNull(
            ComposerFirst.modelSheetState(
                listOf(ComposerFirst.ManagedProviderRef("Kimi Code", isManaged = false, managedModel = null)),
            ),
        )
        assertNull(ComposerFirst.modelSheetState(emptyList()))
    }

    @Test
    fun `empty-string model counts as disabled not available`() {
        val state = ComposerFirst.modelSheetState(
            listOf(ComposerFirst.ManagedProviderRef("ZCode", isManaged = true, managedModel = "")),
        )
        assertTrue(state is ComposerFirst.ModelSheetState.ManagedDisabled)
    }
}
