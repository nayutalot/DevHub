package com.devhub.mobile.data.remote

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger

/**
 * B1 泛化热修回归锁（2026-09-13，P0 同类：契约违背 2xx 体）：
 * **合法 JSON 但违反 docs/14 §B.1 DTO 契约（形状/错型/必填缺失）的 2xx 响应体
 * → 结构化 ApiError(BAD_PAYLOAD)，绝不抛 JSONException/NumberFormatException。**
 *
 * 缺陷机理（B1 静态扫查实证）：GatewayApi 端点层 `Dtos.parse*` 对「合法 JSON、
 * 形状不符」抛 JSONException（如 `{"providers":"x"}` getJSONArray 抛、数组元素
 * 非对象 `JSONObject(raw)` 抛、reply 202 体缺 commandId getString 抛）。该抛出族
 * 不在任何调用方 catch（ApiError/IOException）面内：
 * - SessionDetailScreen reply/pause/resume 等提交协程（rememberCoroutineScope 主线程
 *   无异常处理器）→ 穿透即进程闪退（P0 同款机理）；
 * - ConnectionManager.flushPendingCommandsLocal 的 catch(ApiError|IOException) 面 →
 *   穿透杀 loopJob（连接循环终止）。
 * P0 已修「非 JSON 体」（GatewayApiNonJsonBodyTest）；本锁覆盖其补集=「JSON 但违约」，
 * 修法同源：parseContract wrap → BAD_PAYLOAD（原异常 message 收进，不吞码）。
 *
 * 基建：裸 [ServerSocket] 手写 HTTP/1.1 响应（同 P0 先例，零新依赖）。
 */
class GatewayApiContractViolationTest {

    private lateinit var server: ServerSocket
    private val requests = AtomicInteger(0)

    /** 每连接一行式应答；请求读取到空行即回（幂等，不解析请求体）。 */
    private var responseBody: String = ""

    @Before
    fun setUp() {
        server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
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
                            "Content-Type: application/json; charset=utf-8\r\n" +
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

    private fun expectBadPayload(block: () -> Unit) {
        try {
            block()
            throw AssertionError("expected ApiError(BAD_PAYLOAD)")
        } catch (err: ApiError) {
            assertEquals("BAD_PAYLOAD", err.code)
            // 两种结构化面均为合法兜底：execute 面（非 JSON 体）="not valid JSON"；
            // 契约解析面（合法 JSON 但违约）="violates contract"。
            assertTrue(
                err.message.contains("violates contract") || err.message.contains("not valid JSON"),
            )
        }
    }

    @Test
    fun `reply 202 body missing commandId maps to BAD_PAYLOAD not JSONException`() {
        // UI 提交协程闪退面的畸形场景：网关 2xx 体缺必填字段（getString 抛）。
        responseBody = """{"status":"accepted"}"""
        expectBadPayload { api().reply(sessionId = 1, text = "hi", idempotencyKey = "k") }
    }

    @Test
    fun `agents with non-array providers maps to BAD_PAYLOAD`() {
        // 错型：providers 应为数组，实际字符串（getJSONArray 抛）。
        responseBody = """{"providers": "not-an-array"}"""
        expectBadPayload { api().agents() }
    }

    @Test
    fun `sessions with non-object array elements maps to BAD_PAYLOAD`() {
        // 错型：数组元素非对象（mapObjects 内 JSONObject(raw) 抛）。
        responseBody = """{"sessions": [1, 2, 3]}"""
        expectBadPayload { api().sessions() }
    }

    @Test
    fun `health with wrong-typed number field maps to BAD_PAYLOAD`() {
        // 错型：uptimeSec 应为数值，实际非数值字符串（getLong 抛 JSONException/NumberFormatException）。
        responseBody = """{"name":"gateway","version":"1.0","uptimeSec":"garbage"}"""
        expectBadPayload { api().health() }
    }

    @Test
    fun `top-level json array body maps to BAD_PAYLOAD (execute face regression)`() {
        // 顶层 JSON 数组（JSONObject(String) 抛）——P0 execute 面补集确认，同转 BAD_PAYLOAD。
        responseBody = """[1, 2, 3]"""
        expectBadPayload { api().sessions() }
    }

    @Test
    fun `claim body missing deviceId maps to BAD_PAYLOAD`() {
        // 配对面：claim 2xx 体缺 deviceId（getLong 抛）——PairingScreen 有 catch(Exception)
        // 兜底，但结构化 BAD_PAYLOAD 让失败码语义化（人话映射「版本可能不匹配」）。
        responseBody = """{"token":"t","tokenVersion":1,"gatewayName":"gw"}"""
        expectBadPayload { api().claim(pairingId = null, code = "ABCD2345", deviceName = "dev") }
    }

    @Test
    fun `valid contract body still parses normally (zero normal-path regression)`() {
        // 注：JVM 单测 classpath 的 org.json:json（严格模式）对「数组元素按 getString 取
        // 再 new JSONObject」的 Android 协迫语义不一致（抛 not a String），故正常路径夹具
        // 用空数组形态（与 GatewayApiNonJsonBodyTest 同理）；真机 Android 运行时对象数组
        // 解析不受影响（parseContract 直通不干预）。
        responseBody = """{"providers":[]}"""
        val list = api().agents()
        assertTrue(list.isEmpty())
    }
}
