package com.devhub.mobile.data

import android.content.Context
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
                api = GatewayApi(
                    baseUrlProvider = {
                        val config = db.gatewayConfigDao().get()
                        "http://${config?.host ?: "10.0.2.2"}:${config?.port ?: 8746}"
                    },
                    tokenProvider = { SecureStore.loadToken(context.applicationContext) },
                )
            }
            return api!!
        }
    }

    /**
     * 只读投影入口：夹具开关打开 → FixtureProjection（演示数据，UI 显著标注）；
     * 否则真实 GatewayApi。控制类调用（reply/actions）不走这里（ConnectionManager 直连 rest）。
     */
    fun projection(context: Context): ProjectionApi =
        if (FixtureMode.enabled(context)) FixtureProjection.get() else rest(context)
}
