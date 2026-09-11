package com.devhub.mobile.notify

import android.content.Context

/**
 * U1-M5（AUDIT P1#5）：POST_NOTIFICATIONS 拒绝记录（SharedPreferences 一键，本机私有）。
 * - 用户拒绝系统权限框 → 落拒绝标记；下次冷启动起不再自动弹（决策在
 *   :core NotificationPermissionPolicy，本类只承担存取 IO）；
 * - 用户授予 → 清标记（卸载重装/换机语义随系统，不做跨生命周期保留）。
 * 零凭据：只存一个布尔键，与设备 Token（Keystore）无关。
 */
object NotificationPermissionStore {

    private const val PREFS = "devhub_notification_prefs"
    private const val KEY_DENIED = "post_notifications_denied"

    fun previouslyDenied(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_DENIED, false)

    /** 系统权限框回调落点：granted=true 清拒绝标记；false 落标记。 */
    fun record(context: Context, granted: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_DENIED, !granted)
            .apply()
    }
}
