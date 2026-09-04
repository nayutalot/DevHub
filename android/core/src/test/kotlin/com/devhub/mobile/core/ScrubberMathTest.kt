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
}
