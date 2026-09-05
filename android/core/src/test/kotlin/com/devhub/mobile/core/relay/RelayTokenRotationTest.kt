package com.devhub.mobile.core.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** token_rotation 轮换原子性（docs/18 §3.14：写入失败保留旧值并按旧值继续重连）。 */
class RelayTokenRotationTest {

    @Test
    fun `accepts strictly newer token version and writes atomically`() {
        val store = InMemoryTokenStore(StoredToken(token = "old-token", tokenVersion = 1, deviceId = 12))
        val outcome = RelayTokenRotation.apply(store, newToken = "new-token", newVersion = 2, newDeviceId = 12)
        assertTrue(outcome is RotationOutcome.Accepted)
        assertEquals(StoredToken("new-token", 2, 12), store.current)
        assertEquals(1, store.writeCount)
    }

    @Test
    fun `stale rotation frames are ignored with zero writes`() {
        val store = InMemoryTokenStore(StoredToken(token = "old-token", tokenVersion = 2, deviceId = 12))
        assertEquals(RotationOutcome.Stale, RelayTokenRotation.apply(store, "again-token", 2))
        assertEquals(RotationOutcome.Stale, RelayTokenRotation.apply(store, "older-token", 1))
        assertEquals(0, store.writeCount)
        assertEquals(StoredToken("old-token", 2, 12), store.current)
    }

    @Test
    fun `no current token means unpaired and rotation is ignored`() {
        val store = InMemoryTokenStore(initial = null)
        assertEquals(RotationOutcome.NoCurrentToken, RelayTokenRotation.apply(store, "new-token", 2))
        assertEquals(0, store.writeCount)
    }

    @Test
    fun `write failure preserves old token for reconnect-with-old-value path`() {
        val store = InMemoryTokenStore(StoredToken(token = "old-token", tokenVersion = 1, deviceId = 12))
        store.failNextWrite = true
        val outcome = RelayTokenRotation.apply(store, newToken = "new-token", newVersion = 2)
        assertTrue(outcome is RotationOutcome.FailedPreservedOld)
        assertEquals(StoredToken("old-token", 1, 12), store.current) // 旧值原样保留
        assertEquals("old-token", (outcome as RotationOutcome.FailedPreservedOld).preserved?.token)
    }

    @Test
    fun `rotation without explicit deviceId keeps current deviceId`() {
        val store = InMemoryTokenStore(StoredToken(token = "old", tokenVersion = 1, deviceId = 12))
        val outcome = RelayTokenRotation.apply(store, "new", 2, newDeviceId = null) as RotationOutcome.Accepted
        assertEquals(12L, outcome.written.deviceId)
    }

    @Test
    fun `store write contract is all-or-nothing`() {
        val store = InMemoryTokenStore(StoredToken("old", 1, 12))
        store.failNextWrite = true
        assertFalse(store.write("partial", 2, 12))
        assertEquals("old", store.read()?.token) // 部分写绝不可见
        assertTrue(store.write("good", 2, 12))
        assertEquals("good", store.read()?.token)
    }
}
