package com.devhub.mobile.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.core.ErrorPresent
import com.devhub.mobile.core.relay.WakeResultStatus
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ConnState
import com.devhub.mobile.connect.WakeSubmit
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * RW1 wake 本地冷却窗（纯防抖 UX；权威在 relay WAKE_COOLDOWN_S 缺省 15s，docs/18 §3.17）：
 * sent/already_on 后本地禁用 15s；rate_limited 以回传 retryAfterMs 为准。
 */
private const val WAKE_LOCAL_COOLDOWN_MS = 15_000L

/**
 * UX-P2（docs/26 §3.2）：唤醒卡条件置顶纯判定——仅 relay 且电脑未确认在线时出现
 * （relay 全在线 = Connected + beacon connected → 卡隐藏，减少常态噪音）；
 * beacon 尚未回传（null）按未确认处理，卡保留（六态人话与禁用态全部可达，不收窄）。
 */
fun wakeCardNeeded(activeMode: String?, connected: Boolean, upstreamBeacon: String?): Boolean =
    activeMode == "relay" && !(connected && upstreamBeacon == "connected")

/**
 * RW1（docs/18 §3.17）：relay 分支连接区「唤醒电脑」卡（UX-P2 自 AgentsScreen 抽出共享：
 * 助手页条件置顶 + 「我的」电脑连接状态卡同用；行为零改动）。
 * - 仅 relay 模式渲染（activeMode==relay；本地 REST 模式 = wake 是 relay 原生能力，不渲染）；
 * - WS 非 Connected → 按钮不可用并如实展示「不排队不伪成功」（wake 禁入 QueueReplay）；
 * - 六态文案不美化：disabled=未启用、rate_limited=冷却中、sent=已发出≠已开机、
 *   exec_failed 含 relay 回传 stderrSummary（relay 侧已脱敏截断）；
 * - App 侧 20s 等待窗超时与 relay timeout 态同文案，绝不谎报 sent；
 * - 冷却倒计时纯本地防抖（权威在 relay）：sent/already_on → 15s，rate_limited → retryAfterMs；
 * - loading / disabled / 结果三态强制，数据全部来自真实 ConnectionManager 面（零 mock）。
 */
