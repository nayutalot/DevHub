package com.devhub.mobile

import android.app.Application

/** Application：通知通道初始化 + ConnectionManager/WorkspaceLinkController 初始化（进程内单例根）。 */
class DevHubApp : Application() {
    override fun onCreate() {
        super.onCreate()
        com.devhub.mobile.connect.Notifier.ensureChannels(this)
        com.devhub.mobile.connect.ConnectionManager.init(this)
        // S 批：ZCode 工作区智能条目控制器（tab 打开自动请求的承载面）
        com.devhub.mobile.connect.WorkspaceLinkController.init(this)
    }
}
