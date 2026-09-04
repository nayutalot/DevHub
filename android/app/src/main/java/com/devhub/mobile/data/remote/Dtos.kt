package com.devhub.mobile.data.remote

import org.json.JSONArray
import org.json.JSONObject

/**
 * Gateway REST DTO（docs/14 §B.1 权威契约；org.json 解析，零额外依赖）。
 * 解析纪律：字段缺失容忍（opt*），类型不匹配直接抛（服务端契约冻结，异常即 bug）。
 */

/** 统一错误结构 {"error":{"code","message"}}（docs/14 Part C）。 */
class ApiError(
    val code: String,
    /** AC7b 编译修复：显式 override Throwable.message。 */
    override val message: String,
    val httpCode: Int,
    val retryAfterSec: Int? = null,
) : Exception("[$httpCode][$code] $message") {
    /** Token 撤销/失效/未配对 → 全局 401 处理（停服务+清凭据+回配对页）。 */
    val isAuthFatal: Boolean
        get() = httpCode == 401 && code in setOf("DEVICE_REVOKED", "AUTH_INVALID_TOKEN", "DEVICE_NOT_PAIRED")
}

data class HealthInfo(val name: String, val version: String, val uptimeSec: Long)

data class ClaimResult(
    val deviceId: Long,
    val token: String,
    val tokenVersion: Int,
    val gatewayName: String,
)

data class CapabilitiesDto(
    val mode: String,
    val granted: List<String>,
    val verifiedAtSec: Long,
    val evidence: String,
)

data class AgentDto(
    val id: Long,
    val displayName: String,
    val health: String,
    val capabilities: CapabilitiesDto,
)

data class SessionDto(
    val id: Long,
    val providerId: Long,
    val nativeId: String,
    val sessionMode: String,
    val title: String?,
    val status: String,
    val statusDetail: String?,
    val startedAtSec: Long?,
    val lastActivityAtSec: Long?,
    val endedAtSec: Long?,
    val stale: Boolean,
    // —— 体验整改批附加字段（可选，向后兼容；字段名 = docs/17 §2 契约，批次 A 同名实现）——
    val providerKey: String? = null,
    val providerLabel: String? = null,
    val archived: Boolean = false,
    val parentSessionId: Long? = null,
)

data class SessionDetailDto(
    val session: SessionDto,
    val capabilities: CapabilitiesDto,
    /** R2：子智能体会话（含已结束；旧端点无此字段 → 空列表，入口隐藏）。 */
    val childSessions: List<SessionDto> = emptyList(),
)

/** R1 消息分段（任务书 §2：kind='text'|'thinking'|'toolInvocation', label?, content）。 */
data class SegmentDto(val kind: String, val label: String?, val content: String)

data class MessageDto(
    val id: Long,
    val role: String,
    val contentRedacted: String,
    val occurredAtSec: Long?,
    val segments: List<SegmentDto>? = null,
)

data class MessagesPage(
    val items: List<MessageDto>,
    val nextAfter: Long?,
    /** R10：向旧翻页游标（last=<n> 尾部取数时返回；after 正向语义不变）。 */
    val prevAfter: Long? = null,
)

data class DeviceDto(
    val id: Long,
    val deviceName: String,
    val platform: String,
    val status: String,
    val pairedAtSec: Long,
    val lastSeenAtSec: Long?,
    val tokenVersion: Int,
)

data class CommandAccept(val commandId: String, val status: String)

data class DiagProvider(
    val id: String,
    val installed: Boolean,
    val version: String?,
    val exeFound: Boolean,
    val dataSourceKind: String?,
    val dataSourceReadable: Boolean?,
    val controlNote: String?,
)

data class GatewayStatusDto(
    val enabled: Boolean,
    val running: Boolean,
    val port: Long?,
    val actualPort: Long?,
    val activeDevices: Int,
    val lastError: String?,
)

data class DiagnosticsDto(val providers: List<DiagProvider>, val gateway: GatewayStatusDto?)

// ---------------------------------------------------------------------------
// 解析器（JSONArray 元素一律按 String 取出再 new JSONObject(String)，单一遍历原语）
// ---------------------------------------------------------------------------

object Dtos {
    fun parseHealth(body: JSONObject): HealthInfo = HealthInfo(
        name = body.getString("name"),
        version = body.getString("version"),
        uptimeSec = body.getLong("uptimeSec"),
    )

    fun parseClaim(body: JSONObject): ClaimResult = ClaimResult(
        deviceId = body.getLong("deviceId"),
        token = body.getString("token"),
        tokenVersion = body.getInt("tokenVersion"),
        gatewayName = body.getString("gatewayName"),
    )

    fun parseCapabilities(body: JSONObject): CapabilitiesDto = CapabilitiesDto(
        mode = body.getString("mode"),
        granted = body.getJSONArray("granted").toStringList(),
        verifiedAtSec = body.getLong("verifiedAt"),
        evidence = body.optString("evidence"),
    )

    fun parseAgents(body: JSONObject): List<AgentDto> = body.getJSONArray("providers").mapObjects { raw ->
        val o = JSONObject(raw)
        AgentDto(
            id = o.getLong("id"),
            displayName = o.getString("displayName"),
            health = o.getString("health"),
            capabilities = parseCapabilities(o.getJSONObject("capabilities")),
        )
    }

