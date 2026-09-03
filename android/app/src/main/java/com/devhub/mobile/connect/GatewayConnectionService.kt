package com.devhub.mobile.connect

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 前台服务（dataSync）：保持 WS 长连（常驻通知「DevHub Agent 连接中」，docs/11 §7）。
 * 生命周期：MainActivity 配对成功后 start；撤销/失效（401）时 ConnectionManager 回调 stop。
 */
class GatewayConnectionService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
        // AC8 真机 e2e 实测缺陷修复：常驻通知文本原为 startAsForeground 一次性构建，
        // 网关配置改端口 / 连接状态变化后仍显示旧值（实测：已连 8760 仍显示「10.0.2.2:8746」）。
        // 订阅连接状态：文本变化即重发同 ID 通知（仅文本刷新，零新增权限/通道）。
        scope.launch {
            var lastText: String? = null
            ConnectionManager.state.collect {
                val text = connectionText()
                if (text != lastText) {
                    lastText = text
                    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
                    manager.notify(Notifier.ID_CONNECTION, Notifier.connectionNotification(this@GatewayConnectionService, text))
                }
            }
        }
    }

    private fun connectionText(): String =
        "远程面 ${ConnectionManager.baseUrl()} · ${ConnectionManager.diagnosticsSnapshot()}"

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        ConnectionManager.init(this)
        ConnectionManager.start()
        return START_STICKY
    }

    private fun startAsForeground() {
        // AC7b 编译修复：core 1.16 的 ServiceCompat.startForeground 为 4 参（须显式
        // foregroundServiceType）；与 Manifest 的 android:foregroundServiceType="dataSync"
        // 及 FOREGROUND_SERVICE_DATA_SYNC 权限对齐（targetSdk 35 要求）。
        ServiceCompat.startForeground(
            this,
            Notifier.ID_CONNECTION,
            Notifier.connectionNotification(this, connectionText()),
            android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
    }

    override fun onDestroy() {
        scope.cancel()
        ConnectionManager.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        fun start(context: Context) {
            val intent = Intent(context, GatewayConnectionService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, GatewayConnectionService::class.java))
        }
    }
}
