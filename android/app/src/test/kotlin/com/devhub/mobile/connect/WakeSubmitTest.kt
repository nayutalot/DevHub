package com.devhub.mobile.connect

import com.devhub.mobile.core.relay.RelayCodec
import com.devhub.mobile.core.relay.RelayFrame
import com.devhub.mobile.core.relay.WakeResultStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap

/**
 * RW1 wake 提交序列单测（docs/18 §3.17；对齐 SelfManageSubmitTest 风格——
 * 注入式 fake websocket：send 缝捕获 wake_host 帧并按 requestId 回填 wake_result，
 * 零真实网络）。覆盖：六态映射 + App 侧超时 + NotConnected（未连接/发送失败）。
 * 帧编解码面由 :core RelayWakeCodecTest / RelayCodecFixtureTest 覆盖，此处不重复。
 */
class WakeSubmitTest {

    /** fake websocket：send 捕获编码帧（校验 wake_host 形）→ 按帧内 requestId 回填 wake_result。 */
    private class FakeWs(
        private val connected: Boolean,
        private val sendOk: Boolean = true,
        private val reply: ((requestId: String) -> RelayFrame.WakeResult?)? = null,
    ) {
        val pending = ConcurrentHashMap<String, CompletableDeferred<RelayFrame.WakeResult>>()
        val submitter = WakeHostSubmitter(timeoutMs = 500, pending = pending)
        var sentFrames = mutableListOf<String>()
            private set

        fun send(): (String) -> Boolean = { text ->
            sentFrames.add(text)
            if (!sendOk) {
                false
            } else {
                val frame = RelayCodec.parse(text)
                assertTrue(frame is RelayFrame.WakeHost)
                val requestId = (frame as RelayFrame.WakeHost).requestId
                assertTrue("requestId 应为 UUID 形", requestId.length >= 32 && requestId.contains('-'))
                val result = reply?.invoke(requestId)
                if (result != null) {
                    pending[requestId]?.complete(RelayCodec.parse(RelayCodec.encode(result)) as RelayFrame.WakeResult)
                }
                true
            }
        }
    }

    private fun resultOf(s: WakeSubmit): WakeSubmit.Result = s as WakeSubmit.Result

    @Test
    fun `not connected short-circuits before any send`() = runBlocking {
        val ws = FakeWs(connected = false)
        val r = ws.submitter.submit(connected = false, send = ws.send())
        assertEquals(WakeSubmit.NotConnected, r)
        assertTrue("未连接绝不发帧", ws.sentFrames.isEmpty())
        assertTrue("未连接绝不留挂起行", ws.pending.isEmpty())
    }

    @Test
    fun `send failure folds to NotConnected without dangling pending entry`() = runBlocking {
        val ws = FakeWs(connected = true, sendOk = false)
        val r = ws.submitter.submit(connected = true, send = ws.send())
        assertEquals(WakeSubmit.NotConnected, r)
        assertTrue("发送失败必须清挂起行", ws.pending.isEmpty())
    }

    @Test
    fun `six wake_result statuses map through unchanged`() = runBlocking {
        val cases = listOf(
            RelayFrame.WakeResult("x1", WakeResultStatus.SENT, latencyMs = 812L),
            RelayFrame.WakeResult("x2", WakeResultStatus.ALREADY_ON),
            RelayFrame.WakeResult("x3", WakeResultStatus.RATE_LIMITED, retryAfterMs = 9300L),
            RelayFrame.WakeResult("x4", WakeResultStatus.DISABLED),
            RelayFrame.WakeResult(
                "x5",
                WakeResultStatus.EXEC_FAILED,
                latencyMs = 210L,
                stderrSummary = "ssh: connect to host 127.0.0.1 port 2222: Connection refused",
            ),
            RelayFrame.WakeResult("x6", WakeResultStatus.TIMEOUT, latencyMs = 15000L),
        )
        for (model in cases) {
            val ws = FakeWs(connected = true) { model.copy(requestId = it) }
            val r = ws.submitter.submit(connected = true, send = ws.send())
            val got = resultOf(r)
            assertEquals("status=${model.status}", model.status, got.status)
            assertEquals(model.latencyMs, got.latencyMs)
            assertEquals(model.retryAfterMs, got.retryAfterMs)
            assertEquals(model.stderrSummary, got.stderrSummary)
            assertTrue("终态结算即清挂起行", ws.pending.isEmpty())
        }
    }

    @Test
    fun `app side wait window timeout folds to Timeout and clears pending`() = runBlocking {
        // reply = null：relay 终态永不到达 → 500ms 测试窗耗尽（真实面 = 20s > relay 15s 执行上限）
        val ws = FakeWs(connected = true, reply = { null })
        val r = ws.submitter.submit(connected = true, send = ws.send())
        assertEquals(WakeSubmit.Timeout, r)
        assertTrue("超时后挂起行必须清空（迟到帧无主即弃）", ws.pending.isEmpty())
    }

    @Test
    fun `wake wire frame carries no idempotency or queue face`() = runBlocking {
        val ws = FakeWs(connected = true) { RelayFrame.WakeResult(it, WakeResultStatus.SENT, latencyMs = 1L) }
        ws.submitter.submit(connected = true, send = ws.send())
        val sent = ws.sentFrames.single()
        assertTrue("wake 与 command 三段流本质不同：无幂等键面", !sent.contains("idempotencyKey"))
        assertTrue(!sent.contains("queued"))
        val obj = org.json.JSONObject(sent)
        val keys = mutableListOf<String>()
        val it = obj.keys()
        while (it.hasNext()) keys.add(it.next())
        assertEquals(setOf("type", "requestId"), keys.toSet())
    }
}
