package com.devhub.mobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** 进程级 UI 状态桥（401 回配对页的结构化提示等）。 */
object AppState {
    /** 401 DEVICE_REVOKED / AUTH_INVALID_TOKEN 后由 ConnectionManager 状态驱动设置。 */
    var unpairedMessage: String? by mutableStateOf<String?>(null)
        private set

    fun reportUnpaired(code: String, message: String) {
        unpairedMessage = "[$code] $message"
    }

    fun consumeUnpairedMessage(): String? {
        val msg = unpairedMessage
        unpairedMessage = null
        return msg
    }
}
