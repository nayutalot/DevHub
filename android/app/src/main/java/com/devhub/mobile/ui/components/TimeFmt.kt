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
}
