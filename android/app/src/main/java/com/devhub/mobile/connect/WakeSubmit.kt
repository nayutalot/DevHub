package com.devhub.mobile.connect

import com.devhub.mobile.core.relay.RelayCodec
import com.devhub.mobile.core.relay.RelayFrame
import com.devhub.mobile.core.relay.WakeResultStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * RW1 wake_host 提交终态（docs/18 §3.17；relay 面专用——wake 是 relay 原生能力）。
 * 六态 = wake_result 原样投影（绝不美化：disabled=未启用、rate_limited=冷却中、
 * sent=已发出≠已开机）；外加两个 App 侧终态：
 * - [NotConnected]：WS 非 Connected / 发送失败——如实展示，**不排队不伪成功**
 *   （wake 禁止入 QueueReplay/幂等体系：排队重放会撞 relay 每设备冷却窗且语义撒谎）；
 * - [Timeout]：App 侧 20s 等待窗超时（> relay 执行上限 15s），与 relay timeout 态同文案，
 *   绝不谎报 sent。
 */
sealed class WakeSubmit {
    /** wake_result 单帧终态（六态之一 + 附加字段按态）。 */
    data class Result(
        val status: WakeResultStatus,
        val latencyMs: Long? = null,
        val retryAfterMs: Long? = null,
        val stderrSummary: String? = null,
    ) : WakeSubmit()

    /** 未连接（或发送失败）：不排队，如实不可用。 */
    data object NotConnected : WakeSubmit()

    /** App 侧等待窗（20s）超时：relay 终态未回。 */
    data object Timeout : WakeSubmit()
}

/**
 * RW1 wake_host 提交序列（docs/18 §3.17；注入式纯序列——单测零真实 WS，对齐
 * ManagedSpawnOutcome 的「ConnectionManager 消费、:app 单测面」拆分纪律）：
 * 门（connected）→ 生成 requestId → 注册挂起表 → send → 单帧等 wake_result（20s 超时）
 * → 按帧结算。挂起表 key = requestId（ECS 原样回显）；无幂等键、无队列行——wake 与
 * command 三段流本质不同（§3.17：relay 侧唯一去重面 = 每设备冷却窗）。
 *
 * @param timeoutMs App 侧等待窗（ConnectionManager 传 20s，> relay 15s 执行上限）
 * @param pending   挂起表（ConnectionManager 持有；wake_result 帧分发按 requestId 结算）
 */
internal class WakeHostSubmitter(
    private val timeoutMs: Long,
    private val pending: ConcurrentHashMap<String, CompletableDeferred<RelayFrame.WakeResult>>,
) {
    /**
     * @param connected WS 是否 Connected（ConnectionManager：ws 非 null 且 state is Connected）
     * @param send      发送缝（真实 = ws.send(encoded)；测试 = fake websocket）
     */
    suspend fun submit(connected: Boolean, send: (String) -> Boolean): WakeSubmit {
        if (!connected) return WakeSubmit.NotConnected
        val requestId = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<RelayFrame.WakeResult>()
        pending[requestId] = deferred
        if (!send(RelayCodec.encode(RelayFrame.WakeHost(requestId)))) {
            pending.remove(requestId)
            return WakeSubmit.NotConnected
        }
        val result: RelayFrame.WakeResult? = try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (err: TimeoutCancellationException) {
            null
        } finally {
            // 单帧终态结算即清挂起（成功/失败/超时三路一致；迟到帧无主即弃）
            pending.remove(requestId)
        }
        return result?.let { WakeSubmit.Result(it.status, it.latencyMs, it.retryAfterMs, it.stderrSummary) }
            ?: WakeSubmit.Timeout
    }
}
