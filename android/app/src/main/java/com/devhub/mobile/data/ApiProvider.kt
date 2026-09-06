package com.devhub.mobile.data

import android.content.Context
import com.devhub.mobile.core.relay.RelayEndpoint
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.remote.FixtureProjection
import com.devhub.mobile.data.remote.GatewayApi
import com.devhub.mobile.data.remote.ProjectionApi

/** UI 层共享的 REST 客户端（token/gateway 配置动态读取；进程内单例）。 */
object ApiProvider {
    @Volatile
    private var api: GatewayApi? = null

    fun rest(context: Context): GatewayApi {
        val existing = api
        if (existing != null) return existing
        synchronized(this) {
            if (api == null) {
                val db = DevHubDb.get(context)
                val appContext = context.applicationContext
                api = GatewayApi(
                    baseUrlProvider = {
                        val config = runCatching { db.gatewayConfigDao().get() }.getOrNull()
                        modeAwareBaseUrl(
                            mode = config?.mode,
                            host = config?.host,
                            port = config?.port,
                            relayUrl = config?.relayUrl,
                        )
                    },
                    tokenProvider = { SecureStore.loadToken(appContext) },
                )
            }
            return api!!
        }
    }

    /**
     * M3-C6c bug#2（C2c 实录）：REST base **按连接模式切换**——mode == relay 时会话/设备/
     * 自撤销等 REST 请求改打 ECS REST 面（`https://<endpoint.host>:<port>`，docs/18 §7.1，
     * 与 ConnectionManager relayApi 同形态，参照其正确实现），绝不再打 `http://host:port`
     * 桌面网关（旧实现恒打该面 → relay Token 被桌面网关拒 AUTH_INVALID_TOKEN——文案
     * "gateway:" 前缀即桌面网关实锤）。
     *
     * 纯函数（零 Android 依赖，JVM 单测直测）：
     * - local / 未配置 → `http://host:port`（缺省回落 10.0.2.2:8746 模拟器默认，原语义）；
     * - relay → endpoint 经 [RelayEndpoint.parse]（保存层已强制 wss）取 `restBaseUrl`；
     *   endpoint 非法的防御态回落本地 base（连接层 `_lastWsError` 同步暴露配置错误，
     *   REST 面不静默吞也绝不因此崩溃）。
     * 注：client 实例的 TLS pinning 与本函数无关（GatewayApi pinner-only 面对自签 IP 证书
     * 的信任问题属既有连接层结构，本批不扩——docs/19 §10.2 勘误仅覆盖 pin-TM 面）。
     */
    fun modeAwareBaseUrl(mode: String?, host: String?, port: Int?, relayUrl: String?): String {
        if (mode == "relay") {
            val endpoint = runCatching { RelayEndpoint.parse(relayUrl ?: "") }.getOrNull()
            if (endpoint != null) return endpoint.restBaseUrl
        }
        return "http://${host ?: "10.0.2.2"}:${port ?: 8746}"
    }

    /**
     * 只读投影入口：夹具开关打开 → FixtureProjection（演示数据，UI 显著标注）；
     * 否则真实 GatewayApi。控制类调用（reply/actions）不走这里（ConnectionManager 直连 rest）。
     */
    fun projection(context: Context): ProjectionApi =
        if (FixtureMode.enabled(context)) FixtureProjection.get() else rest(context)
}
