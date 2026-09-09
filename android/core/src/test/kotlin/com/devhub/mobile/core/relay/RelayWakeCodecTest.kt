package com.devhub.mobile.core.relay

import org.json.JSONException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RW1 wake 帧对（#17 wake_host / #18 wake_result，docs/18 §3.17）的 :core 编解码测试：
 * - wake_host D→E 帧形（零业务字段——目标/端口/凭据全在 ECS 机器级层，帧面绝不携带）；
 * - wake_result 六态 round-trip 全覆盖（白名单枚举 + 附加字段按态）+ 畸形帧拒绝；
 * - 对齐 [RelaySelfMgmtCodecTest] 风格。wake 不入排队/幂等体系（无 idempotencyKey/queued 面）——
 *   帧模型缺省字段 = 帧面不带（绝不猜纪律）。
 */
class RelayWakeCodecTest {

    @Test
    fun `wake_host encodes exactly type plus requestId with zero business fields`() {
        val encoded = RelayCodec.encode(RelayFrame.WakeHost(requestId = "req-wake-1"))
        val obj = org.json.JSONObject(encoded)
        assertEquals("wake_host", obj.getString("type"))
        assertEquals("req-wake-1", obj.getString("requestId"))
        assertEquals("wake_host 帧面只允许 type+requestId 两键（零目标/端口/凭据承载）", 2, obj.length())
    }

    @Test
    fun `wake_host round-trips`() {
        val frame = RelayFrame.WakeHost(requestId = "b1e2c3d4-1111-4a5e-9a2b-000000000011")
        assertEquals(frame, RelayCodec.parse(RelayCodec.encode(frame)))
    }

    @Test
    fun `wake_result round-trips all six whitelisted statuses`() {
        val cases = listOf(
            RelayFrame.WakeResult(requestId = "r1", status = WakeResultStatus.SENT, latencyMs = 812L),
            RelayFrame.WakeResult(requestId = "r2", status = WakeResultStatus.ALREADY_ON),
            RelayFrame.WakeResult(requestId = "r3", status = WakeResultStatus.RATE_LIMITED, retryAfterMs = 9300L),
            RelayFrame.WakeResult(requestId = "r4", status = WakeResultStatus.DISABLED),
            RelayFrame.WakeResult(
                requestId = "r5",
                status = WakeResultStatus.EXEC_FAILED,
                latencyMs = 210L,
                stderrSummary = "ssh: connect to host 127.0.0.1 port 2222: Connection refused",
            ),
            RelayFrame.WakeResult(requestId = "r6", status = WakeResultStatus.TIMEOUT, latencyMs = 15000L),
        )
        for (model in cases) {
            val decoded = RelayCodec.parse(RelayCodec.encode(model))
            assertTrue(decoded is RelayFrame.WakeResult)
            assertEquals("status=${model.status}", model, decoded)
        }
    }

    @Test
    fun `wake_result wire values match docs 18 section 3_17 exactly`() {
        assertEquals("sent", WakeResultStatus.SENT.wire)
        assertEquals("already_on", WakeResultStatus.ALREADY_ON.wire)
        assertEquals("rate_limited", WakeResultStatus.RATE_LIMITED.wire)
        assertEquals("disabled", WakeResultStatus.DISABLED.wire)
        assertEquals("exec_failed", WakeResultStatus.EXEC_FAILED.wire)
        assertEquals("timeout", WakeResultStatus.TIMEOUT.wire)
        assertEquals(6, WakeResultStatus.entries.size)
    }

    @Test
    fun `wake_result optional fields are absent on the wire when null`() {
        val encoded = RelayCodec.encode(RelayFrame.WakeResult(requestId = "r2", status = WakeResultStatus.ALREADY_ON))
        assertFalse("缺省字段绝不写出猜测值", encoded.contains("latencyMs"))
        assertFalse(encoded.contains("retryAfterMs"))
        assertFalse(encoded.contains("stderrSummary"))
        val decoded = RelayCodec.parse(encoded) as RelayFrame.WakeResult
        assertNull(decoded.latencyMs)
        assertNull(decoded.retryAfterMs)
        assertNull(decoded.stderrSummary)
    }

    @Test
    fun `wake_result parses raw relay-shaped json with stderrSummary intact`() {
        val raw = """
            {"type":"wake_result","requestId":"uuid-e5","status":"exec_failed",
             "latencyMs":210,"stderrSummary":"ssh: connect to host 127.0.0.1 port 2222: Connection refused"}
        """.trimIndent()
        val decoded = RelayCodec.parse(raw) as RelayFrame.WakeResult
        assertEquals(WakeResultStatus.EXEC_FAILED, decoded.status)
        assertEquals(210L, decoded.latencyMs)
        assertTrue(decoded.stderrSummary!!.contains("Connection refused"))
    }

    @Test
    fun `wake frames malformed variants fail loudly instead of guessing`() {
        val bad = listOf(
            // wake_host：requestId 缺失 / 类型错
            """{"type":"wake_host"}""",
            """{"type":"wake_host","requestId":42}""",
            // wake_result：requestId 缺失 / status 缺失 / status 不在白名单 / status 类型错
            """{"type":"wake_result"}""",
            """{"type":"wake_result","requestId":"r1"}""",
            """{"type":"wake_result","requestId":"r1","status":"booting"}""",
            """{"type":"wake_result","requestId":"r1","status":7}""",
            // retryAfterMs 类型错（rate_limited 附加字段）
            """{"type":"wake_result","requestId":"r1","status":"rate_limited","retryAfterMs":"soon"}""",
        )
        for (text in bad) {
            var threw = false
            try {
                RelayCodec.parse(text)
            } catch (expected: JSONException) {
                threw = true
            }
            assertTrue("must reject: $text", threw)
        }
    }

    @Test
    fun `wake types join the codec type registry`() {
        assertTrue(RelayCodec.TYPE_WAKE_HOST in RelayCodec.ALL_TYPES)
        assertTrue(RelayCodec.TYPE_WAKE_RESULT in RelayCodec.ALL_TYPES)
        assertEquals(18, RelayCodec.ALL_TYPES.size)
    }
}
