package com.devhub.mobile.core

/**
 * 离线命令队列按序补发状态机（docs/14 §B.5 / docs/11 §7 离线队列要求）。
 *
 * 语义：
 * - 顺序：按 createdAt 升序（同刻按入队 id），保证用户操作时序（如先 reply 后 pause）；
 * - 网络失败（IOException / WS 断连 / 未拿到 HTTP 响应）→ RETRY_LATER：停止本轮补发，
 *   指令保留在队列，重试继续复用同一 idempotencyKey（服务端幂等返回原结果，不重复执行）；
 * - 2xx → SENT：出队；
 * - 429（限流）/5xx（暂时性服务端问题）→ RETRY_LATER：保留待下轮；
 * - 其余 4xx（403 能力门/COMMAND_NOT_EXECUTABLE、409 COMMAND_KEY_CONFLICT/
 *   COMMAND_EXPIRED、404 等）→ DROP_FAILED：结构化落败（UI 展示错误码），
 *   并继续补发后续指令——被拒指令不应阻塞其它会话的合法指令；
 * - 401（DEVICE_REVOKED/AUTH_INVALID_TOKEN）→ AUTH_INVALID：停止一切补发，
 *   交由全局 401 处理（停服务 + 清凭据 + 回配对页）。
 */
enum class ReplayVerdict { SENT, RETRY_LATER, DROP_FAILED, AUTH_INVALID }

data class QueuedCommand(
    val id: Long,
    /** reply | pause | resume */
    val kind: String,
    val sessionId: Long,
    val idempotencyKey: String,
    val createdAtMs: Long,
)

object QueueReplayPlanner {
    const val KIND_REPLY = "reply"
    const val KIND_PAUSE = "pause"
    const val KIND_RESUME = "resume"
    // M2-R3（docs/18 §5.1 五值锁死 / docs/19 §7.4）：approve/interrupt 仅 Relay 命令面存在
    // （门控：能力恒空 → 按钮恒不显示）；入队面数据驱动放行，出队面按模式分派
    // （local 面 → 结构化落败 COMMAND_NOT_EXECUTABLE，relay 面 → command 帧）。
    const val KIND_APPROVE = "approve"
    const val KIND_INTERRUPT = "interrupt"
    // M3-E1（docs/18 §5.3，用户裁决 2026-09-07 #9=B）：设备自管理两值入队面——
    // spawn_session（无会话自管理命令，sessionId 存 0）/ revoke_device（自撤销）。
    // 仅 relay 命令面下发；local 面出队 → 结构化落败（与 approve/interrupt 同款）。
    const val KIND_SPAWN_SESSION = "spawn_session"
    const val KIND_REVOKE_DEVICE = "revoke_device"
    // S 批（docs/18 §5.3 注记）：workspace_link 查询入队面（离线桌面 = 排队提示照
    // relay 语义）。仅 relay 命令面下发；local 面出队 → 结构化落败（同上款）。
    const val KIND_WORKSPACE_LINK = "workspace_link"

    /**
     * 取下一批待补发指令：合法 kind 过滤 → 按时间序 → 截取 batch 上限。
     */
    fun nextBatch(queue: List<QueuedCommand>, maxBatchSize: Int = 20): List<QueuedCommand> =
        queue.asSequence()
            .filter {
                it.kind == KIND_REPLY || it.kind == KIND_PAUSE || it.kind == KIND_RESUME ||
                    it.kind == KIND_APPROVE || it.kind == KIND_INTERRUPT ||
                    it.kind == KIND_SPAWN_SESSION || it.kind == KIND_REVOKE_DEVICE ||
                    it.kind == KIND_WORKSPACE_LINK
            }
            .sortedWith(compareBy({ it.createdAtMs }, { it.id }))
            .take(maxBatchSize.coerceAtLeast(1))
            .toList()

    /** 把一次补发结果分类为状态机迁移。httpCode 为 null 表示网络层失败（未拿到响应）。 */
    fun classify(httpCode: Int?): ReplayVerdict = when {
        httpCode == null -> ReplayVerdict.RETRY_LATER
        httpCode in 200..299 -> ReplayVerdict.SENT
        httpCode == 401 -> ReplayVerdict.AUTH_INVALID
        httpCode == 429 -> ReplayVerdict.RETRY_LATER
        httpCode in 500..599 -> ReplayVerdict.RETRY_LATER
        else -> ReplayVerdict.DROP_FAILED
    }
}
