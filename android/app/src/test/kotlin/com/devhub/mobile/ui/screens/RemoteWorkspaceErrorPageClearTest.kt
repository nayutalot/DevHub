package com.devhub.mobile.ui.screens

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * W 批（错误页凭据加固）：清错误页空载荷识别纯函数锁。
 * 背景：主帧 onReceivedError 时默认 Chromium 错误页把完整 URL（可含会话凭据）渲染在
 * 屏上——App 用 loadData 空文本（data: URL）清屏；该载荷会走 onPageStarted，须被
 * isErrorPageClearPayload 识别并跳过状态重置（否则抹掉结构化错误横幅/标题栏 URL 被冲掉）。
 * 真实清屏时序（回调是否触发/先后）属 WebView UI 面，本锁只钉识别约定本身。
 */
class RemoteWorkspaceErrorPageClearTest {

    @Test
    fun `recognizes exact empty text payload produced by loadData`() {
        // WebView.loadData("", "text/plain", "utf-8") 的落地 URL 形态
        assertTrue(isErrorPageClearPayload("data:text/plain;charset=utf-8,"))
    }

    @Test
    fun `recognizes any data url payload`() {
        assertTrue(isErrorPageClearPayload("data:text/html,<x/>"))
    }

    @Test
    fun `normal http navigation is not clear payload`() {
        assertFalse(isErrorPageClearPayload("https://example.com/workspace?sid=x&hash=y"))
        assertFalse(isErrorPageClearPayload("http://example.com/"))
    }

    @Test
    fun `about blank is not clear payload`() {
        // about:blank 属真实导航，状态重置语义照旧
        assertFalse(isErrorPageClearPayload("about:blank"))
    }
}
