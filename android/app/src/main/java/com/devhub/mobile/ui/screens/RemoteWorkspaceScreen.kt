package com.devhub.mobile.ui.screens

import android.content.ClipboardManager
import android.content.Context
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
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
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.Refresh
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
 * S 批追加：顶部固定「ZCode 工作区」智能条目（docs/18 §5.3 注记）——tab 打开时
 * **自动请求**桌面重建的当前有效链接（WorkspaceLinkController → relay
 * workspace_link 查询），结果自动建/更新置顶条目，点击即开 WebView；离线桌面 =
 * 排队提示照 relay 语义；手动粘贴路径原样保留（零粘贴路径不动，任务书 §1 #4）。
 */
@Composable
fun RemoteWorkspaceScreen(onOpenEntry: (Long) -> Unit) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()
    // Flow initial=null = 加载态；空列表 → 空态引导；非空 → 内容（约束 #24 三态）
    val entriesFlow by db.remoteWorkspaceEntryDao().observeAll().collectAsState(initial = null)
    // S 批智能条目状态（tab 打开自动请求；状态机在 WorkspaceLinkCard，:app 单测锁）
    val linkState by WorkspaceLinkController.state.collectAsState()

    var title by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var clipboardUrl by remember { mutableStateOf<String?>(null) }
    var formError by remember { mutableStateOf<String?>(null) }

    // S 批：tab 打开即自动请求（拉取模型——App 需要时取，永远新鲜且有效）；
    // LaunchedEffect(Unit) = 每次进入本屏恰一次，重试由卡片按钮/下次进入承载。
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
        Text("远程工作区", style = MaterialTheme.typography.titleLarge)
        Text(
            "把电脑上复制的远程控制页链接（ZCode 移动端遥控、网页终端、控制面板等，https://）存成条目，" +
                "在手机上全屏打开。链接可能含动态会话令牌：仅存本机、绝不外发，展示时中段省略。",
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
                            scope.launch { withContext(Dispatchers.IO) { db.remoteWorkspaceEntryDao().delete(entry.id) } }
                        },
                    )
                    HorizontalDivider()
                }
            }
        }

        // —— 添加条目表单 ——
        Text("添加条目", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            label = { Text("标题（留空取链接主机名）") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        OutlinedTextField(
            value = url,
            onValueChange = { url = it; formError = null },
            label = { Text("链接（https://…，仅接受 http(s)）") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            isError = url.isNotBlank() && RemoteWorkspaceUrl.parse(url) is RemoteWorkspaceUrl.Verdict.Rejected,
            supportingText = {
                Text("仅接受 http(s)://，其余一律拒绝（BAD_PAYLOAD）", fontSize = 11.sp)
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
                Text(if (clipboardUrl != null) "从剪贴板填入（已检出链接）" else "从剪贴板填入（未检出 http(s) 链接）")
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

// ---------------------------------------------------------------------------
// S 批：ZCode 工作区智能条目卡片（顶部固定；状态机 = WorkspaceLinkCard，:app 单测锁）
// ---------------------------------------------------------------------------

/**
 * 智能条目卡片：状态分五个面（Idle/Requesting/Ready/Queued/Unavailable）。
 * - Ready → 整卡可点，直达全屏 WebView（onOpen(entryId)）；
 * - 非 Ready 但存在既往会话留下的智能条目行（staleEntryId）→ 同样可点打开
 *   （链接成分静态、t 为 nonce——旧条目仍有效；自动请求照常刷新）；
 * - Queued = 离线桌面排队提示（relay 语义，绝不伪造成功）；
 * - Unavailable = 结构化不可用（ZCODE_LINK_UNAVAILABLE 等）+ 重试按钮。
 * 卡片零 URL 展示（点击才进 WebView；WebView 标题栏本就中段省略）。
 */
@Composable
private fun WorkspaceLinkCardView(
    state: WorkspaceLinkCard.State,
    staleEntryId: Long?,
    onOpen: (Long) -> Unit,
    onRetry: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = state is WorkspaceLinkCard.State.Ready || staleEntryId != null) {
                    when (state) {
                        is WorkspaceLinkCard.State.Ready -> onOpen(state.entryId)
                        else -> staleEntryId?.let(onOpen)
                    }
                }
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("ZCode 工作区", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                when (val s = state) {
                    WorkspaceLinkCard.State.Idle ->
                        Text("进入本页时自动获取桌面链接…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

                    WorkspaceLinkCard.State.Requesting ->
                        Text("正在从桌面获取当前链接…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

                    is WorkspaceLinkCard.State.Ready ->
                        Text(
                            "已获取（${s.deviceName ?: "桌面"}）· 点击全屏打开",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )

                    WorkspaceLinkCard.State.Queued ->
                        Text("电脑离线：请求已排队，桌面恢复连接后自动送达", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

                    is WorkspaceLinkCard.State.Unavailable -> {
                        Text(s.message, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = onRetry) { Text("重试", fontSize = 12.sp) }
                    }
                }
            }
            if (state is WorkspaceLinkCard.State.Ready || staleEntryId != null) {
                Icon(Icons.Filled.ExitToApp, contentDescription = "打开 ZCode 工作区")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 全屏 WebView 屏（独立导航目的地，主导航底栏之外 = 真全屏）
// ---------------------------------------------------------------------------

/**
 * 全屏 WebView：标题栏（返回/标题+当前 URL 中段省略/刷新/复制 URL）+ WebView 主体。
 * 三态：加载态（顶部线性进度）/ 错误态（结构化提示+重试）/ 正常渲染；
 * 空态=条目不存在（深链/已删兜底）。
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
                Text("条目不存在（可能已被删除）。", fontSize = 14.sp)
                TextButton(onClick = onBack) { Text("返回列表") }
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
                    Text(if (copied) "已复制" else "复制URL", fontSize = 12.sp)
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
                        webViewClient = object : WebViewClient() {
                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                // 白名单 http/https；file/content/javascript 等一律拒载（仅拒载，
                                // 对齐 openLink 简化语义）；URL 零入日志（可能含令牌）
                                val scheme = request.url.scheme?.lowercase()
                                return scheme != "http" && scheme != "https"
                            }

                            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
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
                                    errorMsg = "页面加载失败（${error.description}，code=${error.errorCode}）。" +
                                        "请检查链接与网络后重试。"
                                }
                            }

                            override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) {
                                // 证书错误绝不 proceed（cancel 默认拒绝——与 pin-TL 红线同向，绝不自签放行）
                                handler.cancel()
                                loading = false
                                errorMsg = "证书校验失败，已阻止加载（绝不放行证书错误）。"
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
                        TextButton(onClick = {
                            errorMsg = null
                            loading = true
                            webView?.reload()
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
