package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * U1-M1（AUDIT P1#1）：横屏气泡区空白修复的度量纯函数直锁。
 * 场景数值取自 AVD DevHub_API_35 实测：density 2.75（420dpi），
 * 76dp 避让基准 ≈ 209px；横屏气泡区被头部压到 ~57dp ≈ 157px。
 */
class TranscriptListMetricsTest {

    private val basePx = 76f * 2.75f // ≈209px

    @Test
    fun `portrait tall viewport keeps the base padding untouched`() {
        // 竖屏气泡区典型 ~500dp ≈ 1375px：基准 209px ≤ 1375×0.4=550 → 原样
        assertEquals(basePx, TranscriptListMetrics.bottomPaddingPx(1375f, basePx), 0.001f)
    }

    @Test
    fun `landscape tiny viewport caps the padding below viewport height`() {
        // 横屏实测：视口 ~157px < 基准 209px → 修复点：padding 收敛为 157×0.4
        val p = TranscriptListMetrics.bottomPaddingPx(157f, basePx)
        assertEquals(157f * TranscriptListMetrics.VIEWPORT_FRACTION_CAP, p, 0.001f)
        // 铁律：padding 绝不吞掉整个视口（此前空白缺陷的充要条件）
        assertTrue(p < 157f)
        assertTrue(157f - p > 0f)
    }

    @Test
    fun `viewport slightly above cap boundary still returns base`() {
        // 视口高恰好 = 基准/0.4 时边界：基准 ≤ 视口×0.4 → 基准
        val boundary = basePx / TranscriptListMetrics.VIEWPORT_FRACTION_CAP
        assertEquals(basePx, TranscriptListMetrics.bottomPaddingPx(boundary, basePx), 0.001f)
    }

    @Test
    fun `zero or negative viewport falls back to base`() {
        assertEquals(basePx, TranscriptListMetrics.bottomPaddingPx(0f, basePx), 0.001f)
        assertEquals(basePx, TranscriptListMetrics.bottomPaddingPx(-100f, basePx), 0.001f)
    }
}