    fun parseSession(o: JSONObject): SessionDto = SessionDto(
        id = o.getLong("id"),
        providerId = o.getLong("providerId"),
        nativeId = o.getString("nativeId"),
        sessionMode = o.getString("sessionMode"),
        title = o.optString("title").takeIf { it.isNotEmpty() },
        status = o.getString("status"),
        statusDetail = o.optString("statusDetail").takeIf { it.isNotEmpty() },
        startedAtSec = o.optLong("startedAt", -1).takeIf { it > 0 },
        lastActivityAtSec = o.optLong("lastActivityAt", -1).takeIf { it > 0 },
        endedAtSec = o.optLong("endedAt", -1).takeIf { it > 0 },
        stale = o.optBoolean("stale", false),
        // R4/R2/R3 附加字段（旧端点缺失 → null/false，UI 回退不回归）
        providerKey = o.optString("providerKey").takeIf { it.isNotEmpty() },
        providerLabel = o.optString("providerLabel").takeIf { it.isNotEmpty() },
        archived = o.optBoolean("archived", false),
        parentSessionId = o.optLong("parentSessionId", -1).takeIf { it > 0 },
    )

    fun parseSessions(body: JSONObject): List<SessionDto> =
        body.getJSONArray("sessions").mapObjects { raw -> parseSession(JSONObject(raw)) }

    fun parseSessionDetail(body: JSONObject): SessionDetailDto = SessionDetailDto(
        session = parseSession(body.getJSONObject("session")),
        capabilities = parseCapabilities(body.getJSONObject("capabilities")),
        childSessions = body.optJSONArray("childSessions")?.mapObjects { raw -> parseSession(JSONObject(raw)) }
            ?: emptyList(),
    )

    /** R1 segments：字段级 opt 容忍（label/content 缺失 → null），数组缺失 → null（App 回退整段纯文本）。 */
    fun parseSegments(arr: org.json.JSONArray?): List<SegmentDto>? = arr?.mapObjects { raw ->
        val o = JSONObject(raw)
        SegmentDto(
            kind = o.optString("kind"),
            label = o.optString("label").takeIf { it.isNotEmpty() },
            content = o.optString("content"),
        )
    }

    fun parseMessages(body: JSONObject): MessagesPage = MessagesPage(
        items = body.getJSONArray("items").mapObjects { raw ->
            val o = JSONObject(raw)
            MessageDto(
                id = o.getLong("id"),
                role = o.getString("role"),
                contentRedacted = o.getString("contentRedacted"),
                occurredAtSec = o.optLong("occurredAt", -1).takeIf { it > 0 },
                segments = parseSegments(o.optJSONArray("segments")),
            )
        },
        nextAfter = body.optLong("nextAfter", -1).takeIf { it > 0 },
        prevAfter = body.optLong("prevAfter", -1).takeIf { it > 0 },
    )

    fun parseDevices(body: JSONObject): List<DeviceDto> = body.getJSONArray("devices").mapObjects { raw ->
        val o = JSONObject(raw)
        DeviceDto(
            id = o.getLong("id"),
            deviceName = o.getString("deviceName"),
            platform = o.getString("platform"),
            status = o.getString("status"),
            pairedAtSec = o.getLong("pairedAt"),
            lastSeenAtSec = o.optLong("lastSeenAt", -1).takeIf { it > 0 },
            tokenVersion = o.getInt("tokenVersion"),
        )
    }

    fun parseCommandAccept(body: JSONObject): CommandAccept = CommandAccept(
        commandId = body.getString("commandId"),
        status = body.getString("status"),
    )

    fun parseDiagnostics(body: JSONObject): DiagnosticsDto = DiagnosticsDto(
        providers = body.optJSONArray("providers")?.mapObjects { raw ->
            val o = JSONObject(raw)
            val source = o.optJSONObject("dataSource")
            DiagProvider(
                id = o.optString("id"),
                installed = o.optBoolean("installed", false),
                version = o.optString("version").takeIf { it.isNotEmpty() },
                exeFound = o.optBoolean("exeFound", false),
                dataSourceKind = source?.optString("kind")?.takeIf { it.isNotEmpty() },
                dataSourceReadable = source?.optBoolean("readable"),
                controlNote = o.optJSONObject("control")?.optString("note")?.takeIf { it.isNotEmpty() },
            )
        } ?: emptyList(),
        gateway = body.optJSONObject("gateway")?.let { parseGatewayStatus(it) },
    )

    fun parseGatewayStatus(o: JSONObject): GatewayStatusDto = GatewayStatusDto(
        enabled = o.optBoolean("enabled", false),
        running = o.optBoolean("running", false),
        port = o.optLong("port", -1).takeIf { it > 0 },
        actualPort = o.optLong("actualPort", -1).takeIf { it > 0 },
        activeDevices = o.optInt("activeDevices", 0),
        lastError = o.optString("lastError").takeIf { it.isNotEmpty() },
    )

    /** {"error":{"code","message"}} 解析；非契约形态 → null。 */
    fun parseError(body: String): Pair<String, String>? =
        try {
            val err = JSONObject(body).optJSONObject("error") ?: return null
            val code = err.optString("code")
            val message = err.optString("message")
            if (code.isNotEmpty()) code to message else null
        } catch (err: Exception) {
            null
        }
}

internal fun JSONArray.toStringList(): List<String> = (0 until length()).map { getString(it) }

internal inline fun <T> JSONArray.mapObjects(transform: (String) -> T): List<T> =
    (0 until length()).map { idx -> transform(getString(idx)) }
