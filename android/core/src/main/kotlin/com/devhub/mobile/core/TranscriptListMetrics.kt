package com.devhub.mobile.core

/**
 * U1-M1（AUDIT P1#1）：转录气泡区 LazyColumn 底部避让 padding 度量（纯函数，:core 单测直锁）。
 *
 * 缺陷机理（26-landscape-child-detail.png 实证）：气泡区 LazyColumn 固定底部避让
 * padding（「跳到最新」FAB 高度 + 边距，竖屏基准约 76dp）。横屏时头部横幅/徽章/
 * 原因卡/遥控入口把气泡区视口压到极矮——一旦视口高 < 底部 padding，reverseLayout
 * 的最新气泡（含全部更早气泡）整体落在视口上方 → 头部/滑杆（滑杆在气泡区外）正常
 * 渲染而气泡区持续空白，等待再久也不恢复。
 *
 * 修复：避让 padding 收敛为 min(基准 padding, 视口高 × 比例)——小视口时 padding
 * 绝不吞掉整个视口，最新气泡恒可见；大视口（竖屏）行为不变（基准值原样生效）。
 */
object TranscriptListMetrics {

    /**
     * 视口高占比上限：小视口时避让 padding 至多吃掉视口的这一比例，
     * 其余留给气泡（0.40 = 剩 60% 视口可容纳至少一条最新气泡的保守下限）。
     */
    const val VIEWPORT_FRACTION_CAP: Float = 0.40f

    /**
     * 气泡区底部避让 padding（px）。纯算术：
     * - 视口高非正（首帧未测量/无界约束下 Infinity 传入方自行判守）→ 原样返回基准；
     * - 基准 ≤ 视口 × 上限（竖屏常态）→ 原样返回基准（行为不变）；
     * - 否则（横屏小视口）→ 收敛为 视口 × 上限。
     */
    fun bottomPaddingPx(viewportHeightPx: Float, basePaddingPx: Float): Float {
        if (!(viewportHeightPx > 0f)) return basePaddingPx
        val capped = viewportHeightPx * VIEWPORT_FRACTION_CAP
        return if (basePaddingPx <= capped) basePaddingPx else capped
    }
}
