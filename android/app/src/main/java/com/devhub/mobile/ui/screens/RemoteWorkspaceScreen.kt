package com.devhub.mobile.ui.screens

import android.content.ClipboardManager
import android.content.Context
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.devhub.mobile.connect.WorkspaceLinkCard
import com.devhub.mobile.connect.WorkspaceLinkController
import com.devhub.mobile.data.RemoteWorkspaceUrl
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.RemoteWorkspaceEntryEntity
import com.devhub.mobile.ui.components.TimeFmt
import com.devhub.mobile.ui.components.WorkspaceLinkCardView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 「远程工作区」屏（Q 批）：可配置 URL 条目 + 全屏 WebView（ZCode 移动端遥控页 /
 * 任何网页终端、控制面板等 https 页面内嵌）。
 * - 列表：条目（标题+URL+时间戳，最近使用排序）+ 剪贴板一键填充（检出 http(s) 才亮）；
 *   加载/空/内容三态强制（约束 #24）；
 * - 全屏 WebView：javaScript+domStorage 开（终端类页面必需）；shouldOverrideUrlLoading
 *   白名单 http/https（file/content 等一律拒载）；证书错误**绝不 proceed**（cancel——
 *   与 App pin-TL 红线同向）；返回键先 WebView.canGoBack() 再屏退；
 * - URL 可能含动态会话令牌：按敏感对待——零入日志、零外发；展示一律中段省略。
 *
 * S 批追加：顶部固定「ZCode 工作区」智能条目（docs/18 §5.3 注记）——进入本屏时
 * **自动请求**桌面重建的当前有效链接（WorkspaceLinkController → relay
 * workspace_link 查询），结果自动建/更新置顶条目，点击即开 WebView；离线桌面 =
 * 排队提示照 relay 语义；手动粘贴路径原样保留（零粘贴路径不动，任务书 §1 #4）。
 *
 * T1 批改判：独立「远程工作区」tab 撤销——本屏保留为**可路由条目管理屏**
 * （路由 remote-manage），从会话页「ZCode 工作区」智能卡的管理入口（小图标）可达；
 * 手工 URL 条目功能原样保留。遥控主入口并入会话/Agent 流（sessions 智能卡 /
 * zcode 会话详情按钮 / zcode Agent 卡按钮）。
 */
