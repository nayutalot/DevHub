package com.devhub.mobile.data.remote

import com.devhub.mobile.core.TlsPinningConfig
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * 防重放两头拦截器（docs/14 §B.4）：
 * - X-DevHub-Timestamp：unix 秒（服务端 ±300s 窗口）；
 * - X-DevHub-Nonce：UUID（128-bit 随机的可打印编码形态，16-128 字符；服务端 LRU 10min 去重）。
 * 所有请求统一携带；/v1/health 与 /v1/pairing/claim 服务端豁免（本端也不送，与契约对齐）。
 * 鉴权头 Authorization: Bearer <token> 由 tokenProvider 动态取（撤销后即空）。
 */
class ProtocolHeadersInterceptor(
    private val tokenProvider: () -> String?,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val path = request.url.encodedPath
        val builder = request.newBuilder()
        if (path != "/v1/health" && path != "/v1/pairing/claim") {
            tokenProvider()?.let { token ->
                builder.header("Authorization", "Bearer $token")
            }
            builder.header("X-DevHub-Timestamp", (System.currentTimeMillis() / 1000).toString())
            builder.header("X-DevHub-Nonce", UUID.randomUUID().toString())
        }
        return chain.proceed(builder.build())
    }
}

/**
 * 只读投影面（体验整改批抽取的接口）：GatewayApi 真实实现；夹具联调用 FixtureProjection 实现同签名。
 * 控制类端点（reply/actions/claim）刻意不在接口内——夹具绝不伪造控制通道（红线）。
 */
interface ProjectionApi {
    fun agents(): List<AgentDto>

    fun sessions(limit: Int = 200, includeArchived: Boolean = false, parentId: Long? = null): List<SessionDto>

    fun sessionDetail(sessionId: Long): SessionDetailDto

    /**
     * R10 契约：last=<n> 尾部取数（返回 prevAfter 游标）；after 正向语义保持（增量回流用）；
     * before=<prevAfter> 向旧翻页（prevAfter 游标回传参数名，客户端侧实现约定）。
     */
    fun messages(sessionId: Long, after: Long? = null, last: Int? = null, before: Long? = null, limit: Int = 200): MessagesPage

    /** R3 归档/删除：只动 DevHub 本地投影。 */
    fun archive(sessionId: Long)

    fun unarchive(sessionId: Long)

    fun deleteSession(sessionId: Long)
}

/**
 * Gateway REST 客户端（docs/14 §B.1 13 端点的 Android 面）。
 * 同步执行（调用方负责切 Dispatchers.IO）；网络失败以 IOException 上抛
 * （离线队列按 QueueReplayPlanner 分类）；结构化错误统一 ApiError。
 *
 * U1 注入缝（docs/21 §1.1 / docs/19 §10.2）：[tlsPinning] 可选指纹配置（无域名 IP TLS）——
 * null（默认）= 现行为不变（local 模式 http/ws 明文、无 pinning，零回归）；
 * 非 null 时对 TLS 连接（https）启用 SPKI 指纹锁定（relay 模式接线属 R3 批，docs/20 §2.3）。
 */
