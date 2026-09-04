package com.devhub.mobile.core

import java.util.Calendar

/**
 * R11 跨天日期分隔线（纯逻辑）：
 * - 首条消息必带分隔线；
 * - 与上一条消息不同「本地自然日」时插入分隔线；
 * - 文案：今天 / 昨天 / 同年 M月d日 / 跨年 yyyy年M月d日。
 */
object DateGrouping {

    data class Marker(val show: Boolean, val label: String?)

    private fun startOfDay(epochSec: Long): Long {
        val cal = Calendar.getInstance()
        cal.timeInMillis = epochSec * 1000
        cal.set(Calendar.HOUR_OF_DAY, 0)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis / 1000
    }

    private fun dayDiffDays(fromSec: Long, toSec: Long): Int {
        val secPerDay = 24 * 60 * 60L
        // startOfDay 均已对齐本地日界（秒），夏令时 ±1h 偏差由取整吸收
        return Math.round((startOfDay(toSec) - startOfDay(fromSec)).toDouble() / secPerDay).toInt()
    }

    /** 单条时间戳的分组文案（相对 now）。 */
    fun labelFor(epochSec: Long, nowSec: Long): String {
        val diff = dayDiffDays(epochSec, nowSec)
        val cal = Calendar.getInstance().apply { timeInMillis = epochSec * 1000 }
        val nowCal = Calendar.getInstance().apply { timeInMillis = nowSec * 1000 }
        val sameYear = cal.get(Calendar.YEAR) == nowCal.get(Calendar.YEAR)
        return when {
            diff == 0 -> "今天"
            diff == 1 -> "昨天"
            diff == -1 -> "明天" // 时钟回拨等异常输入仍给出确定性文案
            sameYear -> "${cal.get(Calendar.MONTH) + 1}月${cal.get(Calendar.DAY_OF_MONTH)}日"
            else -> "${cal.get(Calendar.YEAR)}年${cal.get(Calendar.MONTH) + 1}月${cal.get(Calendar.DAY_OF_MONTH)}日"
        }
    }

    /**
     * 升序消息流中，第 index 条是否需要日期分隔线。
     * prevSec = 上一条消息时间（首条传 null）。时间缺失（null）不猜：只有当无法确认为同一天时，
     * 缺失时间戳一律不插入分隔线（避免噪声），下一条有时间戳时再比较。
     */
    fun markerFor(prevSec: Long?, curSec: Long?, nowSec: Long): Marker {
        if (curSec == null) return Marker(show = false, label = null)
        val label = labelFor(curSec, nowSec)
        val show = prevSec == null || dayDiffDays(prevSec, curSec) != 0
        return Marker(show = show, label = if (show) label else null)
    }
}
