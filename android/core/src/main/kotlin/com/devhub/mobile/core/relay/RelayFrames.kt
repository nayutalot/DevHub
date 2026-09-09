package com.devhub.mobile.core.relay

import org.json.JSONArray
import org.json.JSONObject

/**
 * ECS Relay 帧协议模型（docs/18 §3 全表 16 帧 + §3.17 wake 帧对 #17/#18；M2-R3，docs/20 §2.3）。
 *
 * 对拍权威 = `ecs-relay/test/fixtures/frames.json`（随 143ccad 镜像到
 * `core/src/test/resources/relay/frames-fixture.json`）+ `ecs-relay/README.md` 偏离单：
 * - 偏离①：event 帧判别 `type:'event'`，事件类型承载于 `eventType` 字段（JSON 重复键非法，
 *   fixture meta.conventions 裁定；docs/18 §3.6 示例的双 `type` 键不采纳）；
 * - 偏离②：token_rotation 帧可携带 `deviceId`（H→E 路由必需；E→D 视图可缺省）；
 * - 偏离③：`register_pairing`/`register_pairing_ack` 属 host 腿控制面，不入 16 帧正集——
 *   设备腿收到时按 Unknown 静默（App 认识并忽略）；
 * - 偏离④：requestId ECS 可内部重写，响应帧回显客户端原 requestId——App 侧关联语义不变；
 * - 偏离⑤：离线排队 `command_ack{status:'accepted', queued:true}`（docs/18 §3.9）；
 * - 偏离⑥（RW1）：wake 帧对（#17 wake_host / #18 wake_result，docs/18 §3.17 RW0 增补）的
 *   对拍件仅存 App 侧镜像——ecs-relay frames.json 属 RW1 零改动面（RW0 未扩 fixture），
 *   镜像按 §3.17 帧形就地追加并在此登记偏离；正集 16→18。
 *
 * 模式选择纪律（docs/18 §10）：local=docs/14 原样（WsFrames.kt），relay=本文件；
 * 显式 mode 选择、绝不字段嗅探。解析失败（必填字段缺失/类型错）抛 JSONException——绝不猜。
 */
sealed class RelayFrame {
    /** #1 hello（E→D 服务端首帧）。upstream = host 腿信标：connected | disconnected（§3.1/§7.3）。 */
    data class Hello(
        val sequence: Long,
        val deviceId: Long?,
        val heartbeatSec: Int,
        val relayVersion: String?,
        val upstream: String?,
    ) : RelayFrame()

    /** #2 pair（D→E 裸连接首帧；E→H 中继变体的 ecsDeviceId/pairingId 仅解析容忍，设备不发送）。 */
    data class Pair(
        val requestId: String,
        val code: String,
        val deviceName: String,
        val platform: String,
        val clientVersion: String?,
        val ecsDeviceId: Long? = null,
        val pairingId: String? = null,
    ) : RelayFrame()

    /** #3 pair_accepted（E→D 设备视图：deviceToken 明文唯一两次过境之一，红线受控面 docs/19 §3）。 */
    data class PairAccepted(
        val requestId: String?,
        val deviceId: Long,
        val deviceToken: String,
        val tokenVersion: Int,
        val heartbeatSec: Int?,
    ) : RelayFrame()

    /** #4 agent_list（D→E / E→D；App v1 列表首选 REST 直连，本帧为可选用法）。 */
    data class RelayProvider(
        val id: String,
        val displayName: String,
        val health: String?,
        val mode: String?,
        val granted: List<String>,
    )

    data class AgentList(
        val requestId: String?,
        val providers: List<RelayProvider>,
    ) : RelayFrame()

    /** #5 session_list（E→D；stale = host 断线时 ECS 缓存降级应答，docs/18 §3.5）。 */
    data class RelaySession(
        val id: Long,
        val providerId: String?,
        val nativeId: String?,
        val sessionMode: String?,
        val status: String?,
        val title: String?,
        val lastActivityAtSec: Long?,
    )

    data class SessionList(
        val requestId: String?,
        val stale: Boolean,
        val sessions: List<RelaySession>,
    ) : RelayFrame()

