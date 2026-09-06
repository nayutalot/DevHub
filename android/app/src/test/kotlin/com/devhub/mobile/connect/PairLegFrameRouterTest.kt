package com.devhub.mobile.connect

import com.devhub.mobile.core.relay.RelayCodec
import com.devhub.mobile.core.relay.RelayFrame
import com.devhub.mobile.core.relay.RelayPairEvent
import com.devhub.mobile.core.relay.RelayPairingMachine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M3-C6c bug#3 单测：pair 腿帧路由（fake WS 帧泵——JSON 文本帧序列经 RelayCodec.parse
 * 直喂 [PairLegFrameRouter.onFrame]，等价传输层 onMessage 管线）。
 *
 * 回归面（C2c 三设备 #38/39/40 确定性复现）：Windows post-pairing 自动轮换使 token_rotation
 * 与 pair_accepted 同秒背靠背到达 pair 裸连接——旧实现 `else -> Unit` 丢弃 → App 恒持 v1，
 * 300s grace 到期 grace_expired denied → onAuthFatal 清凭据（系统性自毁）。现路由必须：
 * - token_rotation → rotation 捕获（绝不丢弃、绝不喂状态机）；
 * - 配对主流事件语义零回退（hello/pair_accepted/error/disconnect）；
 * - rotation 混入主流（hello 与 pair_accepted 之间 / 之后）绝不破坏配对流。
 *
 * 协议空白点标注：docs/18 §3.14 未定义 token_rotation 的投递通道（仅写「Android 收帧」）；
 * 本实现按「pair WS 与常规 WS 两腿都处理」落地（常规腿 = ConnectionManager.applyTokenRotation，
 * 已有 :core RelayTokenRotationTest 覆盖决策面）；建议 docs/18 §3.14 增补投递通道语义。
 */
class PairLegFrameRouterTest {

    private class Sink {
        val machineEvents = mutableListOf<RelayPairEvent>()
        val rotations = mutableListOf<RelayFrame.TokenRotation>()

        val router = PairLegFrameRouter(
            onMachineEvent = { machineEvents.add(it) },
            onRotation = { rotations.add(it) },
        )

        /** fake WS 帧泵：服务端发来的 JSON 文本帧 → codec → router（等价 WS onMessage）。 */
        fun pump(text: String) = router.onFrame(RelayCodec.parse(text))
    }

    private fun helloJson() =
        RelayCodec.encode(
            RelayFrame.Hello(
                sequence = 14871,
                deviceId = null, // 裸 pair 连接 deviceId 缺省（docs/18 §3.1）
                heartbeatSec = 30,
                relayVersion = "1.0.0",
                upstream = "connected",
            ),
        )

    private fun rotationJson(version: Int = 2, token: String = "tok-v2") =
        RelayCodec.encode(
            RelayFrame.TokenRotation(
                requestId = "req-rot-1",
                deviceId = 7,
                newToken = token,
                tokenVersion = version,
                reason = "post-pairing",
            ),
        )

    @Test
    fun `token_rotation frame on pair leg is captured - never dropped again`() {
        val sink = Sink()
        sink.pump(rotationJson())
        // C2c 根因回归：该帧曾走 else -> Unit 丢弃分支 → App 恒持 v1
        assertEquals(1, sink.rotations.size)
        assertEquals(2, sink.rotations[0].tokenVersion)
        assertEquals("tok-v2", sink.rotations[0].newToken)
        assertEquals(7L, sink.rotations[0].deviceId)
        // 绝不喂状态机（rotation 不是配对流事件，终态机不得被扰动）
        assertEquals(0, sink.machineEvents.size)
    }

    @Test
    fun `same-second rotation between hello and pair_accepted - pairing still succeeds`() {
        val machine = RelayPairingMachine(code = "A3K7M9XY", deviceName = "Pixel 8", clientVersion = "1.0")
        val rotations = mutableListOf<RelayFrame.TokenRotation>()
        val router = PairLegFrameRouter(
            onMachineEvent = { machine.onEvent(it) },
            onRotation = { rotations.add(it) },
        )
        fun pump(text: String) = router.onFrame(RelayCodec.parse(text))

        // 复刻 C2c 同秒背靠背时间线：hello → token_rotation → pair_accepted
        pump(helloJson())
        assertEquals(RelayPairingMachine.State.AwaitingPairAccepted, machine.state)
        pump(rotationJson())
        pump(
            RelayCodec.encode(
                RelayFrame.PairAccepted(
                    requestId = machine.requestId,
                    deviceId = 7,
                    deviceToken = "tok-v1",
                    tokenVersion = 1,
                    heartbeatSec = 30,
                ),
            ),
        )
        assertEquals(RelayPairingMachine.State.Succeeded, machine.state)
        assertEquals(1, rotations.size)
        assertEquals(2, rotations[0].tokenVersion)
    }

    @Test
    fun `rotation arriving before hello is held - machine still waits for hello`() {
        val sink = Sink()
        sink.pump(rotationJson()) // 理论乱序（帧先于 hello）：捕获持有，绝不扰动状态机
        assertEquals(1, sink.rotations.size)
        assertTrue(sink.machineEvents.isEmpty())
        sink.pump(helloJson())
        assertEquals(1, sink.machineEvents.size)
        assertTrue(sink.machineEvents.single() is RelayPairEvent.Hello)
    }

    @Test
    fun `non-pairing frames stay silent and disconnect maps to closed event`() {
        val sink = Sink()
        sink.pump(RelayCodec.encode(RelayFrame.Heartbeat(ts = 1)))
        sink.pump("""{"type":"register_pairing","requestId":"x"}""") // host 腿控制帧 → Unknown 静默
        assertEquals(0, sink.machineEvents.size)
        assertEquals(0, sink.rotations.size)
        sink.pump(RelayCodec.encode(RelayFrame.Disconnect(reason = "maintenance")))
        val closed = sink.machineEvents.single() as RelayPairEvent.Closed
        assertEquals(1000, closed.wsCode)
        assertEquals("disconnect:maintenance", closed.reason)
    }

    @Test
    fun `success outcome carries captured rotations with empty default`() {
        // Outcome.Success 契约面：pendingRotations 缺省空（既有调用点零改动）；捕获帧原样携带
        val success = RelayPairingClient.Outcome.Success(
            deviceId = 7,
            token = "tok-v1",
            tokenVersion = 1,
            heartbeatSec = 30,
            relayHost = "59.110.149.11",
        )
        assertEquals(0, success.pendingRotations.size)
        val frame = RelayFrame.TokenRotation(newToken = "tok-v2", tokenVersion = 2, deviceId = 7)
        val withRotation = success.copy(pendingRotations = listOf(frame))
        assertEquals(listOf(frame), withRotation.pendingRotations)
    }
}
