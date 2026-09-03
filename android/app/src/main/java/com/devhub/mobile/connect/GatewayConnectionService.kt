package com.devhub.mobile.connect

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.ServiceCompat

/**
 * 前台服务（dataSync）：保持 WS 长连（常驻通知「DevHub Agent 连接中」，docs/11 §7）。
 * 生命周期：MainActivity 配对成功后 start；撤销/失效（401）时 ConnectionManager 回调 stop。
 */
class GatewayConnectionService : Service() {

    override fun onCreate() {
        super.onCreate()
        Notifier.ensureChannels(this)
    }

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
            Notifier.connectionNotification(this, "远程面 ${ConnectionManager.baseUrl()} · ${ConnectionManager.diagnosticsSnapshot()}"),
            android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
    }

    override fun onDestroy() {
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
