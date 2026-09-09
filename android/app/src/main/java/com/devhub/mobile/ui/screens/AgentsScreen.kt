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
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ManagedSpawnSubmit
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.remote.AgentDto
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.ui.components.HealthBadge
import com.devhub.mobile.ui.components.ModeBadge
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/** 托管任务输入上限（与服务端 MANAGED_SESSION_TASK_MAX_CHARS 对齐）。 */
private const val SPAWN_TASK_MAX_CHARS = 4_000

/**
 * 页面 3：Agent 列表（GET /v1/agents，docs/14 §B.1；体验整改批 C 交互诚实化）。
 * - R6.1：managed provider 卡文案 =「托管会话可交互；外部会话只读」（能力是会话级的，
 *   展示必须如实；不再把 provider 级 granted 列表渲染成"现在就能交互"）；
 * - R6.2：对 managed provider（现 = codex，数据驱动判定，绝不硬编码）显示
 *   「启动托管会话」→ POST /v1/providers/{id}/sessions（202）→ 跳入新会话详情，
 *   reply/pause/resume 真实可用；夹具演示模式一律不给按钮（绝不伪造控制通道）；
 * - R7.1/R7.2：observed provider 行显示 per-provider 原因卡（文案与
 *   docs/known-limitations.md §1 一致），只展示会话级真实可用动作——不可用的
 *   绝不显示为可点。
 */
@Composable
fun AgentsScreen(onOpenSession: (Long) -> Unit = {}) {
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
            }
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Text("Agents", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(4.dp))
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
