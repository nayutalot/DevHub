# M3-C3a 批任务书（App relay 入网三修 + R5.3 收尾——android 批）

> 依据：M3-C2 问题清单 #1/#3 + R5.3（用户已认可四项技术建议之三）。三项全在 android 范围。
> worktree `F:\Active_Project\DevHub-worktrees\app-relayjoin`，分支 `agent/app-relayjoin`（自 main=973eeb3）。

## 0. 占用资源清单
- 模拟器 1 台（门禁冒烟+截图用毕即关）；JAVA_HOME=`D:\Apps\JetBrains\IntelliJ IDEA 2026.1\jbr`；local.properties 已在位
- 不碰 src/（桌面）、ecs-relay/、DevHub.exe、ECS；桌面常驻 8746 只作 local 模式回归只读连接

## 1. 任务

### 修 1（阻断级）：relay 模式 WS pair 配对传输（C2 #1，docs/19 §7.1"UI 复用现 Pairing 页，仅传输层换"）
- PairingScreen 模式感知：local 模式走现 REST claim；**relay 模式走 WS 裸连接 pair**——复用 RelayFrame.Pair codec（已有无调用方），ConnectionManager 增配对流：连接 /relay/device（无 Bearer 裸连）→ 收 hello → 发 pair{code, deviceName...按 docs/18 §3 帧}→ pair_accepted{ecsDeviceId, deviceToken, tokenVersion} → SecureStore 落凭据 → 以新 token 重连正式连接
- 10s 裸连接 pair 超时/失败码（RELAY_UPSTREAM_OFFLINE 等按协议帧）结构化文案；配对码 UI 零改（复用现输入页）
- :core 单测：pair 帧 round-trip + 裸连接流状态机（mock relay 桩端口段外）

### 修 2（阻断级）：指纹 pin 通配符崩溃（C2 #3）
- `TlsPinningOkHttp.kt:32` pattern `'*'` → OkHttp 抛 IllegalArgumentException 进程死循环。修：CertificatePinner 用具体 host pattern（从 relayUrl 解析 host，IP 字面量直接作 pattern——OkHttp 支持 IP pattern）；构造前校验 host 非空，空则 fail-fast 不注入
- :core 单测：IP host/域名 host/空 host 三态

### 修 3：R5.3 App WS 事件驱动刷新收尾（四项建议之三）
- 现轮询兜底为主 → 事件驱动为主：WS 收帧（event/sync_response/命令回执）即触发对应 UI 数据刷新（会话/事件/设备列表），轮询降为低频兜底（如 120s）仅连接健康与补偿
- 体感指标：模拟器 local 模式下桌面发事件 → App 列表出现延迟 <2s（轮询时代基线记录在案）

## 2. 门禁
`gradlew :core:test :app:assembleDebug` 全绿（:core 167+新增）；模拟器冒烟：local 模式回归不回退 + relay 模式配置页/指纹高级项不崩（修 2 验证）——**真实公网 pair 留给 C2b 重跑批**，本批不连公网。

## 3. 铁律与汇报
- 只动 `android/` + `acceptance/`（截图）；observed 零控件；增量提交+push `origin agent/app-relayjoin`；绝不 --no-verify
- 汇报四分类+分支 SHA+:core 数字+新增用例清单+模拟器证据+修 3 前后延迟对比
