package com.devhub.mobile.core

import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * R9 scrubber 索引映射（纯逻辑）。
 *
 * 坐标系：fraction ∈ [0,1]，0 = 最新（消息窗口底部），1 = 最旧（窗口顶部）。
 * 已加载窗口 = 升序 messages[0..count-1]；「更旧」未加载区间只在 hasMoreOlder=true 时存在，
 * 拖到窗口顶部边缘即按 prevAfter 翻页（锚点 = 目标索引时间戳）。
 */
object ScrubberMath {

    /** fraction → 已加载窗口内的升序索引（clamp 到 [0, count-1]；count=0 返回 -1）。 */
    fun indexForFraction(fraction: Float, count: Int): Int {
        if (count <= 0) return -1
        val f = fraction.coerceIn(0f, 1f)
        // fraction 0 → 最新 = count-1；fraction 1 → 最旧 = 0
        return (count - 1 - (f * (count - 1)).roundToInt()).coerceIn(0, count - 1)
    }

    /** 升序索引 → fraction（scrubber 回显）。 */
    fun fractionForIndex(index: Int, count: Int): Float {
        if (count <= 1) return 0f
        val i = index.coerceIn(0, count - 1)
        return (count - 1 - i).toFloat() / (count - 1).toFloat()
    }

    /**
     * 视口锚点 fraction（打磨批 D 初始语义：at-bottom = 最新锚）。
     * 输入 = reverseLayout 列表 firstVisibleItemIndex（reversed 索引，0 = 底部/最新）；
     * 输出 = scrubber fraction（0 = 最新端，1 = 最旧端）。
     * 停在底部（含初始/空窗口/全部可见的小窗口）恒 → 0，即「内容是最新」在滑条上
     * 锚定「最新」端；此前以"最顶可见项"推 fraction，小窗口下初始误停最旧端。
     */
    fun fractionForReversedAnchor(firstVisibleReversedIndex: Int, count: Int): Float {
        if (count <= 1) return 0f
        return firstVisibleReversedIndex.coerceIn(0, count - 1).toFloat() / (count - 1).toFloat()
    }

    /**
     * 拖动是否触达「更旧」边缘（需要按 prevAfter 翻页）：
     * 目标索引落在已加载窗口顶部 edgeWindow 条以内且还有更旧数据。
     */
    fun needsOlderPage(fraction: Float, count: Int, hasMoreOlder: Boolean, edgeWindow: Int = 2): Boolean {
        if (!hasMoreOlder || count <= 0) return false
        val target = indexForFraction(fraction, count)
        return target < edgeWindow.coerceIn(0, count - 1)
    }

    /**
     * 拖动气泡显示的锚点时间戳：已加载窗口内按索引线性插值（近似显示；
     * 释放后的真实定位以加载回来的数据为准）。窗口外/时间缺失 → null（气泡显示"更早…"）。
     */
    fun anchorSecForFraction(fraction: Float, count: Int, oldestSec: Long?, newestSec: Long?): Long? {
        if (count <= 0 || oldestSec == null || newestSec == null) return null
        if (count == 1) return newestSec
        val f = fraction.coerceIn(0f, 1f)
        // f=0（最新）→ t=count-1；f=1（最旧）→ t=0
        val t = ((1f - f) * (count - 1)).roundToInt().coerceIn(0, count - 1)
        return oldestSec + ((newestSec - oldestSec).toDouble() * t / (count - 1)).toLong()
    }

    /** 释放跳转目标（reversed LazyColumn 索引 = count-1-升序索引；count=0 返回 0）。 */
    fun reversedIndexForFraction(fraction: Float, count: Int): Int {
        if (count <= 0) return 0
        return (count - 1 - indexForFraction(fraction, count)).coerceIn(0, count - 1)
    }

    /** 一次拖拽翻页预算（验收：≤2 次翻页内命中）。 */
    fun maxPagingStepsPerDrag(): Int = 2

    /** 翻页数学：还需 remaining 条、每页 pageSize 条 → 需要页数（向上取整）。 */
    fun pagesNeeded(remaining: Int, pageSize: Int): Int =
        if (remaining <= 0 || pageSize <= 0) 0 else ceil(remaining.toDouble() / pageSize).toInt()
}
