package com.devhub.mobile.core.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** relay endpoint wss 强制（docs/19 §11）+ ack/error 分类（偏离⑤）+ 五值 action 值域。 */
class RelayEndpointAndClassifierTest {

    // ---- RelayEndpoint ----

    @Test
    fun `parses wss endpoint with explicit port`() {
        val e = RelayEndpoint.parse("wss://59.110.149.11:18443")
        assertEquals("59.110.149.11", e.host)
        assertEquals(18443, e.port)
        assertEquals("wss://59.110.149.11:18443/relay/device", e.deviceWsUrl)
        assertEquals("https://59.110.149.11:18443", e.restBaseUrl)
    }

    @Test
    fun `parses wss endpoint default port and path suffix`() {
        val e = RelayEndpoint.parse("wss://59.110.149.11/")
        assertEquals(443, e.port)
        assertEquals("wss://59.110.149.11/relay/device", e.deviceWsUrl)
    }

    @Test
    fun `rejects plaintext ws with docs19 section 11 reason`() {
        for (bad in listOf("ws://59.110.149.11", "http://59.110.149.11", "59.110.149.11", "")) {
            val err = runCatching { RelayEndpoint.parse(bad) }.exceptionOrNull()
            assertTrue("must reject: '$bad'", err is IllegalArgumentException)
            assertEquals(RelayEndpoint.REJECT_REASON, err?.message)
        }
    }

    @Test
    fun `rejects malformed wss endpoints`() {
        for (bad in listOf("wss://", "wss://host:0", "wss://host:99999", "wss://host:abc")) {
            assertTrue("must reject: '$bad'", runCatching { RelayEndpoint.parse(bad) }.isFailure)
        }
    }

    @Test
    fun `rejects path-bearing endpoint with bare-address reason (KC batch 404 trap)`() {
        // RD 批 404 陷阱：parse 曾静默接受带路径输入 → deviceWsUrl 双拼 /relay/device
        for (bad in listOf(
            "wss://59.110.149.11/relay/device",
            "wss://59.110.149.11:18443/relay/device",
            "wss://relay.example.test/sub/path",
        )) {
            val err = runCatching { RelayEndpoint.parse(bad) }.exceptionOrNull()
            assertTrue("must reject path-bearing: '$bad'", err is IllegalArgumentException)
            assertEquals(RelayEndpoint.REJECT_REASON_PATH, err?.message)
        }
    }

    @Test
    fun `bare address still passes and device path is appended exactly once (KC batch)`() {
        val e = RelayEndpoint.parse("wss://relay.example.test:8443")
        assertEquals("relay.example.test", e.host)
        assertEquals(8443, e.port)
        assertEquals("wss://relay.example.test:8443/relay/device", e.deviceWsUrl)
        // 裸尾斜杠归一剥除（既有语义保持）：非路径，不拒绝
        val trailing = RelayEndpoint.parse("wss://relay.example.test/")
        assertEquals("wss://relay.example.test/relay/device", trailing.deviceWsUrl)
    }

    // ---- RelayCommandClassifier（偏离⑤：queued → 挂起重试） ----

    @Test
    fun `accepted ack without queued flag means sent`() {
        assertEquals(RelayAckVerdict.ACCEPTED, RelayCommandClassifier.classifyAck("accepted", queued = false))
    }

    @Test
    fun `queued ack holds the retry per deviation 5`() {
        assertEquals(RelayAckVerdict.QUEUED_HOLD, RelayCommandClassifier.classifyAck("accepted", queued = true))
    }

    @Test
    fun `rejected ack drops with structured error`() {
        assertEquals(RelayAckVerdict.REJECTED_DROP, RelayCommandClassifier.classifyAck("rejected", queued = false))
    }

    @Test
    fun `unknown ack status never guesses success`() {
        assertEquals(RelayAckVerdict.RETRY, RelayCommandClassifier.classifyAck("maybe", queued = false))
        assertEquals(RelayAckVerdict.RETRY, RelayCommandClassifier.classifyAck("", queued = false))
    }