    /**
     * #6 event（E→D；字段名按偏离①与 docs/18 §4.1 投影：sequence/eventType/timestamp +
     * requiresUserAction 白名单布尔）。
     */
    data class Event(
        val sequence: Long,
        val eventId: String,
        val deviceId: Long?,
        val provider: String?,
        val sessionId: Long?,
        val eventType: String,
        val timestampSec: Long,
        val summary: String?,
        val payload: JSONObject,
        val requiresUserAction: Boolean,
    ) : RelayFrame()

    /** #7 message（E→D 分页；items = 脱敏投影，绝无 sourceRef）。 */
    data class MessageItem(
        val id: Long,
        val role: String,
        val contentRedacted: String,
        val occurredAtSec: Long?,
    )

    data class MessagePage(
        val requestId: String?,
        val items: List<MessageItem>,
        val prevAfter: Long?,
    ) : RelayFrame()

    /**
     * #8 command（D→E；auth 内嵌端到端 Bearer——ECS 不解释只转发，docs/18 §3.8）。
     * M3-E（docs/18 §5.3）：spawn_session（尚无会话）/ revoke_device（自指无目标）两 action
     * 的 sessionId 缺省合法 → nullable；§5.1 会话级 action 恒携带（调用方保证）。
     */
    data class Command(
        val requestId: String,
        val idempotencyKey: String,
        val sessionId: Long?,
        val action: String,
        val payload: JSONObject,
        val token: String?,
        val tsSec: Long?,
        val nonce: String?,
        val createdAtSec: Long?,
    ) : RelayFrame()

    /** #9 command_ack（E→D；queued=true = ECS 排队受理，Windows 尚未见到，docs/18 §3.9）。 */
    data class CommandAck(
        val requestId: String?,
        val idempotencyKey: String,
        val commandId: String?,
        val status: String,
        val errorCode: String?,
        val queued: Boolean,
    ) : RelayFrame()

    /** #10 command_result（E→D 终态；与 command.result 事件双通道按 commandId 去重，§3.10）。 */
    data class CommandResult(
        val commandId: String,
        val idempotencyKey: String?,
        val sessionId: Long?,
        val action: String?,
        val status: String,
        val errorCode: String?,
        val timestampSec: Long?,
    ) : RelayFrame()

    /** #11 sync_request（D→E；after = 本机已持久处理的最高 contiguous sequence；E→H 变体带 deviceId）。 */
    data class SyncRequest(
        val requestId: String?,
        val after: Long,
        val deviceId: Long? = null,
    ) : RelayFrame()

    /** #12 sync_response（E→D 补发页；H→E 对齐探测恒空页；hasGaps = 缓存洞显式标注 §3.12/§6.3）。 */
    data class SyncResponse(
        val requestId: String?,
        val upTo: Long,
        val hasMore: Boolean,
        val hasGaps: Boolean,
        val events: List<Event>,
    ) : RelayFrame()

    /** #13 heartbeat（双向 × 两腿；字段按腿可缺省——合并模型，逐字段 nullable）。 */
    data class Heartbeat(
        val ts: Long,
        // D→E：累计 ACK 兜底 + token_rotation 确认信道（§3.13/§3.14）
        val lastAckedSeq: Long? = null,
        val tokenVersion: Int? = null,
        // E→D：降级信标 + 排队深度
        val upstream: String? = null,
        val queuedCommands: Int? = null,
        // H→E
        val lastSentSeq: Long? = null,
    ) : RelayFrame()

    /** #14 token_rotation（E→D；newToken 明文红线受控面；tokenVersion 单调，§3.14）。 */
    data class TokenRotation(
        val requestId: String? = null,
        val deviceId: Long? = null,
        val newToken: String,
        val tokenVersion: Int,
        val reason: String? = null,
    ) : RelayFrame()

    /** #15 disconnect（优雅关闭；reason=revoked → 不得自动重连，§3.15）。 */
    data class Disconnect(
        val reason: String,
        val deviceId: Long? = null,
    ) : RelayFrame()

    /** #16 error（结构化错误帧；requestId 可省 = 连接级错误，§3.16/§8）。 */
    data class Error(
        val requestId: String? = null,
        val code: String,
        val message: String? = null,
        val retryable: Boolean = false,
        val retryAfterSec: Int? = null,
    ) : RelayFrame()

