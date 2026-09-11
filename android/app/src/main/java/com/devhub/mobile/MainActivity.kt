package com.devhub.mobile

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ConnState
import com.devhub.mobile.connect.GatewayConnectionService
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.SecureStore
import com.devhub.mobile.ui.AppState
import com.devhub.mobile.ui.screens.ChildSessionsScreen
import com.devhub.mobile.ui.screens.GatewayConfigScreen
import com.devhub.mobile.ui.screens.MainTabs
import com.devhub.mobile.ui.screens.PairingScreen
import com.devhub.mobile.ui.screens.RemoteWorkspaceScreen
import com.devhub.mobile.ui.screens.RemoteWorkspaceWebViewScreen
import com.devhub.mobile.ui.screens.SessionDetailScreen
import com.devhub.mobile.ui.theme.DevHubTheme

/**
 * 入口：导航 = gateway 配置 → pairing 配对 → main（会话/Agents/诊断/设备）→
 * session/{id} 详情 / remote/{id} 全屏 WebView / remote-manage 条目管理屏。
 * - deep link：devhub://session/{id}（事件通知点击直达会话详情；onNewIntent 热路径同样生效）；
 * - 401（撤销/失效）：ConnState.Unpaired → 清凭据已由 ConnectionManager 完成 → 回配对页；
 * - 通知权限：API 33+ 启动时请求一次（POST_NOTIFICATIONS）；
 * - windowSoftInputMode=adjustResize（Q 批）：WebView 页软键盘局部处理，输入焦点正常落 WebView；
 * - T1 批：独立「远程工作区」tab 撤销——ZCode 遥控入口并入会话/Agent 流
 *   （会话页智能卡 / zcode 会话详情 / zcode Agent 卡 → remote/{entryId}，语义不动）；
 *   条目管理屏经智能卡管理入口（remote-manage 路由）可达。
 */
