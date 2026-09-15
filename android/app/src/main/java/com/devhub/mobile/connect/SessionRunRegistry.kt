package com.devhub.mobile.connect

import com.devhub.mobile.core.RunTurnClock
import com.devhub.mobile.core.SessionStatusCore
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * UX-Z3 运行态层（docs/28 §6.1）：会话运行 turn 锚点登记（进程内内存态，绝不持久化伪造）。
 *
 * 喂养点（三路同机，edge 去重同轨）：
 * - ConnectionManager local/relay 事件帧（status_changed to / waiting_input status）——
 *   WS 实时沿，详情页未打开也登记（回详情页计时器即恢复）；
 * - SessionDetailScreen 详情轮询投影（WS 漏沿时的补偿观测）。
 *
 * 语义（RunTurnClock：开始沿 = to:'running'，停沿 = 五终态）：
 * - 首次观测即 running（进程启动后从未见过非 running 沿）→ 锚点不可考 → anchorAtMs = null
 *   → UI 降级「运行中…」（绝不伪造——spec §6.1 兜底条款）；
 * - 观测到 running 沿 → anchorAtMs = 该沿本地时刻；
 * - 观测到停沿且 anchor 在考 → frozenElapsedSec = (now - anchor)/1000 冻结，
 *   anchor 清空（下轮 running 沿开新区间）；
 * - 停沿无 anchor（全程未见过 running 沿）→ 零冻结值（无据不画）。
 *
 * 进程重启 → 本表清空 → 已 running 会话首观测即降级——正是 spec 要求的诚实路径。
 * 纯 Kotlin 零 Android 依赖（:app 内可 JVM 单测直锁）。
 */
object SessionRunRegistry {

    /** 单会话 turn 观测态。 */
    data class Turn(
        val anchorAtMs: Long? = null,
        val frozenElapsedSec: Long? = null,
        val lastStatus: String? = null,
    )

    private val turns = ConcurrentHashMap<Long, Turn>()

    /** turn 态变更版本号（UI 收集即刷新；同状态重观察零 bump 防重组风暴）。 */
    private val _version = MutableStateFlow(0L)
    val version: StateFlow<Long> = _version

    fun get(sessionId: Long): Turn = turns[sessionId] ?: Turn()

    /** 清空（进程级语义测试/登出场景；运行期不调用）。 */
    fun clear() = turns.clear()

    /**
     * 观测一次会话状态（沿去重：同状态重观察为 no-op）。
     * @return 观测后的 turn 态（UI 以此渲染计时器）。
     */
    fun observeStatus(sessionId: Long, rawStatus: String, nowMs: Long): Turn {
        val status = SessionStatusCore.normalize(rawStatus)
        val prev = turns[sessionId] ?: Turn()
        val changed: Boolean
        val next = when {
            status == prev.lastStatus -> {
                changed = false
                prev
            }

            RunTurnClock.isStartEdge(status) -> {
                changed = true
                if (prev.anchorAtMs != null) {
                    // 已在 running 区间（重复沿/approval_required 回归）：锚点保持首观测值
                    prev.copy(lastStatus = status)
                } else if (prev.lastStatus != null) {
                    // 真实沿：观测到 非 running → running 的翻转才起锚（±1s 与状态沿一致）
                    Turn(anchorAtMs = nowMs, lastStatus = status)
                } else {
                    // 首观测即 running（进程启动后本会话从未见过其他状态）：锚点不可考
                    // → 降级「运行中…」（绝不伪造——spec §6.1 兜底条款）
                    Turn(lastStatus = status)
                }
            }

            RunTurnClock.isStopEdge(status) -> {
                changed = true
                val frozen = prev.anchorAtMs?.let { (nowMs - it).coerceAtLeast(0L) / 1000L }
                Turn(frozenElapsedSec = frozen, lastStatus = status)
            }

            else -> { // 集外/unknown 等非沿状态：不构成任何沿，仅记账
                changed = true
                prev.copy(lastStatus = status)
            }
        }
        turns[sessionId] = next
        if (changed) _version.value = _version.value + 1
        return next
    }
}
