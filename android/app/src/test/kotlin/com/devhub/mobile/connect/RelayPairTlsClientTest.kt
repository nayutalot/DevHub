package com.devhub.mobile.connect

import com.devhub.mobile.core.TlsPinningConfig
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * M3-C6c bug#1 单测（C2c 实证：pin-TM 与 CertificatePinner 并装 → 空洞拒连）：
 * - pin-TM 激活（指纹已配置）→ pair 客户端 builder **不装** certificatePinner
 *   （信任判定单点 = PinTrustManager checkServerTrusted；docs/19 §10.2 实现层勘误）；
 * - 无指纹 → 全默认（无 pinning 面，同样零 pinner）。
 * M3-C6d：GatewayApi（REST 数据面）已同语义 pin-TM 化——其注入/生命周期面移至
 * GatewayApiTlsTest（`toCertificatePinner` pinner-only 旧面全量退役）。
 */
class RelayPairTlsClientTest {

    private fun fingerprint(byte: Int): String = "sha256/" + List(32) { String.format("%02x", byte) }.joinToString("")

    @Test
    fun `pin-TM active pair client installs no certificatePinner pins`() {
        val pinning = TlsPinningConfig(listOf(fingerprint(0xAB), fingerprint(0xCD)))
        val client = RelayPairingClient.relayPairClient(
            pinning = pinning,
            pinPattern = TlsPinningConfig.pinPatternFor("59.110.149.11"),
        )
        // 回归面：旧实现此处并装 pinner（pins.size == 2）→ Android 自定义 TM 链清洗返回
        // 空链 → check$okhttp 空链即拒（空洞拒连）。现信任判定单点 = checkServerTrusted。
        assertEquals(0, client.certificatePinner.pins.size)
    }

    @Test
    fun `no pinning pair client stays all-default without pinner`() {
        val client = RelayPairingClient.relayPairClient(pinning = null, pinPattern = null)
        assertEquals(0, client.certificatePinner.pins.size)
    }
}
