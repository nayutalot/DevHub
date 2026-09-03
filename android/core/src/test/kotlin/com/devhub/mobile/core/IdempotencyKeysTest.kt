package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 幂等 key：UUID 生成 + 重试路径必须复用同 key（docs/14 §B.5）。 */
class IdempotencyKeysTest {

    @Test
    fun `new keys are unique uuids`() {
        val a = IdempotencyKeys.newKey()
        val b = IdempotencyKeys.newKey()
        assertNotEquals(a, b)
        assertTrue(a.contains("-"))
        assertEquals(36, a.length) // 标准 UUID v4 形态
    }

    @Test
    fun `retry reuses the exact original key`() {
        val original = IdempotencyKeys.newKey()
        for (attempt in 2..5) {
            assertEquals("attempt $attempt must reuse original key", original, IdempotencyKeys.keyForAttempt(original))
        }
    }

    @Test
    fun `first attempt generates a fresh key`() {
        val generated = IdempotencyKeys.keyForAttempt(null)
        assertTrue(generated.isNotBlank())
        val blank = IdempotencyKeys.keyForAttempt("")
        assertTrue(blank.isNotBlank())
        assertNotEquals(generated, blank)
    }
}