    @Test
    fun `error frame classification follows retryability and code domain`() {
        assertEquals(RelayAckVerdict.RETRY, RelayCommandClassifier.classifyError("RELAY_UPSTREAM_OFFLINE", retryable = true))
        assertEquals(RelayAckVerdict.RETRY, RelayCommandClassifier.classifyError("RELAY_QUEUE_FULL", retryable = false))
        assertEquals(RelayAckVerdict.RETRY, RelayCommandClassifier.classifyError("SOMETHING_NEW", retryable = false))
        assertEquals(RelayAckVerdict.REJECTED_DROP, RelayCommandClassifier.classifyError("COMMAND_EXPIRED", retryable = false))
        assertEquals(RelayAckVerdict.REJECTED_DROP, RelayCommandClassifier.classifyError("AGENT_CAPABILITY_MISSING", retryable = false))
        assertEquals(RelayAckVerdict.REJECTED_DROP, RelayCommandClassifier.classifyError("COMMAND_KEY_CONFLICT", retryable = false))
    }

    // ---- RelayActions（docs/18 §5.1 五值 + §5.3 设备自管理两值 + S 批查询一值锁死，就地更新） ----

    @Test
    fun `action set is locked to eight values with reply renaming (M3-E self-mgmt two values + S batch query one value)`() {
        assertEquals(setOf("send_message", "approve", "pause", "resume", "interrupt", "spawn_session", "revoke_device", "workspace_link"), RelayActions.ALL)
        assertEquals("send_message", RelayActions.fromKind("reply"))
        assertEquals("pause", RelayActions.fromKind("pause"))
        assertEquals("resume", RelayActions.fromKind("resume"))
        assertEquals("approve", RelayActions.fromKind("approve"))
        assertEquals("interrupt", RelayActions.fromKind("interrupt"))
        assertEquals("spawn_session", RelayActions.fromKind("spawn_session"))
        assertEquals("revoke_device", RelayActions.fromKind("revoke_device"))
        assertEquals("workspace_link", RelayActions.fromKind("workspace_link"))
        assertNull(RelayActions.fromKind("exec"))
        assertNull(RelayActions.fromKind("shell"))
    }

    // ---- SelfRevokeFlow（M3-E1：revoke_device 收口状态机，docs/18 §5.3/§3.15） ----

    @Test
    fun `self revoke ack classification follows accepted semantics`() {
        assertEquals(SelfRevokeFlow.Step.AWAIT_CLOSURE, SelfRevokeFlow.onAck("accepted", queued = false))
        assertEquals(SelfRevokeFlow.Step.QUEUED_HOLD, SelfRevokeFlow.onAck("accepted", queued = true))
        assertEquals(SelfRevokeFlow.Step.FAILED, SelfRevokeFlow.onAck("rejected", queued = false))
        // 绝不猜：未知 status 留在等待（超时由调用方收口）
        assertEquals(SelfRevokeFlow.Step.AWAIT_ACK, SelfRevokeFlow.onAck("maybe", queued = false))
    }

    @Test
    fun `self revoke closure is the disconnect-revoked auth-fatal code only`() {
        assertTrue(SelfRevokeFlow.isClosure("DEVICE_REVOKED"))
        assertFalse(SelfRevokeFlow.isClosure("AUTH_INVALID_TOKEN"))
        assertFalse(SelfRevokeFlow.isClosure(""))
    }

    @Test
    fun `tls pinning fingerprint model stays fail-fast for relay wiring`() {
        // Block 7 注入缝的前置合同（:core 模型；app 层 RelayTlsTrust pin-TM 消费）
        val hex = "ab".repeat(32) // 64 位十六进制 SPKI 指纹
        val cfg = com.devhub.mobile.core.TlsPinningConfig(listOf("sha256/$hex"))
        assertEquals(1, cfg.fingerprints.size)
        assertTrue(cfg.matches("sha256/${hex.uppercase()}")) // 大小写不敏感
        assertFalse(cfg.matches("sha256/" + "cd".repeat(32)))
        assertTrue(runCatching { com.devhub.mobile.core.TlsPinningConfig(emptyList()) }.isFailure)
        assertTrue(runCatching { com.devhub.mobile.core.TlsPinningConfig(listOf("sha256/AABB")) }.isFailure)
    }
}