@Composable
fun RemoteWorkspaceScreen(onOpenEntry: (Long) -> Unit, onBack: () -> Unit = {}) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()
    // Flow initial=null = 加载态；空列表 → 空态引导；非空 → 内容（约束 #24 三态）
    val entriesFlow by db.remoteWorkspaceEntryDao().observeAll().collectAsState(initial = null)
    // S 批智能条目状态（tab 打开自动请求；状态机在 WorkspaceLinkCard，:app 单测锁）
    // U5 批的 displayState 投影随 X-L 反转（docs/18 §5.3.2）退役：控制器状态直通卡片
    //（local 模式全流转，失败走 Unavailable 结构化面；relay/fixture 原状零改写）。
    val linkState by WorkspaceLinkController.state.collectAsState()

    var title by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var clipboardUrl by remember { mutableStateOf<String?>(null) }
    var formError by remember { mutableStateOf<String?>(null) }
    // U1-M6/P2#3（AUDIT）：垃圾桶一点即删无确认——先二次确认再删
    var confirmDeleteEntry by remember { mutableStateOf<RemoteWorkspaceEntryEntity?>(null) }

    // S 批：进入本屏即自动请求（拉取模型——App 需要时取，永远新鲜且有效）；
    // LaunchedEffect(Unit) = 每次进入本屏恰一次，重试由卡片按钮/下次进入承载。
    // T1 批：tab 撤销，节奏原样迁移（会话页智能卡同款 LaunchedEffect(Unit)）。
    LaunchedEffect(Unit) {
        WorkspaceLinkController.request()
    }

    // 剪贴板轮询检出（1.5s；Android 10+ 仅前台可读，本屏在前台时检出，离开即失明属平台预期）
    LaunchedEffect(Unit) {
        while (true) {
            clipboardUrl = readClipboardHttpUrl(context)
            delay(1500)
        }
    }

    // 智能条目行（固定保留标题）从手动列表中分离——唯一展示面 = 顶部智能卡片
    val allEntries = entriesFlow
    val smartEntry = allEntries?.firstOrNull { it.title == WorkspaceLinkCard.ENTRY_TITLE }
    val manualEntries = allEntries?.filter { it.title != WorkspaceLinkCard.ENTRY_TITLE }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // T1 批：独立 tab 撤销后本屏为路由推送目的地——显式返回面（系统返回键同效）
            TextButton(onClick = onBack) { Text("< 返回") }
            Text("远程工作区", style = MaterialTheme.typography.titleLarge)
        }
        Text(
            // UX-P1 R2：安全提示事实全保留（仅存本机/绝不外发/展示打码）
            "把电脑上复制的控制页链接（https://）存成条目，在这里全屏打开。" +
                "链接可能带私人凭据：只存在手机里、绝不外发，显示时打码。",
            fontSize = 13.sp,
        )

        // —— S 批：ZCode 工作区智能条目（顶部固定；点击即开）——
        WorkspaceLinkCardView(
            state = linkState,
            staleEntryId = smartEntry?.id,
            onOpen = { id -> onOpenEntry(id) },
            onRetry = { WorkspaceLinkController.request() },
        )
        HorizontalDivider()

        when (val state = manualEntries?.let { RemoteWorkspaceUi.from(it) }) {
            null -> {
                // —— 加载态 ——
                CircularProgressIndicator()
            }

            RemoteWorkspaceUi.State.Empty -> {
                // —— 空态引导 ——
                Surface(
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        "还没有条目。\n\n在电脑上复制远程控制页链接后，点下方「从剪贴板填入」；" +
                            "或直接在输入框粘贴 https:// 链接添加。添加后点条目即可全屏打开。",
                        fontSize = 13.sp,
                        textAlign = TextAlign.Start,
                        modifier = Modifier.padding(14.dp),
                    )
                }
            }

            is RemoteWorkspaceUi.State.Content -> {
                // —— 内容态：最近使用排序条目 ——
                state.entries.forEach { entry ->
                    EntryRow(
                        entry = entry,
                        onOpen = {
                            scope.launch {
                                withContext(Dispatchers.IO) {
                                    db.remoteWorkspaceEntryDao().touchOpened(entry.id, System.currentTimeMillis())
                                }
                            }
                            onOpenEntry(entry.id)
                        },
                        onDelete = {
                            // U1-M6/P2#3：不再即时删——转确认对话框
                            confirmDeleteEntry = entry
                        },
                    )
                    HorizontalDivider()
                }
            }
        }

        // —— 添加条目表单 ——
        Text("添加页面", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold) // UX-P1 R4
        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            label = { Text("标题（可不填）") }, // UX-P1 R5
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = url,
            onValueChange = { url = it; formError = null },
            label = { Text("链接（http/https）") }, // UX-P1 R6
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            isError = url.isNotBlank() && RemoteWorkspaceUrl.parse(url) is RemoteWorkspaceUrl.Verdict.Rejected,
            supportingText = {
                // U2-M3（AUDIT P3#5）：helper 不再直出错误码（码归结构化错误面承载）
                Text("只能添加 http/https 开头的链接", fontSize = 11.sp) // UX-P1 R7
            },
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            // 剪贴板一键填：检出 http(s) 链接才亮（任务书 §1.2）
            TextButton(
                onClick = {
                    clipboardUrl?.let { found ->
                        url = found
                        if (title.isBlank()) title = RemoteWorkspaceUrl.defaultTitle(found)
                        formError = null
                    }
                },
                enabled = clipboardUrl != null,
            ) {
                Text(if (clipboardUrl != null) "从剪贴板粘贴" else "剪贴板里没有链接") // UX-P1 R8
            }
            Button(
                onClick = {
                    when (val verdict = RemoteWorkspaceUrl.parse(url)) {
                        is RemoteWorkspaceUrl.Verdict.Ok -> {
                            scope.launch {
                                withContext(Dispatchers.IO) {
                                    db.remoteWorkspaceEntryDao().insert(
                                        RemoteWorkspaceEntryEntity(
                                            title = title.trim().ifBlank { RemoteWorkspaceUrl.defaultTitle(verdict.url) },
                                            url = verdict.url,
                                            createdAtMs = System.currentTimeMillis(),
                                        ),
                                    )
                                }
                            }
                            title = ""
                            url = ""
                            formError = null
                        }

                        is RemoteWorkspaceUrl.Verdict.Rejected -> formError = verdict.reason
                    }
                },
                // 纯函数校验面前置：非法输入按钮不亮（结构化拒绝面兜底在 onClick）
                enabled = RemoteWorkspaceUrl.parse(url) is RemoteWorkspaceUrl.Verdict.Ok,
            ) { Text("添加") }
        }
        formError?.let {
            Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
        }
        Spacer(Modifier.height(8.dp))
    }

    // U1-M6/P2#3（AUDIT P2-3，15-delete-confirm.png）：条目删除二次确认
    confirmDeleteEntry?.let { target ->
        AlertDialog(
            onDismissRequest = { confirmDeleteEntry = null },
            title = { Text("删除条目", fontWeight = FontWeight.SemiBold) },
            text = { Text("「${target.title}」将从本机列表移除（仅删本机条目，不影响桌面）。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDeleteEntry = null
                        scope.launch { withContext(Dispatchers.IO) { db.remoteWorkspaceEntryDao().delete(target.id) } }
                    },
                ) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDeleteEntry = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun EntryRow(entry: RemoteWorkspaceEntryEntity, onOpen: () -> Unit, onDelete: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(entry.title, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            // 敏感 URL：展示一律中段省略（令牌通常在 query 中段）
            Text(
                RemoteWorkspaceUrl.elideMiddle(entry.url),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                entry.lastOpenedAtMs?.let { "最近打开 ${TimeFmt.mdHm(it / 1000)}" } ?: "从未打开",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = onDelete) {
            Icon(Icons.Filled.Delete, contentDescription = "删除条目")
        }
    }
}

/** 剪贴板 http(s) 检出（无障碍降级 coerceToText；无/未检出返回 null）。 */
internal fun readClipboardHttpUrl(context: Context): String? = try {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return null
    val text = cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()
    RemoteWorkspaceUrl.extractFromClipboard(text)
} catch (_: Exception) {
    null
}

/**
 * V 批：去除 Android WebView 默认 UA 中的 "; wv)" 标记（保留其余成分——最小侵入）。
 * 部分网页按该标记识别 WebView 并拒绝渲染（白屏常见嫌疑位）；纯函数便于单测。
 * 已含标记 → 恰去一处；不含（普通 Chrome UA / 已处理过）→ 原样返回（幂等）。
 */
internal fun stripWebViewUaMarker(ua: String): String =
    if (ua.contains("; wv)")) ua.replaceFirst("; wv)", ")") else ua

/**
 * W 批（错误页凭据加固）：主帧加载失败后用于清除默认 Chromium 错误页的空载荷识别
 * （loadData 空文本 → data: URL）。默认错误页会把完整 URL（可含 ZCode 会话凭据
 * sid/hash）渲染在屏上——旁观/录屏可见；清屏载荷自身会走 WebView 回调，onPageStarted
 * 须跳过之（否则反向抹掉结构化错误横幅/把标题栏 URL 冲成 data: 文本）。纯函数便于单测。
 */
internal fun isErrorPageClearPayload(url: String): Boolean = url.startsWith("data:")

// ---------------------------------------------------------------------------
// 全屏 WebView 屏（独立导航目的地，主导航底栏之外 = 真全屏）
// ---------------------------------------------------------------------------

/**
 * 全屏 WebView：标题栏（返回/标题+当前 URL 中段省略/刷新/复制 URL）+ WebView 主体。
 * 三态：加载态（顶部线性进度）/ 错误态（结构化提示+重试）/ 正常渲染；
 * 空态=条目不存在（深链/已删兜底）。
 * W 批：主帧加载失败立即以空文本清掉默认 Chromium 错误页（其把完整 URL——可含
 * 会话凭据——渲染在屏上）；用户面信息全由 App 结构化错误横幅+重试承担。
 * 返回键纪律：先 WebView.canGoBack() 后退网页历史，无历史再屏退（任务书 §1.3）。
 */
@Composable
fun RemoteWorkspaceWebViewScreen(entryId: Long, onBack: () -> Unit) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    var entry by remember { mutableStateOf<RemoteWorkspaceEntryEntity?>(null) }
    var missing by remember { mutableStateOf(false) }

    LaunchedEffect(entryId) {
        val loaded = withContext(Dispatchers.IO) { db.remoteWorkspaceEntryDao().get(entryId) }
        if (loaded == null) {
            missing = true
        } else {
            entry = loaded
            withContext(Dispatchers.IO) {
                db.remoteWorkspaceEntryDao().touchOpened(loaded.id, System.currentTimeMillis())
            }
        }
    }

    when {
        missing -> {
            // 空态兜底：条目不存在（结构化提示，不白屏）
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("页面不存在或已删除", fontSize = 14.sp) // UX-P1 R10
                TextButton(onClick = onBack) { Text("返回") }
            }
        }

        else -> entry?.let { loaded ->
            WebViewPane(entry = loaded, onExit = onBack)
        }
    }
}