class GatewayApi(
    private val baseUrlProvider: () -> String,
    private val tokenProvider: () -> String?,
    private val tlsPinning: TlsPinningConfig? = null,
) : ProjectionApi {
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(ProtocolHeadersInterceptor(tokenProvider))
        .apply { tlsPinning?.let { certificatePinner(it.toCertificatePinner()) } }
        .build()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private fun url(path: String): String = baseUrlProvider().trimEnd('/') + path

    private fun execute(request: Request): JSONObject {
        val response = try {
            client.newCall(request).execute()
        } catch (err: IOException) {
            throw err // 网络层失败：调用方（离线队列）按 RETRY_LATER 处理
        }
        response.use { resp ->
            val body = resp.body?.string() ?: ""
            if (resp.isSuccessful) {
                return if (body.isEmpty()) JSONObject() else JSONObject(body)
            }
            val (code, message) = Dtos.parseError(body) ?: ("INTERNAL" to "gateway: unexpected error body")
            val retryAfter = resp.header("Retry-After")?.toIntOrNull()
            throw ApiError(code = code, message = message, httpCode = resp.code, retryAfterSec = retryAfter)
        }
        @Suppress("UNREACHABLE_CODE")
        throw IOException("unreachable")
    }

    private fun get(path: String): JSONObject = execute(Request.Builder().url(url(path)).get().build())

    private fun post(path: String, payload: JSONObject): JSONObject =
        execute(Request.Builder().url(url(path)).post(payload.toString().toRequestBody(jsonMedia)).build())

    private fun delete(path: String): JSONObject = execute(Request.Builder().url(url(path)).delete().build())

    // --- 端点（docs/14 §B.1 逐条） -----------------------------------------

    /** GET /v1/health（无鉴权活性探测）。 */
    fun health(): HealthInfo = Dtos.parseHealth(get("/v1/health"))

    /**
     * POST /v1/pairing/claim（AC7b 裁决：pairingId 可选——null/空白时不发送该字段，
     * code-only 依赖服务端「同时仅 1 活跃码」唯一定位；platform 固定 android）。
     */
    fun claim(pairingId: String?, code: String, deviceName: String): ClaimResult {
        val payload = JSONObject()
            .put("code", code.uppercase())
            .put("deviceName", deviceName)
            .put("platform", "android")
        if (!pairingId.isNullOrBlank()) {
            payload.put("pairingId", pairingId)
        }
        return Dtos.parseClaim(post("/v1/pairing/claim", payload))
    }

    /** GET /v1/agents。 */
    override fun agents(): List<AgentDto> = Dtos.parseAgents(get("/v1/agents"))

    /** GET /v1/sessions?limit（R3 includeArchived / R2 parentId 契约参数，批次 A 同名实现）。 */
    override fun sessions(limit: Int, includeArchived: Boolean, parentId: Long?): List<SessionDto> =
        Dtos.parseSessions(get(com.devhub.mobile.core.SessionListOps.sessionsQuery(limit, includeArchived, parentId)))

    /** GET /v1/sessions/{id}（R2：childSessions 可选附加）。 */
    override fun sessionDetail(sessionId: Long): SessionDetailDto = Dtos.parseSessionDetail(get("/v1/sessions/$sessionId"))

    /** GET /v1/sessions/{id}/messages?after|last|before（游标分页；R10 尾部取数 last=<n> → prevAfter）。 */
    override fun messages(sessionId: Long, after: Long?, last: Int?, before: Long?, limit: Int): MessagesPage {
        val query = buildString {
            append("/v1/sessions/")
            append(sessionId)
            append("/messages?limit=")
            append(limit)
            if (last != null) {
                append("&last=")
                append(last)
            }
            if (after != null) {
                append("&after=")
                append(after)
            }
            if (before != null) {
                append("&before=")
                append(before)
            }
        }
        return Dtos.parseMessages(get(query))
    }

    /** POST /v1/sessions/{id}/archive（R3：只动本地投影）。 */
    override fun archive(sessionId: Long) {
        post("/v1/sessions/$sessionId/archive", JSONObject())
    }

    /** POST /v1/sessions/{id}/unarchive。 */
    override fun unarchive(sessionId: Long) {
        post("/v1/sessions/$sessionId/unarchive", JSONObject())
    }

    /** DELETE /v1/sessions/{id}（R3：仅移除 DevHub 记录，绝不触碰源文件）。 */
    override fun deleteSession(sessionId: Long) {
        delete("/v1/sessions/$sessionId")
    }

    /** POST /v1/sessions/{id}/reply（能力门：reply ∈ granted；202 accepted）。 */
    fun reply(sessionId: Long, text: String, idempotencyKey: String): CommandAccept = Dtos.parseCommandAccept(
        post(
            "/v1/sessions/$sessionId/reply",
            JSONObject().put("text", text).put("idempotencyKey", idempotencyKey),
        ),
    )

    /** POST /v1/sessions/{id}/actions（pause | resume；202 accepted）。 */
    fun action(sessionId: Long, action: String, idempotencyKey: String): CommandAccept = Dtos.parseCommandAccept(
        post(
            "/v1/sessions/$sessionId/actions",
            JSONObject().put("action", action).put("idempotencyKey", idempotencyKey),
        ),
    )

    /**
     * POST /v1/providers/{providerId}/sessions（R6 启动托管会话；202 accepted|executed）。
     * 仅对 capabilities 已授予 managed 的 provider 有意义——调用方（UI 门）须先经
     * InteractionHonesty.canSpawnManagedSession 判定；服务端 L3 二次校验非 managed →
     * 403 COMMAND_NOT_EXECUTABLE。控制类端点：刻意不进 ProjectionApi（夹具绝不伪造）。
     */
    fun startManagedSession(providerId: Long, task: String, idempotencyKey: String): ManagedSessionStart =
        Dtos.parseManagedSessionStart(
            post(
                "/v1/providers/$providerId/sessions",
                JSONObject().put("task", task).put("idempotencyKey", idempotencyKey),
            ),
        )

    /** GET /v1/devices。 */
    fun devices(): List<DeviceDto> = Dtos.parseDevices(get("/v1/devices"))

    /** DELETE /v1/devices/{id}（仅自撤销）。 */
    fun revokeSelf(deviceId: Long): Unit {
        delete("/v1/devices/$deviceId")
    }

    /** GET /v1/diagnostics。 */
    fun diagnostics(): DiagnosticsDto = Dtos.parseDiagnostics(get("/v1/diagnostics"))

    /** POST /v1/events/{seq}/ack（WS ack 的 REST 等效兜底）。 */
    fun ackEvent(sequence: Long) {
        post("/v1/events/$sequence/ack", JSONObject())
    }
}
