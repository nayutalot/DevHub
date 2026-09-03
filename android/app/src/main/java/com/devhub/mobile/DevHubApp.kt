package com.devhub.mobile

import android.app.Application

/** Application：通知通道初始化 + ConnectionManager 初始化（进程内单例根）。 */
class DevHubApp : Application() {
    override fun onCreate() {
        super.onCreate()
        com.devhub.mobile.connect.Notifier.ensureChannels(this)
        com.devhub.mobile.connect.ConnectionManager.init(this)
    }
}
