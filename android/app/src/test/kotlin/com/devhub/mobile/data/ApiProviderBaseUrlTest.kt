package com.devhub.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * M3-C6c bug#2 单测：REST base 按连接模式切换（C2c 实录：relay 模式列表/设备/自撤销全打
 * 桌面网关 10.0.2.2:8746 得 AUTH_INVALID_TOKEN）。[ApiProvider.modeAwareBaseUrl] 纯函数面：
 * - local / 未配置 → 桌面网关 base（原语义零回归，缺省 10.0.2.2:8746）；
 * - relay → ECS REST base（`https://<host>:<port>`，docs/18 §7.1，与 ConnectionManager
 *   relayApi 同形态）；
 * - relay 且 endpoint 非法（保存层已拦，防御态）→ 回落本地 base（绝不抛出崩溃）。
 */
class ApiProviderBaseUrlTest {

    @Test
    fun `local mode keeps desktop gateway base`() {
        assertEquals("http://10.0.2.2:8746", ApiProvider.modeAwareBaseUrl("local", "10.0.2.2", 8746, null))
        assertEquals("http://192.168.1.10:8746", ApiProvider.modeAwareBaseUrl("local", "192.168.1.10", 8746, "wss://59.110.149.11"))
    }

    @Test
    fun `null config falls back to emulator default base`() {
        assertEquals("http://10.0.2.2:8746", ApiProvider.modeAwareBaseUrl(null, null, null, null))
    }

    @Test
    fun `relay mode switches REST base to ECS https endpoint`() {
        assertEquals(
            "https://59.110.149.11:443",
            ApiProvider.modeAwareBaseUrl("relay", "10.0.2.2", 8746, "wss://59.110.149.11"),
        )
    }

    @Test
    fun `relay mode keeps explicit port and tolerates trailing path`() {
        assertEquals(
            "https://relay.example.test:8443",
            ApiProvider.modeAwareBaseUrl("relay", "10.0.2.2", 8746, "wss://relay.example.test:8443/"),
        )
    }

    @Test
    fun `relay mode with unparseable endpoint falls back to local base defensively`() {
        // 非 wss（保存层已拦）或空白 endpoint：防御态回落，绝不抛出（连接层另行暴露配置错误）
        assertEquals("http://10.0.2.2:8746", ApiProvider.modeAwareBaseUrl("relay", "10.0.2.2", 8746, "http://nope"))
        assertEquals("http://10.0.2.2:8746", ApiProvider.modeAwareBaseUrl("relay", "10.0.2.2", 8746, null))
    }
}
