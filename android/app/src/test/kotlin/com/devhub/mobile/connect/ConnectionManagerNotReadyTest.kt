package com.devhub.mobile.connect

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P0 热修回归锁（2026-09-13 用户真机「连接失败即闪退」）：
 * **失败路径依赖未就绪（init 未调用）时绝不抛（原 `db!!`/`api!!` KNPE 面），走诚实错误态。**
 *
 * 纪律：本用例在全新 JVM 直测 `ConnectionManager` object——db/api/cachedConfig 均为 null
 * （无 Android 依赖、无 Log 调用的守卫路径），锁定「不抛 + 结构化拒绝」双契约：
 * - flushPendingCommands → 诚实跳过本轮（静默返回，不 KNPE）；
 * - submitReply / submitAction → SubmitResult.Rejected（GATEWAY_NOT_READY 人话，绝不伪装成功）。
 */
class ConnectionManagerNotReadyTest {

    @Test
    fun `flushPendingCommands with deps not ready does not throw`() {
        // 原 flushPendingCommandsLocal 首行 `db!!.pendingCommandDao()` → KNPE 直达
        // scope（无 CoroutineExceptionHandler）→ 进程闪退；热修后诚实跳过本轮。
        runBlocking { ConnectionManager.flushPendingCommands() }
    }

    @Test
    fun `submitReply with deps not ready returns structured Rejected not crash`() = runBlocking {
        val result = ConnectionManager.submitReply(sessionId = 1L, text = "hello")
        assertTrue("expect Rejected, got $result", result is SubmitResult.Rejected)
        assertEquals("GATEWAY_NOT_READY", (result as SubmitResult.Rejected).code)
    }

    @Test
    fun `submitAction with deps not ready returns structured Rejected not crash`() = runBlocking {
        val paused = ConnectionManager.submitAction(sessionId = 1L, action = "pause")
        assertTrue("expect Rejected, got $paused", paused is SubmitResult.Rejected)
        assertEquals("GATEWAY_NOT_READY", (paused as SubmitResult.Rejected).code)
        val resumed = ConnectionManager.submitAction(sessionId = 1L, action = "resume")
        assertTrue("expect Rejected, got $resumed", resumed is SubmitResult.Rejected)
    }
}
