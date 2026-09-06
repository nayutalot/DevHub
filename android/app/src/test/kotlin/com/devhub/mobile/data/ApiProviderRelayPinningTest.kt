package com.devhub.mobile.data

import com.devhub.mobile.data.db.GatewayConfigEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * M3-C6d 修 2 单测：ApiProvider relay 模式 REST 面 pinning 解析（[ApiProvider.relayPinning]
 * 纯函数面；docs/19 §10.2，与 ConnectionManager.parsePinning **同源同规则**——internal
 * 直调，拆分规则绝不复制粘贴）：
 * - relay + 指纹已配置 → (pinning, 具体 host pattern)——GatewayApi pin-TM 注入物料；
 * - local / 未配置 / endpoint 非法 / 指纹为空 → 不启用 pinning（零回归 / 防御回落）；
 * - 指纹条目非法 → 防御回落不抛出（连接层 refreshCachedConfig 对同一配置经
 *   `_lastWsError` 显式暴露；https + 系统默认信任下自签 IP 证书握手必然显式失败，
 *   绝不静默降级为「连上但不校验」）。
 */
class ApiProviderRelayPinningTest {

    private fun config(
        mode: String = "relay",
        relayUrl: String? = "wss://59.110.149.11",
        pinFingerprints: String? = null,
    ): GatewayConfigEntity = GatewayConfigEntity(
        host = "10.0.2.2",
        port = 8746,
        mode = mode,
        relayUrl = relayUrl,
        pinFingerprints = pinFingerprints,
    )

    private fun fingerprint(byte: Int): String = "sha256/" + List(32) { String.format("%02x", byte) }.joinToString("")

    @Test
    fun `relay mode with configured fingerprints yields pinning and concrete host pattern`() {
        val (pinning, pinHost) = ApiProvider.relayPinning(config(pinFingerprints = fingerprint(0xAB)))
        // pinHost = endpoint.host 经 :core pinPatternFor（IP 字面量直接作 pattern，与
        // ConnectionManager.rebuildRelayClients 同形态）
        assertEquals(listOf(fingerprint(0xAB)), pinning!!.fingerprints)
        assertEquals("59.110.149.11", pinHost)
    }

    @Test
    fun `fingerprint list splits on comma newline semicolon with trim and dedup - same rule as ConnectionManager`() {
        val raw = "${fingerprint(0xAB)} ,\n${fingerprint(0xCD)};${fingerprint(0xAB)}"
        val (pinning, pinHost) = ApiProvider.relayPinning(config(pinFingerprints = raw))
        assertEquals(listOf(fingerprint(0xAB), fingerprint(0xCD)), pinning!!.fingerprints)
        assertEquals("59.110.149.11", pinHost)
    }

    @Test
    fun `local mode and null config never enable pinning`() {
        assertEquals(null to null, ApiProvider.relayPinning(config(mode = "local", pinFingerprints = fingerprint(0xAB))))
        assertEquals(null to null, ApiProvider.relayPinning(null))
    }

    @Test
    fun `relay mode without fingerprints keeps system default trust`() {
        assertEquals(null to null, ApiProvider.relayPinning(config()))
        assertEquals(null to null, ApiProvider.relayPinning(config(pinFingerprints = "  ")))
    }

    @Test
    fun `relay mode with unparseable endpoint falls back defensively to no pinning`() {
        // 非 wss（保存层已拦）或缺失 relayUrl：防御态回落，绝不抛出
        assertEquals(null to null, ApiProvider.relayPinning(config(relayUrl = "http://nope", pinFingerprints = fingerprint(0xAB))))
        assertEquals(null to null, ApiProvider.relayPinning(config(relayUrl = null, pinFingerprints = fingerprint(0xAB))))
    }

    @Test
    fun `malformed fingerprint entries fall back defensively without throwing`() {
        // TlsPinningConfig fail-fast（缺前缀/长度错）在 REST 面必须转防御回落，绝不让
        // UI 请求路径崩溃（原因暴露职责在连接层 _lastWsError）
        val (pinning, pinHost) = ApiProvider.relayPinning(config(pinFingerprints = "not-a-fingerprint"))
        assertNull(pinning)
        assertNull(pinHost)
    }
}
