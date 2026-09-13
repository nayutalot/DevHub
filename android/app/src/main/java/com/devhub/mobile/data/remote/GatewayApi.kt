package com.devhub.mobile.data.remote

import com.devhub.mobile.core.TlsPinningConfig
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONException
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
 * 非 null 时对 TLS 连接（https）启用 SPKI 指纹锁定。M3-C3a 修 2（C2 #3）：pin pattern
 * 为**具体 host**——[pinHost] 必须给出（IP 字面量直接作 pattern）；空/非法 host =
 * fail-fast 不注入（绝不通配符 `'*'`——OkHttp 抛 IllegalArgumentException，
 * 曾致 relay 配置指纹后进程崩溃死循环）。
 *
 * M3-C6d 修 1（docs/19 §10.2 勘误语义覆盖 REST 数据面，与 WS/pair 面同语义）：pinning
 * 有效且 pattern 可解析 → [RelayTlsTrust.sslSocketFactory] 自定义 TrustManager（信任锚 =
 * 配置指纹，叶 SPKI 就地裁决），**绝不装 CertificatePinner**——Android 对自定义 TM 的
 * 链清洗 fallback 返回空链，pinner 只对清洁链配 pin → 空链即拒（空洞拒连）；
 * HostnameVerifier 默认（IP SAN 第二保险）。pinner-only 旧面已全量退役
 * （`toCertificatePinner` 随之零消费删除）。
 *
 * M3-C6d 修 2（生命周期最小方案）：[tlsPinningProvider] 可选动态注入（ApiProvider relay
 * 模式用）——client 的 TLS 在构建时固化而 baseUrl 动态，故 client 按（指纹列表摘要+
 * pinHost）缓存键惰性重建：指纹配置变更后下一次请求自动换用新信任锚，无需外部失效通知；
 * provider 为 null 时键恒定只建一次（静态参数调用方——ConnectionManager.relayApi 等——
 * 行为不变，其生命周期仍由 refreshCachedConfig → rebuildRelayClients 自管）。
 */
