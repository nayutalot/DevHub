package com.devhub.mobile.ui.components

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** 时间显示（气泡尾注 / 列表 / 子会话行共用）。 */
object TimeFmt {
    private val hm = SimpleDateFormat("HH:mm", Locale.US)
    private val mdHm = SimpleDateFormat("MM-dd HH:mm", Locale.US)
    private val full = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US)

    fun hm(sec: Long): String = hm.format(Date(sec * 1000))

    fun mdHm(sec: Long): String = mdHm.format(Date(sec * 1000))

    fun full(sec: Long): String = full.format(Date(sec * 1000))

    /**
     * UX-P2（docs/26 §3.1 微信列表行时间形态，纯函数可单测）：
     * 今天 → HH:mm（如 10:24）；非今天 → MM-dd HH:mm。
     * nowMs 注入（时区跟随系统默认）；sec 非正 → 空串（无时间数据行不显示占位）。
     */
    fun listTime(sec: Long?, nowMs: Long): String {
        if (sec == null || sec <= 0) return ""
        val cal = Calendar.getInstance()
        cal.timeInMillis = nowMs
        val nowDay = cal.get(Calendar.YEAR) * 10000 + cal.get(Calendar.MONTH) * 100 + cal.get(Calendar.DAY_OF_MONTH)
        cal.timeInMillis = sec * 1000
        val thenDay = cal.get(Calendar.YEAR) * 10000 + cal.get(Calendar.MONTH) * 100 + cal.get(Calendar.DAY_OF_MONTH)
        return if (nowDay == thenDay) hm(sec) else mdHm(sec)
    }

    /**
     * UX-Z2 结构层（docs/28 §4.3 E3「更新于 X」）：相对时间，与桌面 relativeTime
     * （src/renderer/src/lib/format.ts）中文口径逐字一致——「刚刚」/「N 分钟前」/
     * 「N 小时前」/「N 天前」/超过 30 天回退本地日期。nowMs 注入（纯函数可单测）；
     * sec 非正/null → 空串（无时间数据不显示占位，listTime 同纪律）；
     * 未来时间（时钟偏差）→「刚刚」（桌面同款容忍）。
     */
    fun rel(sec: Long?, nowMs: Long): String {
        if (sec == null || sec <= 0) return ""
        val diffMs = nowMs - sec * 1000
        if (diffMs < 0) return "刚刚" // 时钟偏差容忍（桌面同款）
        val minutes = diffMs / 60_000
        if (minutes < 1) return "刚刚"
        if (minutes < 60) return "$minutes 分钟前"
        val hours = minutes / 60
        if (hours < 24) return "$hours 小时前"
        val days = hours / 24
        if (days < 30) return "$days 天前"
        return mdHm(sec)
    }
}
