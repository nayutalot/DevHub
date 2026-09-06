package com.devhub.mobile.data

import android.content.Context
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.core.TlsPinningConfig
import com.devhub.mobile.core.relay.RelayEndpoint
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.GatewayConfigEntity
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
                    // M3-C6d 修 2：relay 模式注入 pin-TM（与 ConnectionManager.parsePinning
                    // 同源规则）。生命周期取舍见 [relayPinning] 与 GatewayApi KDoc——配置
                    // 读取留在请求期 lambda（与 baseUrlProvider 同一既有模式：IO 线程 +
                    // runCatching 防御），GatewayApi 内部按指纹摘要+pinHost 缓存键惰性重建
                    // client，指纹配置变更下一次请求即生效，单例永不读旧信任锚。
                    tlsPinningProvider = {
                        relayPinning(runCatching { db.gatewayConfigDao().get() }.getOrNull())
                    },
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
     * 注（M3-C6d 修 2 后更新）：client 实例的 TLS pinning 经 [relayPinning] 注入
     * （relay 模式 pin-TM），pinner-only 旧面对自签 IP 证书的信任问题已随 GatewayApi
     * pin-TM 化一并消除（docs/19 §10.2 勘误语义覆盖 REST 数据面）。
     */
    fun modeAwareBaseUrl(mode: String?, host: String?, port: Int?, relayUrl: String?): String {
        if (mode == "relay") {
            val endpoint = runCatching { RelayEndpoint.parse(relayUrl ?: "") }.getOrNull()
            if (endpoint != null) return endpoint.restBaseUrl
        }
        return "http://${host ?: "10.0.2.2"}:${port ?: 8746}"
    }

    /**
     * M3-C6d 修 2：relay 模式 REST 面的 pinning 解析（纯函数，零 Android 依赖，JVM 单测直测）。
     * 与 ConnectionManager.parsePinning **同源同规则**（internal 同模块直调，绝不另拆一套
     * 拆分规则）+ endpoint.host 经 :core `pinPatternFor` 作 pinHost（与 rebuildRelayClients
     * 同形态）。三态防御（绝不抛出、绝不崩溃）：
     * - mode != relay / endpoint 非法 → `(null, null)`：不启用 pinning（local 明文零回归；
     *   relay endpoint 非法时 baseUrl 已防御回落本地 base，pinning 无意义）；
     * - 指纹未配置 → `(null, null)`：系统默认信任（与 ConnectionManager relayApi 同态）；
     * - 指纹条目非法（TlsPinningConfig fail-fast）→ `(null, null)`：REST 面单行防御回落，
     *   原因由连接层 refreshCachedConfig 对同一配置经 `_lastWsError` 显式暴露；https +
     *   系统默认信任下自签 IP 证书握手必然显式失败——绝不静默降级为「连上但不校验」。
     */
    internal fun relayPinning(config: GatewayConfigEntity?): Pair<TlsPinningConfig?, String?> {
        if (config?.mode != "relay") return null to null
        val endpoint = runCatching { RelayEndpoint.parse(config.relayUrl ?: "") }.getOrNull()
            ?: return null to null
        val pinning = runCatching { ConnectionManager.parsePinning(config.pinFingerprints) }
            .getOrNull() ?: return null to null
        return pinning to TlsPinningConfig.pinPatternFor(endpoint.host)
    }

    /**
     * 只读投影入口：夹具开关打开 → FixtureProjection（演示数据，UI 显著标注）；
     * 否则真实 GatewayApi。控制类调用（reply/actions）不走这里（ConnectionManager 直连 rest）。
     */
    fun projection(context: Context): ProjectionApi =
        if (FixtureMode.enabled(context)) FixtureProjection.get() else rest(context)
}
