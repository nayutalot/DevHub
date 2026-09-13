package com.devhub.mobile.data.remote

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger

/**
 * P0 热修回归锁（2026-09-13 用户真机「连接失败即闪退」）：
 * **非 JSON 成功响应体（中间盒/captive portal 劫持回 HTML、坏代理注入）→ 结构化
 * ApiError(BAD_PAYLOAD)，绝不抛 JSONException。**
 *
 * 缺陷机理：GatewayApi.execute 原 `JSONObject(body)` 对非 JSON 2xx 体抛
 * JSONException（RuntimeException）——不在任何调用方 catch（ApiError/IOException）
 * 面内 → 穿透 UI/连接协程 → 进程闪退。这正是「App 连不上电脑就闪退」的宿主之一：
 * 网关不可达时请求可能被局域网中间盒截胡返回 HTML 200。
 *
 * 基建：裸 [ServerSocket] 手写 HTTP/1.1 响应（零新依赖——android 单测 classpath 无
 * com.sun.net.httpserver/MockWebServer；本机回环一行响应即足）。
 */
class GatewayApiNonJsonBodyTest {

    private lateinit var server: ServerSocket
    private val requests = AtomicInteger(0)

    /** 每连接一行式应答；请求读取到空行即回（幂等，不解析请求体）。 */
    private var responseBody: String = ""

    @Before
    fun setUp() {
        server = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        val acceptor = Thread {
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (err: Exception) {
                    return@Thread
                }
                val body = responseBody
                requests.incrementAndGet()
                try {
                    socket.use { s ->
                        val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.ISO_8859_1))
                        while (reader.readLine()?.isNotEmpty() == true) { /* 读到请求头尾 */ }
                        val payload = body.toByteArray(Charsets.UTF_8)
                        val head = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: text/html; charset=utf-8\r\n" +
                            "Content-Length: ${payload.size}\r\n" +
                            "Connection: close\r\n\r\n"
                        s.getOutputStream().apply {
                            write(head.toByteArray(Charsets.ISO_8859_1))
                            write(payload)
                            flush()
                        }
                    }
                } catch (err: Exception) {
                    /* 客户端先行断开等——测试语义无关 */
                }
            }
        }
        acceptor.isDaemon = true
        acceptor.start()
    }

    @After
    fun tearDown() {
        server.close()
    }

    private fun api(): GatewayApi =
        GatewayApi(
            baseUrlProvider = { "http://127.0.0.1:${server.localPort}" },
            tokenProvider = { null },
        )

    @Test
    fun `html body on 200 maps to structured ApiError BAD_PAYLOAD not JSONException`() {
        responseBody = "<html><body>captive portal hijack</body></html>"
        try {
            api().agents()
            throw AssertionError("expected ApiError")
        } catch (err: ApiError) {
            assertEquals("BAD_PAYLOAD", err.code)
            assertTrue(err.message.contains("not valid JSON"))
        }
    }

    @Test
    fun `garbage body on 200 maps to structured ApiError BAD_PAYLOAD`() {
        responseBody = "not-json{{{"
        try {
            api().agents()
            throw AssertionError("expected ApiError")
        } catch (err: ApiError) {
            assertEquals("BAD_PAYLOAD", err.code)
        }
    }

    @Test
    fun `valid json body still parses normally (zero normal-path regression)`() {
        responseBody = """{"providers":[]}"""
        // 正常路径行为不变：合法 JSON 照常解析（空列表=parseAgents 对空集的既有投影）。
        val list = api().agents()
        assertTrue(list.isEmpty())
    }
}
