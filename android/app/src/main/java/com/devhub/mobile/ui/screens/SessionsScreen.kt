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
import androidx.compose.material3.AlertDialog
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
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.WorkspaceLinkCard
import com.devhub.mobile.connect.WorkspaceLinkController
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.SessionCacheEntity
import com.devhub.mobile.data.remote.AgentDto
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.ui.components.ModeBadge
import com.devhub.mobile.ui.components.ProviderAvatarFor
import com.devhub.mobile.ui.components.StatusBadge
import com.devhub.mobile.ui.components.StatusColors
import com.devhub.mobile.ui.components.WorkspaceLinkCardView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * 页面 4：会话列表（GET /v1/sessions，docs/14 §B.1；体验整改批 B 增强）。
 * - R4：行首固定色板 + 首字母徽标；`provider #N` → providerLabel；顶部 provider 过滤 chips（数据 /v1/agents）；
 * - R3：行**长按**菜单（归档/取消归档/删除 + 二次确认，文案写明"仅移除 DevHub 记录"）；「显示归档」开关（includeArchived=1）；
 * - 9 值状态徽章 / waiting 高亮 / stale 标注 / observed 整行标注（现状保持）；
 * - 夹具模式（显式开关）：数据驱动自本地夹具，显著标注"演示数据"。
 *
 * T1 批（ZCode 遥控合并进会话流）：列表顶部加「ZCode 工作区」智能卡
 * （复用 WorkspaceLinkCardView / WorkspaceLinkController，沿用原 tab 的取链节奏——
 * 进入本屏自动请求一次、Requesting 幂等去抖；点击 → 取/建智能条目 → remote/{entryId}；
 * 卡上管理入口（小图标）→ 条目管理屏，手工 URL 条目功能不丢）。
 */
