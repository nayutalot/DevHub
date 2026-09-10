package com.devhub.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Q 批「远程工作区」URL 纯函数面单测（任务书 §2.2：校验拒绝面/剪贴板 http 检出/标题缺省 host）。
 * 安全口径：`https?://` 之外一律拒绝（BAD_PAYLOAD 结构化提示）；URL 按敏感对待——
 * 展示走中段省略（令牌段不可见）。
 */
class RemoteWorkspaceUrlTest {

    private fun rejected(raw: String?): Boolean =
        RemoteWorkspaceUrl.parse(raw) is RemoteWorkspaceUrl.Verdict.Rejected

    @Test
    fun `parse rejects non http schemes and malformed urls`() {
        // 拒绝面：非 http(s) scheme
        assertTrue(rejected("ftp://example.com/file"))
        assertTrue(rejected("file:///etc/passwd"))
        assertTrue(rejected("content://media/1"))
        assertTrue(rejected("javascript:alert(1)"))
        assertTrue(rejected("wss://59.110.149.11"))
        // 拒绝面：畸形（无 scheme / 无 host / 空 / 纯空白 / null）
        assertTrue(rejected("example.com/page"))
        assertTrue(rejected("https://"))
        assertTrue(rejected("http://:8080/x"))
        assertTrue(rejected(""))
        assertTrue(rejected("   "))
        assertTrue(rejected(null))
        // 拒绝面：内嵌空白（URL 不容空白；含令牌 URL 带换行同样拒）
        assertTrue(rejected("https://exa mple.com/a"))
        assertTrue(rejected("https://example.com/a\nb"))
    }

    @Test
    fun `parse rejects control chars and oversize urls`() {
        assertTrue(rejected("https://example.com/\u0001"))
        assertTrue(rejected("https://example.com/" + "a".repeat(3000)))
    }

    @Test
    fun `parse accepts http and https and trims surrounding whitespace`() {
        val ok1 = RemoteWorkspaceUrl.parse("  https://example.com/path?q=1#frag  ")
        assertTrue(ok1 is RemoteWorkspaceUrl.Verdict.Ok)
        assertEquals("https://example.com/path?q=1#frag", (ok1 as RemoteWorkspaceUrl.Verdict.Ok).url)
        val ok2 = RemoteWorkspaceUrl.parse("http://10.0.2.2:8746/terminal")
        assertTrue(ok2 is RemoteWorkspaceUrl.Verdict.Ok)
        // scheme 大小写不敏感（WebView 侧原样加载，不改写 query——动态令牌页改写即失效）
        val ok3 = RemoteWorkspaceUrl.parse("HTTPS://Example.COM/x")
        assertTrue(ok3 is RemoteWorkspaceUrl.Verdict.Ok)
    }

    @Test
    fun `clipboard extraction finds http link inside shared text`() {
        // 分享文本夹带链接（前后有文案）
        assertEquals(
            "https://example.com/w/a?token=abc",
            RemoteWorkspaceUrl.extractFromClipboard("打开这个页面 https://example.com/w/a?token=abc 即可遥控"),
        )
        // 尾部标点截除
        assertEquals(
            "https://example.com/page",
            RemoteWorkspaceUrl.extractFromClipboard("访问 https://example.com/page。"),
        )
        assertEquals(
            "https://example.com/page",
            RemoteWorkspaceUrl.extractFromClipboard("访问 (https://example.com/page) 了解"),
        )
        // 无链接 / 空文本 / 非 http(s) 链接 → null（按钮不亮）
        assertNull(RemoteWorkspaceUrl.extractFromClipboard("今天天气不错"))
        assertNull(RemoteWorkspaceUrl.extractFromClipboard(null))
        assertNull(RemoteWorkspaceUrl.extractFromClipboard(""))
        assertNull(RemoteWorkspaceUrl.extractFromClipboard("ftp://example.com/file"))
        assertNull(RemoteWorkspaceUrl.extractFromClipboard("file:///C:/x"))
    }

    @Test
    fun `default title takes host without port with safe fallback`() {
        assertEquals("example.com", RemoteWorkspaceUrl.defaultTitle("https://example.com/path?q=1"))
        assertEquals("127.0.0.1", RemoteWorkspaceUrl.defaultTitle("http://127.0.0.1:8080/terminal"))
        assertEquals("ws.example.test", RemoteWorkspaceUrl.defaultTitle("https://ws.example.test"))
        // 解析不出 host → 结构化回退，绝不抛出
        assertEquals("未命名页面", RemoteWorkspaceUrl.defaultTitle("not-a-url"))
    }

    @Test
    fun `elide middle hides token bearing segment of long urls`() {
        val tokenUrl = "https://example.com/session/abcdefghijklmnopqrstuvwxyz1234567890?token=SECRETVALUE"
        val shown = RemoteWorkspaceUrl.elideMiddle(tokenUrl)
        assertTrue(shown.contains("…"))
        assertTrue(shown.length < tokenUrl.length)
        assertNotEquals(tokenUrl, shown)
        // 令牌整段（中段）不可见
        assertTrue(!shown.contains("SECRETVALUE"))
        // 短 URL 原样
        assertEquals("https://example.com", RemoteWorkspaceUrl.elideMiddle("https://example.com"))
    }
}
