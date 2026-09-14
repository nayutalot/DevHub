package com.devhub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.core.ErrorPresent
import com.devhub.mobile.core.IdempotencyKeys
import com.devhub.mobile.core.InteractionHonesty
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ConnState
import com.devhub.mobile.connect.ManagedSpawnSubmit
import com.devhub.mobile.connect.WorkspaceLinkCard
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.remote.AgentDto
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.ui.components.HealthBadge
import com.devhub.mobile.ui.components.ZcodeRemoteOpenButton
import com.devhub.mobile.ui.components.wakeCardNeeded
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/** 托管任务输入上限（与服务端 MANAGED_SESSION_TASK_MAX_CHARS 对齐）。 */
private const val SPAWN_TASK_MAX_CHARS = 4_000

/**
 * UX-P3（docs/briefs/uxp3-flows.md §1.2 funnel）：自动展开「开始对话」面板的目标
 * 纯判定（:app 单测直锁）——首个可对话（managed 且非演示）的助手；无可对话助手 →
 * null（绝不伪造入口，A4 教训：页面无该功能不得画按钮）。
 */
internal fun autoSpawnTargetId(agents: List<AgentDto>, fixtureOn: Boolean): Long? =
    agents.firstOrNull { InteractionHonesty.canSpawnManagedSession(it.capabilities.mode, fixtureOn) }?.id

/**
 * 页面 3：Agent 列表（GET /v1/agents，docs/14 §B.1；体验整改批 C 交互诚实化）。
 * - R6.1：managed provider 卡文案 =「托管会话可交互；外部会话只读」（能力是会话级的，
 *   展示必须如实；不再把 provider 级 granted 列表渲染成"现在就能交互"）；
 * - R6.2：对 managed provider（现 = codex，数据驱动判定，绝不硬编码）显示
 *   「启动托管会话」→ POST /v1/providers/{id}/sessions（202）→ 跳入新会话详情，
 *   reply/pause/resume 真实可用；夹具演示模式一律不给按钮（绝不伪造控制通道）；
 * - R7.1/R7.2：observed provider 行显示 per-provider 原因卡（文案与
 *   docs/known-limitations.md §1 一致），只展示会话级真实可用动作——不可用的
 *   绝不显示为可点；
 * - T1 批：zcode provider 卡加「打开遥控」动作（数据驱动
 *   InteractionHonesty.isZcodeDisplayEntry；与「启动托管会话」视觉同层、文案区分，
 *   注明控制经 ZCode 自家认证遥控页；observed 原因卡保持——DevHub 原生控制仍不可用）。
 *
 * UX-P3 开始对话一键化：autoOpenSpawn=true 时（对话页空态 CTA「去助手开始第一个对话」
 * 一步带入）首个可对话助手卡自动展开内联输入框并聚焦（键盘弹起）；无可对话助手不展开
 * （诚实纪律）。onAutoSpawnConsumed 在名单就绪消费一次，防重复展开。
 */
