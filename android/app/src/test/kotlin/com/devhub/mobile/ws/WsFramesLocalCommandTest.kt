package com.devhub.mobile.ws

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * X-L 批（docs/18 §5.3.2）：本地命令帧解析/编码单测——command_ack / command_result
 * 解析（additive 扩展）+ commandWorkspaceLink 出帧形态。字段对齐本地网关 ws.ts
 * 发帧（smoke xl-local-ws 同源）；URL 值全程 fake、断言零凭据输出。
 */
class WsFramesLocalCommandTest {

    // ---- 客户端 → 服务端：本地命令帧出帧形态（docs/18 §5.3.2 最小 ndjson 扩展）----

    @Test
    fun `command frame carries the five-field local shape with zero auth block`() {
        val frame = JSONObject(WsFrames.commandWorkspaceLink("req-1", "key-1"))
        assertEquals("command", frame.getString("type"))
        assertEquals("req-1", frame.getString("requestId"))
        assertEquals("key-1", frame.getString("idempotencyKey"))
        assertEquals("workspace_link", frame.getString("action"))
        assertEquals(0, frame.getJSONObject("payload").length())
        assertEquals(5, frame.length()) // 封闭帧面：type/requestId/idempotencyKey/action/payload
    }

    @Test
    fun `command frames are unique per request id and idempotency key`() {
        val a = WsFrames.commandWorkspaceLink("req-a", "key-a")
        val b = WsFrames.commandWorkspaceLink("req-b", "key-b")
        assertTrue(a != b)
    }

    // ---- 服务端 → 客户端：command_ack 解析 ----

    @Test
    fun `command ack parses accepted with command id`() {
        val raw = JSONObject()
            .put("type", "command_ack")
            .put("requestId", "req-1")
            .put("idempotencyKey", "key-1")
            .put("commandId", "cmd-abc")
            .put("status", "accepted")
            .toString()
        val frame = WsFrames.parse(raw)
        val ack = frame as WsServerFrame.CommandAck
        assertEquals("req-1", ack.requestId)
        assertEquals("key-1", ack.idempotencyKey)
        assertEquals("cmd-abc", ack.commandId)
        assertEquals("accepted", ack.status)
        assertNull(ack.errorCode)
    }

    @Test
    fun `command ack parses rejected with error code`() {
        val raw = JSONObject()
            .put("type", "command_ack")
            .put("requestId", "req-2")
            .put("idempotencyKey", "key-2")
            .put("status", "rejected")
            .put("errorCode", "BAD_PAYLOAD")
            .toString()
        val frame = WsFrames.parse(raw)
        val ack = frame as WsServerFrame.CommandAck
        assertEquals("rejected", ack.status)
        assertEquals("BAD_PAYLOAD", ack.errorCode)
        assertNull(ack.commandId)
    }

    // ---- 服务端 → 客户端：command_result 解析（含可选 result 帧面回流）----

    @Test
    fun `command result parses executed with the in-frame result object`() {
        // URL 全程 fake（形态断言，零凭据输出）
        val result = JSONObject()
            .put("provider", "zcode")
            .put("url", "https://example.test/remote/v4?sid=fake&hash=fake&t=1&mid=fake&name=d&app_version=3.11.2")
            .put("deviceName", "desk-1")
        val raw = JSONObject()
            .put("type", "command_result")
            .put("requestId", "req-1")
            .put("commandId", "cmd-abc")
            .put("idempotencyKey", "key-1")
            .put("action", "workspace_link")
            .put("status", "executed")
            .put("errorCode", JSONObject.NULL)
            .put("result", result)
            .put("timestamp", 1757000100L)
            .toString()
        val frame = WsFrames.parse(raw)
        val res = frame as WsServerFrame.CommandResult
        assertEquals("req-1", res.requestId)
        assertEquals("cmd-abc", res.commandId)
        assertEquals("key-1", res.idempotencyKey)
        assertEquals("workspace_link", res.action)
        assertEquals("executed", res.status)
        assertNull(res.errorCode)
        assertEquals("zcode", res.result?.getString("provider"))
        assertEquals("desk-1", res.result?.getString("deviceName"))
        assertEquals(1757000100L, res.timestampSec)
    }

    @Test
    fun `command result parses failed without a result object`() {
        val raw = JSONObject()
            .put("type", "command_result")
            .put("commandId", "cmd-def")
            .put("idempotencyKey", "key-3")
            .put("action", "workspace_link")
            .put("status", "failed")
            .put("errorCode", "ZCODE_LINK_UNAVAILABLE")
            .put("timestamp", 1757000200L)
            .toString()
        val frame = WsFrames.parse(raw)
        val res = frame as WsServerFrame.CommandResult
        assertEquals("failed", res.status)
        assertEquals("ZCODE_LINK_UNAVAILABLE", res.errorCode)
        assertNull(res.result)
        assertNull(res.requestId)
    }

    // ---- 既有帧解析零回归（additive 扩展不误伤）----

    @Test
    fun `existing frame kinds still parse unchanged`() {
        val hello = WsFrames.parse(JSONObject().put("type", "hello").put("sequence", 7L).put("device", 3L).put("heartbeatSec", 30).toString())
        assertEquals(WsServerFrame.Hello(7L, 3L, 30), hello)
        val event = WsFrames.parse(
            JSONObject()
                .put("type", "event")
                .put("seq", 1L)
                .put("eventId", "e1")
                .put("eventType", "session.status_changed")
                .put("payload", JSONObject().put("to", "running"))
                .toString(),
        )
        assertTrue(event is WsServerFrame.Event)
        val unknown = WsFrames.parse(JSONObject().put("type", "mystery").toString())
        assertEquals("mystery", (unknown as WsServerFrame.Unknown).type)
        // 出帧形态结构化断言（JSONObject 键序不保证，绝不断言字面串）
        val sync = JSONObject(WsFrames.sync(5L))
        assertEquals("sync", sync.getString("type"))
        assertEquals(5L, sync.getLong("after"))
        val ack = JSONObject(WsFrames.ack(listOf(1L, 2L)))
        assertEquals("ack", ack.getString("type"))
        assertEquals(2, ack.getJSONArray("seqs").length())
        assertEquals(1L, ack.getJSONArray("seqs").getLong(0))
    }
}
