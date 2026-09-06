package com.devhub.mobile.core.relay

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M3-C3a 修 1 单测：relay 裸连接 pair 流（docs/18 §2/§3.2/§3.3/§8.2）。
 * - pair / pair_accepted 帧 round-trip（复用 RelayFrame.Pair codec）；
 * - 裸连接流状态机：hello → 发 pair → pair_accepted → 凭据；error 帧码域 → 结构化失败；
 *   10s 阶段超时；提前关闭；协议违例；终态幂等；未知帧静默。
 */
class RelayPairingTest {

    // ---- pair 帧 round-trip（codec 复用面） --------------------------------

    @Test
    fun `pair frame round-trip preserves all device-view fields`() {
        val frame = RelayFrame.Pair(
            requestId = "req-pair-1",
            code = "A3K7M9XY",
            deviceName = "Pixel 8",
            platform = "android",
            clientVersion = "1.0",
        )
        val parsed = RelayCodec.parse(RelayCodec.encode(frame)) as RelayFrame.Pair
        assertEquals(frame, parsed)
        // 设备视图绝不发送 E→H 中继变体字段（偏离②：可容忍解析，但 D→E 编码不写出）
        val obj = JSONObject(RelayCodec.encode(frame))
        assertEquals(true, !obj.has("ecsDeviceId") && !obj.has("pairingId"))
        assertEquals("pair", obj.getString("type"))
    }

    @Test
    fun `pair_accepted device view round-trip carries one-time token`() {
        val frame = RelayFrame.PairAccepted(
            requestId = "req-pair-1",
            deviceId = 12,
            deviceToken = "tok-256bit",
            tokenVersion = 1,
            heartbeatSec = 30,
        )
        val parsed = RelayCodec.parse(RelayCodec.encode(frame)) as RelayFrame.PairAccepted
        assertEquals(frame, parsed)
        // fixture 对拍（ecs-relay/test/fixtures/frames.json §3.3 设备视图字段名）
        val obj = JSONObject(RelayCodec.encode(frame))
        assertEquals(12L, obj.getLong("deviceId"))
        assertEquals(1, obj.getInt("tokenVersion"))
    }

    // ---- 状态机：正常流 -----------------------------------------------------

    @Test
    fun `happy path - hello then send pair then accepted yields credentials`() {
        val machine = RelayPairingMachine(code = "A3K7M9XY", deviceName = "Pixel 8", clientVersion = "1.0")
        assertEquals(RelayPairingMachine.State.AwaitingHello, machine.state)

        val step1 = machine.onEvent(RelayPairEvent.Hello(hello()))
        assertEquals(RelayPairingMachine.Step.SendPair, step1)
        assertEquals(RelayPairingMachine.State.AwaitingPairAccepted, machine.state)

        // SendPair 时刻即应发送构造期成形的 pair 帧；requestId 关联两帧（§3.2/§3.3）
        val sent = JSONObject(machine.pairRequestJson)
        assertEquals("pair", sent.getString("type"))
        assertEquals("A3K7M9XY", sent.getString("code"))
        assertEquals("Pixel 8", sent.getString("deviceName"))
        assertEquals("android", sent.getString("platform"))
        assertEquals(machine.requestId, sent.getString("requestId"))

        val accepted = RelayFrame.PairAccepted(
            requestId = machine.requestId,
            deviceId = 12,
            deviceToken = "tok",
            tokenVersion = 1,
            heartbeatSec = 30,
        )
        val step2 = machine.onEvent(RelayPairEvent.PairAccepted(accepted))
        assertTrue(step2 is RelayPairingMachine.Step.Succeeded)
        val cred = (step2 as RelayPairingMachine.Step.Succeeded).credentials
        assertEquals(12L, cred.deviceId)
        assertEquals("tok", cred.deviceToken)
        assertEquals(1, cred.tokenVersion)
        assertEquals(30, cred.heartbeatSec)
        assertEquals(RelayPairingMachine.State.Succeeded, machine.state)
    }

    @Test
    fun `unknown frames are silently absorbed while pairing`() {
        val machine = RelayPairingMachine("A3K7M9XY", "Pixel 8")
        machine.onEvent(RelayPairEvent.Hello(hello()))
        // register_pairing（偏离③ host 腿控制帧）/ heartbeat 等未知帧：静默不转移
        assertNull(machine.onEvent(RelayPairEvent.Hello(hello())))
        assertEquals(RelayPairingMachine.State.AwaitingPairAccepted, machine.state)
    }

    // ---- 状态机：失败路径 ---------------------------------------------------

