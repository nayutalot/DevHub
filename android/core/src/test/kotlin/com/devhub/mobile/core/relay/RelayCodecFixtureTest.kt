package com.devhub.mobile.core.relay

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RelayCodec 16 帧 round-trip 对拍 fixture（docs/20 §2.4：R3×R2 同帧集双端解析一致，防漂移）。
 * fixture = ecs-relay/test/fixtures/frames.json 的只读镜像（随 143ccad 落 core test resources）。
 * 对拍基准 = 偏离单（ecs-relay/README.md）：①event 双 type 键裁定 ②token_rotation 携 deviceId
 * ③register_pairing host 腿控制帧（App 认识并忽略）⑤queued ack。
 */
class RelayCodecFixtureTest {

    private fun fixture(): JSONObject {
        val stream = javaClass.getResourceAsStream("/relay/frames-fixture.json")
            ?: error("fixture resource missing: /relay/frames-fixture.json")
        return JSONObject(stream.bufferedReader(Charsets.UTF_8).readText())
    }

    private fun typeName(f: RelayFrame): String = when (f) {
        is RelayFrame.Hello -> RelayCodec.TYPE_HELLO
        is RelayFrame.Pair -> RelayCodec.TYPE_PAIR
        is RelayFrame.PairAccepted -> RelayCodec.TYPE_PAIR_ACCEPTED
        is RelayFrame.AgentList -> RelayCodec.TYPE_AGENT_LIST
        is RelayFrame.SessionList -> RelayCodec.TYPE_SESSION_LIST
        is RelayFrame.Event -> RelayCodec.TYPE_EVENT
        is RelayFrame.MessagePage -> RelayCodec.TYPE_MESSAGE
        is RelayFrame.Command -> RelayCodec.TYPE_COMMAND
        is RelayFrame.CommandAck -> RelayCodec.TYPE_COMMAND_ACK
        is RelayFrame.CommandResult -> RelayCodec.TYPE_COMMAND_RESULT
        is RelayFrame.SyncRequest -> RelayCodec.TYPE_SYNC_REQUEST
        is RelayFrame.SyncResponse -> RelayCodec.TYPE_SYNC_RESPONSE
        is RelayFrame.Heartbeat -> RelayCodec.TYPE_HEARTBEAT
        is RelayFrame.TokenRotation -> RelayCodec.TYPE_TOKEN_ROTATION
        is RelayFrame.Disconnect -> RelayCodec.TYPE_DISCONNECT
        is RelayFrame.Error -> RelayCodec.TYPE_ERROR
        is RelayFrame.Unknown -> f.type
    }

    /** 模型级 round-trip：decode → encode → decode 必须得到等值模型（payload 以文本比）。 */
    private fun assertRoundTrip(model: RelayFrame) {
        val reparsed = RelayCodec.parse(RelayCodec.encode(model))
        when (model) {
            is RelayFrame.Event -> {
                val other = reparsed as RelayFrame.Event
                assertEquals(model.sequence, other.sequence)
                assertEquals(model.eventId, other.eventId)
                assertEquals(model.deviceId, other.deviceId)
                assertEquals(model.provider, other.provider)
                assertEquals(model.sessionId, other.sessionId)
                assertEquals(model.eventType, other.eventType)
                assertEquals(model.timestampSec, other.timestampSec)
                assertEquals(model.summary, other.summary)
                assertEquals(model.payload.toString(), other.payload.toString())
                assertEquals(model.requiresUserAction, other.requiresUserAction)
            }

            is RelayFrame.Command -> {
                val other = reparsed as RelayFrame.Command
                assertEquals(model.requestId, other.requestId)
                assertEquals(model.idempotencyKey, other.idempotencyKey)
                assertEquals(model.sessionId, other.sessionId)
                assertEquals(model.action, other.action)
                assertEquals(model.payload.toString(), other.payload.toString())
                assertEquals(model.token, other.token)
                assertEquals(model.tsSec, other.tsSec)
                assertEquals(model.nonce, other.nonce)
                assertEquals(model.createdAtSec, other.createdAtSec)
            }

            else -> assertEquals(model, reparsed)
        }
    }

