package com.devhub.mobile.ui.components

import java.text.SimpleDateFormat
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
}
