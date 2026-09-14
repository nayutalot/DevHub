package com.devhub.mobile.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.devhub.mobile.core.ErrorPresent

/** 进程级 UI 状态桥（401 回配对页的结构化提示等）。 */
object AppState {
    /**
     * 401 DEVICE_REVOKED / AUTH_INVALID_TOKEN 后由 ConnectionManager 状态驱动设置。
     * UX-P1（docs/25 X9）：「[code] message」原样直出退役——经 ErrorPresent.api 人话化
     * （AUTH 族 → 「登录已失效：请重新配对」）；原码/message 由 Presentable.technical
     * 结构化承载（配对页「技术细节」折叠可达，诚实折叠零吞码）。
     */
    var unpairedMessage: ErrorPresent.Presentable? by mutableStateOf<ErrorPresent.Presentable?>(null)
        private set

    fun reportUnpaired(code: String, message: String) {
        unpairedMessage = ErrorPresent.api(code, message)
    }

    fun consumeUnpairedMessage(): ErrorPresent.Presentable? {
        val msg = unpairedMessage
        unpairedMessage = null
        return msg
    }
}
