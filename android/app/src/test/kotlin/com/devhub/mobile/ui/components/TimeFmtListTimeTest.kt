package com.devhub.mobile.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

/**
 * UX-P2（docs/26 §3.1 微信列表行时间形态）：今天 → HH:mm；非今天 → MM-dd HH:mm；
 * 无时间数据 → 空串。nowMs 注入保证纯函数可锁。
 */
class TimeFmtListTimeTest {

    private fun secOf(year: Int, month: Int, day: Int, hour: Int, minute: Int): Long {
        val cal = Calendar.getInstance()
        cal.set(year, month - 1, day, hour, minute, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis / 1000
    }

    @Test
    fun `same day renders HH mm`() {
        // listTime(sec, nowMs)：时间戳单位秒，nowMs 单位毫秒（调用方传 System.currentTimeMillis()）
        val now = secOf(2026, 9, 14, 10, 30) * 1000
        val sec = secOf(2026, 9, 14, 10, 24)
        assertEquals("10:24", TimeFmt.listTime(sec, now))
    }

    @Test
    fun `other day renders MM-dd HH mm`() {
        val now = secOf(2026, 9, 14, 10, 30) * 1000
        val sec = secOf(2026, 9, 12, 21, 5)
        assertEquals("09-12 21:05", TimeFmt.listTime(sec, now))
    }

    @Test
    fun `midnight boundary counts as other day`() {
        // 00:00 边界：昨天 23:59 → 非今天；今天 00:00 → 今天
        val now = secOf(2026, 9, 14, 0, 0) * 1000
        val yesterday = secOf(2026, 9, 13, 23, 59)
        val todayMidnight = secOf(2026, 9, 14, 0, 0)
        assertTrue(TimeFmt.listTime(yesterday, now).startsWith("09-13"))
        assertEquals("00:00", TimeFmt.listTime(todayMidnight, now))
    }

    @Test
    fun `missing timestamps render empty`() {
        val now = secOf(2026, 9, 14, 10, 30) * 1000
        assertEquals("", TimeFmt.listTime(null, now))
        assertEquals("", TimeFmt.listTime(0L, now))
        assertEquals("", TimeFmt.listTime(-5L, now))
    }
}
