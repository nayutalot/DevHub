package com.devhub.mobile.data.remote

import com.devhub.mobile.core.TlsPinningConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M3-C6d 修 1/修 2 单测（docs/19 §10.2 勘误语义覆盖 Gateway REST 数据面，与 WS/pair 面
 * 同语义——照 RelayPairTlsClientTest 风格）：
 * - 配 pinning + 有效 pinHost → client 装**自定义 pin TrustManager**（RelayTlsTrust
 *   .PinTrustManager，信任锚 = 指纹）且**零 pinner**（并装 = Android 对自定义 TM 链清洗
 *   返回空链 → 空洞拒连，C6c 实证）；回归面：旧实现此处 pinner-only（自签 IP 证书在
 *   系统信任层必败 "Trust anchor not found"）；
 * - pinning null / pinHost 空/非法（fail-fast 不注入）→ 全默认（无自定义 TM、无 pinner）；
 * - 生命周期（修 2）：tlsPinningProvider 驱动的缓存键重建——指纹配置变更换 client，
 *   键稳定复用同一实例（ApiProvider 单例永不持旧信任锚）。
 * 注：OkHttp 客户端层端到端握手不在 JVM 假装（链清洗平台差异，面界定见
 * TlsPinningOkHttpTest 头注）——本套件断言注入配置面 + 重建语义，pin-only 信任裁决
 * 语义已由 TlsPinningOkHttpTest 在裸 SSL 引擎上实证。
 */
class GatewayApiTlsTest {

    private fun fingerprint(byte: Int): String = "sha256/" + List(32) { String.format("%02x", byte) }.joinToString("")

    private fun api(pinning: TlsPinningConfig?, pinHost: String?): GatewayApi =
        GatewayApi(
            baseUrlProvider = { "https://59.110.149.11:443" },
            tokenProvider = { null },
            tlsPinning = pinning,
            pinHost = pinHost,
        )

    @Test
    fun `pinning with valid pinHost installs pin TrustManager and zero pinner pins`() {
        val client = api(TlsPinningConfig(listOf(fingerprint(0xAB), fingerprint(0xCD))), "59.110.149.11").client
        // 信任锚 = 配置指纹（pin-TM 单点裁决）；双指纹轮换窗口由 TM 内 pins 列表承载
        assertTrue(client.x509TrustManager is RelayTlsTrust.PinTrustManager)
        // 绝不并装 CertificatePinner（M3-C6c bug#1 勘误语义，docs/19 §10.2）
        assertEquals(0, client.certificatePinner.pins.size)
    }

    @Test
    fun `null pinning keeps all-default client`() {
        val client = api(null, null).client
        assertFalse(client.x509TrustManager is RelayTlsTrust.PinTrustManager)
        assertEquals(0, client.certificatePinner.pins.size)
    }

    @Test
    fun `pinHost null or malformed fail-fasts to no injection`() {
        for (host in listOf<String?>(null, "", "*", "1.2.3.4:443")) {
            val client = api(TlsPinningConfig(listOf(fingerprint(0xAB))), host).client
            assertFalse("pinHost=$host must not inject pin TM", client.x509TrustManager is RelayTlsTrust.PinTrustManager)
            assertEquals(0, client.certificatePinner.pins.size)
        }
    }

    @Test
    fun `provider driven client rebuilds on fingerprint change and stays stable otherwise`() {
        var pair: Pair<TlsPinningConfig?, String?> = null to null
        val api = GatewayApi(
            baseUrlProvider = { "https://59.110.149.11:443" },
            tokenProvider = { null },
            tlsPinningProvider = { pair },
        )
        val defaultClient = api.client
        assertFalse(defaultClient.x509TrustManager is RelayTlsTrust.PinTrustManager)

        // 配置指纹 → 缓存键变化 → 下一次访问重建为 pin-TM client（单例不持旧信任锚）
        pair = TlsPinningConfig(listOf(fingerprint(0xAB))) to "59.110.149.11"
        val pinnedClient = api.client
        assertTrue(pinnedClient.x509TrustManager is RelayTlsTrust.PinTrustManager)
        assertNotSame(defaultClient, pinnedClient)

        // 键稳定 → 复用同一实例（不重复构建连接池/线程面）
        assertSame(pinnedClient, api.client)

        // 轮换窗口新增指纹（旧+新）→ 再重建
        pair = TlsPinningConfig(listOf(fingerprint(0xAB), fingerprint(0xEF))) to "59.110.149.11"
        val rotatedClient = api.client
        assertTrue(rotatedClient.x509TrustManager is RelayTlsTrust.PinTrustManager)
        assertNotSame(pinnedClient, rotatedClient)

        // 指纹清空（配置回退）→ 回落全默认
        pair = null to null
        val fallback = api.client
        assertFalse(fallback.x509TrustManager is RelayTlsTrust.PinTrustManager)
        assertNotSame(rotatedClient, fallback)
    }

    @Test
    fun `provider pinning without resolvable pinHost stays un-injected`() {
        var pair: Pair<TlsPinningConfig?, String?> = TlsPinningConfig(listOf(fingerprint(0xAB))) to ""
        val api = GatewayApi(
            baseUrlProvider = { "https://59.110.149.11:443" },
            tokenProvider = { null },
            tlsPinningProvider = { pair },
        )
        assertFalse(api.client.x509TrustManager is RelayTlsTrust.PinTrustManager)
        assertEquals(0, api.client.certificatePinner.pins.size)
    }
}
