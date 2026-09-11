package com.devhub.mobile.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.SubmitResult
import com.devhub.mobile.core.ProviderPalette
import com.devhub.mobile.core.ScrubberMath
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.MessageCacheEntity
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.SegmentDto
import com.devhub.mobile.data.remote.SessionDetailDto
import com.devhub.mobile.ui.components.ModeBadge
import com.devhub.mobile.ui.components.MessageBubble
import com.devhub.mobile.ui.components.ProviderAvatarFor
import com.devhub.mobile.ui.components.StatusBadge
import com.devhub.mobile.ui.components.TimeFmt
import com.devhub.mobile.ui.components.ZcodeRemoteOpenButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/** R10：进会话即请求最新 200 条（last=200 尾部取数 + prevAfter 向旧翻页）。 */
private const val TAIL_PAGE = 200

/** R5.1 批次 C 端侧可见性打点 tag（logcat 过滤用；内容零输出，仅 id/时间戳）。 */
private const val UX_LOG_TAG = "DevHubUx"

/**
 * 页面 5：会话详情（GET /v1/sessions/{id} + 消息分页，docs/14 §B.1；体验整改批 B 增强）。
 * - R10：进会话 last=200 取最新 → LazyColumn reverseLayout（最新在底部、初始停底部）；
 *   上滑到窗口边缘自动按 prevAfter 加载更早消息（替换"加载更多"按钮）；
 * - R9：底部拖动 scrubber（映射已加载窗口索引；拖动显示邻近时间戳气泡；未加载区间按锚点翻页，
 *   预算 ScrubberMath.maxPagingStepsPerDrag ≤2 页）+「⏬ 跳到最新」FAB；
 * - R11：气泡对话流 + R1 思维链折叠 + R8 迷你渲染（MessageBubble 组件）；
 * - R2：存在子会话时显示「🤖 子智能体会话 (N)」入口；
 * - capabilities / ControlGate 控制门语义保持现状（observed 零控件；本批不动）；
 * - T1 批：provider=zcode 的会话在控制区加「打开 ZCode 遥控」入口（数据驱动展示入口层
 *   特判 InteractionHonesty.isZcodeDisplayEntry）——转录仍只读，控制经 ZCode 自家认证
 *   遥控页（remote/{entryId}）；徽章诚实原则不变：observed 投影绝不显示为 managed/可控。
 */