@Composable
fun SessionsScreen(
    onOpenSession: (Long) -> Unit,
    onOpenRemoteEntry: (Long) -> Unit = {},
    onManageRemote: () -> Unit = {},
) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()

    var fixtureOn by remember { mutableStateOf(FixtureMode.enabled(context)) }
    var showArchived by rememberSaveable { mutableStateOf(false) }
    var selectedProviderId by rememberSaveable { mutableStateOf<Long?>(null) }
    var agents by remember { mutableStateOf<List<AgentDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    // U1-M3（AUDIT P1#3）：错误统一呈现体（人话+技术细节折叠），不再直出原码
    var error by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
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
            }
            loading = false
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    val allSessions by db.sessionCacheDao().observeAll().collectAsState(initial = emptyList())
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

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("会话", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.width(8.dp))
            Text("${visible.size}", fontSize = 13.sp)
            Spacer(Modifier.weight(1f))
            Text(
                text = if (fixtureOn) "演示数据·开" else "演示数据·关",
                fontSize = 11.sp,
                color = if (fixtureOn) Color(0xFF7A4F00) else Color(0xFF757575),
                modifier = Modifier
                    .clickable {
                        val next = !fixtureOn
                        FixtureMode.setEnabled(context, next)
                        // 切换数据源：清空缓存，防真实/夹具数据混排
                        scope.launch { withContext(Dispatchers.IO) {
                            db.sessionCacheDao().clear()
                            db.messageCacheDao().clear()
                        } }
                        fixtureOn = next
                        refreshTick++
                    }
                    .padding(4.dp),
            )
        }
        if (fixtureOn) {
            Text(
                "演示数据（夹具）· 非真实 Gateway — 端到端验收归批次 C",
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
        val linkState by WorkspaceLinkController.state.collectAsState()
        WorkspaceLinkCardView(
            state = linkState,
            staleEntryId = smartEntryId,
            onOpen = { id -> onOpenRemoteEntry(id) },
            onRetry = { WorkspaceLinkController.request() },
            onManage = onManageRemote,
        )
        Spacer(Modifier.height(2.dp))

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
            Text("显示归档", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(4.dp))
            Switch(
                checked = showArchived,
                onCheckedChange = { showArchived = it },
                modifier = Modifier.height(26.dp),
            )
            Spacer(Modifier.weight(1f))
            actionError?.let { Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.error) }
        }

        when {
            loading -> Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
            error != null && visible.isEmpty() ->
                com.devhub.mobile.ui.components.ErrorPresentation(
                    presentable = error!!,
                    headlinePrefix = "加载失败：",
                )

            visible.isEmpty() -> Text("暂无会话（监控管线未产生会话或 Gateway 未连接）", fontSize = 13.sp)
            else -> LazyColumn {
                items(visible, key = { it.sessionId }) { session ->
                    SessionRow(
                        session = session,
                        agents = agents,
                        onOpenSession = onOpenSession,
                        menuExpanded = menuFor?.sessionId == session.sessionId,
                        onMenuChange = { expanded -> menuFor = if (expanded) session else null },
                        onArchive = {
                            scope.launch {
                                runCatching { withContext(Dispatchers.IO) { ApiProvider.projection(context).archive(session.sessionId) } }
                                    .onFailure { actionError = "归档失败：${it.message}" }
                                refreshTick++
                            }
                        },
                        onUnarchive = {
                            scope.launch {
                                runCatching { withContext(Dispatchers.IO) { ApiProvider.projection(context).unarchive(session.sessionId) } }
                                    .onFailure { actionError = "取消归档失败：${it.message}" }
                                refreshTick++
                            }
                        },
                        onRequestDelete = { confirmDelete = session },
                    )
                }
            }
        }
    }

    // R3 删除二次确认（文案写明仅移除 DevHub 记录）
    confirmDelete?.let { target ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("删除会话", fontWeight = FontWeight.SemiBold) },
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
                                .onFailure { actionError = "删除失败：${it.message}" }
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
private fun SessionRow(
    session: SessionCacheEntity,
    agents: List<AgentDto>,
    onOpenSession: (Long) -> Unit,
    menuExpanded: Boolean,
    onMenuChange: (Boolean) -> Unit,
    onArchive: () -> Unit,
    onUnarchive: () -> Unit,
    onRequestDelete: () -> Unit,
) {
    val highlight = StatusColors.highlight(session.status)
    val providerLabel = session.providerLabel
        ?: agents.firstOrNull { it.id == session.providerId }?.displayName
        ?: "provider #${session.providerId}"

    Box(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp)
                // 打磨批 D：waiting 高亮底改为深色琥珀容器（钉深色主题后原浅黄底与
                // 主题默认浅色文字对比失效）；边框保持琥珀高亮语义。
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                // R4 固定色板 + 首字母徽标（替换 provider #N 文案）
                val resolvedLabel = session.providerLabel
                    ?: if (session.providerKey == null) agents.firstOrNull { it.id == session.providerId }?.displayName else null
                ProviderAvatarFor(providerKey = session.providerKey, providerLabel = resolvedLabel, size = 30.dp)
                Spacer(Modifier.width(8.dp))
                Text(
                    // 打磨批 D：显示层清理 ** 记号（不改数据）；超长标题单行省略号截断
                    com.devhub.mobile.core.RichTextTokenizer.stripDisplayMarkers(session.title)
                        ?: "会话 #${session.sessionId}",
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                // U1-M2（AUDIT P1#2）：observed 会话 waiting_input 徽章锁定语义（列表面）
                StatusBadge(session.status, sessionMode = session.sessionMode)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ModeBadge(session.sessionMode) // observed 整行标注（左 chip 一处；行尾重复文字已去除）
                if (session.stale) {
                    Text("数据过期（stale）", fontSize = 11.sp, color = Color(0xFFC7A008))
                }
                Text(providerLabel, fontSize = 11.sp, color = Color(0xFF757575))
                if (session.archived) {
                    Text("已归档", fontSize = 11.sp, color = Color(0xFF757575))
                }
                Spacer(Modifier.weight(1f))
                // 打磨批 D：去掉行尾重复的「observed 只读」文字（与行首 ModeBadge chip 重复）；
                // 保留左侧 chip 一处（信息密度更好，色板徽章一眼可辨）。
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
                text = { Text("删除（仅移除 DevHub 记录）", color = MaterialTheme.colorScheme.error) },
                onClick = { onMenuChange(false); onRequestDelete() },
            )
        }
    }
}
