package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 脱敏渲染：summary 直显 + Token 绝不落日志的护栏断言。 */
class SummaryRenderTest {

    @Test
    fun `summary is rendered as is`() {
        val summary = "密钥 sk-****abcd（len 51）等待输入"
        assertEquals(summary, SummaryRender.render(summary))
    }

    @Test
    fun `null summary renders empty`() {
        assertEquals("", SummaryRender.render(null))
    }

    @Test
    fun `scrub replaces token like runs`() {
        val token = "ajh4hklP9xQ2vBnR7yTzW1mKdF8sGuE6bNcXwAqL5pD" // 43 字符 base64url 形态
        val message = "paired token=$token saved"
        val scrubbed = LogRedactor.scrub(message)
        assertFalse(LogRedactor.leaksTokenLike(scrubbed))
        assertTrue(scrubbed.contains("<redacted:43>"))
    }

    @Test
    fun `short codes and words survive scrub`() {
        val message = "pairing code ABCDEFGH accepted seq 315"
        assertEquals(message, LogRedactor.scrub(message))
    }
}
