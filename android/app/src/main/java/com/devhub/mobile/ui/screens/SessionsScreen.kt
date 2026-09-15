package com.devhub.mobile.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.core.ProviderPalette
import com.devhub.mobile.core.SessionListOps
import com.devhub.mobile.core.WorkspaceGrouping
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ConnState
import com.devhub.mobile.connect.WorkspaceLinkCard
import com.devhub.mobile.connect.WorkspaceLinkController
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.RemoteWorkspaceUrl
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.SessionCacheEntity
import com.devhub.mobile.data.remote.AgentDto
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.ui.components.ProviderAvatarFor
import com.devhub.mobile.ui.components.StatusBadge
import com.devhub.mobile.ui.components.StatusColors
import com.devhub.mobile.ui.components.TimeFmt
import com.devhub.mobile.ui.components.WorkspaceLinkCardView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * 页面 4：对话列表（GET /v1/sessions，docs/14 §B.1；体验整改批 B 增强）。
 * - R4：行首固定色板 + 首字母徽标；`provider #N` → providerLabel；顶部 provider 过滤 chips（数据 /v1/agents，次级行）；
 * - R3：行**长按**菜单（归档/取消归档/删除 + 二次确认，文案写明"仅移除 DevHub 记录"）；「显示归档」开关（includeArchived=1）；
 * - 9 值状态徽章 / waiting 高亮 / stale 标注 / observed 整行标注（现状保持）；
 * - 夹具模式（显式开关）：数据驱动自本地夹具，显著标注"演示数据"。
 *
 * UX-P2（docs/24 §3 + docs/26 §3.1）：列表行重排为微信聊天列表形态——
 * 行 1 = 助手头像+标题+时间；行 2 = 最近消息预览（Room 尾条）+9 值状态角标
 * （waiting/approval 高亮=QQ 待办；U1-M2 observed 锁定语义保留）；X2：session_mode
 * 徽章列表行隐藏（observed/attached 以副文案诚实降级，详情 ⓘ 保留）；stale/已归档
 * 降为副文案。演示模式开关迁「我的→演示模式」（琥珀标注不弱化保留）。
 *
 * T1 批（ZCode 遥控合并进会话流）：列表顶部加「ZCode 工作区」智能卡（置顶「电脑」卡，
 * 复用 WorkspaceLinkCardView / WorkspaceLinkController——点击 → 取/建智能条目 →
 * remote/{entryId}；卡上管理入口（小图标）→ 条目管理屏，手工 URL 条目功能不丢）。
 *
 * UX-Z2 结构层（docs/28 §4/§5）：顶部段控「最近对话｜工作区」（三标签 IA 不动、
 * 不加一级页）；「工作区」段 = 原生工作区分组卡片（E1 汇总行/E2 卡/E3 相对时间，
 * 分组纯函数 core.WorkspaceGrouping 单测锁定）；WebView 遥控置顶卡并存（§4.1
 * 职责分离）；「+」动线进入 composer-first 新建页（NewChatScreen，E4/E5/E8/E10）；
 * 助手页「开始对话」跳转经 autoOpenComposer 一次性语义聚焦（P3 升级迁移）。
 */
