package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** 离线队列按序补发状态机：顺序、批量上限、结果分类（docs/14 §B.5）。 */
class QueueReplayPlannerTest {

    private fun cmd(
        id: Long,
        createdAtMs: Long,
        kind: String = "reply",
        key: String = "key-$id",
        sessionId: Long = 1,
    ) = QueuedCommand(id = id, kind = kind, sessionId = sessionId, idempotencyKey = key, createdAtMs = createdAtMs)

    @Test
    fun `batch is ordered by createdAt then id`() {
        val queue = listOf(
            cmd(id = 3, createdAtMs = 300),
            cmd(id = 1, createdAtMs = 100),
            cmd(id = 2, createdAtMs = 200),
            cmd(id = 0, createdAtMs = 100), // 同刻按 id 升序
        )
        val batch = QueueReplayPlanner.nextBatch(queue)
        assertEquals(listOf(0L, 1L, 2L, 3L), batch.map { it.id })
    }

    @Test
    fun `batch respects max size`() {
        val queue = (1..10).map { cmd(id = it.toLong(), createdAtMs = it.toLong() * 10) }
        val batch = QueueReplayPlanner.nextBatch(queue, maxBatchSize = 4)
        assertEquals(4, batch.size)
        assertEquals(listOf(1L, 2L, 3L, 4L), batch.map { it.id })
    }

    @Test
    fun `unknown kinds are filtered out`() {
        val queue = listOf(
            cmd(id = 1, createdAtMs = 1, kind = "reply"),
            cmd(id = 2, createdAtMs = 2, kind = "exec"), // 绝不允许的注入 kind
            cmd(id = 3, createdAtMs = 3, kind = "pause"),
            cmd(id = 4, createdAtMs = 4, kind = "resume"),
            cmd(id = 5, createdAtMs = 5, kind = ""),
        )
        val batch = QueueReplayPlanner.nextBatch(queue)
        assertEquals(listOf(1L, 3L, 4L), batch.map { it.id })
    }

    @Test
    fun `classify network failure keeps command for retry`() {
        assertEquals(ReplayVerdict.RETRY_LATER, QueueReplayPlanner.classify(null))
    }

    @Test
    fun `classify 2xx is sent`() {
        assertEquals(ReplayVerdict.SENT, QueueReplayPlanner.classify(200))
        assertEquals(ReplayVerdict.SENT, QueueReplayPlanner.classify(202))
    }

    @Test
    fun `classify 401 stops everything for auth flow`() {
        assertEquals(ReplayVerdict.AUTH_INVALID, QueueReplayPlanner.classify(401))
    }

    @Test
    fun `classify 429 and 5xx wait for next round`() {
        assertEquals(ReplayVerdict.RETRY_LATER, QueueReplayPlanner.classify(429))
        assertEquals(ReplayVerdict.RETRY_LATER, QueueReplayPlanner.classify(500))
        assertEquals(ReplayVerdict.RETRY_LATER, QueueReplayPlanner.classify(503))
    }

    @Test
    fun `classify structured 4xx rejections drop the command`() {
        // 403 能力门/COMMAND_NOT_EXECUTABLE、409 KEY_CONFLICT/EXPIRED、404 会话不存在
        for (code in listOf(400, 403, 404, 409)) {
            assertEquals("code=$code", ReplayVerdict.DROP_FAILED, QueueReplayPlanner.classify(code))
        }
    }

    @Test
    fun `same idempotency key is preserved across planned retries`() {
        // 状态机不换 key：重试的指令必须带着原 key 再次入站
        val command = cmd(id = 1, createdAtMs = 1, key = "fixed-uuid")
        val batch = QueueReplayPlanner.nextBatch(listOf(command))
        val verdict = QueueReplayPlanner.classify(null)
        assertEquals(ReplayVerdict.RETRY_LATER, verdict)
        assertEquals("fixed-uuid", batch.single().idempotencyKey)
    }
}
