package com.devhub.mobile.ws

import org.json.JSONArray
import org.json.JSONObject

/**
 * WS /v1/events 协议帧（docs/14 §B.2）。
 * hello（服务端首帧）/ event（事件帧）/ token_rotation（协议预留：v1 服务端绝不发送，
 * 客户端持久化新 Token 后回 ack——收到即持久化并 ack，无 UI）。
 */
sealed class WsServerFrame {
    data class Hello(val sequence: Long, val device: Long, val heartbeatSec: Int) : WsServerFrame()

    data class Event(
        val seq: Long,
        val eventId: String,
        val eventType: String,
        val sessionId: Long?,
        val summary: String?,
        val payload: JSONObject,
        val createdAtSec: Long,
    ) : WsServerFrame()

    data class TokenRotation(val newToken: String, val tokenVersion: Int) : WsServerFrame()

    /** 未知类型：v1 静默忽略（与对端「未知类型不断连」对称）。 */
    data class Unknown(val type: String) : WsServerFrame()
}

object WsFrames {
    const val TYPE_HELLO = "hello"
    const val TYPE_EVENT = "event"
    const val TYPE_TOKEN_ROTATION = "token_rotation"

    fun parse(text: String): WsServerFrame {
        val obj = JSONObject(text)
        return when (obj.optString("type")) {
            TYPE_HELLO -> WsServerFrame.Hello(
                sequence = obj.getLong("sequence"),
                device = obj.getLong("device"),
                heartbeatSec = obj.optInt("heartbeatSec", 30),
            )
            TYPE_EVENT -> WsServerFrame.Event(
                seq = obj.getLong("seq"),
                eventId = obj.getString("eventId"),
                eventType = obj.getString("eventType"),
                sessionId = obj.optLong("sessionId", -1).takeIf { it > 0 },
                summary = obj.optString("summary").takeIf { it.isNotEmpty() },
                payload = obj.optJSONObject("payload") ?: JSONObject(),
                createdAtSec = obj.optLong("createdAt", 0),
            )
            TYPE_TOKEN_ROTATION -> WsServerFrame.TokenRotation(
                newToken = obj.getString("newToken"),
                tokenVersion = obj.getInt("tokenVersion"),
            )
            else -> WsServerFrame.Unknown(obj.optString("type"))
        }
    }

    /** 客户端 → 服务端：增量同步（after = 已确认 sequence）。 */
    fun sync(after: Long): String =
        JSONObject().put("type", "sync").put("after", after).toString()

    /** 客户端 → 服务端：批量确认（seqs ≤500，服务端约束）。 */
    fun ack(seqs: List<Long>): String =
        JSONObject().put("type", "ack").put("seqs", JSONArray(seqs)).toString()
}