    /**
     * 设备腿样本过滤：App 只消费 D→E / E→D 面。host 腿视图（hello host / pair ecs-to-host /
     * pair_accepted host-to-ecs 等）不是设备腿 wire format，不入设备解析对拍
     * （command_ack 三态与 command_result 形状两腿一致，单列白名单）。
     */
    private fun isDeviceLegSample(type: String, leg: String): Boolean =
        leg.contains("device") ||
            (type == "command_ack" && leg in setOf("accepted", "rejected", "queued")) ||
            (type == "command_result") ||
            (type == "error" && leg == "connection-level")

    @Test
    fun `all 16 frame types parse from device-leg fixture samples`() {
        val frames = fixture().getJSONArray("frames")
        assertEquals("fixture 正集必须为 16 帧", 16, frames.length())
        val seen = HashSet<String>()
        for (i in 0 until frames.length()) {
            val entry = frames.getJSONObject(i)
            val samples = entry.getJSONArray("samples")
            for (j in 0 until samples.length()) {
                val sample = samples.getJSONObject(j)
                if (!isDeviceLegSample(entry.getString("type"), sample.getString("leg"))) continue
                val frame = sample.getJSONObject("frame")
                val parsed = RelayCodec.parse(frame.toString())
                assertEquals("frame#${entry.getInt("no")} ${entry.getString("type")}", entry.getString("type"), typeName(parsed))
                seen.add(entry.getString("type"))
                assertRoundTrip(parsed)
            }
        }
        assertEquals(RelayCodec.ALL_TYPES.toSet(), seen)
    }

    @Test
    fun `event frame follows deviation 1 - discriminator type event plus eventType field`() {
        val evt = findSample("event", "ecs-to-device") as RelayFrame.Event
        assertEquals(14871L, evt.sequence) // docs/18 §4.1：seq → sequence 改名
        assertEquals("session.waiting_input", evt.eventType) // 偏离①：事件类型在 eventType
        assertEquals(1757000000L, evt.timestampSec) // docs/18 §4.1：createdAt → timestamp
        assertEquals("codex", evt.provider)
        assertEquals(337L, evt.sessionId)
        assertEquals(4L, evt.deviceId)
        assertTrue(evt.requiresUserAction)
    }

    @Test
    fun `sync_response page carries events with hasGaps flag`() {
        val page = findSample("sync_response", "ecs-to-device") as RelayFrame.SyncResponse
        assertEquals(14860L, page.upTo)
        assertTrue(page.hasMore)
        assertEquals(false, page.hasGaps)
        assertEquals(1, page.events.size)
        assertEquals("message.appended", page.events.first().eventType)
    }

    @Test
    fun `token_rotation may carry deviceId per deviation 2`() {
        val hostSide = findSample("token_rotation", "host-to-ecs") as RelayFrame.TokenRotation
        assertEquals(12L, hostSide.deviceId) // 偏离②：H→E 必携 deviceId 路由
        assertEquals(2, hostSide.tokenVersion)
        assertEquals("post-pairing", hostSide.reason)
        val deviceSide = findSample("token_rotation", "ecs-to-device") as RelayFrame.TokenRotation
        assertEquals(2, deviceSide.tokenVersion)
    }

    @Test
    fun `command frame embeds end-to-end auth untouched`() {
        val cmd = findSample("command", "device-to-ecs") as RelayFrame.Command
        assertEquals("send_message", cmd.action)
        assertEquals(337L, cmd.sessionId)
        assertEquals("继续", cmd.payload.optString("text"))
        assertNotNull(cmd.token)
        assertEquals(1757000000L, cmd.tsSec)
        assertNotNull(cmd.nonce)
    }

    @Test
    fun `command_ack queued variant per deviation 5`() {
        val queued = findSample("command_ack", "queued") as RelayFrame.CommandAck
        assertEquals("accepted", queued.status)
        assertTrue(queued.queued)
        assertEquals("b1e2c3d4-1111-4a5e-9a2b-000000000008", queued.idempotencyKey)
        val rejected = findSample("command_ack", "rejected") as RelayFrame.CommandAck
        assertEquals("rejected", rejected.status)
        assertEquals("AGENT_CAPABILITY_MISSING", rejected.errorCode)
    }

    @Test
    fun `hello carries upstream beacon and optional deviceId`() {
        val authed = findSample("hello", "device-authenticated") as RelayFrame.Hello
        assertEquals(14871L, authed.sequence)
        assertEquals(4L, authed.deviceId)
        assertEquals("connected", authed.upstream)
        assertEquals(30, authed.heartbeatSec)
        val bare = findSample("hello", "device-bare") as RelayFrame.Hello
        assertEquals(null, bare.deviceId)
        assertEquals("disconnected", bare.upstream)
    }