@Composable
fun AgentsScreen(
    onOpenSession: (Long) -> Unit = {},
    onOpenRemoteEntry: (Long) -> Unit = {},
    onOpenConnectionStatus: () -> Unit = {},
    autoOpenSpawn: Boolean = false,
    onAutoSpawnConsumed: () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var agents by remember { mutableStateOf<List<AgentDto>?>(null) }
    // U1-M3/UX-P1（A2/A3）：错误统一呈现体（人话 headline + 原始异常/错误码收「技术细节」折叠）
    var error by remember { mutableStateOf<ErrorPresent.Presentable?>(null) }
    val fixtureOn = remember { FixtureMode.enabled(context) }
    // UX-P2：唤醒卡条件置顶判定输入（docs/26 §3.2：电脑不在线且云端连接已连上时出现）
    val connState by ConnectionManager.state.collectAsState()
    val activeMode by ConnectionManager.activeMode.collectAsState()
    val beacon by ConnectionManager.upstreamBeacon.collectAsState()
    val connected = connState is ConnState.Connected

    // R5.3：事件驱动为主（refreshSignal 变化即立即拉取）+ 120s 低频兜底（原 2s 轮询退役）
    val refreshSignal by ConnectionManager.refreshSignal.collectAsState()
    LaunchedEffect(refreshSignal) {
        while (isActive) {
            try {
                agents = withContext(Dispatchers.IO) { ApiProvider.rest(context).agents() }
                error = null
            } catch (err: ApiError) {
                error = ErrorPresent.api(err.code, err.message)
            } catch (err: IOException) {
                error = ErrorPresent.io(err)
            } catch (err: Exception) {
                // P0 热修：未预期异常绝不容 UI 协程崩进程（通用人话，原异常收 technical 不吞码）
                error = ErrorPresent.io(err)
            }
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Text("AI 助手", style = MaterialTheme.typography.titleLarge) // UX-P1 A1
        Spacer(Modifier.height(4.dp))
        // RW1：relay 分支连接区「唤醒电脑」（本地模式不渲染——wake 是 relay 原生能力）。
        // UX-P2（docs/26 §3.2）：条件置顶——仅 relay 且电脑未确认在线时出现
        //（全在线时隐藏，减少常态噪音；六态人话与禁用态经 wakeCardNeeded 不收窄）。
        if (wakeCardNeeded(activeMode, connected, beacon)) {
            com.devhub.mobile.ui.components.WakeHostCard()
        }
        val list = agents
        // UX-P3：autoOpenSpawn 消费（名单就绪才消费一次；消费后父层翻回 false）
        val autoTargetId = remember(list, autoOpenSpawn) {
            if (autoOpenSpawn && list != null) autoSpawnTargetId(list, fixtureOn) else null
        }
        LaunchedEffect(list, autoOpenSpawn) {
            if (autoOpenSpawn && list != null) onAutoSpawnConsumed()
        }
        when {
            list == null && error == null -> Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
            list == null -> com.devhub.mobile.ui.components.ErrorPresentation(
                presentable = error!!,
                headlinePrefix = "加载失败：",
            )
            // UX-P1 A4 + UX-P3（docs/26 §4.3）：空态 = 一句事实 + 一步动作
            //（诊断出口指向真实存在的「电脑连接状态」页；本页事件驱动自动刷新，
            // 无手工重扫功能 → 绝不画「重新扫描」假按钮，A4 教训）
            list.isEmpty() -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "这里会显示电脑上的 AI 助手。还没有内容——请确认电脑在线、DevHub 正在运行，连上后会自动刷新",
                    fontSize = 13.sp,
                )
                Button(onClick = onOpenConnectionStatus) { Text("诊断连接问题") }
            }
            else -> LazyColumn {
                items(list, key = { it.id }) { agent ->
                    ProviderCard(
                        agent = agent,
                        fixtureOn = fixtureOn,
                        onOpenSession = onOpenSession,
                        onOpenRemoteEntry = onOpenRemoteEntry,
                        autoOpen = agent.id == autoTargetId,
                    )
                }
            }
        }
    }
}

