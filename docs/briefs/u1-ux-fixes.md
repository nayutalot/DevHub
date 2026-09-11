# U1 批任务书：App 体验整改第一批（P1×5 + P2 快赢×5）

> 依据：U-Aud 视觉审计（已合 main=de54693，**权威问题清单**=`acceptance/agents-mobile/ux-audit-20260912/AUDIT.md`，含 28 张截图逐条定位——先完整读）。本批修 P1 全部 5 条 + P2 快赢 5 条；P2 其余 5 条与 P3 全部**不做**（产品决策/打磨留后续）。
> 纯 Android 面（android/ 唯一改动域）；桌面零触碰。

## 0. 红线

- 28 条合同；凭据三零；诚实纪律（InteractionHonesty）不退步——凡文案改动不得虚构能力。
- WebView 安全面（WorkspaceWebViewPane W/V 批语义）、relay 帧协议面零触碰。
- 既有单测被锁文案/数字逐一核对更新（grep 测试目录）；新增纯逻辑单测（错误文案映射、通知权限偏好、横屏重载判定可测部分）。
- 门禁：`cd android && ./gradlew :app:testDebugUnitTest :core:test :app:assembleDebug`（Git Bash 链尾勿加 --stop；JAVA_HOME 未设时用 `D:/Apps/JetBrains/IntelliJ IDEA 2026.1/jbr`）。

## 1. P1 修复面（5 条，模块化串行 commit）

1. **U1-M1 横屏转录空白**（AUDIT P1#1，截图证据）：旋转后 SessionDetail 气泡区空白——按 sessionId 重建后重载消息（LaunchedEffect 键补 sessionId/orientation；查 LazyColumn 测量）；修复后旋转往返消息可见。
2. **U1-M2 observed「等待输入」假可供性**（P1#2）：列表/详情的 waiting_input 徽章在 observed 会话上加锁定语义——徽章文案改「等待输入 · 只读」或加锁角标（与 InteractionHonesty 一致），详情页零控件处补一行解释文案（「转录只读，无输入通道」既有文案复用）。
3. **U1-M3 统一错误呈现层**（P1#3）：新建错误文案映射（纯函数+单测）：已知异常类型（SocketTimeout/ConnectException/UnknownHost/SSL 等）→ 人话文案（「连接超时，请检查网络或网关地址」）；原始异常+技术细节收进「技术细节」可折叠区（默认收起）；接 relay 测试连接、DeviceScreen、GatewayConfig 等审计点。
4. **U1-M4 T1 智能卡「电脑离线」误导**（P1#4）：Queued/失败文案改「桌面 ZCode 链路未就绪，请求已排队」（横幅「已连接」指 relay 链路，卡片指 ZCode 链路——两者不同层，文案如实区分）；三态（Ready/Requesting/Unavailable）逐一对照 AUDIT 截图核对。
5. **U1-M5 通知权限拒绝后不再重复弹**（P1#5）：冷启动弹窗前查历史拒绝记录（SharedPreferences 一键），拒绝过则不再自动弹；设置页（GatewayConfig 或诊断页）加「通知权限」入口+价值说明文案。

## 2. P2 快赢（5 条，小改各一 commit 或并入相关模块）

6. 条目删除加确认对话框（remote-manage 屏）。
7. 设备页中英混排统一中文（deviceId 等术语保留英文）。
8. 撤销本设备按钮改警示色（非绿色主按钮）。
9. 网关配置页加返回导航（顶栏返回或系统返回语义核验）。
10. relay 模式 GET /v1/devices NOT_FOUND：错误呈现层（M3）落地时给该码配人话文案（「当前接入点不提供设备列表」），勿改桌面服务端。

## 3. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/u1ux`，分支 `agent/ux-u1-fixes`（自 main de54693 后建）。
- 每模块 commit+push（墙期 SOCKS 配方同前；绝不 --no-verify）。
- 出包：app-debug.apk 复制 `F:/Active_Project/DevHub/dist/DevHub-Android-0.1.0-debug.apk`（记录 sha256+时间戳；dist-cp6 勿碰）。
- 汇报：逐模块 diff 概览+对应 AUDIT 条目号、:app/:core 测试数、APK sha256、push 回执、偏差如实。文案改动逐条引用截图对照（改前/改后语义）。