    @Test
    fun `heartbeat variants merge into one model without phantom fields`() {
        val up = findSample("heartbeat", "device-to-ecs") as RelayFrame.Heartbeat
        assertEquals(14800L, up.lastAckedSeq)
        assertEquals(1, up.tokenVersion)
        assertEquals(null, up.upstream)
        assertEquals(null, up.lastSentSeq)
    }

    @Test
    fun `pair_accepted delivers one-time device token`() {
        val acc = findSample("pair_accepted", "ecs-to-device") as RelayFrame.PairAccepted
        assertEquals(12L, acc.deviceId)
        assertEquals(1, acc.tokenVersion)
        assertTrue(acc.deviceToken.startsWith("<256-bit"))
    }

    @Test
    fun `disconnect and error frames parse with optional correlation`() {
        val revoked = findSample("disconnect", "ecs-to-device-revoked") as RelayFrame.Disconnect
        assertEquals("revoked", revoked.reason)
        val err = findSample("error", "ecs-to-device") as RelayFrame.Error
        assertEquals("RELAY_UPSTREAM_OFFLINE", err.code)
        assertTrue(err.retryable)
        assertEquals(30, err.retryAfterSec)
        val connLevel = findSample("error", "connection-level") as RelayFrame.Error
        assertEquals(null, connLevel.requestId)
        assertEquals("INTERNAL", connLevel.code)
    }

    @Test
    fun `agent_list and session_list shapes parse`() {
        val agents = findSample("agent_list", "ecs-to-device") as RelayFrame.AgentList
        assertEquals(1, agents.providers.size)
        assertEquals("codex", agents.providers.first().id)
        assertEquals(listOf("reply", "pause", "resume"), agents.providers.first().granted)
        val sessions = findSample("session_list", "ecs-to-device") as RelayFrame.SessionList
        assertEquals(false, sessions.stale)
        assertEquals(337L, sessions.sessions.first().id)
        assertEquals("waiting_input", sessions.sessions.first().status)
    }

    /** 偏离③：host 腿控制帧（register_pairing 等）不在 16 帧面——设备腿认识并按 Unknown 忽略。 */
    @Test
    fun `host control frames are recognized and ignored as unknown`() {
        val extras = fixture().getJSONArray("hostControlFrames")
        assertTrue(extras.length() >= 1)
        for (i in 0 until extras.length()) {
            val entry = extras.getJSONObject(i)
            val sample = entry.getJSONArray("samples").getJSONObject(0).getJSONObject("frame")
            val parsed = RelayCodec.parse(sample.toString())
            assertTrue(parsed is RelayFrame.Unknown)
            assertEquals(entry.getString("type"), (parsed as RelayFrame.Unknown).type)
        }
    }

    /** 必填字段缺失/类型错 → 解析失败上抛（绝不猜纪律），绝不静默吞掉当成功。 */
    @Test
    fun `malformed frames fail loudly instead of guessing`() {
        for (bad in listOf("{}", """{"type":"event","sequence":1}""", """{"type":"pair"}""")) {
            var threw = false
            try {
                RelayCodec.parse(bad)
            } catch (expected: Exception) {
                threw = true
            }
            assertTrue("must reject: $bad", threw)
        }
    }

    @Test
    fun `unknown type parses as unknown and survives encode`() {
        val parsed = RelayCodec.parse("""{"type":"future_frame","x":1}""")
        assertTrue(parsed is RelayFrame.Unknown)
        assertEquals("future_frame", (parsed as RelayFrame.Unknown).type)
        val reparsed = RelayCodec.parse(RelayCodec.encode(parsed))
        assertEquals(parsed, reparsed)
    }

    private fun findSample(type: String, leg: String): RelayFrame {
        val frames = fixture().getJSONArray("frames")
        for (i in 0 until frames.length()) {
            val entry = frames.getJSONObject(i)
            if (entry.getString("type") != type) continue
            val samples = entry.getJSONArray("samples")
            for (j in 0 until samples.length()) {
                val s = samples.getJSONObject(j)
                if (s.getString("leg") == leg) {
                    return RelayCodec.parse(s.getJSONObject("frame").toString())
                }
            }
        }
        error("sample not found: $type/$leg")
    }
}