    @Test
    fun `error frame with pairing code domain maps to structured failure`() {
        for (code in listOf("PAIRING_INVALID_CODE", "PAIRING_CODE_EXPIRED", "PAIRING_CODE_VOIDED", "AUTH_RATE_LIMITED")) {
            val machine = RelayPairingMachine("A3K7M9XY", "Pixel 8")
            machine.onEvent(RelayPairEvent.Hello(hello()))
            val step = machine.onEvent(
                RelayPairEvent.Error(RelayFrame.Error(code = code, message = "denied")),
            )
            assertTrue(step is RelayPairingMachine.Step.Failed)
            val failure = (step as RelayPairingMachine.Step.Failed).failure
            assertEquals(code, failure.code)
            assertTrue("文案须含码域 [$code]", failure.message.endsWith("[$code]"))
            assertEquals(RelayPairingMachine.State.Failed, machine.state)
        }
    }

    @Test
    fun `error frame before hello fails immediately`() {
        val machine = RelayPairingMachine("A3K7M9XY", "Pixel 8")
        val step = machine.onEvent(RelayPairEvent.Error(RelayFrame.Error(code = "RELAY_UPSTREAM_OFFLINE")))
        assertTrue(step is RelayPairingMachine.Step.Failed)
        assertEquals("RELAY_UPSTREAM_OFFLINE", (step as RelayPairingMachine.Step.Failed).failure.code)
        assertTrue((step).failure.message.contains("电脑端离线"))
    }

    @Test
    fun `hello timeout maps to RELAY_PAIR_TIMEOUT with 10s wording`() {
        val machine = RelayPairingMachine("A3K7M9XY", "Pixel 8")
        val step = machine.onEvent(RelayPairEvent.Timeout)
        assertTrue(step is RelayPairingMachine.Step.Failed)
        val failure = (step as RelayPairingMachine.Step.Failed).failure
        assertEquals("RELAY_PAIR_TIMEOUT", failure.code)
        assertTrue(failure.message.contains("10s"))
    }

    @Test
    fun `pair answer timeout maps to RELAY_UPSTREAM_TIMEOUT`() {
        val machine = RelayPairingMachine("A3K7M9XY", "Pixel 8")
        machine.onEvent(RelayPairEvent.Hello(hello()))
        val step = machine.onEvent(RelayPairEvent.Timeout)
        assertTrue(step is RelayPairingMachine.Step.Failed)
        assertEquals("RELAY_UPSTREAM_TIMEOUT", (step as RelayPairingMachine.Step.Failed).failure.code)
    }

    @Test
    fun `server close before pair sent surfaces pair-required style failure`() {
        // docs/18 §2：裸连接首帧非 pair 或 10s 未发 → 服务端 close(1000, "pair required")
        val machine = RelayPairingMachine("A3K7M9XY", "Pixel 8")
        val step = machine.onEvent(RelayPairEvent.Closed(wsCode = 1000, reason = "pair required"))
        assertTrue(step is RelayPairingMachine.Step.Failed)
        val failure = (step as RelayPairingMachine.Step.Failed).failure
        assertTrue(failure.message.contains("1000"))
        assertTrue(failure.message.contains("pair required"))
    }

    @Test
    fun `pair_accepted before hello is a protocol violation not silent success`() {
        val machine = RelayPairingMachine("A3K7M9XY", "Pixel 8")
        val step = machine.onEvent(
            RelayPairEvent.PairAccepted(
                RelayFrame.PairAccepted(
                    requestId = machine.requestId,
                    deviceId = 1,
                    deviceToken = "tok",
                    tokenVersion = 1,
                    heartbeatSec = null,
                ),
            ),
        )
        assertTrue(step is RelayPairingMachine.Step.Failed)
        assertEquals("BAD_PAYLOAD", (step as RelayPairingMachine.Step.Failed).failure.code)
        assertEquals(RelayPairingMachine.State.Failed, machine.state)
    }

    @Test
    fun `terminal states are idempotent`() {
        val machine = RelayPairingMachine("A3K7M9XY", "Pixel 8")
        machine.onEvent(RelayPairEvent.Hello(hello()))
        machine.onEvent(RelayPairEvent.Timeout)
        assertEquals(RelayPairingMachine.State.Failed, machine.state)
        assertNull(machine.onEvent(RelayPairEvent.Hello(hello())))
        assertNull(machine.onEvent(RelayPairEvent.Timeout))
    }

    // ---- §8.2 文案映射兜底 ---------------------------------------------------

    @Test
    fun `failure message fallback for unknown and missing codes`() {
        assertEquals("RELAY_UPSTREAM_OFFLINE", RelayPairing.failureMessage("RELAY_UPSTREAM_OFFLINE", null).code)
        val unknown = RelayPairing.failureMessage("SOME_FUTURE_CODE", "detail")
        assertEquals("SOME_FUTURE_CODE", unknown.code)
        assertTrue(unknown.message.contains("detail"))
        val codeless = RelayPairing.failureMessage(null, null)
        assertEquals("RELAY_PAIR_FAILED", codeless.code)
    }

    private fun hello() = RelayFrame.Hello(
        sequence = 14871,
        deviceId = null, // 裸 pair 连接 deviceId 缺省（docs/18 §3.1）
        heartbeatSec = 30,
        relayVersion = "1.0.0",
        upstream = "connected",
    )
}