@Composable
fun WakeHostCard() {
    val scope = rememberCoroutineScope()
    val connState by ConnectionManager.state.collectAsState()
    val activeMode by ConnectionManager.activeMode.collectAsState()

    // 本地模式（REST）不渲染该卡（设计裁决 3：wake 是 relay 原生能力）
    if (activeMode != "relay") return

    var busy by remember { mutableStateOf(false) }
    // UX-P1（A8-A14）：唤醒结果 = 人话 headline + 技术原值收「技术细节」折叠（零吞码）
    var statusText by remember { mutableStateOf<ErrorPresent.Presentable?>(null) }
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
                        try {
                            val r = ConnectionManager.submitWakeHost()
                            when (r) {
                                is WakeSubmit.Result -> {
                                    statusText = wakeResult(r)
                                    val cooldownMs = when (r.status) {
                                        WakeResultStatus.RATE_LIMITED -> r.retryAfterMs ?: WAKE_LOCAL_COOLDOWN_MS
                                        WakeResultStatus.SENT, WakeResultStatus.ALREADY_ON -> WAKE_LOCAL_COOLDOWN_MS
                                        else -> 0L
                                    }
                                    if (cooldownMs > 0) cooldownUntilMs = System.currentTimeMillis() + cooldownMs
                                }

                                WakeSubmit.NotConnected ->
                                    // UX-P1 A7：人话 + 指路（不排队不伪成功纪律不变，工程尾注退役）
                                    statusText = ErrorPresent.Presentable(
                                        "还没连上电脑，无法唤醒；先在「连接设置」检查连接",
                                    )

                                WakeSubmit.Timeout ->
                                    // App 侧等待窗超时：与 relay timeout 态同文案（不谎报 sent）
                                    statusText = wakeTimeoutText()
                            }
                        } catch (err: Exception) {
                            // B1 泛化热修（P0 先例）：未预期异常绝不崩 UI 进程；busy 复位防按钮卡死。
                            statusText = ErrorPresent.Presentable("唤醒出了问题，请重试", err.toString())
                        } finally {
                            busy = false
                        }
                    }
                },
                enabled = connected && !busy && !cooling,
            ) {
                Text(
                    when {
                        busy -> "发送中…"
                        cooling -> "请等 ${cooldownRemainSec}s" // UX-P1 A6
                        else -> "唤醒电脑" // UX-P1 A5
                    },
                    fontSize = 13.sp,
                )
            }
            if (busy) CircularProgressIndicator(Modifier.width(16.dp).height(16.dp), strokeWidth = 2.dp)
        }

        // 结果行（六态如实投影：人话 headline + 技术原值进折叠；exec_failed 的
        // stderrSummary 由 relay 脱敏截断后收「技术细节」，不再直出）
        statusText?.let {
            Text(it.headline, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            it.technical?.let { tech ->
                TechnicalDetailsFold(tech)
            }
        }

        // 状态行（未连接 / 冷却中——诚实禁用原因，绝不静默）
        if (!busy && statusText == null) {
            when {
                !connected ->
                    // UX-P1 A7（第二处：禁用原因如实说明）
                    Text(
                        "还没连上电脑，无法唤醒；先在「连接设置」检查连接",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                cooling ->
                    // UX-P1 A9（本地防抖尾注退役；权威仍在 relay 冷却窗）
                    Text(
                        "请等 ${cooldownRemainSec} 秒后再试",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
            }
        }
    }
}

/**
 * wake 六态 → 如实呈现（UX-P1 A8/A10-A14，docs/25 终稿）：headline 人话，状态码/数值/工程
 * 原值（sent/already_on/rate_limited/disabled/exec_failed/timeout、WAKE_ENABLED、stderr 摘要）
 * 全部收「技术细节」折叠——绝不美化、绝不谎报 sent（「已发出」≠「已开机」语义由 headline
 * 「电脑开机需要一点时间」+折叠原值承载）。
 */
private fun wakeResult(r: WakeSubmit.Result): ErrorPresent.Presentable = when (r.status) {
    WakeResultStatus.SENT ->
        ErrorPresent.Presentable(
            "唤醒指令已发出，电脑开机需要一点时间；是否上线以连接状态为准",
            "sent" + (r.latencyMs?.let { " · ${it}ms" } ?: ""),
        )

    WakeResultStatus.ALREADY_ON ->
        ErrorPresent.Presentable("电脑已经在线，不用唤醒", "already_on")

    WakeResultStatus.RATE_LIMITED ->
        ErrorPresent.Presentable(
            "操作太频繁：请 ${((r.retryAfterMs ?: 15_000L) + 999) / 1000} 秒后再试",
            "rate_limited" + (r.retryAfterMs?.let { " · retryAfter=${it}ms" } ?: ""),
        )

    WakeResultStatus.DISABLED ->
        // UX-P1 A13（最严重级）：ECS/WAKE_ENABLED 字样退出用户面，技术原值进折叠
        ErrorPresent.Presentable(
            "唤醒功能未开启：需在电脑端开启远程唤醒",
            "disabled · 需在 ECS 配置 WAKE_ENABLED=1",
        )

    WakeResultStatus.EXEC_FAILED ->
        ErrorPresent.Presentable(
            "唤醒失败：这台电脑可能不支持远程开机",
            "exec_failed" + (r.stderrSummary?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
        )

    WakeResultStatus.TIMEOUT -> wakeTimeoutText()
}

/** App 侧等待窗超时与 relay timeout 态同文案（A8；绝不谎报 sent）。 */
private fun wakeTimeoutText(): ErrorPresent.Presentable =
    ErrorPresent.Presentable("唤醒超时：电脑没响应，稍后可再试", "timeout")
