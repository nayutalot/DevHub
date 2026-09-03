package com.devhub.mobile.core

import kotlin.math.min

/**
 * 断线重连指数退避计算器（docs/14 §B.2 参数）：
 * 1s → 2s → 4s → 8s → 16s → 32s → 封顶 60s，±20% jitter。
 * 连接成功后调用方必须 [reset]；[nextDelayMs] 每次失败后调用一次（内部连续失败计数 +1）。
 */
class BackoffCalculator(
    private val baseDelayMs: Long = DEFAULT_BASE_DELAY_MS,
    private val maxDelayMs: Long = DEFAULT_MAX_DELAY_MS,
    private val jitterFraction: Double = DEFAULT_JITTER_FRACTION,
    /** 注入缝：返回 [0,1) 随机数；测试固定值以断言 jitter 边界。 */
    private val randomSource: () -> Double = { Math.random() },
) {
    private var attempt = 0

    /** 重连成功：计数归零（下次 nextDelayMs 回到 base）。 */
    fun reset() {
        attempt = 0
    }

    /** 下一次重连延迟（连续失败第 n 次）。 */
    fun nextDelayMs(): Long = delayMsForAttempt(++attempt)

    /**
     * 第 attempt 次失败后的延迟：base = min(base·2^(attempt-1), cap)；
     * jitter：base·(1 - f + 2f·r)，r∈[0,1] → [base·(1-f), base·(1+f)]。
     */
    fun delayMsForAttempt(attempt: Int): Long {
        require(attempt >= 1) { "attempt must be >= 1, got $attempt" }
        var base = baseDelayMs
        var shift = attempt - 1
        // 指数增长封顶前最多 log2(cap/base) 步；封顶后停止翻倍（防溢出）
        while (shift > 0 && base < maxDelayMs) {
            base = min(base * 2, maxDelayMs)
            shift -= 1
        }
        base = min(base, maxDelayMs)
        val r = randomSource().coerceIn(0.0, 1.0)
        val factor = 1.0 - jitterFraction + 2.0 * jitterFraction * r
        return (base * factor).toLong().coerceAtLeast(0L)
    }

    companion object {
        const val DEFAULT_BASE_DELAY_MS = 1_000L
        const val DEFAULT_MAX_DELAY_MS = 60_000L
        const val DEFAULT_JITTER_FRACTION = 0.2
    }
}
