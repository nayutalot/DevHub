package com.devhub.mobile.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * UX-Z2 结构层（docs/28 §4.3 E3「更新于 X」）：TimeFmt.rel 相对时间口径锁——
 * 与桌面 relativeTime（src/renderer/src/lib/format.ts）中文文案逐字一致：
 * 刚刚 / N 分钟前 / N 小时前 / N 天前 / ≥30 天回退日期。nowMs 注入纯函数可锁。
 */
class TimeFmtRelTest {

    @Test
    fun `just now under one minute`() {
        val nowMs = 1_789_600_000_000L
        assertEquals("刚刚", TimeFmt.rel(nowMs / 1000 - 30, nowMs))
        assertEquals("刚刚", TimeFmt.rel(nowMs / 1000, nowMs))
    }

    @Test
    fun `future clock skew tolerated as just now`() {
        val nowMs = 1_789_600_000_000L
        assertEquals("刚刚", TimeFmt.rel(nowMs / 1000 + 120, nowMs))
    }

    @Test
    fun `minutes bucket`() {
        val nowMs = 1_789_600_000_000L
        assertEquals("1 分钟前", TimeFmt.rel(nowMs / 1000 - 60, nowMs))
        assertEquals("5 分钟前", TimeFmt.rel(nowMs / 1000 - 5 * 60, nowMs))
        assertEquals("59 分钟前", TimeFmt.rel(nowMs / 1000 - 59 * 60, nowMs))
    }

    @Test
    fun `hours bucket`() {
        val nowMs = 1_789_600_000_000L
        assertEquals("1 小时前", TimeFmt.rel(nowMs / 1000 - 3_600, nowMs))
        assertEquals("23 小时前", TimeFmt.rel(nowMs / 1000 - 23 * 3_600, nowMs))
    }

    @Test
    fun `days bucket under thirty`() {
        val nowMs = 1_789_600_000_000L
        assertEquals("1 天前", TimeFmt.rel(nowMs / 1000 - 86_400, nowMs))
        assertEquals("29 天前", TimeFmt.rel(nowMs / 1000 - 29 * 86_400L, nowMs))
    }

    @Test
    fun `thirty days and beyond falls back to date`() {
        val nowMs = 1_789_600_000_000L
        val rel = TimeFmt.rel(nowMs / 1000 - 30 * 86_400L, nowMs)
        // ≥30 天回退 MM-dd HH:mm 形态（与列表口径一致；不伪造具体时刻）
        assertEquals(TimeFmt.mdHm(nowMs / 1000 - 30 * 86_400L), rel)
    }

    @Test
    fun `null and non-positive render empty`() {
        assertEquals("", TimeFmt.rel(null, 1_789_600_000_000L))
        assertEquals("", TimeFmt.rel(0, 1_789_600_000_000L))
        assertEquals("", TimeFmt.rel(-5, 1_789_600_000_000L))
    }
}
