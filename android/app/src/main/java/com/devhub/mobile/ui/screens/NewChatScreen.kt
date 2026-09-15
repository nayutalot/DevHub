package com.devhub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ManagedSpawnSubmit
import com.devhub.mobile.core.ComposerFirst
import com.devhub.mobile.core.ErrorPresent
import com.devhub.mobile.core.IdempotencyKeys
import com.devhub.mobile.core.InteractionHonesty
import com.devhub.mobile.core.WorkspaceGrouping
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.remote.AgentDto
import com.devhub.mobile.data.remote.ApiError
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 托管任务输入上限（与 AgentsScreen/服务端 MANAGED_SESSION_TASK_MAX_CHARS 对齐）。 */
private const val SPAWN_TASK_MAX_CHARS = 4_000

/**
 * UX-Z2 结构层（docs/28 §5）：composer-first 新建页（对话 tab 内；P3「开始对话」
 * 内联面板的升级迁移载体——助手页「开始对话」按钮跳转至此并聚焦输入框）。
 *
 * - 问候语（E4）：时段人话词表（core.ComposerFirst，无称呼不伪造）；仅空输入态显示；
 * - 大输入框（E5）+ placeholder 复用 P3 词表；
 * - 快捷 chips（E8）：四枚 DevHub 语境预设（core 常量表），点击仅填入不自动发送；
 * - 模型选择行/弹层（E9/E10）：诚实三态（core.ComposerFirst.modelSheetState）——
 *   可选面=当前模型只读展示+候选灰显（展示不承诺切换，E10' 设备侧写端点不存在）；
 *   托管停用=「模型在电脑上配置后可用」；无 managed provider=入口不画（null）；
 * - 工作区选择器（E6）：只读展示当前 managed 生效工作区（caps.workspace 既有字段；
 *   切换任意工作区=C 档不做，不画可点假入口）；
 * - 提交路径与 P3 逐字节同门：canSpawnManagedSession 门（演示模式/无 managed 不给
 *   提交路径）、relay=WS command、本地=REST、「正在创建…」进行态、H19 拒绝三态、
 *   A18 离线暂存；ControlGate 语义零触碰。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewChatScreen(
    agents: List<AgentDto>?,
    fixtureOn: Boolean,
    focusOnOpen: Boolean,
    onFocusConsumed: () -> Unit,
    onOpenSession: (Long) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val spawnTargetId = remember(agents, fixtureOn) { agents?.let { autoSpawnTargetId(it, fixtureOn) } }
    val target = agents?.firstOrNull { it.id == spawnTargetId }

    // 问候语时刻（进入本页定格一次；无称呼不伪造）
    val greeting = remember { ComposerFirst.greetingForHour(java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)) }

    var task by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<ErrorPresent.Presentable?>(null) }
    var error by remember { mutableStateOf<ErrorPresent.Presentable?>(null) }
    var showModelSheet by remember { mutableStateOf(false) }
    val focusRequester = remember { FocusRequester() }

    // autoOpenSpawn 复用（跨 tab 一次性语义）：聚焦一次即消费（助手页「开始对话」跳转动线）
    LaunchedEffect(focusOnOpen, target) {
        if (focusOnOpen && target != null) {
            onFocusConsumed()
            delay(150)
            runCatching { focusRequester.requestFocus() }
        }
    }
    LaunchedEffect(target) {
        if (target != null) {
            delay(150)
            runCatching { focusRequester.requestFocus() }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp),
    ) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onClose, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp)) {
                Text("‹ 返回", fontSize = 13.sp)
            }
        }
        when {
            agents == null -> Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }

            // 门：无可对话（managed 且非演示）助手 → 绝不给输入提交路径（假可供性红线；
            // 本页入口在上游已按同一判定收敛，此处为防御性兜底）
            target == null -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("电脑上的助手还没有开放「可以对话」能力，暂时不能在这里新建对话", fontSize = 13.sp)
                Text(
                    "可以到「助手」页查看每个助手的能力与原因", fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            else -> {
                // —— 问候语（E4）：仅空输入态显示（docs/28 §5.2 聚焦收缩语义）——
                if (task.isEmpty()) {
                    Text(greeting, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(10.dp))
                }

                // —— 大输入框（E5）——
                OutlinedTextField(
                    value = task,
                    onValueChange = { task = it.take(SPAWN_TASK_MAX_CHARS) },
                    placeholder = { Text(InteractionHonesty.SPAWN_TASK_PLACEHOLDER) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(140.dp)
                        .focusRequester(focusRequester),
                    enabled = !busy,
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
                )
                Spacer(Modifier.height(8.dp))

                // —— 快捷 chips（E8）：点击仅填入（不发送）——
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(ComposerFirst.CHIP_PRESETS, key = { it.label }) { chip ->
                        FilterChip(
                            selected = false,
                            onClick = { if (!busy) task = chip.fillText.take(SPAWN_TASK_MAX_CHARS) },
                            label = { Text(chip.label, fontSize = 12.sp) },
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))

                // —— 工作区选择器（E6 只读降级）：caps.workspace 展示，无值不画行 ——
                target.capabilities.workspace?.let { ws ->
                    val wsName = WorkspaceGrouping.tailSegment(ws)
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("📁", fontSize = 13.sp)
                        Spacer(Modifier.width(6.dp))
                        Column {
                            Text(wsName ?: "工作区", fontSize = 12.sp, fontWeight = FontWeight.Medium)
                            Text(
                                "工作区：$ws（在电脑上配置，这里只展示）",
                                fontSize = 10.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                }

                // —— 模型选择行（E10）：三态入口；无 managed 不画（本分支 target 必为 managed，
                //    但 modelSheetState 仍按 managed_model 值分可选面/停用态）——
                val sheetState = ComposerFirst.modelSheetState(
                    listOf(ComposerFirst.ManagedProviderRef(target.displayName, isManaged = true, managedModel = target.managedModel)),
                )
                if (sheetState != null) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { if (!busy) showModelSheet = true }
                            .padding(horizontal = 4.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("模型", fontSize = 12.sp, fontWeight = FontWeight.Medium)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            when (val s = sheetState) {
                                is ComposerFirst.ModelSheetState.Available -> "${s.rows.firstOrNull()?.model ?: "已配置"}（点击查看）"
                                is ComposerFirst.ModelSheetState.ManagedDisabled -> "在电脑上配置后可用"
                                null -> ""
                            },
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                        )
                        Text("▸", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.height(4.dp))

                // —— 提交行：与 P3 同门（A16/A17/A18/H19/A20/A21 语义逐字节保留）——
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(
                        onClick = {
                            val t = task.trim()
                            if (t.isEmpty() || busy) return@Button
                            busy = true
                            status = null
                            error = null
                            scope.launch {
                                val message: ErrorPresent.Presentable? = if (ConnectionManager.configuredMode() == "relay") {
                                    when (val r = ConnectionManager.submitManagedSpawnRelay(providerId = target.id, task = t)) {
                                        is ManagedSpawnSubmit.Executed -> {
                                            task = ""
                                            onOpenSession(r.sessionId)
                                            onClose()
                                            ErrorPresent.Presentable("对话已创建", "commandId=${r.commandId}")
                                        }

                                        is ManagedSpawnSubmit.AcceptedNoSession ->
                                            ErrorPresent.Presentable(
                                                "已提交：对话创建中，稍后在「对话」列表出现",
                                                "status=${r.status} · commandId=${r.commandId}",
                                            )

                                        ManagedSpawnSubmit.Queued ->
                                            ErrorPresent.Presentable("电脑不在线：已暂存你的请求，它上线后自动开始")

                                        is ManagedSpawnSubmit.Rejected -> {
                                            error = InteractionHonesty.spawnRejection(r.code, r.message)
                                            null
                                        }
                                    }
                                } else {
                                    try {
                                        val started = withContext(Dispatchers.IO) {
                                            ApiProvider.rest(context).startManagedSession(
                                                providerId = target.id,
                                                task = t,
                                                idempotencyKey = IdempotencyKeys.newKey(),
                                            )
                                        }
                                        val sid = started.sessionId
                                        if (sid != null) {
                                            task = ""
                                            onOpenSession(sid)
                                            onClose()
                                            ErrorPresent.Presentable("对话已创建", "commandId=${started.commandId}")
                                        } else {
                                            ErrorPresent.Presentable(
                                                "已提交：对话创建中，稍后在「对话」列表出现",
                                                "status=${started.status} · commandId=${started.commandId}",
                                            )
                                        }
                                    } catch (err: ApiError) {
                                        error = InteractionHonesty.spawnRejection(err.code, err.message)
                                        null
                                    } catch (err: IOException) {
                                        ErrorPresent.Presentable("网络不可用：对话没有创建，请检查网络后再试")
                                    } catch (err: Exception) {
                                        ErrorPresent.Presentable("启动出了问题，请重试", err.toString())
                                    }
                                }
                                busy = false
                                status = message
                            }
                        },
                        enabled = task.isNotBlank() && !busy,
                    ) {
                        Text(if (busy) InteractionHonesty.SPAWN_BUSY_LABEL else InteractionHonesty.SPAWN_CONFIRM_LABEL, fontSize = 13.sp)
                    }
                    Text(target.displayName, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                status?.let {
                    Text(it.headline, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    it.technical?.let { tech -> com.devhub.mobile.ui.components.TechnicalDetailsFold(tech) }
                }
                error?.let {
                    com.devhub.mobile.ui.components.ErrorPresentation(presentable = it)
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }

    // —— 模型弹层（E9/E10/E11 诚实降级）：三态内容；「管理模型」无端点 → 静态指引
    //    文案（绝不画死按钮/可选勾——假可供性红线）——
    if (showModelSheet) {
        val state = target?.let {
            ComposerFirst.modelSheetState(
                listOf(ComposerFirst.ManagedProviderRef(it.displayName, isManaged = true, managedModel = it.managedModel)),
            )
        }
        ModalBottomSheet(onDismissRequest = { showModelSheet = false }) {
            Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("模型", fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                when (val s = state) {
                    null -> {
                        Text("当前助手没有可展示的模型信息", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }

                    is ComposerFirst.ModelSheetState.Available -> {
                        s.rows.forEach { row ->
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("●", fontSize = 11.sp, color = Color(0xFF1B5E20))
                                Spacer(Modifier.width(8.dp))
                                Column {
                                    Text(row.model, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                                    Text("${row.providerName} · 当前使用", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        if (s.candidates.isNotEmpty()) {
                            Text("其他模型（在电脑上切换）", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            s.candidates.forEach { c ->
                                Text(
                                    c,
                                    fontSize = 12.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(8.dp))
                                        .padding(horizontal = 10.dp, vertical = 8.dp),
                                )
                            }
                        }
                        Text(
                            "切换/管理模型请在电脑上的 DevHub 页面操作（手机端暂不支持修改）",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    is ComposerFirst.ModelSheetState.ManagedDisabled -> {
                        Text("模型在电脑上配置后可用", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        s.providerNames.forEach { name ->
                            Text(
                                name,
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                            )
                        }
                        Text(
                            "在电脑上的 DevHub 页面为助手配置模型后，这里会显示当前使用的模型",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