@Composable
private fun WebViewPane(entry: RemoteWorkspaceEntryEntity, onExit: () -> Unit) {
    var webView by remember { mutableStateOf<WebView?>(null) }
    var loading by remember { mutableStateOf(true) }
    var errorMsg by remember { mutableStateOf<String?>(null) }
    // UX-P1 R12：code/description 原值收「技术细节」折叠（headline 人话）
    var errorTech by remember { mutableStateOf<String?>(null) }
    var currentUrl by remember { mutableStateOf(entry.url) }
    var copied by remember { mutableStateOf(false) }
    val context = LocalContext.current

    // 返回键：WebView 先退（canGoBack），无历史再屏退
    BackHandler {
        val wv = webView
        if (wv != null && wv.canGoBack()) wv.goBack() else onExit()
    }

    Column(Modifier.fillMaxSize()) {
        // —— 标题栏 ——
        Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 4.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onExit) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回列表")
                }
                Column(Modifier.weight(1f)) {
                    Text(entry.title, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        RemoteWorkspaceUrl.elideMiddle(currentUrl),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                IconButton(onClick = { webView?.reload() }) {
                    Icon(Icons.Filled.Refresh, contentDescription = "刷新")
                }
                TextButton(onClick = {
                    val cm = context.getSystemService(ClipboardManager::class.java)
                    cm?.setPrimaryClip(android.content.ClipData.newPlainText("url", currentUrl))
                    copied = true
                }) {
                    Text(if (copied) "已复制" else "复制链接", fontSize = 12.sp) // UX-P1 R11
                }
            }
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())

        Box(Modifier.weight(1f)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = android.view.ViewGroup.LayoutParams(
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        settings.javaScriptEnabled = true // 终端/控制面板类页面必需（任务书 §1.3）
                        settings.domStorageEnabled = true
                        settings.allowFileAccess = false // file scheme 红线：存储层同样拒载
                        settings.allowContentAccess = false
                        // V 批（白屏诊断纵深）：默认 UA 去除 "; wv)" WebView 标记——部分站点按
                        // 该标记拒绝渲染；保留 UA 其余成分（最小侵入）。桌面 A/B 已证当前白屏
                        // 主因在服务端基建（zcode 子域私网 A 记录 + ALB 503），此项为恢复期
                        // 拒渲染嫌疑位一的纵深防御。
                        settings.userAgentString = stripWebViewUaMarker(WebSettings.getDefaultUserAgent(ctx))
                        // V 批：仅 debug 构建开 WebView 远程调试（chrome://inspect 抓 console）；
                        // 运行时 FLAG_DEBUGGABLE 核验，生产构建零变化。
                        if ((ctx.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                            WebView.setWebContentsDebuggingEnabled(true)
                        }
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                // 白名单 http/https；file/content/javascript 等一律拒载（仅拒载，
                                // 对齐 openLink 简化语义）；URL 零入日志（可能含令牌）
                                val scheme = request.url.scheme?.lowercase()
                                return scheme != "http" && scheme != "https"
                            }

                            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                                // W 批：清错误页的空 data: 载荷不重置状态——该载荷走回调时若照常
                                // 重置，会把结构化错误横幅抹掉、把标题栏 URL 冲成 data: 文本
                                if (isErrorPageClearPayload(url)) return
                                currentUrl = url
                                loading = true
                                errorMsg = null
                            }

                            override fun onPageFinished(view: WebView, url: String) {
                                loading = false
                            }

                            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                                // 主框架错误 → 错误态（子资源失败不打断整体——容错降级纪律）
                                if (request.isForMainFrame) {
                                    loading = false
                                    errorMsg = "页面加载失败：请检查链接和网络后重试" // UX-P1 R12
                                    errorTech = "description=${error.description} · code=${error.errorCode}"
                                    // W 批：立即清掉默认 Chromium 错误页——其把完整 URL（可含
                                    // sid/hash 会话凭据）渲染在屏上，旁观/录屏可见；错误页只需
                                    // "不清单"，用户面信息由上方结构化错误横幅+重试承担
                                    view.loadData("", "text/plain", "utf-8")
                                }
                            }

                            override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
                                // 证书错误绝不 proceed（cancel 默认拒绝——与 pin-TL 红线同向，绝不自签放行）
                                handler.cancel()
                                loading = false
                                errorMsg = "证书异常，已停止加载（这是安全保护）" // UX-P1 R13
                            }
                        }
                        loadUrl(entry.url)
                    }.also { webView = it }
                },
            )
            // —— 错误态覆盖（加载态=顶部线性进度；正常态=WebView 渲染）——
            errorMsg?.let { msg ->
                Surface(
                    color = Color(0xFFFFEBEE),
                    modifier = Modifier
                        .fillMaxWidth()
                        .align(Alignment.BottomCenter),
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(msg, fontSize = 12.sp, color = Color(0xFFB71C1C))
                        errorTech?.let {
                            com.devhub.mobile.ui.components.TechnicalDetailsFold(it)
                        }
                        TextButton(onClick = {
                            errorMsg = null
                            loading = true
                            // W 批：错误清屏后 WebView 当前项已是空 data: 载荷，reload() 会
                            // 重载空白——重试显式重载条目 URL（失败路径再入同一错误态闭环）
                            webView?.loadUrl(entry.url)
                        }) { Text("重试") }
                    }
                }
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            webView?.destroy()
            webView = null
        }
    }
}
