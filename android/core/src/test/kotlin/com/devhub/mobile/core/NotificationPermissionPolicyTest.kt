package com.devhub.mobile.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** U1-M5（AUDIT P1#5）：通知权限冷启动自动弹窗决策纯判定直锁。 */
class NotificationPermissionPolicyTest {

    @Test
    fun `first run without denial history auto requests once`() {
        assertTrue(NotificationPermissionPolicy.autoRequestOnColdStart(previouslyDenied = false))
    }

    @Test
    fun `after an explicit denial never auto request again`() {
        assertFalse(NotificationPermissionPolicy.autoRequestOnColdStart(previouslyDenied = true))
    }

    @Test
    fun `policy is a pure function of the denial flag`() {
        // 决策只依赖拒绝记录，不猜测系统当前授权态
        assertTrue(
            NotificationPermissionPolicy.autoRequestOnColdStart(false) ==
                !NotificationPermissionPolicy.autoRequestOnColdStart(true),
        )
    }
}
