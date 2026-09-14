# W2 批任务书：App 设备页 relay 模式必 404 轮询退役+诚实文案

> 背景（主控已查明）：ECS relay REST 面无 `GET /v1/devices` 端点（HANDOFF 09-11 实证：结构化 NOT_FOUND；WS 路径不受影响）。`android/app/src/main/java/com/devhub/mobile/ui/screens/DeviceScreen.kt` L72-94 的 LaunchedEffect 每 FALLBACK_POLL_MS（120s）无条件调 `ApiProvider.rest(context).devices()`——relay 模式下这是必 404 的无效轮询：error 永挂「当前接入点不提供设备列表」、「服务端状态」区永缺、每 120s 白打一次 HTTP。撤销路径已正确分岔（relay 走 WS command，L163-194），不受影响、不许触碰。

## 1. 修法

- `ConnectionManager.configuredMode() == "relay"` 时：**跳过 devices() 轮询**（不再打必 404 端点），serverRow 保持 null、无 error；「服务端状态」区位置改一行诚实说明（例：「中继接入不提供设备列表查询：本设备以配对信息为准，撤销操作不受影响。」）。
- 直连（LAN 网关）模式行为零变化（轮询/状态区/错误呈现原样）。
- 抽纯函数 seam（如 `shouldQueryServerRow(mode)`）+ :app 单测。

## 2. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/w2-relay-devices -b agent/app-relay-devices-copy main`。
- `android/local.properties` 从主仓复制（gitignored）；gradle 需 `JAVA_HOME="D:/Apps/JetBrains/IntelliJ IDEA 2026.1/jbr"`。
- 每 commit 即 push 分支；绝不 push main；绝不 `--no-verify`；门禁包装链尾勿加 `./gradlew --stop`（Windows 退出码 1 假阴性）；凭据三零。

## 3. 门禁

- :app 与 :core 单测全绿（基线 **134/301**，新增如实计数）+ `assembleDebug` 成功。
- 产物：APK 拷贝主仓 `dist/DevHub-Android-0.1.0-debug.apk`（覆盖），登记 sha256；dist 根五件 Setup 与 `dist-cp6/` 勿动。
- 模拟器实证可选非硬门禁（relay 配对环境复杂）；单测必须覆盖 relay 跳过/直连保留两分支。

## 4. 边界

- 桌面零改动（免换装）；ECS 零触碰（**不新增 relay REST 端点**——「ECS 零业务」原则）；WS command 面零触碰；撤销路径（L152-230）零触碰。

## 5. 汇报

commits + 门禁计数（:app/:core）+ APK sha256 + 单测证据（两分支）+ 偏差如实。