@Composable
fun SessionsScreen(
    onOpenSession: (Long) -> Unit,
    onOpenRemoteEntry: (Long) -> Unit = {},
    onManageRemote: () -> Unit = {},
    onGoAgentsStart: () -> Unit = {},
    autoOpenComposer: Boolean = false,
    onAutoComposerConsumed: () -> Unit = {},
) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()

    // UX-P3 唤醒联动（docs/briefs/uxp3-flows.md §1.4）：对话 tab 电脑不在线态出口接
    // 共享 WakeHostCard（接线不重写）——relay 已连上云端但电脑不在线时条件渲染
    val connState by ConnectionManager.state.collectAsState()
    val activeMode by ConnectionManager.activeMode.collectAsState()
    val beacon by ConnectionManager.upstreamBeacon.collectAsState()
    val connected = connState is ConnState.Connected

    var fixtureOn by remember { mutableStateOf(FixtureMode.enabled(context)) } // 开关 UX-P2 迁「我的→演示模式」
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var selectedProviderId by rememberSaveable { mutableStateOf<Long?>(null) }
    var agents by remember { mutableStateOf<List<AgentDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    // U1-M3（AUDIT P1#3）：错误统一呈现体（人话+技术细节折叠），不再直出原码
    var error by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }
    // UX-P1 S8：归档/删除失败 = 人话 + 原 message 进「技术细节」折叠（零吞码）
    var actionError by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }
    var refreshTick by remember { mutableStateOf(0) } // 归档/删除等操作后立即刷新
    var menuFor by remember { mutableStateOf<SessionCacheEntity?>(null) }
    var confirmDelete by remember { mutableStateOf<SessionCacheEntity?>(null) }

    // provider 名录（R4 过滤 chips 数据源）——R5.3：事件驱动为主 + 120s 兜底（原 15s 轮询退役）
    val refreshSignal by ConnectionManager.refreshSignal.collectAsState()
    LaunchedEffect(fixtureOn, refreshSignal) {
        while (isActive) {
            runCatching { withContext(Dispatchers.IO) { ApiProvider.projection(context).agents() } }
                .onSuccess { agents = it }
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    // 会话投影 → Room 缓存——R5.3：事件驱动为主（refreshSignal 变化即重启本 effect 立即拉取，
    // WS 事件→UI 延迟从「轮询周期 2s 上限」降到亚秒级）；120s 低频兜底仅连接健康与补偿
    // （includeArchived 切换/操作后 refreshTick 重启语义保持，R3 契约参数）
    LaunchedEffect(fixtureOn, showArchived, refreshTick, refreshSignal) {
        while (isActive) {
            try {
                val sessions = withContext(Dispatchers.IO) {
                    ApiProvider.projection(context).sessions(limit = 200, includeArchived = showArchived)
                }
                val rows = sessions.map { s ->
                    SessionCacheEntity(
                        sessionId = s.id,
                        providerId = s.providerId,
                        nativeId = s.nativeId,
                        sessionMode = s.sessionMode,
                        title = s.title,
                        status = s.status,
                        statusDetail = s.statusDetail,
                        startedAtSec = s.startedAtSec,
                        lastActivityAtSec = s.lastActivityAtSec,
                        endedAtSec = s.endedAtSec,
                        stale = s.stale,
                        cachedAtSec = System.currentTimeMillis() / 1000,
                        providerKey = s.providerKey,
                        providerLabel = s.providerLabel,
                        archived = s.archived,
                        parentSessionId = s.parentSessionId,
                        workdir = s.workdir,
                    )
                }
                withContext(Dispatchers.IO) {
                    if (rows.isEmpty()) db.sessionCacheDao().clear() else {
                        db.sessionCacheDao().upsertAll(rows)
                        db.sessionCacheDao().deleteExcept(rows.map { it.sessionId })
                    }
                }
                error = null
            } catch (err: ApiError) {
                error = com.devhub.mobile.core.ErrorPresent.api(err.code, err.message)
            } catch (err: IOException) {
                error = com.devhub.mobile.core.ErrorPresent.io(err).let {
                    // 离线时列表仍显示 Room 缓存（既有语义），人话点明
                    it.copy(headline = "网络不可达（离线显示缓存）")
                }
            } catch (err: Exception) {
                // P0 热修：非 IO/非 ApiError 的未预期异常（坏响应解析等）绝不崩 UI 协程
                //（进程闪退）——ErrorPresent.io else 分支=通用人话+原异常收进 technical。
                error = com.devhub.mobile.core.ErrorPresent.io(err)
            }
            loading = false
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    val allSessions by db.sessionCacheDao().observeAll().collectAsState(initial = emptyList())
    // UX-P2（docs/26 §3.1/§6-P2）：列表行最近消息预览——Room 尾条一次查齐（GROUP BY 预聚合，
    // 避免每行子查询；数据面零新接口）
    val lastMessages by db.messageCacheDao().observeLastMessages().collectAsState(initial = emptyList())
    val previewBySession = remember(lastMessages) {
        lastMessages.associate { it.sessionId to SessionListOps.rowPreview(it.contentRedacted) }
    }
    // T1 批：智能条目行（固定保留标题）——卡片 stale 兜底点击的导航键
    val wsEntries by db.remoteWorkspaceEntryDao().observeAll().collectAsState(initial = null)
    val smartEntryId = wsEntries?.firstOrNull { it.title == WorkspaceLinkCard.ENTRY_TITLE }?.id
    // T1 批：进入会话页自动取链一次（沿用 tab 时代节奏；Requesting 中幂等去抖在控制器）
    LaunchedEffect(Unit) {
        WorkspaceLinkController.request()
    }
    val visible = allSessions
        .filter { it.parentSessionId == null } // 子会话不出现在默认列表（R2 保留 8442e9d 意图）
        .filter { SessionListOps.isVisible(it.archived, showArchived) }
        .filter { SessionListOps.matchesProvider(it.providerId, selectedProviderId) }

    // —— UX-Z2 结构层（docs/28 §4）：段控/新建页状态 + 工作区分组 ——
    // 分组口径（§4.2）：主会话 + 未归档（与最近对话缺省一致）；workdir 归一键，
    // 缺失归「未分组」组尾部；组间最近活动降序（core.WorkspaceGrouping 单测锁定）
    var segment by rememberSaveable { mutableStateOf("recent") } // recent | workspaces
    var showComposer by rememberSaveable { mutableStateOf(false) }
    var expandedGroups by rememberSaveable { mutableStateOf(setOf<String>()) }
    val workspaceGroups = remember(allSessions) {
        WorkspaceGrouping.group(
            allSessions
                .filter { it.parentSessionId == null }
                .filter { !it.archived }
                .map {
                    WorkspaceGrouping.SessionRef(
                        sessionId = it.sessionId,
                        workdir = it.workdir,
                        lastActivityAtSec = it.lastActivityAtSec ?: it.startedAtSec,
                        title = it.title,
                        status = it.status,
                    )
                },
        )
    }
    val spawnTargetId = remember(agents, fixtureOn) { autoSpawnTargetId(agents, fixtureOn) }
    // 助手页「开始对话」跳转（autoOpenSpawn 机制复用，跨 tab 一次性语义）：
    // 名单就绪且可对话目标存在 → 打开新建页（输入框聚焦由 NewChatScreen 消费）
    LaunchedEffect(autoOpenComposer, spawnTargetId) {
        if (autoOpenComposer && spawnTargetId != null) {
            showComposer = true
        }
    }

    // —— composer-first 新建页（P3 升级迁移载体）：占据本 tab 主面，「+」动线/空态
    // CTA/助手页跳转进入；关闭即回到段控视图 ——
    if (showComposer) {
        NewChatScreen(
            agents = agents,
            fixtureOn = fixtureOn,
            focusOnOpen = autoOpenComposer,
            onFocusConsumed = onAutoComposerConsumed,
            onOpenSession = onOpenSession,
            onClose = { showComposer = false },
        )
        return
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("对话", style = MaterialTheme.typography.titleLarge) // UX-P1 S1
            Spacer(Modifier.width(8.dp))
            Text("${visible.size}", fontSize = 13.sp)
            Spacer(Modifier.weight(1f))
            // UX-Z2（docs/28 §4.3 E2f）：「+ 新对话」动线——仅存在可对话（managed 且非
            // 演示）助手时出现（canSpawnManagedSession 门，绝不假开）；composer-first 页
            if (spawnTargetId != null) {
                Text(
                    "＋ 新对话",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .clickable { showComposer = true }
                        .padding(horizontal = 6.dp, vertical = 4.dp),
                )
            }
        }
        if (fixtureOn) {
            // UX-P1 S3：演示模式标注不弱化（琥珀底保留；夹具/批次号工程语退役）
            Text(
                "演示模式：显示的是示例数据，不是你的电脑",
                fontSize = 11.sp,
                color = Color(0xFF7A4F00),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp)
                    .background(Color(0xFFFFF8E1)),
            )
        }
        Spacer(Modifier.height(4.dp))

        // —— T1 批：ZCode 工作区智能卡（列表顶部；独立 tab 撤销后的遥控主入口）——
        // 点击 → 取/建智能条目 → remote/{entryId}；管理入口（小图标）→ 条目管理屏
        // U5 批的 displayState 投影随 X-L 反转（docs/18 §5.3.2）退役：控制器状态直通卡片
        //（local 模式全流转，失败走 Unavailable 结构化面；relay/fixture 原状零改写）。
        val linkState by WorkspaceLinkController.state.collectAsState()
        WorkspaceLinkCardView(
            state = linkState,
            staleEntryId = smartEntryId,
            onOpen = { id -> onOpenRemoteEntry(id) },
            onRetry = { WorkspaceLinkController.request() },
            onManage = onManageRemote,
        )
        Spacer(Modifier.height(2.dp))

        // —— UX-P3 唤醒联动：电脑不在线态显性异常出口（琥珀卡=不伪造正常态，红线 #1）——
        // 共享 WakeHostCard 原样接线（六态人话/禁用态/冷却不收窄）；relay 全在线自动隐藏
        if (com.devhub.mobile.ui.components.wakeCardNeeded(activeMode, connected, beacon)) {
            com.devhub.mobile.ui.components.WakeHostCard()
        }

        // —— UX-Z2（docs/28 §4.1）：段控「最近对话｜工作区」——对话 tab 内二分段，
        // 不新增底部标签/一级页（三标签 IA 不动）；默认最近对话 = 现状零回归 ——
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            FilterChip(
                selected = segment == "recent",
                onClick = { segment = "recent" },
                label = { Text("最近对话", fontSize = 12.sp, fontWeight = FontWeight.Medium) },
            )
            FilterChip(
                selected = segment == "workspaces",
                onClick = { segment = "workspaces" },
                label = { Text("工作区", fontSize = 12.sp, fontWeight = FontWeight.Medium) },
            )
        }

        if (segment == "workspaces") {
            // —— 「工作区」段：原生工作区分组卡片（E1 汇总行/E2 卡/E3 相对时间）——
            // WebView 遥控置顶卡并存（上方智能卡，§4.1 职责分离：原生=快览动线，
            // WebView=全功能遥控）；分组键/排序见 core.WorkspaceGrouping（单测锁定）
            when {
                loading -> Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
                error != null && workspaceGroups.isEmpty() ->
                    com.devhub.mobile.ui.components.ErrorPresentation(
                        presentable = error!!,
                        headlinePrefix = "加载失败：",
                    )

                workspaceGroups.isEmpty() ->
                    // 空态（docs/28 §4.3）：一句事实 + 真实存在的动线（+/助手页）
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("电脑上还没有对话。连上电脑后，点右上角「＋ 新对话」或到「助手」开始第一个对话", fontSize = 13.sp)
                        Button(onClick = onGoAgentsStart) { Text("去助手看看") }
                    }

                else -> LazyColumn {
                    item {
                        Text(
                            "${workspaceGroups.size} 个工作区 · ${workspaceGroups.sumOf { it.sessions.size }} 个对话",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 4.dp),
                        )
                    }
                    items(workspaceGroups, key = { it.key ?: "__ungrouped__" }) { group ->
                        WorkspaceCard(
                            group = group,
                            expanded = (group.key ?: "__ungrouped__") in expandedGroups,
                            onToggle = {
                                val k = group.key ?: "__ungrouped__"
                                expandedGroups = if (k in expandedGroups) expandedGroups - k else expandedGroups + k
                            },
                            onOpenSession = onOpenSession,
                            onNewChat = { showComposer = true },
                            canNewChat = spawnTargetId != null,
                        )
                    }
                }
            }
        } else {
        // —— R4 provider 过滤 chips（全部 + /v1/agents 名录）——
        // U2-M5（AUDIT P3#8）：横向滚动两端 24dp 渐隐 falloff——截断的 chip 有视觉收口提示，
        // 不再「第 5 枚只露一角」生硬截断（遮罩为纯绘制层，不拦触摸）。
        Box(Modifier.fillMaxWidth()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                item {
                    FilterChip(
                        selected = selectedProviderId == null,
                        onClick = { selectedProviderId = null },
                        label = { Text("全部", fontSize = 12.sp) },
                    )
                }
                items(agents, key = { it.id }) { agent ->
                    val spec = ProviderPalette.resolve(null, agent.displayName)
                    FilterChip(
                        selected = selectedProviderId == agent.id,
                        onClick = { selectedProviderId = if (selectedProviderId == agent.id) null else agent.id },
                        label = { Text(agent.displayName, fontSize = 12.sp) },
                        leadingIcon = {
                            androidx.compose.foundation.layout.Box(
                                Modifier
                                    .size(10.dp)
                                    .background(Color(spec.argb), CircleShape),
                            )
                        },
                    )
                }
            }
            val fadeBg = MaterialTheme.colorScheme.background
            Box(Modifier.matchParentSize()) {
                Box(
                    Modifier
                        .fillMaxHeight()
                        .width(24.dp)
                        .align(Alignment.CenterStart)
                        .background(androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(fadeBg, Color.Transparent))),
                )
                Box(
                    Modifier
                        .fillMaxHeight()
                        .width(24.dp)
                        .align(Alignment.CenterEnd)
                        .background(androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(Color.Transparent, fadeBg))),
                )
            }
        }
        // —— R3 显示归档开关 ——
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
            Text("显示已归档", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) // UX-P1 S4
            Spacer(Modifier.width(4.dp))
            Switch(
                checked = showArchived,
                onCheckedChange = { showArchived = it },
                modifier = Modifier.height(26.dp),
            )
            Spacer(Modifier.weight(1f))
            actionError?.let {
                com.devhub.mobile.ui.components.ErrorPresentation(presentable = it)
            }
        }

        when {
            loading -> Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
            error != null && visible.isEmpty() ->
                com.devhub.mobile.ui.components.ErrorPresentation(
                    presentable = error!!,
                    headlinePrefix = "加载失败：",
                )

            // UX-P1 S5 + UX-P3（docs/26 §4.3）：空态 = 一句事实 + 一步动作 CTA
            // （UX-Z2 升级：可对话助手在册 → 直开本 tab 新建页（composer-first 动线，
            // 一步到输入框聚焦）；无 → 仍去「助手」页（能力披露+原因卡真实存在））
            visible.isEmpty() -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "这里会显示电脑上的 AI 对话。还没有内容——先确认电脑在线（看顶部状态）",
                    fontSize = 13.sp,
                )
                if (spawnTargetId != null) {
                    Button(onClick = { showComposer = true }) { Text("开始第一个对话") }
                } else {
                    Button(onClick = onGoAgentsStart) { Text("去助手开始第一个对话") }
                }
            }
                else -> LazyColumn {
                    items(visible, key = { it.sessionId }) { session ->
                        SessionRow(
                            session = session,
                            preview = previewBySession[session.sessionId],
                            agents = agents,
                        onOpenSession = onOpenSession,
                        menuExpanded = menuFor?.sessionId == session.sessionId,
                        onMenuChange = { expanded -> menuFor = if (expanded) session else null },
                        onArchive = {
                            scope.launch {
                                runCatching { withContext(Dispatchers.IO) { ApiProvider.projection(context).archive(session.sessionId) } }
                                    .onFailure {
                                        actionError = com.devhub.mobile.core.ErrorPresent.Presentable(
                                            "归档没成功，请重试", it.toString(),
                                        )
                                    }
                                refreshTick++
                            }
                        },
                        onUnarchive = {
                            scope.launch {
                                runCatching { withContext(Dispatchers.IO) { ApiProvider.projection(context).unarchive(session.sessionId) } }
                                    .onFailure {
                                        actionError = com.devhub.mobile.core.ErrorPresent.Presentable(
                                            "取消归档没成功，请重试", it.toString(),
                                        )
                                    }
                                refreshTick++
                            }
                        },
                        onRequestDelete = { confirmDelete = session },
                    )
                }
            }
        }
        }
    }

    // R3 删除二次确认（文案写明仅移除 DevHub 记录）
    confirmDelete?.let { target ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("删除对话", fontWeight = FontWeight.SemiBold) }, // UX-P1（会话→对话改名）
            text = { Text(SessionListOps.deleteConfirmText(
            // 打磨批 D：确认弹窗属显示层，标题同样清理 ** 记号
            com.devhub.mobile.core.RichTextTokenizer.stripDisplayMarkers(target.title),
        ), fontSize = 13.sp) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmDelete = null
                        scope.launch {
                            runCatching { withContext(Dispatchers.IO) { ApiProvider.projection(context).deleteSession(target.sessionId) } }
                                .onFailure {
                                    actionError = com.devhub.mobile.core.ErrorPresent.Presentable(
                                        "删除没成功，请重试", it.toString(),
                                    )
                                }
                            refreshTick++
                        }
                    },
                ) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("取消") } },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WorkspaceCard(
    group: WorkspaceGrouping.Group,
    expanded: Boolean,
    onToggle: () -> Unit,
    onOpenSession: (Long) -> Unit,
    onNewChat: () -> Unit,
    canNewChat: Boolean,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f), RoundedCornerShape(12.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        // —— 卡头（E2）：类型图标（本地文件夹恒定，无远程工作区语义不画 tag——E2b C 档）
        // + 名称 + 路径（中段省略）+「N 个对话」+「更新于 X」（E3 相对时间）+ chevron ——
        Row(
            Modifier
                .fillMaxWidth()
                .clickable { onToggle() },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("📁", fontSize = 16.sp)
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    group.name ?: "未分组",
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                group.path?.let { path ->
                    Text(
                        // 中段省略纪律（RemoteWorkspaceUrl.elideMiddle 先例）
                        RemoteWorkspaceUrl.elideMiddle(path, head = 22, tail = 8),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text("${group.sessions.size} 个对话", fontSize = 12.sp)
                Text(
                    listOf("更新于", TimeFmt.rel(group.lastActivityAtSec, System.currentTimeMillis()))
                        .filter { it.isNotBlank() }
                        .joinToString(" "),
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.width(6.dp))
            Text(if (expanded) "▾" else "▸", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // —— chevron 展开：组内对话行（标题 + 状态角标 + 相对时间；点行进详情=既有路由）——
        if (expanded) {
            Spacer(Modifier.height(4.dp))
            group.sessions.forEach { s ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onOpenSession(s.sessionId) }
                        .padding(horizontal = 4.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            com.devhub.mobile.core.RichTextTokenizer.stripDisplayMarkers(s.title) ?: "未命名对话",
                            fontSize = 13.sp,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                        )
                        Text(
                            TimeFmt.rel(s.lastActivityAtSec, System.currentTimeMillis()),
                            fontSize = 10.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.width(6.dp))
                    StatusBadge(s.status)
                }
            }
            // —— 「+ 新对话」（E2f）：v1 语义 = 新建对话（不带工作区绑定，C 档不做）；
            // canNewChat=false（无 managed/演示）不画（假可供性红线）——
            if (canNewChat) {
                Text(
                    "＋ 新对话",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .clickable { onNewChat() }
                        .padding(horizontal = 4.dp, vertical = 6.dp),
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRow(
    session: SessionCacheEntity,
    preview: String?,
    agents: List<AgentDto>,
    onOpenSession: (Long) -> Unit,
    menuExpanded: Boolean,
    onMenuChange: (Boolean) -> Unit,
    onArchive: () -> Unit,
    onUnarchive: () -> Unit,
    onRequestDelete: () -> Unit,
) {
    val highlight = StatusColors.highlight(session.status)

    Box(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp)
                // 打磨批 D：waiting 高亮底改为深色琥珀容器（钉深色主题后原浅黄底与
                // 主题默认浅色文字对比失效）；边框保持琥珀高亮语义（QQ 待办高亮，docs/24 §6）。
                .background(if (highlight) Color(0xFF3B2F00) else Color.Transparent)
                .border(
                    width = if (highlight) 1.dp else 0.dp,
                    color = if (highlight) Color(0xFFFFB300) else Color.Transparent,
                )
                .combinedClickable(
                    onClick = { onOpenSession(session.sessionId) },
                    onLongClick = { onMenuChange(true) }, // R3 长按菜单
                )
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // —— UX-P2 微信聊天列表行形态（docs/26 §3.1）：行 1 = 头像+标题+时间 ——
            Row(verticalAlignment = Alignment.CenterVertically) {
                // R4 固定色板 + 首字母徽标（替换 provider #N 文案）
                val resolvedLabel = session.providerLabel
                    ?: if (session.providerKey == null) agents.firstOrNull { it.id == session.providerId }?.displayName else null
                ProviderAvatarFor(providerKey = session.providerKey, providerLabel = resolvedLabel, size = 30.dp)
                Spacer(Modifier.width(8.dp))
                Text(
                    // 打磨批 D：显示层清理 ** 记号（不改数据）；超长标题单行省略号截断
                    com.devhub.mobile.core.RichTextTokenizer.stripDisplayMarkers(session.title)
                        ?: "未命名对话", // UX-P1 D1
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                Text(
                    TimeFmt.listTime(session.lastActivityAtSec ?: session.startedAtSec, System.currentTimeMillis()),
                    fontSize = 11.sp,
                    color = Color(0xFF757575),
                )
            }
            // —— 行 2 = 预览（observed/attached 模式副文案降级至此，X2 徽章隐藏）+ 状态角标 ——
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    listOfNotNull(
                        preview ?: when (session.sessionMode) {
                            "observed" -> "仅查看" // X2：session_mode 徽章列表行隐藏 → 副文案诚实降级
                            "attached" -> "电脑上接入"
                            else -> null
                        },
                        if (session.stale) "信息可能不是最新" else null, // UX-P1 S7（降为副文案，不再占徽章位）
                        if (session.archived) "已归档" else null,
                    ).joinToString(" · ").ifEmpty { " " },
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                // 一行一状态：9 值人话角标（waiting/approval 高亮=QQ 待办；U1-M2 observed
                // 锁定语义经 StatusBadge 内 InteractionHonesty.waitingInputBadge 保留，不回退）
                StatusBadge(session.status, sessionMode = session.sessionMode)
            }
        }
        // R3 长按菜单
        DropdownMenu(expanded = menuExpanded, onDismissRequest = { onMenuChange(false) }) {
            val actions = SessionListOps.rowActions(session.archived)
            if (actions.archive) {
                DropdownMenuItem(
                    text = { Text("归档") },
                    onClick = { onMenuChange(false); onArchive() },
                )
            }
            if (actions.unarchive) {
                DropdownMenuItem(
                    text = { Text("取消归档") },
                    onClick = { onMenuChange(false); onUnarchive() },
                )
            }
            DropdownMenuItem(
                text = { Text("删除（仅移除手机里的记录）", color = MaterialTheme.colorScheme.error) }, // UX-P1 S9
                onClick = { onMenuChange(false); onRequestDelete() },
            )
        }
    }
}