@Composable
fun SessionDetailScreen(
    sessionId: Long,
    onBack: () -> Unit,
    onOpenChildren: (Long) -> Unit = {},
    onOpenRemoteEntry: (Long) -> Unit = {},
) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    val nowSec = remember { System.currentTimeMillis() / 1000 }
    val fixtureOn = remember { FixtureMode.enabled(context) }

    var detail by remember { mutableStateOf<SessionDetailDto?>(null) }
    var detailError by remember { mutableStateOf<String?>(null) }
    var prevAfter by remember { mutableStateOf<Long?>(null) } // R10 向旧翻页游标（null = 已到最早）
    var loadingOlder by remember { mutableStateOf(false) }
    var replyText by remember { mutableStateOf("") }
    var submitStatus by remember { mutableStateOf<String?>(null) }
    var scrubFraction by remember { mutableStateOf<Float?>(null) }

    /** 消息分页入库（脱敏投影；segments 序列化为 JSON 供 UI 解析）。 */
    suspend fun insertPage(page: com.devhub.mobile.data.remote.MessagesPage) {
        if (page.items.isEmpty()) return
        // R5.1 批次 C 端侧打点：App 侧消息可见时间（logcat 时间戳 ≈ Room 落库完成，
        // Compose 于同帧内上屏；only ids/timestamps，零内容——日志脱敏红线同构）。
        // 与桌面 agent_events.created_at / WS 事件序列对照 → WS→App 可见段样本。
        for (m in page.items) {
            android.util.Log.i(
                UX_LOG_TAG,
                "msg_visible sessionId=$sessionId id=${m.id} occurredAt=${m.occurredAtSec ?: -1L} atMs=${System.currentTimeMillis()}",
            )
        }
        withContext(Dispatchers.IO) {
            db.messageCacheDao().insertAll(
                page.items.map { m ->
                    MessageCacheEntity(
                        sessionId = sessionId,
                        messageId = m.id,
                        role = m.role,
                        contentRedacted = m.contentRedacted,
                        occurredAtSec = m.occurredAtSec,
                        segmentsJson = segmentsToJson(m.segments),
                    )
                },
            )
        }
    }

    /** R10 向旧翻页：prevAfter → before=<prevAfter>。 */
    suspend fun loadOlder() {
        val pa = prevAfter ?: return
        if (loadingOlder) return
        loadingOlder = true
        try {
            val page = withContext(Dispatchers.IO) {
                ApiProvider.projection(context).messages(sessionId, before = pa, limit = TAIL_PAGE)
            }
            insertPage(page)
            prevAfter = page.prevAfter
        } catch (_: Exception) {
            // 保持游标不动，滚动边缘触发时重试
        } finally {
            loadingOlder = false
        }
    }

    // —— 首屏（R10 尾部取数；仅 sessionId 变化执行一次）——
    val refreshSignal by ConnectionManager.refreshSignal.collectAsState() // R5.3 事件驱动刷新信号
    LaunchedEffect(sessionId) {
        runCatching {
            val page = withContext(Dispatchers.IO) {
                ApiProvider.projection(context).messages(sessionId, last = TAIL_PAGE)
            }
            insertPage(page)
            prevAfter = page.prevAfter
        }
    }

    // —— 详情/增量回流——R5.3：事件驱动为主（refreshSignal 变化即重启立即拉取）+
    // 120s 低频兜底（原 3s 轮询退役，仅连接健康与补偿）。
    LaunchedEffect(sessionId, refreshSignal) {
        while (isActive) {
            try {
                detail = withContext(Dispatchers.IO) { ApiProvider.projection(context).sessionDetail(sessionId) }
                detailError = null
            } catch (err: ApiError) {
                detailError = "[${err.code}] ${err.message}"
            } catch (err: IOException) {
                detailError = "网络不可达"
            }
            // 新消息增量回流（after 正向游标；消息指纹去重语义在服务端，Room upsert 幂等）。
            // 批次 C 缺陷修复：新启动的托管会话首屏常为空（消息在 spawn 后才产生），
            // maxMessageId=null 时若跳过拉取，增量轮询永不启动 → 回流永久缺失。
            // 回退为 tail 拉取（last=TAIL_PAGE），拉到任意消息后自然切换 after 增量。
            runCatching {
                val after = withContext(Dispatchers.IO) { db.messageCacheDao().maxMessageId(sessionId) }
                if (after != null) {
                    val page = withContext(Dispatchers.IO) {
                        ApiProvider.projection(context).messages(sessionId, after = after, limit = TAIL_PAGE)
                    }
                    insertPage(page)
                } else {
                    val page = withContext(Dispatchers.IO) {
                        ApiProvider.projection(context).messages(sessionId, last = TAIL_PAGE)
                    }
                    insertPage(page)
                    if (prevAfter == null) prevAfter = page.prevAfter
                }
            }
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    val messages by db.messageCacheDao().observeMessages(sessionId).collectAsState(initial = emptyList())

    // R9/R10：上滑到已加载窗口顶部边缘 → 自动按 prevAfter 加载更早消息
    val atOlderEdge by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            info.totalItemsCount > 0 && lastVisible >= info.totalItemsCount - 4
        }
    }
    LaunchedEffect(atOlderEdge, prevAfter) {
        if (atOlderEdge && prevAfter != null && !loadingOlder) loadOlder()
    }

    val d = detail
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("< 返回") }
            val spec = ProviderPalette.resolve(d?.session?.providerKey, d?.session?.providerLabel)
            ProviderAvatarFor(providerKey = d?.session?.providerKey, providerLabel = d?.session?.providerLabel, size = 24.dp, fontSize = 11)
            Spacer(Modifier.width(6.dp))
            Text(
                com.devhub.mobile.core.RichTextTokenizer.stripDisplayMarkers(d?.session?.title)
                    ?: "会话 #$sessionId",
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
        }
        if (fixtureOn) {
            Text(
                "演示数据（夹具）· 非真实 Gateway — 端到端验收归批次 C",
                fontSize = 10.sp,
                color = Color(0xFF7A4F00),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFFFF8E1))
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            )
        }

        if (d == null && detailError == null) {
            Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
            return@Column
        }
        if (d == null) {
            Text("加载失败：$detailError", color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            return@Column
        }

        // —— 元数据行 ——
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusBadge(d.session.status)
            ModeBadge(d.session.sessionMode)
            if (d.session.stale) Text("数据过期（stale）", fontSize = 11.sp, color = Color(0xFFC7A008))
        }
        d.session.statusDetail?.let { Text(it, fontSize = 12.sp) }
        Text(
            "capabilities：mode=${d.capabilities.mode} granted=[${d.capabilities.granted.joinToString(", ")}] evidence=${d.capabilities.evidence}",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant, // 打磨批 D：深色主题下灰字升为主题次级色
        )

        // —— R2 子智能体会话入口 ——
        if (d.childSessions.isNotEmpty()) {
            Surface(
                color = MaterialTheme.colorScheme.secondaryContainer,
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp)
                    .clickable { onOpenChildren(sessionId) },
            ) {
                Row(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "🤖 子智能体会话 (${d.childSessions.size})",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        "点入查看层级与状态 ▸",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                }
            }
        }

        // —— 控制区（UI 门：ControlGate；observed 零控件现状保持）——
        val controls = ConnectionManager.visibleControls(
            capsMode = d.capabilities.mode,
            sessionMode = d.session.sessionMode,
            granted = d.capabilities.granted,
        )
        if (d.session.sessionMode == "observed" || d.capabilities.mode == "observed") {
            // R7.1：per-provider 原因卡（文案 = known-limitations §1 摘取，批次 C）；
            // provider 未知时回退通用文案，绝不猜。
            val reason = com.devhub.mobile.core.InteractionHonesty.observedReason(
                providerKey = d.session.providerKey,
                displayName = d.session.providerLabel,
            ) ?: com.devhub.mobile.core.InteractionHonesty.GENERIC_OBSERVED_NOTE
            Text(
                reason,
                fontSize = 12.sp,
                color = Color(0xFF7A4F00),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFFFF8E1), RoundedCornerShape(8.dp))
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }
        // —— T1 批：zcode 会话「打开 ZCode 遥控」入口（observed 零控件现状不变——
        // 本入口不提交任何 DevHub 命令，只跳转 ZCode 自家认证遥控页；文案如实注明
        // 转录只读。判定 = 展示入口层 providerId/providerKey 特判，不碰能力门）——
        if (com.devhub.mobile.core.InteractionHonesty.isZcodeDisplayEntry(
                providerKey = d.session.providerKey,
                displayName = d.session.providerLabel,
            )
        ) {
            ZcodeRemoteOpenButton(
                buttonLabel = com.devhub.mobile.core.InteractionHonesty.ZCODE_REMOTE_SESSION_BUTTON,
                noteText = com.devhub.mobile.core.InteractionHonesty.ZCODE_REMOTE_DETAIL_NOTE,
                staleLookup = {
                    db.remoteWorkspaceEntryDao().getByTitle(
                        com.devhub.mobile.connect.WorkspaceLinkCard.ENTRY_TITLE,
                    )?.id
                },
                onOpen = onOpenRemoteEntry,
            )
        }
        if (controls.reply) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = replyText,
                    onValueChange = { replyText = it.take(4000) },
                    label = { Text("回复（≤4000 字符）") },
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        val text = replyText.trim()
                        if (text.isEmpty()) return@Button
                        scope.launch {
                            submitStatus = when (val r = ConnectionManager.submitReply(sessionId, text)) {
                                is SubmitResult.Accepted -> {
                                    // R5.1 端侧打点：reply 提交→回流往返样本的起点标记
                                    android.util.Log.i(
                                        UX_LOG_TAG,
                                        "reply_sent sessionId=$sessionId commandId=${r.commandId} atMs=${System.currentTimeMillis()}",
                                    )
                                    "已接受（commandId=${r.commandId}）"
                                }
                                SubmitResult.QueuedOffline -> "当前离线：已入离线队列，重连后自动补发（幂等）"
                                is SubmitResult.Rejected -> "被拒绝：[${r.code}] ${r.message}"
                            }
                            replyText = ""
                        }
                    },
                    enabled = replyText.isNotBlank(),
                ) { Text("发送") }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
            if (controls.pause) {
                OutlinedButton(onClick = {
                    scope.launch {
                        submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "pause")) {
                            is SubmitResult.Accepted -> "pause 已接受（commandId=${r.commandId}）"
                            SubmitResult.QueuedOffline -> "当前离线：pause 已入离线队列"
                            is SubmitResult.Rejected -> "pause 被拒绝：[${r.code}] ${r.message}"
                        }
                    }
                }) { Text("暂停") }
            }
            if (controls.resume) {
                OutlinedButton(onClick = {
                    scope.launch {
                        submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "resume")) {
                            is SubmitResult.Accepted -> "resume 已接受（commandId=${r.commandId}）"
                            SubmitResult.QueuedOffline -> "当前离线：resume 已入离线队列"
                            is SubmitResult.Rejected -> "resume 被拒绝：[${r.code}] ${r.message}"
                        }
                    }
                }) { Text("恢复") }
            }
            // M2-R3 门控路径（docs/18 §5.1 / docs/19 §6.1/§7.3）：approve/interrupt 按钮纯数据驱动
            // ——仅当 CapabilitySet.granted 含对应能力才显示。判定源（agent 投影 granted）与执行
            // 通道双双真实验证通过前恒不含二者 → 按钮恒不显示（当前现实态）；绝不硬编码放开。
            if (controls.approve) {
                OutlinedButton(onClick = {
                    scope.launch {
                        submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "approve")) {
                            is SubmitResult.Accepted -> "approve 已接受（commandId=${r.commandId}）"
                            SubmitResult.QueuedOffline -> "当前离线：approve 已入离线队列"
                            is SubmitResult.Rejected -> "approve 被拒绝：[${r.code}] ${r.message}"
                        }
                    }
                }) { Text("批准") }
            }
            if (controls.interrupt) {
                OutlinedButton(onClick = {
                    scope.launch {
                        submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "interrupt")) {
                            is SubmitResult.Accepted -> "interrupt 已接受（commandId=${r.commandId}）"
                            SubmitResult.QueuedOffline -> "当前离线：interrupt 已入离线队列"
                            is SubmitResult.Rejected -> "interrupt 被拒绝：[${r.code}] ${r.message}"
                        }
                    }
                }) { Text("中断") }
            }
        }
        submitStatus?.let { Text(it, fontSize = 12.sp) }

        // —— 消息（R11 气泡流；R10 逆序布局：最新在底部、初始停底部）——
        // 打磨批 D：底部 contentPadding = 「跳到最新」FAB 高度 + 边距的避让区，
        // 最新一条气泡不再被 FAB 遮压（ux-b-08/12、r9-fab 三帧缺陷）。
        Box(Modifier.weight(1f).fillMaxWidth().padding(top = 4.dp)) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                reverseLayout = true,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 76.dp),
            ) {
                val count = messages.size
                items(
                    count = count,
                    key = { idx -> messages[count - 1 - idx].messageId },
                ) { idx ->
                    val i = count - 1 - idx
                    MessageBubble(
                        message = messages[i],
                        providerKey = d.session.providerKey,
                        providerLabel = d.session.providerLabel,
                        prevOccurredAtSec = if (i > 0) messages[i - 1].occurredAtSec else null,
                        nowSec = nowSec,
                    )
                }
            }
            // R9 「跳到最新」FAB（不在底部时显示）
            val showJumpToLatest by remember {
                derivedStateOf { listState.firstVisibleItemIndex > 2 }
            }
            if (showJumpToLatest) {
                ExtendedFloatingActionButton(
                    onClick = { scope.launch { listState.animateScrollToItem(0) } },
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(12.dp),
                    containerColor = MaterialTheme.colorScheme.secondaryContainer,
                ) {
                    Text("⏬ 跳到最新", fontSize = 12.sp)
                }
            }
        }

        // —— R9 scrubber：映射已加载窗口；拖动显示邻近时间戳；释放跳转；边缘按锚点翻页 ——
        if (messages.size > 1) {
            ScrubberBar(
                count = messages.size,
                hasOlder = prevAfter != null,
                loadingOlder = loadingOlder,
                listState = listState,
                messages = messages,
                scrubFraction = scrubFraction,
                onScrub = { scrubFraction = it },
                onJump = { fraction ->
                    scope.launch {
                        var steps = ScrubberMath.maxPagingStepsPerDrag()
                        if (ScrubberMath.needsOlderPage(fraction, messages.size, prevAfter != null)) {
                            while (steps-- > 0 && prevAfter != null) {
                                loadOlder()
                            }
                        }
                        val total = listState.layoutInfo.totalItemsCount
                        val target = if (fraction >= 0.99f) {
                            total - 1 // 拖到最旧端：翻页后跳到新窗口顶部
                        } else {
                            ScrubberMath.reversedIndexForFraction(fraction, total)
                        }
                        if (total > 0) listState.scrollToItem(target.coerceIn(0, total - 1))
                    }
                },
            )
        }
    }
}

