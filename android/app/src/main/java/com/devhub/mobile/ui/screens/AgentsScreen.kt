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
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.core.IdempotencyKeys
import com.devhub.mobile.core.InteractionHonesty
import com.devhub.mobile.core.relay.WakeResultStatus
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ConnState
import com.devhub.mobile.connect.ManagedSpawnSubmit
import com.devhub.mobile.connect.WakeSubmit
import com.devhub.mobile.connect.WorkspaceLinkCard
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.remote.AgentDto
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.ui.components.HealthBadge
import com.devhub.mobile.ui.components.ModeBadge
import com.devhub.mobile.ui.components.ZcodeRemoteOpenButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/** 托管任务输入上限（与服务端 MANAGED_SESSION_TASK_MAX_CHARS 对齐）。 */
private const val SPAWN_TASK_MAX_CHARS = 4_000

/**
 * RW1 wake 本地冷却窗（纯防抖 UX；权威在 relay WAKE_COOLDOWN_S 缺省 15s，docs/18 §3.17）：
 * sent/already_on 后本地禁用 15s；rate_limited 以回传 retryAfterMs 为准。
 */
private const val WAKE_LOCAL_COOLDOWN_MS = 15_000L

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
 */
@Composable
fun AgentsScreen(
    onOpenSession: (Long) -> Unit = {},
    onOpenRemoteEntry: (Long) -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var agents by remember { mutableStateOf<List<AgentDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val fixtureOn = remember { FixtureMode.enabled(context) }

    // R5.3：事件驱动为主（refreshSignal 变化即立即拉取）+ 120s 低频兜底（原 2s 轮询退役）
    val refreshSignal by ConnectionManager.refreshSignal.collectAsState()
    LaunchedEffect(refreshSignal) {
        while (isActive) {
            try {
                agents = withContext(Dispatchers.IO) { ApiProvider.rest(context).agents() }
                error = null
            } catch (err: ApiError) {
                error = "[${err.code}] ${err.message}"
            } catch (err: IOException) {
                error = "网络不可达"
            } catch (err: Exception) {
                // P0 热修：未预期异常绝不容 UI 协程崩进程（诚实人话，不直出栈）
                error = "发生未知错误：请重试（${err.javaClass.simpleName}）"
            }
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Text("Agents", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(4.dp))
        // RW1：relay 分支连接区「唤醒 Windows」（本地模式不渲染——wake 是 relay 原生能力）
        WakeHostCard()
        val list = agents
        when {
            list == null && error == null -> Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
            list == null -> Text("加载失败：$error", color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            list.isEmpty() -> Text("暂无 provider 投影", fontSize = 13.sp)
            else -> LazyColumn {
                items(list, key = { it.id }) { agent ->
                    ProviderCard(
                        agent = agent,
                        fixtureOn = fixtureOn,
                        onOpenSession = onOpenSession,
                        onOpenRemoteEntry = onOpenRemoteEntry,
                    )
                }
            }
        }
    }
}

/**
 * RW1（docs/18 §3.17）：relay 分支连接区「唤醒 Windows」。
 * - 仅 relay 模式渲染（activeMode==relay；本地 REST 模式 = wake 是 relay 原生能力，不渲染）；
 * - WS 非 Connected → 按钮不可用并如实展示「不排队不伪成功」（wake 禁入 QueueReplay）；
 * - 六态文案不美化：disabled=未启用、rate_limited=冷却中、sent=已发出≠已开机、
 *   exec_failed 含 relay 回传 stderrSummary（relay 侧已脱敏截断）；
 * - App 侧 20s 等待窗超时与 relay timeout 态同文案，绝不谎报 sent；
 * - 冷却倒计时纯本地防抖（权威在 relay）：sent/already_on → 15s，rate_limited → retryAfterMs；
 * - loading / disabled / 结果三态强制，数据全部来自真实 ConnectionManager 面（零 mock）。
 */
@Composable
private fun WakeHostCard() {
    val scope = rememberCoroutineScope()
    val connState by ConnectionManager.state.collectAsState()
    val activeMode by ConnectionManager.activeMode.collectAsState()

    // 本地模式（REST）不渲染该卡（设计裁决 3：wake 是 relay 原生能力）
    if (activeMode != "relay") return

    var busy by remember { mutableStateOf(false) }
    var statusText by remember { mutableStateOf<String?>(null) }
    var cooldownUntilMs by remember { mutableStateOf(0L) }
    var cooldownRemainSec by remember { mutableStateOf(0) }

    // 冷却倒计时（本地节拍 250ms；权威在 relay，本窗仅防抖）
    LaunchedEffect(cooldownUntilMs) {
        while (true) {
            val remain = ((cooldownUntilMs - System.currentTimeMillis()) / 1000L).toInt().coerceAtLeast(0)
            cooldownRemainSec = remain
            if (remain <= 0) break
            delay(250)
        }
    }

    val connected = connState is ConnState.Connected
    val cooling = cooldownRemainSec > 0

    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    if (busy || cooling || !connected) return@Button
                    busy = true
                    statusText = null
                    scope.launch {
                        val r = ConnectionManager.submitWakeHost()
                        when (r) {
                            is WakeSubmit.Result -> {
                                statusText = wakeResultText(r)
                                val cooldownMs = when (r.status) {
                                    WakeResultStatus.RATE_LIMITED -> r.retryAfterMs ?: WAKE_LOCAL_COOLDOWN_MS
                                    WakeResultStatus.SENT, WakeResultStatus.ALREADY_ON -> WAKE_LOCAL_COOLDOWN_MS
                                    else -> 0L
                                }
                                if (cooldownMs > 0) cooldownUntilMs = System.currentTimeMillis() + cooldownMs
                            }

                            WakeSubmit.NotConnected ->
                                statusText = "未连接：唤醒仅在 Relay 已连接时可用（不排队、不伪成功）"

                            WakeSubmit.Timeout ->
                                // App 侧等待窗超时：与 relay timeout 态同文案（不谎报 sent）
                                statusText = "唤醒超时（timeout）：15s 内未完成，可稍后重试"
                        }
                        busy = false
                    }
                },
                enabled = connected && !busy && !cooling,
            ) {
                Text(
                    when {
                        busy -> "发送中…"
                        cooling -> "冷却中 ${cooldownRemainSec}s"
                        else -> "唤醒 Windows"
                    },
                    fontSize = 13.sp,
                )
            }
            if (busy) CircularProgressIndicator(Modifier.width(16.dp).height(16.dp), strokeWidth = 2.dp)
        }

        // 结果行（六态如实投影；exec_failed 的 stderrSummary 由 relay 脱敏截断后直显）
        statusText?.let {
            Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        // 状态行（未连接 / 冷却中——诚实禁用原因，绝不静默）
        if (!busy && statusText == null) {
            when {
                !connected ->
                    Text(
                        "未连接：唤醒仅在 Relay 已连接时可用（不排队、不伪成功）",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                cooling ->
                    Text(
                        "冷却中：${cooldownRemainSec}s 后可再试（本地防抖，以 relay 实际判定为准）",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
            }
        }
    }
}

/** wake 六态 → 如实文案（绝不美化；exec_failed 携 relay 已脱敏 stderr 摘要）。 */
private fun wakeResultText(r: WakeSubmit.Result): String = when (r.status) {
    WakeResultStatus.SENT ->
        "唤醒指令已发出（sent，${r.latencyMs ?: "?"}ms）。「已发出」≠「已开机」，以主机实际状态为准"

    WakeResultStatus.ALREADY_ON -> "Windows 已在线（already_on），无需唤醒"

    WakeResultStatus.RATE_LIMITED ->
        "Relay 冷却窗拒绝（rate_limited）：需 ${((r.retryAfterMs ?: 15_000L) + 999) / 1000}s 后重试"

    WakeResultStatus.DISABLED -> "Relay 未启用唤醒功能（disabled）：需在 ECS 配置 WAKE_ENABLED=1"

    WakeResultStatus.EXEC_FAILED ->
        "唤醒执行失败（exec_failed）：" + (r.stderrSummary?.takeIf { it.isNotBlank() } ?: "无诊断摘要")

    WakeResultStatus.TIMEOUT -> "唤醒超时（timeout）：15s 内未完成，可稍后重试"
}

@Composable
private fun ProviderCard(
    agent: AgentDto,
    fixtureOn: Boolean,
    onOpenSession: (Long) -> Unit,
    onOpenRemoteEntry: (Long) -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // 展开状态（启动面板）只属于单卡：按 agent.id 记忆
    var spawnPanelOpen by remember(agent.id) { mutableStateOf(false) }
    var spawnTask by remember(agent.id) { mutableStateOf("") }
    var spawnBusy by remember(agent.id) { mutableStateOf(false) }
    var spawnStatus by remember(agent.id) { mutableStateOf<String?>(null) }

    val isManaged = agent.capabilities.mode == InteractionHonesty.MODE_MANAGED
    val canSpawn = InteractionHonesty.canSpawnManagedSession(agent.capabilities.mode, fixtureOn)
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
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ModeBadge(agent.capabilities.mode)
                Text(
                    when {
                        isManaged -> InteractionHonesty.MANAGED_PROVIDER_NOTE // R6.1 诚实文案
                        agent.capabilities.granted.isEmpty() -> InteractionHonesty.EMPTY_GRANTED_NOTE
                        else -> "granted: ${agent.capabilities.granted.joinToString(" / ")}"
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

        // R6.2：启动托管会话（数据驱动门：mode==managed 且非夹具；服务端 L3 二次校验兜底）
        if (canSpawn && !spawnPanelOpen) {
            OutlinedButton(
                onClick = {
                    spawnPanelOpen = true
                    spawnStatus = null
                },
            ) { Text(InteractionHonesty.SPAWN_BUTTON_LABEL, fontSize = 13.sp) }
        }
        if (spawnPanelOpen) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(
                    value = spawnTask,
                    onValueChange = { spawnTask = it.take(SPAWN_TASK_MAX_CHARS) },
                    label = { Text(InteractionHonesty.SPAWN_TASK_LABEL, fontSize = 12.sp) },
                    modifier = Modifier.fillMaxWidth(),
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
                            scope.launch {
                                val message: String = if (ConnectionManager.configuredMode() == "relay") {
                                    // M3-E1（docs/18 §5.3/§10 通道迁移）：relay 模式走 WS command
                                    // spawn_session（REST POST /v1/providers/{id}/sessions 打 ECS
                                    // 必败——§7.2 不开放）；本地模式保持下方 REST 路径零改动。
                                    when (val r = ConnectionManager.submitManagedSpawnRelay(providerId = agent.id, task = task)) {
                                        is ManagedSpawnSubmit.Executed -> {
                                            spawnPanelOpen = false
                                            spawnTask = ""
                                            // 跳入新托管会话详情：reply/pause/resume 会话级真实可用（R6.2）
                                            onOpenSession(r.sessionId)
                                            "已启动（commandId=${r.commandId}）"
                                        }

                                        is ManagedSpawnSubmit.AcceptedNoSession ->
                                            "已受理（${r.status}，commandId=${r.commandId}）；会话列表稍后出现新会话"

                                        ManagedSpawnSubmit.Queued ->
                                            "已排队（电脑离线）：连接恢复后自动启动"

                                        is ManagedSpawnSubmit.Rejected ->
                                            InteractionHonesty.spawnRejectionText(r.code, r.message)
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
                                            "已启动（commandId=${started.commandId}）"
                                        } else {
                                            "已受理（${started.status}，commandId=${started.commandId}）；会话列表稍后出现新会话"
                                        }
                                    } catch (err: ApiError) {
                                        "启动被拒绝：[${err.code}] ${err.message}"
                                    } catch (err: IOException) {
                                        "网络不可达，未启动"
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
            Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (fixtureOn) {
            Text(
                "演示数据（夹具）：此页能力展示仅示意，控制动作不可用",
                fontSize = 10.sp,
                color = Color(0xFF7A4F00),
            )
        }
    }
}