    /** #17 wake_host（D→E；relay 原生执行，绝不转发桌面——docs/18 §3.17。零业务字段：
     *  目标/端口/凭据全在 ECS 机器级 ssh config/wrapper 层；不入排队/幂等体系——
     *  relay 侧唯一去重面 = 每设备冷却窗）。 */
    data class WakeHost(
        val requestId: String,
    ) : RelayFrame()

    /** #18 wake_result（E→D 单帧终态，docs/18 §3.17；业务级绝不 close）。 */
    data class WakeResult(
        val requestId: String,
        val status: WakeResultStatus,
        val latencyMs: Long? = null,
        val retryAfterMs: Long? = null,
        /** exec_failed 附加诊断摘要——relay 侧已脱敏（≥32 连续 base64/hex 样串 → <redacted>）+ 截断 ≤200。 */
        val stderrSummary: String? = null,
    ) : RelayFrame()

    /** 未知类型：设备腿静默忽略（与对端「未知类型回 error 不断连」的非对称容忍面）。 */
    data class Unknown(val type: String) : RelayFrame()
}

/**
 * wake_result status 六态白名单（docs/18 §3.17：白名单制，绝不猜）。
 * 未知 status 字符串 = 畸形帧 → JSONException（对齐既有解析纪律），绝不降级猜测。
 */
enum class WakeResultStatus(val wire: String) {
    SENT("sent"),
    ALREADY_ON("already_on"),
    RATE_LIMITED("rate_limited"),
    DISABLED("disabled"),
    EXEC_FAILED("exec_failed"),
    TIMEOUT("timeout"),
    ;

    companion object {
        fun fromWire(value: String): WakeResultStatus =
            entries.firstOrNull { it.wire == value }
                ?: throw org.json.JSONException("wake_result unknown status: $value")
    }
}

/**
 * Relay 帧编解码（docs/18 §3；16 帧全集 + §3.17 wake 帧对 parse/encode，round-trip 对 fixture 验证）。
 * encode 面向 round-trip 保真与 D→E 发送；字段缺省时绝不写出猜测值（绝不猜纪律）。
 */
object RelayCodec {
    const val TYPE_HELLO = "hello"
    const val TYPE_PAIR = "pair"
    const val TYPE_PAIR_ACCEPTED = "pair_accepted"
    const val TYPE_AGENT_LIST = "agent_list"
    const val TYPE_SESSION_LIST = "session_list"
    const val TYPE_EVENT = "event"
    const val TYPE_MESSAGE = "message"
    const val TYPE_COMMAND = "command"
    const val TYPE_COMMAND_ACK = "command_ack"
    const val TYPE_COMMAND_RESULT = "command_result"
    const val TYPE_SYNC_REQUEST = "sync_request"
    const val TYPE_SYNC_RESPONSE = "sync_response"
    const val TYPE_HEARTBEAT = "heartbeat"
    const val TYPE_TOKEN_ROTATION = "token_rotation"
    const val TYPE_DISCONNECT = "disconnect"
    const val TYPE_ERROR = "error"
    const val TYPE_WAKE_HOST = "wake_host"
    const val TYPE_WAKE_RESULT = "wake_result"

    /** 帧类型全集（docs/18 §3.0 16 帧 + §3.17 #17/#18；对拍完整性断言用）。 */
    val ALL_TYPES = listOf(
        TYPE_HELLO, TYPE_PAIR, TYPE_PAIR_ACCEPTED, TYPE_AGENT_LIST, TYPE_SESSION_LIST,
        TYPE_EVENT, TYPE_MESSAGE, TYPE_COMMAND, TYPE_COMMAND_ACK, TYPE_COMMAND_RESULT,
        TYPE_SYNC_REQUEST, TYPE_SYNC_RESPONSE, TYPE_HEARTBEAT, TYPE_TOKEN_ROTATION,
        TYPE_DISCONNECT, TYPE_ERROR,
        TYPE_WAKE_HOST, TYPE_WAKE_RESULT,
    )

