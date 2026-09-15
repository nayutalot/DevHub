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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.core.ErrorPresent
import com.devhub.mobile.core.InteractionHonesty
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ConnState
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
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * UX-P3（docs/briefs/uxp3-flows.md §1.2 funnel）+ UX-Z2（docs/28 §5.1 升级迁移）：
 * 「开始对话」目标纯判定（:app 单测直锁）——首个可对话（managed 且非演示）的助手；
 * 无可对话助手 → null（绝不伪造入口，A4 教训：页面无该功能不得画按钮）。
 * UX-Z2 起消费方 = 对话 tab composer-first 新建页（NewChatScreen 的提交目标）。
 */
internal fun autoSpawnTargetId(agents: List<AgentDto>, fixtureOn: Boolean): Long? =
    agents.firstOrNull { InteractionHonesty.canSpawnManagedSession(it.capabilities.mode, fixtureOn) }?.id

/**
 * 页面 3：Agent 列表（GET /v1/agents，docs/14 §B.1；体验整改批 C 交互诚实化）。
 * - R6.1：managed provider 卡文案 =「托管会话可交互；外部会话只读」（能力是会话级的，
 *   展示必须如实；不再把 provider 级 granted 列表渲染成"现在就能交互"）；
 * - R6.2：对 managed provider（数据驱动判定，绝不硬编码）显示「开始对话」→
 *   UX-Z2 升级迁移（docs/28 §5.1）：新建流迁至对话 tab 的 composer-first 新建页，
 *   本卡按钮改为跳转（onGoSessionsCompose → 切对话 tab + 打开新建页 + 聚焦），
 *   提交路径/门语义在新页逐字节保留；
 * - R7.1/R7.2：observed provider 行显示 per-provider 原因卡（文案与
 *   docs/known-limitations.md §1 一致），只展示会话级真实可用动作——不可用的
 *   绝不显示为可点；
 * - T1 批：zcode provider 卡加「打开遥控」动作（数据驱动
 *   InteractionHonesty.isZcodeDisplayEntry；与「开始对话」视觉同层、文案区分，
 *   注明控制经 ZCode 自家认证遥控页；observed 原因卡保持——DevHub 原生控制仍不可用）。
 */
@Composable
fun AgentsScreen(
    onOpenSession: (Long) -> Unit = {},
    onOpenRemoteEntry: (Long) -> Unit = {},
    onOpenConnectionStatus: () -> Unit = {},
    onGoSessionsCompose: () -> Unit = {},
) {
    val context = LocalContext.current
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
                        onGoSessionsCompose = onGoSessionsCompose,
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
    onGoSessionsCompose: () -> Unit = {},
) {
    val context = LocalContext.current

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

        // T1 批：zcode 卡「打开遥控」动作（与「开始对话」视觉同层、文案区分；
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

        // R6.2 + UX-Z2 升级迁移（docs/28 §5.1）：「开始对话」→ 跳转对话 tab 新建页
        // （composer-first，autoOpenComposer 一次性语义聚焦输入框）；门语义不变
        //（canSpawnManagedSession：无 managed/演示模式绝不画按钮，绝不假开）
        if (canSpawn) {
            Button(onClick = onGoSessionsCompose) {
                Text(InteractionHonesty.SPAWN_BUTTON_LABEL, fontSize = 13.sp)
            }
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
