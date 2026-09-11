package com.devhub.mobile.core

/**
 * U1-M5（AUDIT P1#5）：POST_NOTIFICATIONS 冷启动自动弹窗决策（纯函数，:core 单测直锁）。
 *
 * 缺陷（01/16 号截图）：每次冷启动无条件弹系统权限框——用户拒绝后下次启动再弹，
 * 骚扰式重复请求。修复：拒绝一次即记录，之后不再自动弹；改由设置页
 * （GatewayConfig「通知权限」入口）承载用户主动开启。
 */
object NotificationPermissionPolicy {

    /**
     * 冷启动是否应自动弹系统权限框。
     * - 历史无拒绝记录 → true（每安装生命周期内至多自动请求到第一次明确拒绝为止）；
     * - 历史拒绝过 → false（绝不自动再弹；用户主动权移交设置页入口）。
     * 纯判定：不看当前实际授权状态（那是系统回调面的事，与本决策解耦）。
     */
    fun autoRequestOnColdStart(previouslyDenied: Boolean): Boolean = !previouslyDenied
}
