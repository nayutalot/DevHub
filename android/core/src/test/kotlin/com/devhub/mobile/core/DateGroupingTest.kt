package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

/** R11 跨天日期分隔线分组。 */
class DateGroupingTest {

    private fun at(year: Int, month: Int, day: Int, hour: Int, minute: Int): Long {
        val cal = Calendar.getInstance()
        cal.set(year, month - 1, day, hour, minute, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis / 1000
    }

    @Test
    fun `first message always shows separator`() {
        val now = at(2026, 9, 4, 12, 0)
        val m = DateGrouping.markerFor(prevSec = null, curSec = at(2026, 9, 1, 9, 30), nowSec = now)
        assertTrue(m.show)
        assertEquals("9月1日", m.label)
    }

    @Test
    fun `same day consecutive messages hide separator`() {
        val now = at(2026, 9, 4, 12, 0)
        val a = at(2026, 9, 4, 9, 0)
        val b = at(2026, 9, 4, 11, 30)
        val m = DateGrouping.markerFor(prevSec = a, curSec = b, nowSec = now)
        assertFalse(m.show)
        assertNull(m.label)
    }

    @Test
    fun `day boundary inserts separator with today label`() {
        val now = at(2026, 9, 4, 12, 0)
        val prev = at(2026, 9, 3, 23, 58)
        val cur = at(2026, 9, 4, 0, 5)
        val m = DateGrouping.markerFor(prevSec = prev, curSec = cur, nowSec = now)
        assertTrue(m.show)
        assertEquals("今天", m.label)
    }

    @Test
    fun `yesterday label for previous calendar day`() {
        val now = at(2026, 9, 4, 12, 0)
        assertEquals("昨天", DateGrouping.labelFor(at(2026, 9, 3, 8, 0), now))
        assertEquals("今天", DateGrouping.labelFor(at(2026, 9, 4, 0, 1), now))
    }

    @Test
    fun `cross year includes year in label`() {
        val now = at(2026, 9, 4, 12, 0)
        assertEquals("2025年12月31日", DateGrouping.labelFor(at(2025, 12, 31, 10, 0), now))
    }

    @Test
    fun `month day label without year for same year`() {
        val now = at(2026, 9, 4, 12, 0)
        assertEquals("8月15日", DateGrouping.labelFor(at(2026, 8, 15, 22, 0), now))
    }

    @Test
    fun `missing current timestamp never inserts separator`() {
        val now = at(2026, 9, 4, 12, 0)
        val m = DateGrouping.markerFor(prevSec = at(2026, 9, 3, 10, 0), curSec = null, nowSec = now)
        assertFalse(m.show)
    }
}
