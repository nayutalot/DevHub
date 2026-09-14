package com.devhub.mobile.ui.screens

import com.devhub.mobile.data.remote.ApiError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * UX-P3（docs/briefs/uxp3-flows.md §1.1）：「连接电脑」单页流纯函数锁。
 * - 地址形态（与保存/连接两层 RelayEndpoint.parse 同判，绝不双标）；
 * - 连接按钮可用性（8 位码 + 地址合法）；
 * - 失败三态人话（docs/24 §2.2 矩阵：码不对过期 / 连不上 local+relay 分叉 / 其余结构化）。
 */
class ConnectFlowPolicyTest {

    // —— connectAddressValid ——

    @Test
    fun `local address valid requires host and port range`() {
        assertTrue(connectAddressValid("local", "10.0.2.2", "8746", ""))
        assertTrue(connectAddressValid("local", "192.168.1.20", "1", ""))
        assertFalse(connectAddressValid("local", "", "8746", ""))
        assertFalse(connectAddressValid("local", "10.0.2.2", "0", ""))
        assertFalse(connectAddressValid("local", "10.0.2.2", "65536", ""))
        assertFalse(connectAddressValid("local", "10.0.2.2", "abc", ""))
    }

    @Test
    fun `relay address valid requires wss prefix`() {
        // wss 强制不损失（红线）：非 wss:// 一律拒绝
        assertTrue(connectAddressValid("relay", "", "", "wss://relay.example.com"))
        assertFalse(connectAddressValid("relay", "", "", "ws://relay.example.com"))
        assertFalse(connectAddressValid("relay", "", "", "https://relay.example.com"))
        assertFalse(connectAddressValid("relay", "", "", ""))
    }

    // —— connectEnabled ——

    @Test
    fun `connect enabled needs 8 digit code plus valid address`() {
        assertTrue(connectEnabled("12345678", "local", "10.0.2.2", "8746", ""))
        assertFalse(connectEnabled("1234567", "local", "10.0.2.2", "8746", ""))
        assertFalse(connectEnabled("123456789", "local", "10.0.2.2", "8746", ""))
        assertFalse(connectEnabled("", "local", "10.0.2.2", "8746", ""))
        assertFalse(connectEnabled("12345678", "local", "", "8746", ""))
        assertTrue(connectEnabled("ABCDEF12", "relay", "", "", "wss://relay.example.com"))
        assertFalse(connectEnabled("ABCDEF12", "relay", "", "", "ws://relay.example.com"))
    }

    // —— connectFailurePresentable（失败三态人话，docs/24 §2.2）——

    @Test
    fun `invalid token maps to regenerate hint`() {
        val p = connectFailurePresentable(
            "local",
            ApiError("AUTH_INVALID_TOKEN", "bad code", 401),
        )
        assertTrue(p.headline.contains("码不对"))
        assertTrue(p.headline.contains("重新生成"))
        assertTrue(p.technical!!.contains("AUTH_INVALID_TOKEN"))
    }

    @Test
    fun `io failure local mode names power on and address check`() {
        val p = connectFailurePresentable("local", IOException("connect timed out"))
        assertTrue(p.headline.contains("连不上电脑"))
        assertTrue(p.headline.contains("已开机"))
        assertTrue(p.headline.contains("电脑地址"))
    }

    @Test
    fun `io failure relay mode names network and server address`() {
        val p = connectFailurePresentable("relay", IOException("connect refused"))
        assertTrue(p.headline.contains("云端服务器"))
        assertTrue(p.headline.contains("服务器地址"))
    }

    @Test
    fun `rate limited keeps wait seconds`() {
        val p = connectFailurePresentable(
            "local",
            ApiError("AUTH_RATE_LIMITED", "slow down", 429, retryAfterSec = 42),
        )
        assertTrue(p.headline.contains("42"))
    }

    @Test
    fun `gateway disabled maps to computer side switch hint`() {
        val p = connectFailurePresentable(
            "relay",
            ApiError("GATEWAY_DISABLED", "disabled", 403),
        )
        assertTrue(p.headline.contains("允许手机连接"))
    }

    @Test
    fun `unknown error keeps generic headline with code folded`() {
        val p = connectFailurePresentable(
            "local",
            ApiError("WEIRD_CODE", "boom", 500),
        )
        assertEquals("连接出了问题，请重试", p.headline)
        assertTrue(p.technical!!.contains("WEIRD_CODE"))
    }
}