    fun parse(text: String): RelayFrame {
        val obj = JSONObject(text)
        val type = obj.optString("type")
        // 无 type / 空 type = 协议级畸形帧：绝不猜测语义当 Unknown 吞掉（docs/18 §1.3 纪律 4）
        if (type.isEmpty()) throw org.json.JSONException("frame missing 'type' discriminator")
        return when (type) {
            TYPE_HELLO -> RelayFrame.Hello(
                sequence = obj.getLong("sequence"),
                deviceId = optLong(obj, "deviceId"),
                heartbeatSec = obj.optInt("heartbeatSec", 30),
                relayVersion = optString(obj, "relayVersion"),
                upstream = optString(obj, "upstream"),
            )

            TYPE_PAIR -> RelayFrame.Pair(
                requestId = obj.getString("requestId"),
                code = optString(obj, "code") ?: "",
                deviceName = optString(obj, "deviceName") ?: "",
                platform = optString(obj, "platform") ?: "android",
                clientVersion = optString(obj, "clientVersion"),
                ecsDeviceId = optLong(obj, "ecsDeviceId"),
                pairingId = optString(obj, "pairingId"),
            )

            TYPE_PAIR_ACCEPTED -> RelayFrame.PairAccepted(
                requestId = optString(obj, "requestId"),
                deviceId = obj.getLong("deviceId"),
                deviceToken = obj.getString("deviceToken"),
                tokenVersion = obj.getInt("tokenVersion"),
                heartbeatSec = optInt(obj, "heartbeatSec"),
            )

            TYPE_AGENT_LIST -> RelayFrame.AgentList(
                requestId = optString(obj, "requestId"),
                providers = obj.optJSONArray("providers")?.let { arr ->
                    (0 until arr.length()).mapNotNull { i ->
                        arr.optJSONObject(i)?.let { p ->
                            RelayFrame.RelayProvider(
                                id = p.optString("id"),
                                displayName = p.optString("displayName"),
                                health = optString(p, "health"),
                                mode = p.optJSONObject("capabilities")?.let { optString(it, "mode") },
                                granted = p.optJSONObject("capabilities")
                                    ?.optJSONArray("granted")
                                    ?.let { g -> (0 until g.length()).map { g.optString(it) } }
                                    ?: emptyList(),
                            )
                        }
                    }
                } ?: emptyList(),
            )

            TYPE_SESSION_LIST -> RelayFrame.SessionList(
                requestId = optString(obj, "requestId"),
                stale = obj.optBoolean("stale", false),
                sessions = obj.optJSONArray("sessions")?.let { arr ->
                    (0 until arr.length()).mapNotNull { i ->
                        arr.optJSONObject(i)?.let { s ->
                            RelayFrame.RelaySession(
                                id = s.getLong("id"),
                                providerId = optString(s, "providerId"),
                                nativeId = optString(s, "nativeId"),
                                sessionMode = optString(s, "sessionMode"),
                                status = optString(s, "status"),
                                title = optString(s, "title"),
                                lastActivityAtSec = optLong(s, "lastActivityAt"),
                            )
                        }
                    }
                } ?: emptyList(),
            )

            TYPE_EVENT -> parseEvent(obj)

            TYPE_MESSAGE -> RelayFrame.MessagePage(
                requestId = optString(obj, "requestId"),
                items = obj.optJSONArray("items")?.let { arr ->
                    (0 until arr.length()).mapNotNull { i ->
                        arr.optJSONObject(i)?.let { m ->
                            RelayFrame.MessageItem(
                                id = m.getLong("id"),
                                role = m.optString("role"),
                                contentRedacted = m.optString("contentRedacted"),
                                occurredAtSec = optLong(m, "occurredAt"),
                            )
                        }
                    }
                } ?: emptyList(),
                prevAfter = optLong(obj, "prevAfter"),
            )

            TYPE_COMMAND -> RelayFrame.Command(
                requestId = obj.getString("requestId"),
                idempotencyKey = obj.getString("idempotencyKey"),
                // M3-E §5.3：sessionId 缺省合法（spawn_session/revoke_device 帧形）
                sessionId = optLong(obj, "sessionId"),
                action = obj.getString("action"),
                payload = obj.optJSONObject("payload") ?: JSONObject(),
                token = obj.optJSONObject("auth")?.optString("token")?.takeIf { it.isNotEmpty() },
                tsSec = obj.optJSONObject("auth")?.let { optLong(it, "ts") },
                nonce = obj.optJSONObject("auth")?.let { optString(it, "nonce") },
                createdAtSec = optLong(obj, "createdAt"),
            )

            TYPE_COMMAND_ACK -> RelayFrame.CommandAck(
                requestId = optString(obj, "requestId"),
                idempotencyKey = obj.getString("idempotencyKey"),
                commandId = optString(obj, "commandId"),
                status = obj.getString("status"),
                errorCode = optString(obj, "errorCode"),
                queued = obj.optBoolean("queued", false),
            )

            TYPE_COMMAND_RESULT -> RelayFrame.CommandResult(
                commandId = obj.getString("commandId"),
                idempotencyKey = optString(obj, "idempotencyKey"),
                sessionId = optLong(obj, "sessionId"),
                action = optString(obj, "action"),
                status = obj.getString("status"),
                errorCode = optString(obj, "errorCode"),
                timestampSec = optLong(obj, "timestamp"),
            )

            TYPE_SYNC_REQUEST -> RelayFrame.SyncRequest(
                requestId = optString(obj, "requestId"),
                after = obj.getLong("after"),
                deviceId = optLong(obj, "deviceId"),
            )

            TYPE_SYNC_RESPONSE -> RelayFrame.SyncResponse(
                requestId = optString(obj, "requestId"),
                upTo = obj.getLong("upTo"),
                hasMore = obj.optBoolean("hasMore", false),
                hasGaps = obj.optBoolean("hasGaps", false),
                events = obj.optJSONArray("events")?.let { arr ->
                    (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let(::parseEvent) }
                } ?: emptyList(),
            )

            TYPE_HEARTBEAT -> RelayFrame.Heartbeat(
                ts = obj.optLong("ts", 0),
                lastAckedSeq = optLong(obj, "lastAckedSeq"),
                tokenVersion = optInt(obj, "tokenVersion"),
                upstream = optString(obj, "upstream"),
                queuedCommands = optInt(obj, "queuedCommands"),
                lastSentSeq = optLong(obj, "lastSentSeq"),
            )

            TYPE_TOKEN_ROTATION -> RelayFrame.TokenRotation(
                requestId = optString(obj, "requestId"),
                deviceId = optLong(obj, "deviceId"),
                newToken = obj.getString("newToken"),
                tokenVersion = obj.getInt("tokenVersion"),
                reason = optString(obj, "reason"),
            )

            TYPE_DISCONNECT -> RelayFrame.Disconnect(
                reason = obj.getString("reason"),
                deviceId = optLong(obj, "deviceId"),
            )

            TYPE_ERROR -> RelayFrame.Error(
                requestId = optString(obj, "requestId"),
                code = obj.getString("code"),
                message = optString(obj, "message"),
                retryable = obj.optBoolean("retryable", false),
                retryAfterSec = optInt(obj, "retryAfterSec"),
            )

            TYPE_WAKE_HOST -> RelayFrame.WakeHost(
                requestId = obj.getString("requestId"),
            )

            TYPE_WAKE_RESULT -> RelayFrame.WakeResult(
                requestId = obj.getString("requestId"),
                status = WakeResultStatus.fromWire(obj.getString("status")),
                latencyMs = optLong(obj, "latencyMs"),
                retryAfterMs = optLong(obj, "retryAfterMs"),
                stderrSummary = optString(obj, "stderrSummary"),
            )

            else -> RelayFrame.Unknown(type)
        }
    }
    /**
     * event 帧解析（独立函数：sync_response 内嵌事件同形复用）。
     * 判别面按偏离①：`type:'event'` + `eventType` 字段承载事件类型。
     */
    fun parseEvent(obj: JSONObject): RelayFrame.Event = RelayFrame.Event(
        sequence = obj.getLong("sequence"),
        eventId = obj.getString("eventId"),
        deviceId = optLong(obj, "deviceId"),
        provider = optString(obj, "provider"),
        sessionId = optLong(obj, "sessionId"),
        eventType = obj.getString("eventType"),
        timestampSec = obj.getLong("timestamp"),
        summary = optString(obj, "summary"),
        payload = obj.optJSONObject("payload") ?: JSONObject(),
        requiresUserAction = obj.optBoolean("requiresUserAction", false),
    )

