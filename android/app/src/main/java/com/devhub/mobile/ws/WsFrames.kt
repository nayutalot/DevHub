package com.devhub.mobile.ws

import org.json.JSONArray
import org.json.JSONObject

/**
 * WS /v1/events 协议帧（docs/14 §B.2）。
 * hello（服务端首帧）/ event（事件帧）/ token_rotation（协议预留：v1 服务端绝不发送，
 * 客户端持久化新 Token 后回 ack——收到即持久化并 ack，无 UI）。
 * X-L 批（docs/18 §5.3.2）：command_ack / command_result 本地命令回程帧——T1 本地
 * Queued 根治的 App 侧结算面（additive 扩展，docs/18 §10「WsFrames sealed class 仅
 * additive 扩展」口径）。
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

    /**
     * 本地命令受理回执（docs/18 §5.3.2；§3.9 同域语义本地形态）。v1 仅
     * workspace_link 命令面使用；本端发起后以 command_result 为准结算。
     */
    data class CommandAck(
        val requestId: String?,
        val idempotencyKey: String?,
        val commandId: String?,
        val status: String,
        val errorCode: String?,
    ) : WsServerFrame()

    /**
     * 本地命令终态（docs/18 §5.3.2；§3.10 同域语义本地形态）。result 仅
     * workspace_link executed 携带——URL 帧面内存过境（零日志零落库红线）。
     */
    data class CommandResult(
        val requestId: String?,
        val commandId: String?,
        val idempotencyKey: String?,
        val action: String?,
        val status: String,
        val errorCode: String?,
        val result: JSONObject?,
        val timestampSec: Long?,
    ) : WsServerFrame()

    /** 未知类型：v1 静默忽略（与对端「未知类型不断连」对称）。 */
    data class Unknown(val type: String) : WsServerFrame()
}

object WsFrames {
    const val TYPE_HELLO = "hello"
    const val TYPE_EVENT = "event"
    const val TYPE_TOKEN_ROTATION = "token_rotation"
    const val TYPE_COMMAND_ACK = "command_ack"
    const val TYPE_COMMAND_RESULT = "command_result"

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
            TYPE_COMMAND_ACK -> WsServerFrame.CommandAck(
                requestId = obj.optString("requestId").takeIf { it.isNotEmpty() },
                idempotencyKey = obj.optString("idempotencyKey").takeIf { it.isNotEmpty() },
                commandId = obj.optString("commandId").takeIf { it.isNotEmpty() },
                status = obj.optString("status"),
                errorCode = obj.optString("errorCode").takeIf { it.isNotEmpty() },
            )
            TYPE_COMMAND_RESULT -> WsServerFrame.CommandResult(
                requestId = obj.optString("requestId").takeIf { it.isNotEmpty() },
                commandId = obj.optString("commandId").takeIf { it.isNotEmpty() },
                idempotencyKey = obj.optString("idempotencyKey").takeIf { it.isNotEmpty() },
                action = obj.optString("action").takeIf { it.isNotEmpty() },
                status = obj.optString("status"),
                errorCode = obj.optString("errorCode").takeIf { it.isNotEmpty() },
                result = obj.optJSONObject("result"),
                timestampSec = obj.optLong("timestamp", -1).takeIf { it > 0 },
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

    /**
     * 客户端 → 服务端：本地命令帧（X-L 批，docs/18 §5.3.2）。零 auth 块——本地连接
     * upgrade 时已 Bearer 鉴权（docs/14 §B.2）；v1 唯一 action='workspace_link'。
     * URL 凭据成分绝不出现在本帧（查询语义 payload {} 无参数）。
     */
    fun commandWorkspaceLink(requestId: String, idempotencyKey: String): String =
        JSONObject()
            .put("type", "command")
            .put("requestId", requestId)
            .put("idempotencyKey", idempotencyKey)
            .put("action", "workspace_link")
            .put("payload", JSONObject())
            .toString()
}
