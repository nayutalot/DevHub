package com.devhub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.SubmitResult
import com.devhub.mobile.core.ProviderPalette
import com.devhub.mobile.core.ScrubberMath
import com.devhub.mobile.core.TranscriptListMetrics
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
    // U1-M3（AUDIT P1#3）：错误统一呈现体（人话 + 原码收「技术细节」折叠）
    var detailError by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }
    var prevAfter by remember { mutableStateOf<Long?>(null) } // R10 向旧翻页游标（null = 已到最早）
    var loadingOlder by remember { mutableStateOf(false) }
    var replyText by remember { mutableStateOf("") }
    // UX-P1 Top4（D8-D17）：指令回执 = 人话 headline + 技术原值（commandId/幂等）收「技术细节」折叠
    var submitStatus by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }
    // U1-M3：指令被拒 → 统一呈现体（人话 + 原码「技术细节」折叠），不再直出 [code] msg
    var submitError by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }
    // DM2 批（docs/briefs/dm2-capsws.md §1）：caps 过期一次性自愈——重探+重发期间按钮
    // 人话态「正在重新验证能力…」；状态机本体在 :core CapsSelfHeal（单测直锁）。
    var capsHealing by remember { mutableStateOf(false) }
    val capsSelfHeal = remember { com.devhub.mobile.core.CapsSelfHeal.OneShot() }
    var scrubFraction by remember { mutableStateOf<Float?>(null) }
    // U2-M1（AUDIT P3#7）：capabilities ⓘ 弹层开关（详情页头部常态 = 一行摘要）
    var showCapsInfo by remember { mutableStateOf(false) }

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
    // U1-M1（AUDIT P1#1）：旋转（Activity 重建/配置变化）后按 sessionId 重载消息——
    // orientation 入键：横竖屏切换后本 effect 重启，尾部取数 + prevAfter 游标重建，
    // 气泡数据面与度量面（下方 TranscriptListMetrics 收敛 padding）双路修复。
    val orientation = LocalConfiguration.current.orientation
    val refreshSignal by ConnectionManager.refreshSignal.collectAsState() // R5.3 事件驱动刷新信号
    LaunchedEffect(sessionId, orientation) {
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
                detailError = com.devhub.mobile.core.ErrorPresent.api(
                    err.code, err.message,
                    com.devhub.mobile.core.ErrorPresent.Surface.SESSION_MESSAGES,
                )
            } catch (err: IOException) {
                detailError = com.devhub.mobile.core.ErrorPresent.io(err)
            } catch (err: Exception) {
                // P0 热修：未预期异常绝不容 UI 协程崩进程（通用人话+technical 保留）
                detailError = com.devhub.mobile.core.ErrorPresent.io(err)
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
            // DM2 批兜底面（取舍见 :core CapsSelfHeal 头注释）：managed 会话详情打开
            // 期间 ≥120s 低频 caps 重探——本循环周期 = FALLBACK_POLL_MS = 120s，探针
            // 置于 delay 之后 = 打开满 120s 才首探（0~120s 窗口由一次性自愈主修面承担，
            // 两机制窗口互补）。探针 = agents 列表既有通道（桌面 probeWiredProviders
            // → caps 过期重验），真实探测绝不伪造；失败容忍，绝不打断详情轮询。
            if (detail?.session?.sessionMode == "managed" || detail?.capabilities?.mode == "managed") {
                runCatching {
                    withContext(Dispatchers.IO) { ApiProvider.projection(context).agents() }
                }
            }
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
                    ?: "未命名对话", // UX-P1 D1
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
        }
        if (fixtureOn) {
            // UX-P1 D2：同 S3（演示模式标注不弱化）
            Text(
                "演示模式：显示的是示例数据，不是你的电脑",
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
            com.devhub.mobile.ui.components.ErrorPresentation(
                presentable = detailError ?: com.devhub.mobile.core.ErrorPresent.Presentable("加载失败"),
                headlinePrefix = "加载失败：",
            )
            return@Column
        }

        // —— 元数据行 ——
        // U1-M2（AUDIT P1#2）：observed 会话 waiting_input 徽章锁定语义（详情面，
        // sessionMode/capsMode 双门同口径——详情页零控件，原「等待输入」= 假可供性）
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusBadge(d.session.status, sessionMode = d.session.sessionMode, capsMode = d.capabilities.mode)
            ModeBadge(d.session.sessionMode)
            if (d.session.stale) Text("信息可能不是最新", fontSize = 11.sp, color = Color(0xFFC7A008)) // UX-P1 D3
        }
        d.session.statusDetail?.let { Text(it, fontSize = 12.sp) }
        // —— U2-M1（AUDIT P2#1 + P3#7）：capabilities 人话化 + 头部压缩 ——
        // 原样直出行（mode=… granted=[…] evidence=…英文原句，06/08/24 号截图）退役：
        // 常态 = 一行人话摘要（core.CapabilitiesExplain 纯函数译码，:core 单测穷举锁）+ ⓘ 弹层；
        // 技术原值（mode/granted/evidence 逐字原串）收进弹层「技术信息」折叠区——翻译不删除，
        // 零吞码。provider 只读原因卡同压缩进弹层（常态占屏显著缩小，对照 06 号）。
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                com.devhub.mobile.core.CapabilitiesExplain.summaryLine(
                    mode = d.capabilities.mode,
                    evidence = d.capabilities.evidence,
                ),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
            TextButton(onClick = { showCapsInfo = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                Text("ⓘ 这台手机能做什么", fontSize = 11.sp) // UX-P1 D4
            }
        }

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
                        "🤖 子任务 (${d.childSessions.size})", // UX-P1 D5
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        "查看 ▸", // UX-P1 D6
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
            // R7.1 per-provider 原因卡 → U2-M1（AUDIT P3#7）压缩进 ⓘ 弹层（「为何只读」区），
            // 常态头部不再占两行 amber 卡；provider 未知时回退通用文案，绝不猜。
            // U1-M2（AUDIT P1#2）：observed + waiting_input 同屏 → 保留解释行（直接回应徽章召唤）
            if (com.devhub.mobile.core.InteractionHonesty.waitingInputBadge(
                    status = d.session.status,
                    sessionMode = d.session.sessionMode,
                    capsMode = d.capabilities.mode,
                ) != null
            ) {
                Text(
                    com.devhub.mobile.core.InteractionHonesty.OBSERVED_WAITING_NOTE,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
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
                    label = { Text("输入消息…") }, // UX-P1 D7
                    supportingText = {
                        // 仅当接近 4000 上限时显示剩余计数（D7：常态零密度）
                        if (replyText.length >= 3600) {
                            Text("还可输入 ${4000 - replyText.length} 字", fontSize = 11.sp)
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        val text = replyText.trim()
                        if (text.isEmpty()) return@Button
                        scope.launch {
                            submitStatus = null
                            submitError = null
                            try {
                                // DM2 批（docs/briefs/dm2-capsws.md §1）：caps 过期一次性自愈——
                                // 首发被拒且拒绝码 = caps 过期族（:core CapsSelfHeal 判定，一次性
                                // 语义由 OneShot 锁定）→ 经既有探针通道（agents 列表 → 桌面
                                // probeWiredProviders → caps 过期重验）真实重探一次；探针成功
                                // （verifiedAt 落入新鲜窗口，绝不伪造）才自动重发原消息一次；
                                // 重试仍拒 → 既有错误呈现，绝不循环。非 caps 族拒绝不触发、
                                // 不消费一次性机会。
                                var r = ConnectionManager.submitReply(sessionId, text)
                                if (r is SubmitResult.Rejected && capsSelfHeal.shouldRetry(r.code)) {
                                    capsHealing = true
                                    try {
                                        android.util.Log.i(
                                            UX_LOG_TAG,
                                            "caps_heal_start sessionId=$sessionId code=${r.code} atMs=${System.currentTimeMillis()}",
                                        )
                                        val agents = withContext(Dispatchers.IO) {
                                            ApiProvider.projection(context).agents()
                                        }
                                        val caps = agents
                                            .firstOrNull { it.id == d.session.providerId }
                                            ?.capabilities
                                        val fresh = caps != null &&
                                            com.devhub.mobile.core.CapsSelfHeal.capsFreshNow(
                                                caps.verifiedAtSec,
                                                System.currentTimeMillis() / 1000,
                                            )
                                        android.util.Log.i(
                                            UX_LOG_TAG,
                                            "caps_heal_probe providerId=${d.session.providerId} fresh=$fresh atMs=${System.currentTimeMillis()}",
                                        )
                                        if (fresh && caps != null) {
                                            r = ConnectionManager.submitReply(sessionId, text)
                                            android.util.Log.i(
                                                UX_LOG_TAG,
                                                "caps_heal_retry atMs=${System.currentTimeMillis()}",
                                            )
                                        }
                                    } finally {
                                        capsHealing = false
                                    }
                                }
                                submitStatus = when (r) {
                                    is SubmitResult.Accepted -> {
                                        // R5.1 端侧打点：reply 提交→回流往返样本的起点标记
                                        android.util.Log.i(
                                            UX_LOG_TAG,
                                            "reply_sent sessionId=$sessionId commandId=${r.commandId} atMs=${System.currentTimeMillis()}",
                                        )
                                        // UX-P1 D8：commandId 收「技术细节」折叠
                                        com.devhub.mobile.core.ErrorPresent.Presentable(
                                            "已发送", "commandId=${r.commandId}",
                                        )
                                    }
                                    SubmitResult.QueuedOffline ->
                                        // UX-P1 D9（Top4）：幂等字样进折叠
                                        com.devhub.mobile.core.ErrorPresent.Presentable(
                                            "电脑不在线，消息会在上线后自动送达",
                                            "已入离线队列（幂等补发）",
                                        )
                                    is SubmitResult.Rejected -> {
                                        submitError = com.devhub.mobile.core.ErrorPresent.api(
                                            r.code, r.message,
                                            com.devhub.mobile.core.ErrorPresent.Surface.COMMAND,
                                        )
                                        null
                                    }
                                }
                            } catch (err: Exception) {
                                // B1 泛化热修（P0 先例）：提交协程跑在 rememberCoroutineScope（主线程
                                // 无异常处理器）——未预期 Throwable 绝不容其崩进程；诚实态上屏，
                                // 原异常收 technical 不吞码。
                                submitError = com.devhub.mobile.core.ErrorPresent.io(err)
                            }
                            replyText = ""
                        }
                    },
                    enabled = replyText.isNotBlank() && !capsHealing,
                ) { Text(if (capsHealing) "正在重新验证能力…" else "发送") }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
            if (controls.pause) {
                OutlinedButton(onClick = {
                    scope.launch {
                            submitStatus = null
                            submitError = null
                            try {
                                submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "pause")) {
                                    is SubmitResult.Accepted -> com.devhub.mobile.core.ErrorPresent.Presentable( // D10
                                        "已暂停 · 电脑已确认", "commandId=${r.commandId}",
                                    )
                                    SubmitResult.QueuedOffline -> com.devhub.mobile.core.ErrorPresent.Presentable( // D11
                                        "电脑不在线：暂停指令已暂存，恢复后自动发送", "已入离线队列（幂等补发）",
                                    )
                                    is SubmitResult.Rejected -> {
                                        submitError = com.devhub.mobile.core.ErrorPresent.api(
                                            r.code, r.message,
                                            com.devhub.mobile.core.ErrorPresent.Surface.COMMAND,
                                        )
                                        null
                                    }
                                }
                            } catch (err: Exception) {
                                // B1 泛化热修（P0 先例）：同 reply——未预期异常绝不崩 UI 进程。
                                submitError = com.devhub.mobile.core.ErrorPresent.io(err)
                            }
                    }
                }) { Text("暂停") }
            }
            if (controls.resume) {
                OutlinedButton(onClick = {
                    scope.launch {
                            submitStatus = null
                            submitError = null
                            try {
                                submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "resume")) {
                                    is SubmitResult.Accepted -> com.devhub.mobile.core.ErrorPresent.Presentable( // D12
                                        "已继续 · 电脑已确认", "commandId=${r.commandId}",
                                    )
                                    SubmitResult.QueuedOffline -> com.devhub.mobile.core.ErrorPresent.Presentable( // D13
                                        "电脑不在线：恢复指令已暂存，上线后自动发送", "已入离线队列（幂等补发）",
                                    )
                                    is SubmitResult.Rejected -> {
                                        submitError = com.devhub.mobile.core.ErrorPresent.api(
                                            r.code, r.message,
                                            com.devhub.mobile.core.ErrorPresent.Surface.COMMAND,
                                        )
                                        null
                                    }
                                }
                            } catch (err: Exception) {
                                // B1 泛化热修（P0 先例）：同 reply——未预期异常绝不崩 UI 进程。
                                submitError = com.devhub.mobile.core.ErrorPresent.io(err)
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
                            submitStatus = null
                            submitError = null
                            try {
                                submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "approve")) {
                                    is SubmitResult.Accepted -> com.devhub.mobile.core.ErrorPresent.Presentable( // D14
                                        "已同意 · 电脑已确认", "commandId=${r.commandId}",
                                    )
                                    SubmitResult.QueuedOffline -> com.devhub.mobile.core.ErrorPresent.Presentable( // D15
                                        "电脑不在线：批准指令已暂存，上线后自动发送", "已入离线队列（幂等补发）",
                                    )
                                    is SubmitResult.Rejected -> {
                                        submitError = com.devhub.mobile.core.ErrorPresent.api(
                                            r.code, r.message,
                                            com.devhub.mobile.core.ErrorPresent.Surface.COMMAND,
                                        )
                                        null
                                    }
                                }
                            } catch (err: Exception) {
                                // B1 泛化热修（P0 先例）：同 reply——未预期异常绝不崩 UI 进程。
                                submitError = com.devhub.mobile.core.ErrorPresent.io(err)
                            }
                    }
                }) { Text("批准") }
            }
            if (controls.interrupt) {
                OutlinedButton(onClick = {
                    scope.launch {
                            submitStatus = null
                            submitError = null
                            try {
                                submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "interrupt")) {
                                    is SubmitResult.Accepted -> com.devhub.mobile.core.ErrorPresent.Presentable( // D16
                                        "已中断 · 电脑已确认", "commandId=${r.commandId}",
                                    )
                                    SubmitResult.QueuedOffline -> com.devhub.mobile.core.ErrorPresent.Presentable( // D17
                                        "电脑不在线：中断指令已暂存，上线后自动发送", "已入离线队列（幂等补发）",
                                    )
                                    is SubmitResult.Rejected -> {
                                        submitError = com.devhub.mobile.core.ErrorPresent.api(
                                            r.code, r.message,
                                            com.devhub.mobile.core.ErrorPresent.Surface.COMMAND,
                                        )
                                        null
                                    }
                                }
                            } catch (err: Exception) {
                                // B1 泛化热修（P0 先例）：同 reply——未预期异常绝不崩 UI 进程。
                                submitError = com.devhub.mobile.core.ErrorPresent.io(err)
                            }
                    }
                }) { Text("中断") }
            }
        }
        submitStatus?.let {
            Text(it.headline, fontSize = 12.sp)
            it.technical?.let { tech ->
                com.devhub.mobile.ui.components.TechnicalDetailsFold(tech)
            }
        }
        // U1-M3：指令拒绝统一呈现（人话 + 技术细节折叠，默认收起）
        submitError?.let {
            com.devhub.mobile.ui.components.ErrorPresentation(presentable = it)
        }

        // —— 消息（R11 气泡流；R10 逆序布局：最新在底部、初始停底部）——
        // 打磨批 D：底部 contentPadding = 「跳到最新」FAB 高度 + 边距的避让区，
        // 最新一条气泡不再被 FAB 遮压（ux-b-08/12、r9-fab 三帧缺陷）。
        // U1-M1（AUDIT P1#1）：横屏小视口下固定 76dp 避让区可 ≥ 视口高——reverseLayout
        // 最新气泡整体落视口上方 → 气泡区持续空白（26 号截图实证）。底部避让区按
        // TranscriptListMetrics 收敛为 min(基准, 视口高×0.4)：横屏最新气泡恒可见，
        // 竖屏（大视口）行为不变。
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().padding(top = 4.dp)) {
            val bottomAvoidDp = if (maxHeight != androidx.compose.ui.unit.Dp.Infinity) {
                with(LocalDensity.current) {
                    TranscriptListMetrics
                        .bottomPaddingPx(viewportHeightPx = maxHeight.toPx(), basePaddingPx = 76.dp.toPx())
                        .toDp()
                }
            } else {
                76.dp
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                reverseLayout = true,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = bottomAvoidDp),
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

    // —— U2-M1（AUDIT P2#1 + P3#7）：capabilities ⓘ 弹层 ——
    // 人话明细（mode/granted/reason 译码）+ observed provider 只读原因 + 「技术信息」折叠区
    // （mode/granted/evidence 原值逐字承载，默认收起）——翻译不删除，零吞码。
    if (showCapsInfo && d != null) {
        val explain = com.devhub.mobile.core.CapabilitiesExplain.explain(
            mode = d.capabilities.mode,
            granted = d.capabilities.granted,
            evidence = d.capabilities.evidence,
        )
        var techOpen by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { showCapsInfo = false },
            title = { Text("这台手机能做什么", fontWeight = FontWeight.SemiBold) }, // UX-P1 D21
            text = {
                Column {
                    Text("连接方式：${explain.modeLabel}", fontSize = 13.sp) // UX-P1 D22
                    Spacer(Modifier.height(4.dp))
                    Text("可执行操作：${explain.grantedLabel}", fontSize = 13.sp)
                    Spacer(Modifier.height(4.dp))
                    Text("状态说明：${explain.reasonLabel}", fontSize = 13.sp)
                    // DSW 批（docs/briefs/dsw-workspace.md §1）：生效工作区一行——
                    // 用户面可见 agent 在哪读写（仅托管门开时桌面端携带，缺失不显示）
                    d.capabilities.workspace?.let { ws ->
                        Spacer(Modifier.height(4.dp))
                        Text("工作区：$ws", fontSize = 13.sp)
                    }
                    if (d.session.sessionMode == "observed" || d.capabilities.mode == "observed") {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "为何只读：" + (
                                com.devhub.mobile.core.InteractionHonesty.observedReason(
                                    providerKey = d.session.providerKey,
                                    displayName = d.session.providerLabel,
                                )
                                    ?: com.devhub.mobile.core.InteractionHonesty.GENERIC_OBSERVED_NOTE
                                ),
                            fontSize = 12.sp,
                            color = Color(0xFF7A4F00),
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    TextButton(onClick = { techOpen = !techOpen }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                        Text(if (techOpen) "收起技术信息" else "技术信息", fontSize = 12.sp)
                    }
                    if (techOpen) {
                        Text(
                            "mode=${d.capabilities.mode}\n" +
                                "granted=[${d.capabilities.granted.joinToString(", ")}]\n" +
                                "evidence=${d.capabilities.evidence}" +
                                (d.capabilities.workspace?.let { "\nworkspace=$it" } ?: ""), // DSW 批：技术原值零吞码
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(6.dp))
                                .padding(8.dp),
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showCapsInfo = false }) { Text("关闭") }
            },
        )
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
                if (loadingOlder) "正在加载更早消息…" else "松手查看更早消息" // UX-P1 D19
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
            Text("最早", fontSize = 10.sp, color = Color(0xFF757575)) // UX-P1 D20
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
