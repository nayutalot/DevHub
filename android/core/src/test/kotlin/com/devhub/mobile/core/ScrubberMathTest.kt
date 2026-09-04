package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** R9 scrubber 索引映射与翻页判定。 */
class ScrubberMathTest {

    @Test
    fun `fraction endpoints map to newest and oldest`() {
        val count = 201
        assertEquals(count - 1, ScrubberMath.indexForFraction(0f, count)) // 最新
        assertEquals(0, ScrubberMath.indexForFraction(1f, count))         // 最旧
        assertEquals(0f, ScrubberMath.fractionForIndex(count - 1, count), 1e-6f)
        assertEquals(1f, ScrubberMath.fractionForIndex(0, count), 1e-6f)
    }

    @Test
    fun `fraction index mapping is invertible on grid points`() {
        val count = 101
        for (i in 0 until count) {
            val f = ScrubberMath.fractionForIndex(i, count)
            assertEquals(i, ScrubberMath.indexForFraction(f, count))
        }
    }

    @Test
    fun `clamps and degenerate windows`() {
        assertEquals(-1, ScrubberMath.indexForFraction(0.5f, 0))
        assertEquals(0, ScrubberMath.indexForFraction(0.5f, 1))
        assertEquals(0f, ScrubberMath.fractionForIndex(3, 1), 1e-6f)
        assertEquals(0, ScrubberMath.reversedIndexForFraction(0.3f, 0))
    }

    @Test
    fun `reversed index complements ascending index`() {
        val count = 51
        assertEquals(0, ScrubberMath.reversedIndexForFraction(0f, count))         // 最新 = 底部索引 0
        assertEquals(count - 1, ScrubberMath.reversedIndexForFraction(1f, count)) // 最旧 = 顶部索引
    }

    @Test
    fun `older edge triggers paging only when more data exists`() {
        val count = 200
        assertTrue(ScrubberMath.needsOlderPage(1f, count, hasMoreOlder = true))
        assertTrue(ScrubberMath.needsOlderPage(0.999f, count, hasMoreOlder = true))
        assertFalse(ScrubberMath.needsOlderPage(0.95f, count, hasMoreOlder = true)) // 距顶部 >2 条
        assertFalse(ScrubberMath.needsOlderPage(1f, count, hasMoreOlder = false))
        assertFalse(ScrubberMath.needsOlderPage(1f, 0, hasMoreOlder = true))
    }

    @Test
    fun `anchor timestamp interpolates within loaded window`() {
        val count = 11
        val oldest = 1000L
        val newest = 2000L
        assertEquals(newest, ScrubberMath.anchorSecForFraction(0f, count, oldest, newest))
        assertEquals(oldest, ScrubberMath.anchorSecForFraction(1f, count, oldest, newest))
        assertEquals(1500L, ScrubberMath.anchorSecForFraction(0.5f, count, oldest, newest))
        assertNull(ScrubberMath.anchorSecForFraction(0.5f, 0, oldest, newest))
        assertNull(ScrubberMath.anchorSecForFraction(0.5f, count, null, newest))
    }

    @Test
    fun `drag paging budget is at most two pages`() {
        assertEquals(2, ScrubberMath.maxPagingStepsPerDrag())
        assertEquals(2, ScrubberMath.pagesNeeded(remaining = 150, pageSize = 100))
        assertEquals(1, ScrubberMath.pagesNeeded(remaining = 100, pageSize = 100))
        assertEquals(0, ScrubberMath.pagesNeeded(remaining = 0, pageSize = 100))
    }

    @Test
    fun `reversed anchor at bottom maps to latest end`() {
        // 打磨批 D 初始语义：at-bottom（reversed 索引 0，含空窗口/单条/全部可见小窗口）= 最新锚 0
        val count = 201
        assertEquals(0f, ScrubberMath.fractionForReversedAnchor(0, count), 1e-6f)
        assertEquals(0f, ScrubberMath.fractionForReversedAnchor(0, 0), 1e-6f)
        assertEquals(0f, ScrubberMath.fractionForReversedAnchor(0, 1), 1e-6f)
        // 小窗口全部可见（此前误停最旧端 1.0 的场景：count=4 全部可见时旧算法给出 1.0）
        assertEquals(0f, ScrubberMath.fractionForReversedAnchor(0, 4), 1e-6f)
    }

    @Test
    fun `reversed anchor is monotonic and clamped`() {
        val count = 101
        assertEquals(1f, ScrubberMath.fractionForReversedAnchor(count - 1, count), 1e-6f)
        assertEquals(1f, ScrubberMath.fractionForReversedAnchor(500, count), 1e-6f)   // clamp 上界
        assertEquals(0f, ScrubberMath.fractionForReversedAnchor(-5, count), 1e-6f)    // clamp 下界
        assertEquals(0.5f, ScrubberMath.fractionForReversedAnchor(50, count), 1e-6f)
        var prev = -1f
        for (i in 0 until count) {
            val f = ScrubberMath.fractionForReversedAnchor(i, count)
            assertTrue(f >= prev)
            prev = f
        }
    }
}
