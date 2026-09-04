package com.devhub.mobile.data

import android.content.Context

/**
 * 夹具联调开关（体验整改批 B）。
 *
 * 用途：批次 A 的真实端点（segments/last/prevAfter/childSessions/archive…）合并前，
 * 以本地夹具数据驱动新 UI 联调与截图验收。**显式开关，绝不自动回退**——
 * 夹具模式下所有界面显著标注「演示数据（夹具）」，绝不冒充真实 Gateway（红线）。
 * 持久化用 SharedPreferences（非 Room，避免碰缓存库 schema）。
 */
object FixtureMode {
    private const val PREFS = "devhub_fixture_mode"
    private const val KEY_ENABLED = "enabled"

    fun enabled(context: Context): Boolean =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_ENABLED, false)

    fun setEnabled(context: Context, value: Boolean) {
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_ENABLED, value).apply()
    }
}
