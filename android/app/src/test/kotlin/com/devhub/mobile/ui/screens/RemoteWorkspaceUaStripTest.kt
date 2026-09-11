package com.devhub.mobile.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * V 批（WebView 白屏诊断纵深）：UA "; wv)" 标记剥离纯函数锁。
 * 背景：Android WebView 默认 UA 带 "; wv)"，部分站点按该标记拒绝渲染；
 * 修复=仅去标记、保留 UA 其余成分（最小侵入），普通 UA 幂等不变。
 */
class RemoteWorkspaceUaStripTest {

    @Test
    fun `strips wv marker from default webview ua`() {
        val webviewUa =
            "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64 Build/AP4A.250105.002; wv) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36"
        val expected =
            "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64 Build/AP4A.250105.002) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36"
        assertEquals(expected, stripWebViewUaMarker(webviewUa))
    }

    @Test
    fun `keeps plain desktop chrome ua unchanged`() {
        val chromeUa =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/152.0.0.0 Safari/537.36"
        assertEquals(chromeUa, stripWebViewUaMarker(chromeUa))
    }

    @Test
    fun `keeps mobile chrome ua without marker unchanged`() {
        val mobileUa =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/124.0.0.0 Mobile Safari/537.36"
        assertEquals(mobileUa, stripWebViewUaMarker(mobileUa))
    }

    @Test
    fun `idempotent on already stripped ua`() {
        val stripped =
            "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64 Build/AP4A.250105.002) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36"
        assertEquals(stripped, stripWebViewUaMarker(stripped))
    }
}
