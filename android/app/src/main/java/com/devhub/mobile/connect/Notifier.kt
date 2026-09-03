package com.devhub.mobile.connect

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import com.devhub.mobile.R
import com.devhub.mobile.core.EventNotification

/**
 * 系统通知（docs/11 §7）：
 * - 常驻连接通知（低优先级，前台服务身份）；
 * - 事件通知（仅脱敏 summary 直显；点击 deep link devhub://session/{id} → 会话详情）。
 */
object Notifier {
    const val CHANNEL_CONNECTION = "connection"
    const val CHANNEL_EVENTS = "events"
    const val ID_CONNECTION = 1

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_CONNECTION, context.getString(R.string.notif_channel_connection), NotificationManager.IMPORTANCE_LOW),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_EVENTS, context.getString(R.string.notif_channel_events), NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    /** 前台服务常驻通知（startForeground 必需）。 */
    fun connectionNotification(context: Context, text: String): Notification =
        NotificationCompat.Builder(context, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_devhub)
            .setContentTitle(context.getString(R.string.notif_connection_title))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

    /**
     * 事件通知：正文 = 服务端脱敏 summary（App 零加工）；
     * contentIntent = devhub://session/{sessionId}（完整上下文点进详情才加载，docs/15 §6）。
     */
    fun postEventNotification(context: Context, notification: EventNotification) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val deepLink = Intent(Intent.ACTION_VIEW, Uri.parse("devhub://session/${notification.sessionId ?: 0}")).apply {
            setPackage(context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pending = PendingIntent.getActivity(
            context,
            (notification.sessionId ?: 0).toInt(),
            deepLink,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_EVENTS)
            .setSmallIcon(R.drawable.ic_stat_devhub)
            .setContentTitle(notification.title)
            .setContentText(notification.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notification.body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()
        manager.notify((notification.sessionId ?: 0).toInt(), n)
    }

    fun cancelEventNotification(context: Context, sessionId: Long) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(sessionId.toInt())
    }

    /** API 33+ 运行时通知权限是否已授予（调用方决定是否仍发——未授予时静默丢弃）。 */
    fun canPostNotifications(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
}