/** R9 底部拖动条：0 = 最新（底），1 = 最旧（顶）。拖动显示邻近消息时间戳气泡。 */
@Composable
private fun ScrubberBar(
    count: Int,
    hasOlder: Boolean,
    loadingOlder: Boolean,
    listState: androidx.compose.foundation.lazy.LazyListState,
    messages: List<MessageCacheEntity>,
    scrubFraction: Float?,
    onScrub: (Float?) -> Unit,
    onJump: (Float) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        // 拖动时间戳气泡（邻近消息时间；未加载区间显示翻页提示）
        scrubFraction?.let { f ->
            val target = ScrubberMath.indexForFraction(f, count)
            val anchorText = if (ScrubberMath.needsOlderPage(f, count, hasOlder)) {
                if (loadingOlder) "更早…（加载中）" else "更早…（释放自动翻页）"
            } else {
                messages.getOrNull(target)?.occurredAtSec?.let { TimeFmt.full(it) } ?: "更早…"
            }
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Surface(
                    color = MaterialTheme.colorScheme.inverseSurface,
                    shape = RoundedCornerShape(8.dp),
                ) {
                    Text(
                        anchorText,
                        color = MaterialTheme.colorScheme.inverseOnSurface,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                    )
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("最新", fontSize = 10.sp, color = Color(0xFF757575))
            // 打磨批 D：scrubber 回显走"视口锚点"语义——firstVisible（reversed 索引，0=底部最新）
            // → fraction。停在底部（初始/全部可见的小窗口）恒锚「最新」端，
            // 修复新会话/子会话首屏滑条误停最旧端/中位的缺陷。
            val restFraction = ScrubberMath.fractionForReversedAnchor(
                firstVisibleReversedIndex = listState.firstVisibleItemIndex,
                count = count,
            )
            Slider(
                value = scrubFraction ?: restFraction,
                onValueChange = { onScrub(it) },
                onValueChangeFinished = {
                    val f = scrubFraction
                    onScrub(null)
                    if (f != null) onJump(f)
                },
                modifier = Modifier.weight(1f),
            )
            Text("最旧", fontSize = 10.sp, color = Color(0xFF757575))
        }
    }
}

/** segments → JSON（Room 存储形态；解析端 parseSegments 容忍失败回退纯文本）。 */
private fun segmentsToJson(segments: List<SegmentDto>?): String? {
    if (segments.isNullOrEmpty()) return null
    return runCatching {
        val arr = org.json.JSONArray()
        for (s in segments) {
            val o = org.json.JSONObject()
            o.put("kind", s.kind)
            if (s.label != null) o.put("label", s.label)
            o.put("content", s.content)
            arr.put(o)
        }
        arr.toString()
    }.getOrNull()
}
