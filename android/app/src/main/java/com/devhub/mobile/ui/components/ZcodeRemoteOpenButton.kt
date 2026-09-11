package com.devhub.mobile.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.WorkspaceLinkCard
import com.devhub.mobile.connect.WorkspaceLinkController
import com.devhub.mobile.core.InteractionHonesty
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * T1 批「ZCode 遥控合并进会话/Agent 流」：三处展示入口（Sessions 智能卡 / 会话详情按钮 /
 * Agent 卡按钮）共用的取/开纯决策。数据驱动（providerId==zcode 展示入口层特判，
 * 判定在 InteractionHonesty.isZcodeDisplayEntry），不碰能力门/服务端语义。
 *
 * 点击语义与会话页智能卡一致（tab 时代继承）：
 * 1) 控制器已 Ready → 直开该条目；
 * 2) 既往智能条目仍在（stale，旧链接成分静态有效）→ 直开旧条目（自动请求照常刷新）；
 * 3) 无条目可开 → 发起自动请求并挂起等待：Ready 到达后自动导航；
 *    Queued（桌面 ZCode 链路未就绪，U1-M4 分层文案）/ Unavailable（结构化不可用）
 *    → 状态行如实收口，绝不伪导航。
 */
internal object ZCodeRemoteEntryOp {

    /** 点击瞬间决策。 */
    sealed interface ClickDecision {
        /** 控制器已持有效链接（本屏请求已成功建/更新条目）→ 直开。 */
        data class OpenReady(val entryId: Long) : ClickDecision

        /** 既往智能条目仍在（stale）→ 直开旧行。 */
        data class OpenStale(val entryId: Long) : ClickDecision

        /** 无条目可开 → 发起自动请求并挂起等终态。 */
        data object RequestAndAwait : ClickDecision
    }

    /** Ready 优先；其次 stale；否则挂起请求（纯函数，单测直锁）。 */
    fun onClick(state: WorkspaceLinkCard.State, staleEntryId: Long?): ClickDecision =
        if (state is WorkspaceLinkCard.State.Ready) {
            ClickDecision.OpenReady(state.entryId)
        } else {
            staleEntryId?.let { ClickDecision.OpenStale(it) } ?: ClickDecision.RequestAndAwait
        }

    /** 挂起期间到达的状态 → 收口决策。 */
    sealed interface PendingSettle {
        /** 链接已就绪 → 导航。 */
        data class Open(val entryId: Long) : PendingSettle

        /** 终态但不可开（排队/结构化不可用）→ 以原文如实收口（绝不伪导航）。 */
        data class GiveUp(val message: String) : PendingSettle

        /** 进行中（Idle/Requesting）→ 继续等待。 */
        data object KeepWaiting : PendingSettle
    }

    fun settleWhilePending(state: WorkspaceLinkCard.State): PendingSettle = when (state) {
        is WorkspaceLinkCard.State.Ready -> PendingSettle.Open(state.entryId)
        is WorkspaceLinkCard.State.Queued ->
            // U1-M4（AUDIT P1#4）：与心跳横幅分层——横幅「已连接」指 relay 链路，
            // 排队真因是桌面侧 ZCode 工作区链路未就绪，文案如实区分（不写「电脑离线」）
            PendingSettle.GiveUp("桌面 ZCode 链路未就绪：链接请求已排队，就绪后再试")
        is WorkspaceLinkCard.State.Unavailable -> PendingSettle.GiveUp(state.message)
        WorkspaceLinkCard.State.Idle, WorkspaceLinkCard.State.Requesting -> PendingSettle.KeepWaiting
    }
}

/**
 * 「打开 ZCode 遥控」按钮（SessionDetail / Agents 两入口共用；Sessions 用智能卡承载）。
 * - staleLookup：既往智能条目查询（Room getByTitle 固定保留标题）；调用方注入（IO 语义在调用方）；
 * - onOpen：remote/{entryId} 导航回调；
 * - noteText：入口上方如实文案（如「转录只读 · 控制经 ZCode 遥控页」）。
 * 请求状态机 = WorkspaceLinkController（应用级单例；Requesting 幂等去抖沿用 tab 时代语义）。
 */
@Composable
fun ZcodeRemoteOpenButton(
    staleLookup: suspend () -> Long?,
    onOpen: (Long) -> Unit,
    buttonLabel: String,
    noteText: String? = null,
    modifier: Modifier = Modifier,
) {
    val linkState by WorkspaceLinkController.state.collectAsState()
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf(false) }
    // request() 同步置 Requesting；只信「见过 Requesting 之后」的终态（防旧帧误收口）
    var sawRequesting by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(linkState) {
        if (linkState is WorkspaceLinkCard.State.Requesting) sawRequesting = true
        if (pending && sawRequesting) {
            when (val settle = ZCodeRemoteEntryOp.settleWhilePending(linkState)) {
                is ZCodeRemoteEntryOp.PendingSettle.Open -> {
                    pending = false
                    sawRequesting = false
                    note = null
                    onOpen(settle.entryId)
                }

                is ZCodeRemoteEntryOp.PendingSettle.GiveUp -> {
                    pending = false
                    sawRequesting = false
                    note = settle.message
                }

                ZCodeRemoteEntryOp.PendingSettle.KeepWaiting -> Unit
            }
        }
    }

    Column(modifier) {
        noteText?.let {
            Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(2.dp))
        }
        OutlinedButton(
            onClick = {
                if (pending) return@OutlinedButton
                scope.launch {
                    // 状态直读 StateFlow（最新值；collectAsState 的帧滞后不影响决策）
                    val decision = ZCodeRemoteEntryOp.onClick(
                        WorkspaceLinkController.state.value,
                        runCatching { withContext(Dispatchers.IO) { staleLookup() } }.getOrNull(),
                    )
                    when (decision) {
                        is ZCodeRemoteEntryOp.ClickDecision.OpenReady -> onOpen(decision.entryId)
                        is ZCodeRemoteEntryOp.ClickDecision.OpenStale -> onOpen(decision.entryId)
                        ZCodeRemoteEntryOp.ClickDecision.RequestAndAwait -> {
                            note = InteractionHonesty.ZCODE_REMOTE_FETCHING
                            sawRequesting = WorkspaceLinkController.state.value is WorkspaceLinkCard.State.Requesting
                            pending = true
                            WorkspaceLinkController.request()
                        }
                    }
                }
            },
            enabled = !pending,
        ) {
            Text(buttonLabel, fontSize = 13.sp)
        }
        note?.let {
            Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
