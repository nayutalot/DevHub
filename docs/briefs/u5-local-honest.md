# U5 批任务书：T1 遥控卡本地模式诚实文案（Z3 结论 B 的 App 侧收口）

> 背景（Z3 Phase 1 结论 B，主控已裁决）：本地模式 T1 卡结构性永远 Queued（App 本地帧解析器无 command 结算概念+网关无命令路由——双端协议面缺失），闭环需双端成对改+docs/14 协议扩展，**为纯开发场景（本地模式=模拟器/同机专用，真机物理不可达 127.0.0.1）不值当**。主控裁决=方案①：App 侧诚实文案——本地模式不发起取链请求，卡显「本地模式不提供 ZCode 遥控取链」；relay 模式一切行为不变。
> 依据：Z3 侦察报告（acceptance/agents-mobile/ux-u4-regression-20260912/REPORT.md 项2+ConnectionManager.kt 帧解析分派 :486/:531/:584、WsFrames.kt:35-58、submitWorkspaceLink :1166-1231）。

## 0. 红线

- 28 条合同；只动 android/；桌面零触碰。
- **relay 模式行为逐字节不变**（自动取链/Queued→Ready 流转/U1-M4 分层文案/U2-M2 重试全保持——既有单测锁定处逐一核对）；WebView 安全面零触碰。
- 诚实纪律：本地模式文案如实说明「不提供+原因+出路（Relay 接入）」，绝不渲染成假等待/假失败。
- 门禁：`cd android && ./gradlew :app:testDebugUnitTest :core:test :app:assembleDebug`（JAVA_HOME 未设用 `D:/Apps/JetBrains/IntelliJ IDEA 2026.1/jbr`；链尾勿加 --stop）。

## 1. 实施面

1. **模式判定纯函数**（:core 或 controller 层，单测锁）：连接模式 → T1 卡呈现策略：`relay` → 现状全流转；`local` → NotAvailableInLocal 态（不自动取链、点击不发起请求）；fixture 演示模式 → 现状。
2. **取链请求门**：WorkspaceLinkController 自动请求/手动请求入口加模式门——local 模式不发出 workspace_link 帧（消灭无谓的 10s 超时+幂等键垃圾行）。
3. **UI 三入口同文案**：SessionsScreen 智能卡、SessionDetail「打开 ZCode 遥控」、Agents 卡遥控入口——local 模式统一呈诚实态（文案例：「本地模式不提供 ZCode 遥控取链 · 请使用 Relay 接入」），不渲染 Queued/重试；relay 模式零变化。
4. 既有单测：锁文案/流转处逐一核对（ZCodeRemoteOpenTest/WorkspaceLinkUpsertTest 等），新增模式判定用例。

## 2. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/u5local`，分支 `agent/ux-u5-local-honest`（自 main 建）。
- 增量 commit+push（墙期 SOCKS 配方同前）；绝不 --no-verify。
- 出包：app-debug.apk → `F:/Active_Project/DevHub/dist/DevHub-Android-0.1.0-debug.apk`（覆盖；记录 sha256+时间戳；dist-cp6 勿碰）。
- 汇报：diff 概览、:app/:core 测试数、APK sha256、push 回执、偏差如实（relay 模式不变的自证=既有 relay 用例原样通过清单）。
- worktree 准备：android/local.properties 从主仓复制（若缺）。
