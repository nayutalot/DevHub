package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** 退避计算器：docs/14 §B.2 序列 1→2→4→8→16→32→60s 封顶 + ±20% jitter 边界。 */
class BackoffCalculatorTest {

    private fun calc(random: Double) = BackoffCalculator(randomSource = { random })

    @Test
    fun `base sequence doubles up to cap with mid jitter`() {
        val calc = calc(random = 0.5) // factor = 1.0 - 0.2 + 0.4*0.5 = 1.0（无 jitter 偏移）
        val expected = longArrayOf(1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000)
        for (expect in expected) {
            assertEquals(expect, calc.nextDelayMs())
        }
    }

    @Test
    fun `jitter lower bound at random zero is 80 percent`() {
        val calc = calc(random = 0.0)
        assertEquals(800L, calc.delayMsForAttempt(1))
        assertEquals(1_600L, calc.delayMsForAttempt(2))
        // 封顶 60s 的下界 = 48s
        assertEquals(48_000L, calc.delayMsForAttempt(9))
    }

    @Test
    fun `jitter upper bound at random one is 120 percent`() {
        val calc = calc(random = 1.0)
        assertEquals(1_200L, calc.delayMsForAttempt(1))
        assertEquals(2_400L, calc.delayMsForAttempt(2))
        // 封顶 60s 的上界 = 72s
        assertEquals(72_000L, calc.delayMsForAttempt(9))
    }

    @Test
    fun `attempt seven and beyond stay capped at 60s bounds`() {
        val low = calc(random = 0.0)
        val high = calc(random = 1.0)
        repeat(6) {
            low.nextDelayMs()
            high.nextDelayMs()
        }
        for (i in 7..20) {
            val vLow = low.delayMsForAttempt(i)
            val vHigh = high.delayMsForAttempt(i)
            assertTrue("attempt $i low=$vLow", vLow in 48_000..48_000)
            assertTrue("attempt $i high=$vHigh", vHigh in 72_000..72_000)
        }
    }

    @Test
    fun `reset returns to base delay`() {
        val calc = calc(random = 0.5)
        calc.nextDelayMs()
        calc.nextDelayMs()
        assertEquals(4_000L, calc.nextDelayMs())
        calc.reset()
        assertEquals(1_000L, calc.nextDelayMs())
    }

    @Test
    fun `random source out of range is coerced into jitter bounds`() {
        assertEquals(800L, calc(random = -5.0).delayMsForAttempt(1))
        assertEquals(1_200L, calc(random = 42.0).delayMsForAttempt(1))
    }

    @Test
    fun `non positive attempt is rejected`() {
        try {
            calc(random = 0.5).delayMsForAttempt(0)
            fail("expected IllegalArgumentException")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message!!.contains("attempt"))
        }
    }
}
