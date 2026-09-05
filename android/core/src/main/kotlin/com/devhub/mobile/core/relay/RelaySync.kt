package com.devhub.mobile.core.relay

/**
 * 累计 ACK 游标（docs/18 §3.11/§6.1/§6.2，M2-R3）。
 *
 * 语义（docs/18 §3.11）：
 * - `after = max(连续已处理)`；事件按 leg 内 TCP 有序到达；
 * - 本地尚未持久化处理的事件**不得**计入 after（ACK 只前进）；
 * - 空洞（sequence 跳号）时不得越过——先挂起，待 `gapFill`（hasGaps:true 的 REST 权威刷新
 *   补齐路径，docs/18 §6.3）显式推进，绝不静默跳号、绝不伪造连续性；
 * - 重复/旧序（重连补发重放）绝不使游标回退。
 *
 * 纯逻辑（线程不安全；调用方负责单线程/加锁访问——与 ackBuffer 同纪律）。
 */
class CumulativeAckCursor(initial: Long = 0L) {

    var value: Long = initial
        private set

    private val held = sortedSetOf<Long>()

    /**
     * 观察 sequence：仅当接续（seq == value+1，及随后被解挂的连续链）时推进。
     * @return 游标是否前进（true = 调用方应推进 sync_request/heartbeat 的 after/lastAckedSeq）
     */
    fun observe(seq: Long): Boolean {
        if (seq <= value) return false // 重复/旧序：绝不回退
        if (seq == value + 1) {
            value = seq
            // 解挂后续接链（缺口事件先到、后位事件已挂起的场景）
            while (held.isNotEmpty() && held.first() == value + 1) {
                value += 1
                held.remove(value)
            }
            return true
        }
        // 空洞：挂起等待缺口事件，不得越过后位 ack（先落库后推进的镜像纪律）
        held.add(seq)
        return false
    }

    /**
     * hasGaps 补齐路径（docs/18 §6.3）：REST 权威刷新完成后，把游标显式推进到 [upTo]
     * （ECS 声明的页上界）。挂起队列中 ≤ upTo 的项一并解除。
     * @return 游标是否前进
     */
    fun gapFill(upTo: Long): Boolean {
        if (upTo <= value) return false
        value = upTo
        held.clear()
        return true
    }

    /** 挂起中（空洞后位）的 sequence 数（诊断/测试用）。 */
    fun heldCount(): Int = held.size
}

/**
 * 有界去重集合（docs/18 §3.10 双通道去重 / 重连补发重放去重的通用底座）。
 * - 事件流：按 eventId（fixture 形态）去重；
 * - command_result：按 commandId 保留先到者（后到者仅刷新时间戳，§3.10）。
 * LRU 语义：超容量淘汰最旧条目；线程不安全（调用方串行化）。
 */
class BoundedSeenSet(private val capacity: Int = 512) {
    init {
        require(capacity > 0) { "BoundedSeenSet capacity must be positive" }
    }

    private val order = ArrayDeque<String>()
    private val seen = HashSet<String>(capacity)

    /** @return true = 之前已见过（重复，调用方应丢弃）；false = 首见（已记录）。 */
    fun seenAndRecord(key: String): Boolean {
        if (key in seen) return true
        if (seen.size >= capacity) {
            val oldest = order.removeFirst()
            seen.remove(oldest)
        }
        seen.add(key)
        order.addLast(key)
        return false
    }

    fun size(): Int = seen.size
}
