package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * U1-M3（AUDIT P1#3 + P2#10）：统一错误呈现层纯函数直锁。
 * 缺陷实证：20-relay-test-error.png——异常类名+内网 IP+端口直出用户面。
 * 纪律：headline = 人话+建议动作（无异常类名）；technical 恒携带原始异常/错误码（绝不吞码）。
 */
class ErrorPresentTest {

    // —— IOException 族映射 ——

    @Test
    fun `socket timeout maps to human headline with network and address hint`() {
        val p = ErrorPresent.io(SocketTimeoutException("failed to connect to /10.0.2.15 (port 443)"))
        assertTrue(p.headline.contains("连接超时"))
        assertTrue(p.headline.contains("电脑地址"))
        assertFalse(p.headline.contains("SocketTimeout"))
        assertFalse(p.headline.contains("10.0.2.15"))
        // 绝不吞码：原始异常收技术细节
        assertTrue(p.technical!!.contains("SocketTimeoutException"))
    }

    @Test
    fun `connect exception mentions gateway enabled and port`() {
        val p = ErrorPresent.io(ConnectException("Connection refused"))
        assertTrue(p.headline.contains("无法建立连接"))
        assertTrue(p.headline.contains("DevHub"))
        assertTrue(p.technical!!.contains("ConnectException"))
    }

    @Test
    fun `unknown host maps to spelling hint`() {
        val p = ErrorPresent.io(UnknownHostException("nope.invalid"))
        assertTrue(p.headline.contains("无法解析"))
        assertFalse(p.headline.contains("UnknownHost"))
        assertTrue(p.technical!!.contains("nope.invalid"))
    }

    @Test
    fun `ssl exception points to spki fingerprint config`() {
        val p = ErrorPresent.io(SSLException("Trust anchor not found"))
        assertTrue(p.headline.contains("TLS"))
        assertTrue(p.headline.contains("自签证书"))
        assertTrue(p.headline.contains("证书指纹"))
        assertTrue(p.technical!!.contains("SSLException"))
    }

    @Test
    fun `generic io maps to unreachable`() {
        val p = ErrorPresent.io(java.io.IOException("Network down"))
        assertTrue(p.headline.contains("网络不可达"))
        assertTrue(p.technical!!.contains("IOException"))
    }

    @Test
    fun `non io throwable falls back to generic with technical kept`() {
        val p = ErrorPresent.io(IllegalStateException("boom"))
        assertTrue(p.headline.contains("未知错误"))
        assertTrue(p.technical!!.contains("boom"))
    }

    // —— ApiError 码映射 ——

    @Test
    fun `NOT_FOUND on device list surface gets relay access-point wording (P2#10)`() {
        val p = ErrorPresent.api("NOT_FOUND", "gateway: no route for /v1/devices", ErrorPresent.Surface.DEVICE_LIST)
        assertTrue(p.headline.contains("当前接入点不提供设备列表"))
        assertTrue(p.headline.contains("本地模式"))
        // 原码原样保留在技术细节（翻译不删除）
        assertEquals("[NOT_FOUND] gateway: no route for /v1/devices", p.technical)
    }

    @Test
    fun `NOT_FOUND generic surface stays neutral`() {
        val p = ErrorPresent.api("NOT_FOUND", "missing")
        assertTrue(p.headline.contains("资源不存在"))
        assertFalse(p.headline.contains("设备列表"))
    }

    @Test
    fun `auth fatal codes map to re-pairing hint`() {
        for (code in listOf("AUTH_INVALID_TOKEN", "DEVICE_REVOKED", "DEVICE_NOT_PAIRED")) {
            val p = ErrorPresent.api(code, "x")
            assertTrue("code=$code", p.headline.contains("重新配对"))
            assertTrue(p.technical!!.contains(code))
        }
    }

    @Test
    fun `command rejection keeps raw code out of user face but in technical`() {
        val p = ErrorPresent.api("COMMAND_EXPIRED", "expired at 123", ErrorPresent.Surface.COMMAND)
        assertTrue(p.headline.contains("过期"))
        assertTrue(p.headline.contains("重试"))
        assertFalse(p.headline.contains("[COMMAND_EXPIRED]"))
        assertTrue(p.technical == "[COMMAND_EXPIRED] expired at 123")
    }

    @Test
    fun `unknown code on probe surfaces says reachable but error`() {
        val relay = ErrorPresent.api("SOME_NEW_CODE", "?", ErrorPresent.Surface.RELAY_PROBE)
        assertTrue(relay.headline.contains("云端连接"))
        val gw = ErrorPresent.api("SOME_NEW_CODE", "?", ErrorPresent.Surface.GATEWAY_PROBE)
        assertTrue(gw.headline.contains("电脑"))
        // 未知码 headline 不带原码，technical 兜底
        assertNotEquals(-1, gw.technical!!.indexOf("SOME_NEW_CODE"))
    }

    @Test
    fun `presentable without technical renders plain`() {
        val p = ErrorPresent.api("NOT_FOUND", "x", ErrorPresent.Surface.DEVICE_LIST)
        assertNull(ErrorPresent.Presentable(p.headline).technical)
    }
}