class MainActivity : ComponentActivity() {

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* 授予与否都不阻塞 UI */ }

    /** deep link 目标会话（onCreate / onNewIntent 均更新；Compose 侧消费后清零）。 */
    private var pendingSessionLink by mutableStateOf<Long?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 视觉打磨批 D：钉深色主题 → 状态栏浅色图标（isAppearanceLightStatusBars=false），
        // 深色背景上浅色图标对比成立（此前浅色主题下近白图标不可见）。
        androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
            .isAppearanceLightStatusBars = false
        if (Build.VERSION.SDK_INT >= 33) {
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        pendingSessionLink = sessionIdFromIntent(intent)
        setContent {
            DevHubTheme {
                DevHubRoot(
                    startSessionId = pendingSessionLink,
                    onLinkConsumed = { pendingSessionLink = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        sessionIdFromIntent(intent)?.let { pendingSessionLink = it }
    }

    private fun sessionIdFromIntent(intent: Intent?): Long? {
        val data = intent?.data ?: return null
        if (data.scheme != "devhub" || data.host != "session") return null
        return data.lastPathSegment?.toLongOrNull()
    }
}

@Composable
fun DevHubRoot(startSessionId: Long?, onLinkConsumed: () -> Unit) {
    val navController = rememberNavController()
    val context = LocalContext.current
    val state by ConnectionManager.state.collectAsState()

    val paired = remember {
        mutableStateOf(SecureStore.loadToken(context) != null || FixtureMode.enabled(context))
    }
    val startDestination = if (paired.value) "main" else "gateway"

    // 已配对：拉起前台服务（WS 长连 + 通知）；401 → 回配对页（结构化提示）
    LaunchedEffect(state) {
        when (val s = state) {
            is ConnState.Unpaired -> {
                paired.value = false
                AppState.reportUnpaired(s.code, s.message)
                navController.navigate("pairing") { popUpTo(0) }
            }

            is ConnState.Idle -> {
                if (SecureStore.loadToken(context) != null) {
                    ConnectionManager.start()
                    GatewayConnectionService.start(context)
                }
            }

            else -> Unit
        }
    }

    // deep link（冷启动与 onNewIntent；消费后清零避免重复导航）
    LaunchedEffect(startSessionId) {
        if (startSessionId != null && startSessionId > 0) {
            navController.navigate("session/$startSessionId")
            onLinkConsumed()
        }
    }

    Scaffold { padding ->
        NavHost(
            navController = navController,
            startDestination = startDestination,
            modifier = Modifier.padding(padding),
        ) {
            composable("gateway") {
                GatewayConfigScreen(
                    onConfigured = {
                        // M2-R3：已配对（从主界面进配置页切模式）→ 返回主界面（保存已断旧连新）；
                        // 未配对（首装流程）→ 配对页（docs/19 §7.1 凭据共用，两模式同流程）。
                        if (SecureStore.loadToken(context) != null) {
                            navController.popBackStack()
                        } else {
                            navController.navigate("pairing")
                        }
                    },
                    onDiagnostics = { navController.navigate("main?tab=diagnostics") },
                    onDemoMode = {
                        navController.navigate("main") {
                            popUpTo("gateway") { inclusive = true }
                        }
                    },
                )
            }
            composable("pairing") {
                PairingScreen(
                    onPaired = {
                        paired.value = true
                        ConnectionManager.start()
                        GatewayConnectionService.start(context)
                        navController.navigate("main") {
                            popUpTo("gateway") { inclusive = true }
                        }
                    },
                )
            }
            composable(
                "main?tab={tab}",
                arguments = listOf(navArgument("tab") { type = NavType.StringType; defaultValue = "sessions" }),
            ) { entry ->
                MainTabs(
                    initialTab = entry.arguments?.getString("tab") ?: "sessions",
                    onOpenSession = { id -> navController.navigate("session/$id") },
                    onGatewayConfig = { navController.navigate("gateway") },
                    // Q 批「远程工作区」：条目 → 全屏 WebView 独立目的地（主导航底栏之外）；
                    // T1 批：会话页智能卡/zcode 详情/zcode Agent 卡三处遥控入口共用本回调
                    onOpenRemoteEntry = { id -> navController.navigate("remote/$id") },
                    // T1 批：智能卡管理入口 → 条目管理屏（手工 URL 条目功能不丢）
                    onManageRemote = { navController.navigate("remote-manage") },
                )
            }
            composable(
                "session/{sessionId}",
                arguments = listOf(navArgument("sessionId") { type = NavType.LongType }),
            ) { entry ->
                SessionDetailScreen(
                    sessionId = entry.arguments?.getLong("sessionId") ?: 0L,
                    onBack = { navController.popBackStack() },
                    onOpenChildren = { id ->
                        navController.navigate("children/$id")
                    },
                    // T1 批：zcode 会话「打开 ZCode 遥控」→ remote/{entryId}（语义不动）
                    onOpenRemoteEntry = { id -> navController.navigate("remote/$id") },
                )
            }
            // R2 子智能体会话列表页（从父会话入口一步进入；行内可下钻）
            composable(
                "children/{sessionId}",
                arguments = listOf(navArgument("sessionId") { type = NavType.LongType }),
            ) { entry ->
                ChildSessionsScreen(
                    parentSessionId = entry.arguments?.getLong("sessionId") ?: 0L,
                    parentTitle = null,
                    onBack = { navController.popBackStack() },
                    onOpenSession = { id -> navController.navigate("session/$id") },
                )
            }
            // Q 批「远程工作区」：全屏 WebView（独立目的地；返回键 WebView 先退再屏退）
            composable(
                "remote/{entryId}",
                arguments = listOf(navArgument("entryId") { type = NavType.LongType }),
            ) { entry ->
                RemoteWorkspaceWebViewScreen(
                    entryId = entry.arguments?.getLong("entryId") ?: 0L,
                    onBack = { navController.popBackStack() },
                )
            }
            // T1 批：条目管理屏（独立 tab 撤销后的路由目的地；自会话页智能卡管理入口可达）
            composable("remote-manage") {
                RemoteWorkspaceScreen(
                    onOpenEntry = { id -> navController.navigate("remote/$id") },
                    onBack = { navController.popBackStack() },
                )
            }
        }
    }
}
