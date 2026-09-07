package com.devhub.mobile.core.relay

/**
 * relay 同步引擎（docs/18 §3.11/§6.1/§6.2/§6.3；M3-C8a）：设备侧 sync 引导 + 累计 ACK 游标 +
 * 补发页反应的纯状态机。传输层（OkHttp WS）、协程节流（ACK_FLUSH）、通知/缓存投影等 Android 面
 * 留在 ConnectionManager（委托本引擎）——PairLegFrameRouter 同先例：纯逻辑抽出供 JVM 单测直测。
 *
 * ## M3-C8a 引导死锁修复（C2e 实证死锁链）
 *
 * 旧实现 `sendRelaySyncRequest()` 对 `after<=0` 早退 → fresh install 本地游标永 0 →
 * sync_request 永不发 → 补发页永不启动（gapFill 仅由 hasGaps 的 sync_response 触发，而其前置
 * 正是 sync_request）→ held 队列只增（C2e 批内实测 870+）、event_ack_state row2 永不落盘。
 *
 * 契约依据（docs/18 已定义引导语义，照契约实施）：
 * - §6.1.2 水位对齐：`hello.sequence > 本地 maxSeq → 发 sync_request {after: 本地 maxSeq} 补齐`；
 *   `hello.sequence ≤ 本地 maxSeq → 本地为准，仍发 sync_request（应答空页），绝不回退本地游标`。
 *   fresh 设备本地 maxSeq=0 是合法 after（§3.11：after = 本机已持久处理的最高连续 sequence）。
 * - §3.12/服务端实证（forwarder.ts）：after=0 → `pageSince(0)` 升序补页（页上限 100）+
 *   `upTo/hasGaps` 暴露权威水位；hasGaps → 客户端 gapFill(upTo) 显式推进游标 → 续页。
 *   全链自洽，无需扩帧面、无需新字段。
 *
 * ## 协议空白点标注（不扩帧面，KDoc 留档）
 *
 * 「ECS 缓存全空（hello.sequence=0）+ fresh 设备」的 live 流基线对齐 docs/18 未定义：after=0 的
 * sync_request 应答空页、游标无从推进，其后到达的 live 事件（seq>1）将挂起 held，直至断线重连
 * 再次引导（§6.1.2 循环）。本实现保持最小面不跳号不伪造连续性（§6.3 纪律），不在本批扩大处理。
 */
class RelaySyncEngine(initial: Long = 0L) {

    private val cursor = CumulativeAckCursor(initial)

    /** 本地已持久处理的最高连续 sequence（sync_request.after / heartbeat.lastAckedSeq 取值源）。 */
    val after: Long get() = cursor.value

    /** 挂起中（空洞后位）的 sequence 数（诊断/测试）。 */
    fun heldCount(): Int = cursor.heldCount()

    /**
     * hello 引导/水位对齐帧（docs/18 §6.1.2）：**无论本地游标是否为 0 都必须发出**——
     * fresh（after=0）由此触发 ECS 全量补页；已有游标由此触发补发/对齐（本地为准不回退）。
     * M3-C8a 死锁根因即「此处对 after=0 早退不发」，回归测试必须钉死 after=0 出帧。
     */
    fun helloSyncFrame(): String = syncRequestFrame()

    /**
     * 游标前进/hasGaps 推进后的累计 ACK 帧（docs/18 §3.11：sync_request 兼任累计 ACK；
     * §6.2：ECS 取 max 只前进）。与 [helloSyncFrame] 同线格式，分开命名以区分触发语义。
     */
    fun ackSyncFrame(): String = syncRequestFrame()

    /**
     * 事件 sequence 观察（live 推送与 sync_response 内嵌事件同径）：仅接续前进；空洞挂起 held、
     * 重复/旧序绝不回退。@return true = 游标前进（调用方应安排节流 ACK）。
     */
    fun observe(seq: Long): Boolean = cursor.observe(seq)

    /**
     * hasGaps 补齐路径（docs/18 §6.3）：把游标显式推进到 ECS 声明的页上界，挂起队列一并解除。
     * @return true = 游标前进（调用方应落盘 event_ack_state row2 并安排续页 ACK）
     */
    fun gapFill(upTo: Long): Boolean = cursor.gapFill(upTo)

    private fun syncRequestFrame(): String =
        // requestId 必填（docs/18 §3.11 帧形「"requestId": "uuid-…"」；ECS forwarder
        // asString 校验非空 string）。M3-C8a 实战暴露：旧实现恒发 null（编码即省略）——
        // 死锁时期 sync_request 从未上线故从未被服务端检验，引导打通后即 BAD_PAYLOAD。
        // §3.12 sync_response 回显 requestId；客户端单飞行帧不依赖关联，仅满足帧形。
        RelayCodec.encode(
            RelayFrame.SyncRequest(requestId = java.util.UUID.randomUUID().toString(), after = cursor.value),
        )
}
