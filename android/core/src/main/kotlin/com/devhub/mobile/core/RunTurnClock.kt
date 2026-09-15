package com.devhub.mobile.core

/**
 * UX-Z3 运行态层（docs/28 §6.1 / docs/briefs/uxz3-runtime.md #1）：会话运行计时器纯函数面。
 *
 * 语义（docs/28 §6.1 锁定）：
 * - 「已工作 X 分 Y 秒」= 本 turn 进行时长；turn 活跃 = 9 值状态机之 running 态区间：
 *   开始沿 = status_changed to:'running'；停沿 = to ∈ 五终态
 *   {waiting_input, completed, failed, paused, connection_lost}（provider 差异已被
 *   桌面侧状态归一层吸收，App 只消费归一后状态值）；
 * - 锚点不可考（WS 断线重连/进程重启/进详情时已在跑）→ 降级「运行中…」无计时数字
 *   （绝不拿 lastActivityAt-startedAt 冒充本轮时长——不伪造红线）；
 * - observed 会话无 turn 概念 → 整块不显（调用方门控，本函数不掺 mode）；
 * - 停沿后计时值冻结（停沿时刻真实测得的区间长），新 running 沿开新区间。
 *
 * 纯 Kotlin 零 Android 依赖（:core 纪律），:app/:core 单测直锁。
 */
object RunTurnClock {

    const val STATUS_RUNNING = "running"

    /** 五终态停沿值（docs/28 §6.1 逐字；approval_required 属运行中等待，不构成停沿）。 */
    val STOP_STATUSES: Set<String> = setOf(
        "waiting_input",
        "completed",
        "failed",
        "paused",
        "connection_lost",
    )

    /** 开始沿判定（归一后 to:'running'）。 */
    fun isStartEdge(status: String): Boolean = SessionStatusCore.normalize(status) == STATUS_RUNNING

    /** 停沿判定（归一后 ∈ 五终态）。 */
    fun isStopEdge(status: String): Boolean = SessionStatusCore.normalize(status) in STOP_STATUSES

    /** 计时器显示态。 */
    sealed class Display {
        /** running + 锚点可考：进行中计时（elapsedSec = now - 锚点）。 */
        data class Worked(val elapsedSec: Long) : Display()

        /** running + 锚点不可考：诚实降级（「运行中…」，无数字）。 */
        data object RunningNoAnchor : Display()
    }

    /**
     * 计时器投影。
     *
     * @param status 归一前原始状态（内部经 SessionStatusCore.normalize）。
     * @param anchorAtMs 本 turn 开始沿的本地观测时刻（毫秒）；null = 锚点不可考。
     * @param frozenElapsedSec 停沿时刻冻结的区间长（秒）；null = 无冻结值。
     * @param nowMs 当前时刻（毫秒）。
     * @return null = 不显示（非 running 且无冻结值：无据不画）。
     */
    fun display(
        status: String,
        anchorAtMs: Long?,
        frozenElapsedSec: Long?,
        nowMs: Long,
    ): Display? {
        val st = SessionStatusCore.normalize(status)
        return when {
            st == STATUS_RUNNING && anchorAtMs != null -> Display.Worked((nowMs - anchorAtMs).coerceAtLeast(0L) / 1000L)
            st == STATUS_RUNNING -> Display.RunningNoAnchor
            frozenElapsedSec != null -> Display.Worked(frozenElapsedSec)
            else -> null
        }
    }

    /**
     * 「已工作 X 分 Y 秒」文案（v4 截图 E16 形态）；不足 1 分只显秒。
     * 秒位 = 区间长的诚实截断（floor），不四舍五入虚增。
     */
    fun formatWorked(elapsedSec: Long): String {
        val m = elapsedSec / 60
        val s = elapsedSec % 60
        return if (m > 0) "已工作 $m 分 $s 秒" else "已工作 $s 秒"
    }
}
