package com.devhub.mobile.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.WorkspaceLinkCard

/**
 * S 批「ZCode 工作区」智能条目卡片（顶部固定；状态机 = WorkspaceLinkCard，:app 单测锁）。
 * T1 批：自 RemoteWorkspaceScreen 抽出为共享组件——会话页智能卡与条目管理屏同用；
 * 新增可选管理入口（onManage，小图标）：独立 tab 撤销后，条目管理屏
 * （RemoteWorkspaceScreen）经此入口可达——手工 URL 条目功能不丢。
 *
 * 状态分四个面（Idle/Requesting/Ready/Queued/Unavailable）：
 * - Ready → 整卡可点，直达全屏 WebView（onOpen(entryId)）；
 * - 非 Ready 但存在既往会话留下的智能条目行（staleEntryId）→ 同样可点打开
 *   （链接成分静态、t 为 nonce——旧条目仍有效；自动请求照常刷新）；
 * - Queued = 桌面侧 ZCode 工作区链路未就绪（relay 排队语义，绝不伪造成功；
 *   U1-M4 文案与 relay 心跳横幅分层——横幅指中继链路，卡片指 ZCode 链路）；
 * - Unavailable = 结构化不可用（ZCODE_LINK_UNAVAILABLE / 本地 TIMEOUT / NOT_CONNECTED 等）
 *   + 重试按钮。
 * 卡片零 URL 展示（点击才进 WebView；WebView 标题栏本就中段省略）。
 */
@Composable
fun WorkspaceLinkCardView(
    state: WorkspaceLinkCard.State,
    staleEntryId: Long?,
    onOpen: (Long) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    onManage: (() -> Unit)? = null,
) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = state is WorkspaceLinkCard.State.Ready || staleEntryId != null) {
                    when (state) {
                        is WorkspaceLinkCard.State.Ready -> onOpen(state.entryId)
                        else -> staleEntryId?.let(onOpen)
                    }
                }
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("ZCode 工作区", fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                when (val s = state) {
                    WorkspaceLinkCard.State.Idle ->
                        Text("正在准备电脑页面…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) // UX-P1 W2

                    WorkspaceLinkCard.State.Requesting ->
                        Text("正在从桌面获取当前链接…", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

                    is WorkspaceLinkCard.State.Ready ->
                        Text(
                            "已就绪（${s.deviceName ?: "电脑"}）· 点击打开", // UX-P1 W4
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )

                    WorkspaceLinkCard.State.Queued ->
                        // U1-M4（AUDIT P1#4）：顶部横幅「已连接·心跳」指 relay 链路（手机↔中继），
                        // 卡片 Queued 指桌面侧 ZCode 工作区链路——两者不同层。原「电脑离线」
                        // 与心跳横幅同屏自相矛盾（05/12/16 号截图实证），改如实分层表述。
                        // UX-P1 W5（U1-M4 分层语义保留：不写「电脑离线」，排队如实）
                        Text("电脑还没准备好：已记住你的请求，就绪后自动打开", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

                    // U5 批的 NotAvailableInLocal 本地分支随 X-L 反转（docs/18 §5.3.2）移除：
                    // 本地模式全流转，失败统一 Unavailable 结构化面（原文案 + 重试钮）。

                    is WorkspaceLinkCard.State.Unavailable -> {
                        Text(s.message, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = onRetry) { Text("重试", fontSize = 12.sp) }
                    }
                }
            }
            if (state is WorkspaceLinkCard.State.Ready || staleEntryId != null) {
                Icon(Icons.Filled.ExitToApp, contentDescription = "打开 ZCode 工作区")
            }
            // T1 批：管理入口（小图标）——条目管理屏（手工 URL 条目）唯一导航面
            if (onManage != null) {
                IconButton(onClick = onManage) {
                    Icon(Icons.Filled.Settings, contentDescription = "管理远程工作区条目")
                }
            }
        }
    }
}
