# T1 批任务书：ZCode 遥控合并进会话/Agent 流 + 撤销独立「远程工作区」tab

> 用户裁决（2026-09-11 夜）：ZCode 遥控应合并进会话（可直接控制），Agent 部分同理；独立「远程工作区」tab **撤销**。本批=纯 Android 面（桌面零改动，workspace_link 命令链不变）。
>
> 背景事实：远程工作区=Q/W 批产物——`RemoteWorkspaceScreen`（条目管理+「ZCode 工作区」智能卡，tab 打开自动经 relay 取 workspace_link）+ `RemoteWorkspaceWebViewScreen`（全屏 WebView，路由 `remote/{entryId}`，W 批错误页加固在役）。X 批后遥控 origin=zcode.z.ai 已实证可用。

## 0. 红线

- 28 条合同；仅动 `android/`；桌面 `src/`、`scripts/` 零触碰。
- WebView 安全语义不退步（W/V 批全部保持）：证书错误绝不 proceed、返回键先页内、清屏载荷跳过状态重置。
- 徽章诚实原则（InteractionHonesty 先例）：外部 zcode 会话投影仍是 observed 转录，**绝不显示为 managed/可控**；遥控是 ZCode 自家认证页，入口文案如实（例：「转录只读 · 控制经 ZCode 遥控」）。
- 数据驱动：zcode 特判只允许出现在「providerId == zcode 展示入口」这一层（与 R7 per-provider 卡同模式），不碰能力门/服务端语义。

## 1. 改动面

1. **MainTabs**：移除「远程工作区」tab（底栏回归 会话/Agents/设备…）。`RemoteWorkspaceScreen`（条目管理）保留为可路由屏，从智能卡上的管理入口（小图标/长按，自选最简）可达——手工 URL 条目功能不丢。
2. **SessionsScreen**：列表顶部加「ZCode 工作区」智能卡（复用 WorkspaceLinkCard/Controller；进入会话页时自动取链一次，沿用 tab 时代的取链节奏与去抖）。点击→ 取/建智能条目 → `remote/{entryId}`。
3. **SessionDetailScreen**：provider=zcode 的会话，控制区（observed 现为零控件）加「打开 ZCode 遥控」按钮 → 同上导航；文案注明转录只读、控制走遥控页。
4. **AgentsScreen**：zcode provider 卡片加「打开遥控」动作（与「启动托管会话」视觉同层但文案区分）→ 同上导航。
5. 导航：`remote/{entryId}` 路由与 `RemoteWorkspaceWebViewScreen` 不动；新增从 session/agents/sessions 三处跳转的接线（MainActivity 传回调）。
6. 单测：新增纯逻辑用例（如 find-or-create 智能条目、入口可见性判定 providerId）；既有断言计数连锁更新点全枚举（tab 计数、入口计数等被锁数字处逐一核对）。

## 2. 门禁与交付

- Worktree：`F:/Active_Project/DevHub-worktrees/t1merge`，分支 `agent/app-zcode-remote-merge`（自 main 建）。
- worktree 准备：`local.properties` 从主仓 android/ 复制；JAVA_HOME=jbr（踩坑台账）；无 node_modules 需求（纯 android）。
- 门禁：`cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`（Windows Git Bash 链尾**勿加** `--stop`；UP-TO-DATE 按类文件哈希判合法性）。
- 出包：`android/app/build/outputs/apk/debug/app-debug.apk` → 复制为 `F:/Active_Project/DevHub/dist/DevHub-Android-0.1.0-debug.apk`（覆盖旧件 28923f35；记录新 sha256 与时间戳）。
- 增量提交：每完成一模块即 commit+push 分支（墙期用 SOCKS 配方：`ssh -i ~/.ssh/devhub_ecs -D 127.0.0.1:1081 -fN root@59.110.149.11` 后 `git -c http.proxy=socks5h://127.0.0.1:1081 push`；bind already in use=隧道已在跑直接用）；绝不 --no-verify。
- 汇报：diff 概览、:app 测试数/总数、APK sha256、push 回执、偏差如实。
