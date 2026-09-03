package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 控制按钮 UI 门：observed 全禁；仅 granted 内动作可见（T19 授权矩阵 UI 侧）。 */
class ControlGateTest {

    @Test
    fun `null capability set hides everything`() {
        val v = ControlGate.visibleControls(null, sessionMode = "managed")
        assertEquals(ControlGate.VisibleControls(false, false, false), v)
    }

    @Test
    fun `observed capability mode hides everything`() {
        val caps = ControlGate.CapabilitySnapshot(mode = "observed", granted = setOf("reply", "pause", "resume"))
        val v = ControlGate.visibleControls(caps, sessionMode = "observed")
        assertFalse(v.reply)
        assertFalse(v.pause)
        assertFalse(v.resume)
    }

    @Test
    fun `session mode observed hides everything even if caps disagree`() {
        val caps = ControlGate.CapabilitySnapshot(mode = "attached", granted = setOf("reply"))
        val v = ControlGate.visibleControls(caps, sessionMode = "observed")
        assertFalse(v.reply)
    }

    @Test
    fun `attached with reply only shows reply and never pause`() {
        // T19：attached 无 pause（服务端 granted 同构）
        val caps = ControlGate.CapabilitySnapshot(mode = "attached", granted = listOf("reply").toSet())
        val v = ControlGate.visibleControls(caps, sessionMode = "attached")
        assertTrue(v.reply)
        assertFalse(v.pause)
        assertFalse(v.resume)
    }

    @Test
    fun `managed with full grants shows all controls`() {
        val caps = ControlGate.CapabilitySnapshot(mode = "managed", granted = setOf("reply", "pause", "resume"))
        val v = ControlGate.visibleControls(caps, sessionMode = "managed")
        assertTrue(v.reply)
        assertTrue(v.pause)
        assertTrue(v.resume)
    }

    @Test
    fun `granted set is authoritative per action`() {
        val caps = ControlGate.CapabilitySnapshot(mode = "managed", granted = setOf("reply", "resume"))
        val v = ControlGate.visibleControls(caps, sessionMode = "managed")
        assertTrue(v.reply)
        assertFalse(v.pause)
        assertTrue(v.resume)
    }

    @Test
    fun `empty granted set hides all even when mode allows`() {
        val caps = ControlGate.CapabilitySnapshot(mode = "managed", granted = emptySet())
        val v = ControlGate.visibleControls(caps, sessionMode = "managed")
        assertEquals(ControlGate.VisibleControls(false, false, false), v)
    }
}