class GatewayApi(
    private val baseUrlProvider: () -> String,
    private val tokenProvider: () -> String?,
    private val tlsPinning: TlsPinningConfig? = null,
    private val pinHost: String? = null,
    private val tlsPinningProvider: (() -> Pair<TlsPinningConfig?, String?>)? = null,
) : ProjectionApi {

    private val clientLock = Any()

    /** 缓存键 = 已归一化指纹列表摘要 + pinHost（M3-C6d 生命周期：换键即重建）。 */
    @Volatile
    private var clientCache: Pair<String, OkHttpClient>? = null

    val client: OkHttpClient
        get() {
            val resolved = tlsPinningProvider?.invoke() ?: (tlsPinning to pinHost)
            val key = (resolved.first?.fingerprints?.joinToString(",") ?: "") + "|" + (resolved.second ?: "")
            clientCache?.let { if (it.first == key) return it.second }
            synchronized(clientLock) {
                clientCache?.let { if (it.first == key) return it.second }
                val built = buildClient(resolved.first, resolved.second)
                clientCache = key to built
                return built
            }
        }

    /**
     * M3-C3a 修 2：pattern 由 :core 纯逻辑解析（IP/域名/空三态）；pinHost 空/非法 =
     * fail-fast 不注入（https 系统默认信任继续生效，自签 IP 证书由握手失败显式暴露，
     * 绝不静默放行）。M3-C6d 修 1：注入形态 = pin-TM（信任锚 = 指纹），绝不并装 pinner。
     */
    private fun buildClient(pinning: TlsPinningConfig?, pinHost: String?): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(ProtocolHeadersInterceptor(tokenProvider))
            .apply {
                pinning?.let { pin ->
                    TlsPinningConfig.pinPatternFor(pinHost)?.let {
                        val (factory, trustManager) = RelayTlsTrust.sslSocketFactory(pin)
                        sslSocketFactory(factory, trustManager)
                    }
                }
            }
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
                if (body.isEmpty()) return JSONObject()
                // P0 热修（2026-09-13 用户真机「连接失败闪退」）：非 JSON 成功响应体
                //（网关被中间盒/ captive portal 劫持回 HTML、坏代理注入等——「连不上」
                // 面的真实形态之一）绝不抛 JSONException：RuntimeException 不在调用方
                // catch（ApiError/IOException）面内，会穿透 UI/连接协程致进程闪退。
                // 结构化 ApiError（BAD_PAYLOAD）如实上屏（ErrorPresent 已有人话映射）。
                return try {
                    JSONObject(body)
                } catch (err: JSONException) {
                    throw ApiError(
                        code = "BAD_PAYLOAD",
                        message = "gateway: response body is not valid JSON (http ${resp.code})",
                        httpCode = resp.code,
                    )
                }
            }
            val (code, message) = Dtos.parseError(body) ?: ("INTERNAL" to "gateway: unexpected error body")
            val retryAfter = resp.header("Retry-After")?.toIntOrNull()
            throw ApiError(code = code, message = message, httpCode = resp.code, retryAfterSec = retryAfter)
        }
        @Suppress("UNREACHABLE_CODE")
        throw IOException("unreachable")
    }

    /**
     * B1 泛化热修（P0 同类，2026-09-13）：2xx 响应体是**合法 JSON** 但违反 docs/14 §B.1
     * DTO 契约（形状/错型/必填缺失：如 `{"providers":"x"}`、数组元素非对象、claim 体缺
     * deviceId）→ Dtos 解析抛 JSONException/NumberFormatException。该抛出族不在任何
     * 调用方既有 catch（ApiError/IOException）面内：UI 提交协程（reply/actions/spawn）
     * 与离线补发轮均会穿透（P0 实证模式 = 进程闪退 / 连接循环终止）。
     * 对齐 P0 execute 修法：结构化 ApiError(BAD_PAYLOAD) 如实上抛，原异常 message 收进
     * 不吞码（ErrorPresent 已有 BAD_PAYLOAD 人话映射：「App 与网关版本可能不匹配」）。
     * 只有 2xx 响应体会到达 Dtos 解析（非 2xx 已在 execute 转 ApiError；空体→空对象），
     * 故 httpCode 记 200（2xx 形态）。
     */
    private inline fun <T> parseContract(body: JSONObject, parse: (JSONObject) -> T): T =
        try {
            parse(body)
        } catch (err: JSONException) {
            throw ApiError(
                code = "BAD_PAYLOAD",
                message = "gateway: response JSON violates contract (${err.message})",
                httpCode = 200,
            )
        } catch (err: NumberFormatException) {
            throw ApiError(
                code = "BAD_PAYLOAD",
                message = "gateway: response JSON violates contract (${err.message})",
                httpCode = 200,
            )
        }

    private fun get(path: String): JSONObject = execute(Request.Builder().url(url(path)).get().build())

    private fun post(path: String, payload: JSONObject): JSONObject =
        execute(Request.Builder().url(url(path)).post(payload.toString().toRequestBody(jsonMedia)).build())

    private fun delete(path: String): JSONObject = execute(Request.Builder().url(url(path)).delete().build())

    // --- 端点（docs/14 §B.1 逐条） -----------------------------------------

    /** GET /v1/health（无鉴权活性探测）。 */
    fun health(): HealthInfo = parseContract(get("/v1/health"), Dtos::parseHealth)

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
        return parseContract(post("/v1/pairing/claim", payload), Dtos::parseClaim)
    }

    /** GET /v1/agents。 */
    override fun agents(): List<AgentDto> = parseContract(get("/v1/agents"), Dtos::parseAgents)

    /** GET /v1/sessions?limit（R3 includeArchived / R2 parentId 契约参数，批次 A 同名实现）。 */
    override fun sessions(limit: Int, includeArchived: Boolean, parentId: Long?): List<SessionDto> =
        parseContract(
            get(com.devhub.mobile.core.SessionListOps.sessionsQuery(limit, includeArchived, parentId)),
            Dtos::parseSessions,
        )

    /** GET /v1/sessions/{id}（R2：childSessions 可选附加）。 */
    override fun sessionDetail(sessionId: Long): SessionDetailDto =
        parseContract(get("/v1/sessions/$sessionId"), Dtos::parseSessionDetail)

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
        return parseContract(get(query), Dtos::parseMessages)
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
    fun reply(sessionId: Long, text: String, idempotencyKey: String): CommandAccept = parseContract(
        post(
            "/v1/sessions/$sessionId/reply",
            JSONObject().put("text", text).put("idempotencyKey", idempotencyKey),
        ),
        Dtos::parseCommandAccept,
    )

    /** POST /v1/sessions/{id}/actions（pause | resume；202 accepted）。 */
    fun action(sessionId: Long, action: String, idempotencyKey: String): CommandAccept = parseContract(
        post(
            "/v1/sessions/$sessionId/actions",
            JSONObject().put("action", action).put("idempotencyKey", idempotencyKey),
        ),
        Dtos::parseCommandAccept,
    )

    /**
     * POST /v1/providers/{providerId}/sessions（R6 启动托管会话；202 accepted|executed）。
     * 仅对 capabilities 已授予 managed 的 provider 有意义——调用方（UI 门）须先经
     * InteractionHonesty.canSpawnManagedSession 判定；服务端 L3 二次校验非 managed →
     * 403 COMMAND_NOT_EXECUTABLE。控制类端点：刻意不进 ProjectionApi（夹具绝不伪造）。
     */
    fun startManagedSession(providerId: Long, task: String, idempotencyKey: String): ManagedSessionStart = parseContract(
        post(
            "/v1/providers/$providerId/sessions",
            JSONObject().put("task", task).put("idempotencyKey", idempotencyKey),
        ),
        Dtos::parseManagedSessionStart,
    )

    /** GET /v1/devices。 */
    fun devices(): List<DeviceDto> = parseContract(get("/v1/devices"), Dtos::parseDevices)

    /** DELETE /v1/devices/{id}（仅自撤销）。 */
    fun revokeSelf(deviceId: Long): Unit {
        delete("/v1/devices/$deviceId")
    }

    /** GET /v1/diagnostics。 */
    fun diagnostics(): DiagnosticsDto = parseContract(get("/v1/diagnostics"), Dtos::parseDiagnostics)

    /** POST /v1/events/{seq}/ack（WS ack 的 REST 等效兜底）。 */
    fun ackEvent(sequence: Long) {
        post("/v1/events/$sequence/ack", JSONObject())
    }
}
