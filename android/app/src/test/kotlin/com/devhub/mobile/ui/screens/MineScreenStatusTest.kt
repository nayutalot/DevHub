package com.devhub.mobile.ui.screens

import com.devhub.mobile.ui.components.wakeCardNeeded
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * UX-P2（docs/24 §3「我的」+ docs/26 §3.3）：电脑连接状态卡在线三态纯判定锁 +
 * 唤醒卡条件置顶纯判定锁（docs/26 §3.2：电脑未确认在线时出现，减少常态噪音）。
 * 真值映射与诊断页「电脑端」行同源（P1 语义原样）；未知绝不画成在线（红线 #1）。
 */
class MineScreenStatusTest {

    // —— computerOnlineState：电脑卡在线三态 ——

    @Test
    fun `relay with upstream disconnected is offline`() {
        assertEquals(
            ComputerOnlineState.OFFLINE,
            computerOnlineState("relay", connected = true, upstreamBeacon = "disconnected"),
        )
    }

    @Test
    fun `relay connected with upstream up is online`() {
        assertEquals(
            ComputerOnlineState.ONLINE,
            computerOnlineState("relay", connected = true, upstreamBeacon = "connected"),
        )
    }

    @Test
    fun `relay without ws connection never claims online`() {
        // 手机还没连上云端：电脑状态未知 → 未连接（不伪造状态红线）
        assertEquals(
            ComputerOnlineState.UNCONNECTED,
            computerOnlineState("relay", connected = false, upstreamBeacon = null),
        )
    }

    @Test
    fun `local connected is online`() {
        assertEquals(
            ComputerOnlineState.ONLINE,
            computerOnlineState("local", connected = true, upstreamBeacon = null),
        )
    }

    @Test
    fun `local disconnected and unconfigured are unconnected`() {
        assertEquals(
            ComputerOnlineState.UNCONNECTED,
            computerOnlineState("local", connected = false, upstreamBeacon = null),
        )
        assertEquals(
            ComputerOnlineState.UNCONNECTED,
            computerOnlineState(null, connected = false, upstreamBeacon = null),
        )
    }

    // —— wakeCardNeeded：唤醒卡条件置顶（助手页/我的页同用） ——

    @Test
    fun `wake card hidden when relay fully online`() {
        // docs/26 §3.2：电脑在线时唤醒卡不出现（减少常态噪音）
        assertFalse(wakeCardNeeded("relay", connected = true, upstreamBeacon = "connected"))
    }

    @Test
    fun `wake card shows when relay upstream offline`() {
        assertTrue(wakeCardNeeded("relay", connected = true, upstreamBeacon = "disconnected"))
    }

    @Test
    fun `wake card shows when ws not connected`() {
        // 未确认在线（含 beacon 未回传）保留卡片：六态人话与 A7 禁用态可达，不收窄
        assertTrue(wakeCardNeeded("relay", connected = false, upstreamBeacon = null))
    }

    @Test
    fun `wake card never shows outside relay mode`() {
        // wake 是 relay 原生能力（RW1 设计裁决 3）；本地模式不渲染
        assertFalse(wakeCardNeeded("local", connected = false, upstreamBeacon = null))
        assertFalse(wakeCardNeeded(null, connected = true, upstreamBeacon = "disconnected"))
    }
}