@Composable
private fun ProviderCard(
    agent: AgentDto,
    fixtureOn: Boolean,
    onOpenSession: (Long) -> Unit,
    onOpenRemoteEntry: (Long) -> Unit = {},
    autoOpen: Boolean = false,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // 展开状态（启动面板）只属于单卡：按 agent.id 记忆
    var spawnPanelOpen by remember(agent.id) { mutableStateOf(false) }
    var spawnTask by remember(agent.id) { mutableStateOf("") }
    var spawnBusy by remember(agent.id) { mutableStateOf(false) }
    // UX-P1（A16-A21）：提交回执 = 人话 headline + 技术原值（commandId/status/异常）收折叠
    var spawnStatus by remember(agent.id) { mutableStateOf<ErrorPresent.Presentable?>(null) }
    // 拒绝走 ErrorPresentation（错误语义 + 「技术细节」折叠）
    var spawnError by remember(agent.id) { mutableStateOf<ErrorPresent.Presentable?>(null) }
    // UX-P3 一键化：输入框聚焦请求器（面板展开即键盘弹起，直接说事）
    val spawnFocusRequester = remember { FocusRequester() }

    val isManaged = agent.capabilities.mode == InteractionHonesty.MODE_MANAGED
    val canSpawn = InteractionHonesty.canSpawnManagedSession(agent.capabilities.mode, fixtureOn)

    // UX-P3：对话页空态 CTA 带入的自动展开（仅首个可对话助手；名单/门不满足绝不展开）
    LaunchedEffect(autoOpen) {
        if (autoOpen && canSpawn && !spawnPanelOpen) {
            spawnPanelOpen = true
            spawnStatus = null
            spawnError = null
        }
    }
    // UX-P3：面板展开（手动点按钮或自动带入）即聚焦输入框（键盘弹起，一键化动线）
    LaunchedEffect(spawnPanelOpen) {
        if (spawnPanelOpen) {
            kotlinx.coroutines.delay(150) // 等面板完成布局组合再请求焦点
            runCatching { spawnFocusRequester.requestFocus() }
        }
    }
    // R7.1：observed 原因卡（displayName 匹配；未知 → null → 通用兜底）
    val observedReason = if (!isManaged) {
        InteractionHonesty.observedReason(providerKey = null, displayName = agent.displayName)
    } else {
        null
    }
    // T1 批：zcode 卡「打开遥控」展示入口（displayName 数据驱动；/v1/agents 投影无 providerKey）
    val isZcode = InteractionHonesty.isZcodeDisplayEntry(providerKey = null, displayName = agent.displayName)

    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(agent.displayName, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            Spacer(Modifier.width(8.dp))
            HealthBadge(agent.health)
        }
        // UX-P2（docs/24 §2.1/§3.2 + docs/26 §3.2）：capabilities 二态主显示
        //「● 可以对话 / ○ 仅查看」——managed/attached(有授权)→可以对话，
        // observed/未授权/未知→仅查看（InteractionHonesty.capabilityDuality 纯判定，
        // 红线「不可用不显示为可用」；attached 细节与译名「电脑上接入」进 ⓘ 弹层）。
        val duality = InteractionHonesty.capabilityDuality(agent.capabilities.mode, agent.capabilities.granted)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                text = if (duality == InteractionHonesty.CapabilityDuality.CAN_TALK) {
                    "● " + InteractionHonesty.DUALITY_CAN_TALK_LABEL
                } else {
                    "○ " + InteractionHonesty.DUALITY_VIEW_ONLY_LABEL
                },
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = if (duality == InteractionHonesty.CapabilityDuality.CAN_TALK) {
                    Color(0xFF1B5E20)
                } else {
                    Color(0xFF7A4F00)
                },
                modifier = Modifier
                    .background(
                        if (duality == InteractionHonesty.CapabilityDuality.CAN_TALK) Color(0xFFDDEBDD) else Color(0xFFFFF3E0),
                        RoundedCornerShape(6.dp),
                    )
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            )
            Text(
                when {
                    isManaged -> InteractionHonesty.MANAGED_PROVIDER_NOTE // R6.1 诚实文案（H1 人话化）
                    agent.capabilities.granted.isEmpty() -> InteractionHonesty.EMPTY_GRANTED_NOTE // H7
                    // UX-P1 A15：granted 令牌直出退役 → core 译码（可执行：回复、暂停…）
                    else -> com.devhub.mobile.core.CapabilitiesExplain.grantedLabel(agent.capabilities.granted)
                },
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant, // 打磨批 D：深色主题下灰字升为主题次级色
            )
        }

        // R7.1：per-provider observed 原因卡（文案 = known-limitations §1；未知 provider 回退通用文案）
        if (!isManaged) {
            Text(
                observedReason ?: InteractionHonesty.GENERIC_OBSERVED_NOTE,
                fontSize = 11.sp,
                color = Color(0xFF7A4F00),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFFFF8E1), RoundedCornerShape(8.dp))
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }

        // T1 批：zcode 卡「打开遥控」动作（与「启动托管会话」视觉同层、文案区分；
        // observed 原因卡保持——DevHub 原生 reply/pause/resume 仍不可用，控制走 ZCode
        // 自家认证遥控页 remote/{entryId}，绝不显示为 DevHub 可控）
        if (isZcode) {
            ZcodeRemoteOpenButton(
                buttonLabel = InteractionHonesty.ZCODE_REMOTE_AGENTS_BUTTON,
                noteText = InteractionHonesty.ZCODE_REMOTE_AGENTS_NOTE,
                staleLookup = {
                    DevHubDb.get(context).remoteWorkspaceEntryDao()
                        .getByTitle(WorkspaceLinkCard.ENTRY_TITLE)?.id
                },
                onOpen = onOpenRemoteEntry,
            )
        }

        // R6.2：启动托管会话（数据驱动门：mode==managed 且非夹具；服务端 L3 二次校验兜底）。
        // UX-P2（docs/26 §3.2）：「开始对话」升为填充主按钮（页内主动作视觉层级）。
        if (canSpawn && !spawnPanelOpen) {
            Button(
                onClick = {
                    spawnPanelOpen = true
                    spawnStatus = null
                    spawnError = null
                },
            ) { Text(InteractionHonesty.SPAWN_BUTTON_LABEL, fontSize = 13.sp) }
        }
        if (spawnPanelOpen) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                // DSW 批（docs/briefs/dsw-workspace.md §1）：生效工作区一行——用户面
                // 可见 agent 在哪读写（桌面端 caps.workspace 携带；缺失/旧端 → 不显示）
                agent.capabilities.workspace?.let { ws ->
                    Text(
                        "工作区：$ws",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                    )
                }
                OutlinedTextField(
                    value = spawnTask,
                    onValueChange = { spawnTask = it.take(SPAWN_TASK_MAX_CHARS) },
                    label = { Text(InteractionHonesty.SPAWN_TASK_LABEL, fontSize = 12.sp) },
                    placeholder = { Text(InteractionHonesty.SPAWN_TASK_PLACEHOLDER) }, // UX-P3 一键化
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(spawnFocusRequester),
                    enabled = !spawnBusy,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(
                        onClick = {
                            val task = spawnTask.trim()
                            if (task.isEmpty() || spawnBusy) return@Button
                            spawnBusy = true
                            spawnStatus = null
                            spawnError = null
                            scope.launch {
                                val message: ErrorPresent.Presentable? = if (ConnectionManager.configuredMode() == "relay") {
                                    // M3-E1（docs/18 §5.3/§10 通道迁移）：relay 模式走 WS command
                                    // spawn_session（REST POST /v1/providers/{id}/sessions 打 ECS
                                    // 必败——§7.2 不开放）；本地模式保持下方 REST 路径零改动。
                                    when (val r = ConnectionManager.submitManagedSpawnRelay(providerId = agent.id, task = task)) {
                                        is ManagedSpawnSubmit.Executed -> {
                                            spawnPanelOpen = false
                                            spawnTask = ""
                                            // 跳入新托管会话详情：reply/pause/resume 会话级真实可用（R6.2）
                                            onOpenSession(r.sessionId)
                                            // UX-P1 A16：commandId 收「技术细节」折叠
                                            ErrorPresent.Presentable("对话已创建", "commandId=${r.commandId}")
                                        }

                                        is ManagedSpawnSubmit.AcceptedNoSession ->
                                            // UX-P1 A17：status/commandId 进折叠
                                            ErrorPresent.Presentable(
                                                "已提交：对话创建中，稍后在「对话」列表出现",
                                                "status=${r.status} · commandId=${r.commandId}",
                                            )

                                        ManagedSpawnSubmit.Queued ->
                                            // UX-P1 A18（排队语义如实，绝不伪成功）
                                            ErrorPresent.Presentable("电脑不在线：已暂存你的请求，它上线后自动开始")

                                        is ManagedSpawnSubmit.Rejected -> {
                                            // UX-P1 A19/H19：人话 headline + 原码进「技术细节」
                                            spawnError = InteractionHonesty.spawnRejection(r.code, r.message)
                                            null
                                        }
                                    }
                                } else {
                                    try {
                                        val started = withContext(Dispatchers.IO) {
                                            ApiProvider.rest(context).startManagedSession(
                                                providerId = agent.id,
                                                task = task,
                                                idempotencyKey = IdempotencyKeys.newKey(),
                                            )
                                        }
                                        val sid = started.sessionId
                                        if (sid != null) {
                                            spawnPanelOpen = false
                                            spawnTask = ""
                                            // 跳入新托管会话详情：reply/pause/resume 会话级真实可用（R6.2）
                                            onOpenSession(sid)
                                            ErrorPresent.Presentable("对话已创建", "commandId=${started.commandId}") // A16
                                        } else {
                                            ErrorPresent.Presentable( // A17
                                                "已提交：对话创建中，稍后在「对话」列表出现",
                                                "status=${started.status} · commandId=${started.commandId}",
                                            )
                                        }
                                    } catch (err: ApiError) {
                                        spawnError = InteractionHonesty.spawnRejection(err.code, err.message) // A19
                                        null
                                    } catch (err: IOException) {
                                        ErrorPresent.Presentable("网络不可用：对话没有创建，请检查网络后再试") // A20
                                    } catch (err: Exception) {
                                        // B1 泛化热修（P0 先例）：提交协程跑在 rememberCoroutineScope
                                        //（主线程无异常处理器）——未预期异常绝不崩 UI 进程；
                                        // spawnBusy 在下方统一复位，按钮不卡死。
                                        ErrorPresent.Presentable("启动出了问题，请重试", err.toString()) // A21
                                    }
                                }
                                spawnBusy = false
                                spawnStatus = message
                            }
                        },
                        enabled = spawnTask.isNotBlank() && !spawnBusy,
                    ) {
                        Text(if (spawnBusy) InteractionHonesty.SPAWN_BUSY_LABEL else InteractionHonesty.SPAWN_CONFIRM_LABEL, fontSize = 13.sp)
                    }
                    TextButton(
                        onClick = { spawnPanelOpen = false; spawnStatus = null },
                        enabled = !spawnBusy,
                    ) { Text(InteractionHonesty.SPAWN_CANCEL_LABEL, fontSize = 13.sp) }
                }
            }
        }
        spawnStatus?.let {
            Text(it.headline, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            it.technical?.let { tech -> com.devhub.mobile.ui.components.TechnicalDetailsFold(tech) }
        }
        spawnError?.let {
            com.devhub.mobile.ui.components.ErrorPresentation(presentable = it)
        }
        if (fixtureOn) {
            // UX-P1 A22：演示模式标注不弱化（琥珀底+事实+不可操作说明；「夹具/批次号」工程语退役）
            Text(
                "演示模式：这里是示例数据，按钮不可操作",
                fontSize = 10.sp,
                color = Color(0xFF7A4F00),
            )
        }
    }
}