    fun encode(frame: RelayFrame): String = when (frame) {
        is RelayFrame.Hello -> JSONObject()
            .put("type", TYPE_HELLO)
            .put("sequence", frame.sequence)
            .putOpt("deviceId", frame.deviceId)
            .put("heartbeatSec", frame.heartbeatSec)
            .putOpt("relayVersion", frame.relayVersion)
            .putOpt("upstream", frame.upstream)
            .toString()

        is RelayFrame.Pair -> JSONObject()
            .put("type", TYPE_PAIR)
            .put("requestId", frame.requestId)
            .put("code", frame.code)
            .put("deviceName", frame.deviceName)
            .put("platform", frame.platform)
            .putOpt("clientVersion", frame.clientVersion)
            .putOpt("ecsDeviceId", frame.ecsDeviceId)
            .putOpt("pairingId", frame.pairingId)
            .toString()

        is RelayFrame.PairAccepted -> JSONObject()
            .put("type", TYPE_PAIR_ACCEPTED)
            .putOpt("requestId", frame.requestId)
            .put("deviceId", frame.deviceId)
            .put("deviceToken", frame.deviceToken)
            .put("tokenVersion", frame.tokenVersion)
            .putOpt("heartbeatSec", frame.heartbeatSec)
            .toString()

        is RelayFrame.AgentList -> JSONObject()
            .put("type", TYPE_AGENT_LIST)
            .putOpt("requestId", frame.requestId)
            .put(
                "providers",
                JSONArray().apply {
                    for (p in frame.providers) {
                        put(
                            JSONObject()
                                .put("id", p.id)
                                .put("displayName", p.displayName)
                                .putOpt("health", p.health)
                                .putOpt(
                                    "capabilities",
                                    if (p.mode == null && p.granted.isEmpty()) null
                                    else JSONObject()
                                        .putOpt("mode", p.mode)
                                        .put("granted", JSONArray(p.granted)),
                                ),
                        )
                    }
                },
            )
            .toString()

        is RelayFrame.SessionList -> JSONObject()
            .put("type", TYPE_SESSION_LIST)
            .putOpt("requestId", frame.requestId)
            .put("stale", frame.stale)
            .put(
                "sessions",
                JSONArray().apply {
                    for (s in frame.sessions) {
                        put(
                            JSONObject()
                                .put("id", s.id)
                                .putOpt("providerId", s.providerId)
                                .putOpt("nativeId", s.nativeId)
                                .putOpt("sessionMode", s.sessionMode)
                                .putOpt("status", s.status)
                                .putOpt("title", s.title)
                                .putOpt("lastActivityAt", s.lastActivityAtSec),
                        )
                    }
                },
            )
            .toString()

        is RelayFrame.Event -> encodeEvent(frame).toString()

        is RelayFrame.MessagePage -> JSONObject()
            .put("type", TYPE_MESSAGE)
            .putOpt("requestId", frame.requestId)
            .put(
                "items",
                JSONArray().apply {
                    for (m in frame.items) {
                        put(
                            JSONObject()
                                .put("id", m.id)
                                .put("role", m.role)
                                .put("contentRedacted", m.contentRedacted)
                                .putOpt("occurredAt", m.occurredAtSec),
                        )
                    }
                },
            )
            .putOpt("prevAfter", frame.prevAfter)
            .toString()

        is RelayFrame.Command -> JSONObject()
            .put("type", TYPE_COMMAND)
            .put("requestId", frame.requestId)
            .put("idempotencyKey", frame.idempotencyKey)
            // M3-E §5.3：sessionId 缺省时绝不写出猜测值（绝不猜纪律）
            .putOpt("sessionId", frame.sessionId)
            .put("action", frame.action)
            .put("payload", frame.payload)
            .putOpt(
                "auth",
                if (frame.token == null) null
                else JSONObject()
                    .put("token", frame.token)
                    .putOpt("ts", frame.tsSec)
                    .putOpt("nonce", frame.nonce),
            )
            .putOpt("createdAt", frame.createdAtSec)
            .toString()

        is RelayFrame.CommandAck -> JSONObject()
            .put("type", TYPE_COMMAND_ACK)
            .putOpt("requestId", frame.requestId)
            .put("idempotencyKey", frame.idempotencyKey)
            .putOpt("commandId", frame.commandId)
            .put("status", frame.status)
            .putOpt("errorCode", frame.errorCode)
            .putOpt("queued", if (frame.queued) true else null)
            .toString()

        is RelayFrame.CommandResult -> JSONObject()
            .put("type", TYPE_COMMAND_RESULT)
            .put("commandId", frame.commandId)
            .putOpt("idempotencyKey", frame.idempotencyKey)
            .putOpt("sessionId", frame.sessionId)
            .putOpt("action", frame.action)
            .put("status", frame.status)
            .putOpt("errorCode", frame.errorCode)
            .putOpt("timestamp", frame.timestampSec)
            .toString()

        is RelayFrame.SyncRequest -> JSONObject()
            .put("type", TYPE_SYNC_REQUEST)
            .putOpt("requestId", frame.requestId)
            .put("after", frame.after)
            .putOpt("deviceId", frame.deviceId)
            .toString()

        is RelayFrame.SyncResponse -> JSONObject()
            .put("type", TYPE_SYNC_RESPONSE)
            .putOpt("requestId", frame.requestId)
            .put("upTo", frame.upTo)
            .put("hasMore", frame.hasMore)
            .putOpt("hasGaps", if (frame.hasGaps) true else null)
            .put("events", JSONArray().apply { for (e in frame.events) put(encodeEvent(e)) })
            .toString()

        is RelayFrame.Heartbeat -> JSONObject()
            .put("type", TYPE_HEARTBEAT)
            .put("ts", frame.ts)
            .putOpt("lastAckedSeq", frame.lastAckedSeq)
            .putOpt("tokenVersion", frame.tokenVersion)
            .putOpt("upstream", frame.upstream)
            .putOpt("queuedCommands", frame.queuedCommands)
            .putOpt("lastSentSeq", frame.lastSentSeq)
            .toString()

        is RelayFrame.TokenRotation -> JSONObject()
            .put("type", TYPE_TOKEN_ROTATION)
            .putOpt("requestId", frame.requestId)
            .putOpt("deviceId", frame.deviceId)
            .put("newToken", frame.newToken)
            .put("tokenVersion", frame.tokenVersion)
            .putOpt("reason", frame.reason)
            .toString()

        is RelayFrame.Disconnect -> JSONObject()
            .put("type", TYPE_DISCONNECT)
            .put("reason", frame.reason)
            .putOpt("deviceId", frame.deviceId)
            .toString()

        is RelayFrame.Error -> JSONObject()
            .put("type", TYPE_ERROR)
            .putOpt("requestId", frame.requestId)
            .put("code", frame.code)
            .putOpt("message", frame.message)
            .put("retryable", frame.retryable)
            .putOpt("retryAfterSec", frame.retryAfterSec)
            .toString()

        is RelayFrame.WakeHost -> JSONObject()
            .put("type", TYPE_WAKE_HOST)
            .put("requestId", frame.requestId)
            .toString()

        is RelayFrame.WakeResult -> JSONObject()
            .put("type", TYPE_WAKE_RESULT)
            .put("requestId", frame.requestId)
            .put("status", frame.status.wire)
            .putOpt("latencyMs", frame.latencyMs)
            .putOpt("retryAfterMs", frame.retryAfterMs)
            .putOpt("stderrSummary", frame.stderrSummary)
            .toString()

        is RelayFrame.Unknown -> JSONObject().put("type", frame.type).toString()
    }

    private fun encodeEvent(e: RelayFrame.Event): JSONObject = JSONObject()
        .put("type", TYPE_EVENT)
        .put("sequence", e.sequence)
        .put("eventId", e.eventId)
        .putOpt("deviceId", e.deviceId)
        .putOpt("provider", e.provider)
        .putOpt("sessionId", e.sessionId)
        .put("eventType", e.eventType)
        .put("timestamp", e.timestampSec)
        .putOpt("summary", e.summary)
        .put("payload", e.payload)
        .put("requiresUserAction", e.requiresUserAction)

    // ---- org.json 缺省值歧义防护：取值带「字段确实存在」语义（0/false 不与缺省混淆） ----

    private fun optLong(obj: JSONObject, key: String): Long? =
        if (obj.has(key) && !obj.isNull(key)) obj.getLong(key) else null

    private fun optInt(obj: JSONObject, key: String): Int? =
        if (obj.has(key) && !obj.isNull(key)) obj.getInt(key) else null

    private fun optString(obj: JSONObject, key: String): String? =
        if (obj.has(key) && !obj.isNull(key)) obj.optString(key) else null
}
