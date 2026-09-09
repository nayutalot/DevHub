# RW1 任务书：RemoteWake App 面——「唤醒 Windows」按钮 + wake_host/wake_result 帧接线

> 需求（RW 系列第二步，用户 2026-09-09 深夜立项）：手机 App 经 ECS Relay 原生帧唤醒 Windows
> （桌面离线是主用例）。RW0（relay 侧）已部署 ECS 并端到端实测通过（already_on 快路径 /
> rate_limited 冷却 / 桌面离线真实执行 sent 511ms exit0 全验）；本批=RW1（App 侧），
> 门控 M3-E1 合并已落地（main 含 RelayActions 七值/Command.sessionId 可空）。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/rw1`，分支
> `agent/rw1-app-wake`（从 main 切出）。本任务书自包含。

## 0. 已实测事实链（主控 2026-09-10 实测，勿重复侦查）

- **RW0 在线**：ECS devhub-relay active；`/opt/devhub-relay/src/wake.ts` 已部署；
  `/etc/devhub-relay/env` WAKE 三行在位（WAKE_ENABLED=1 / WAKE_COMMAND=ssh -F … / WAKE_COOLDOWN_S）。
- **协议权威 = docs/18 §3.17 + 帧表 #17/#18**：`wake_host`（D→E，relay 原生执行，**绝不转发桌面**）
  /`wake_result`（E→D，单帧终态）。帧形：`{type:'wake_host',requestId}` →
  `{type:'wake_result',requestId,status,latencyMs?,retryAfterMs?,error?}`；六态
  `sent/already_on/rate_limited/disabled/exec_failed/timeout`；每设备冷却窗 15s（WAKE_COOLDOWN_S）。
- **App 侧既有机械（M3-E1 已落，锚点）**：`ConnectionManager.kt` 已有
  `submitManagedSpawnRelay`/`submitSelfRevokeRelay`（L1093/L1145 起）与 `pendingResults` 挂起表；
  `:core` `RelayFrames.kt`（sealed class RelayFrame，644 行，fixture 对拍纪律见文件头注）。
- **wake 与 command 流的本质差异（主控裁决依据）**：wake_host 不是 `command_downlink`/
  `command_ack`/`command_result` 三段流，无幂等键、无排队重放根（relay 侧唯一去重面=15s 冷却）。
  **禁止**把 wake 塞进 QueueReplay/幂等键体系——排队重放会撞冷却窗且语义撒谎。

## 1. 设计裁决（主控定）

1. **帧**：App 在已鉴权 relay WS 会话直发 `wake_host{requestId:UUID}`；挂起表按 requestId
   匹配 `wake_result` 单帧结算（CompletableDeferred 模式对齐既有 pendingResults 风格）。
2. **不入队**：WS 非 Connected 或本地模式时按钮不可用（如实展示，不排队不伪成功）。
3. **UI 落位**：AgentsScreen（relay 模式主界面）连接状态区新增「唤醒 Windows」按钮；
   DeviceScreen 不动。**本地模式（REST）不渲染该按钮**（wake 是 relay 原生能力）。
4. **超时**：App 侧 await 20s（> relay 执行上限 15s）；超时如实展示 timeout 文案（与
   relay timeout 态同文案，不谎报 sent）。
5. **冷却 UX（纯防抖，权威在 relay）**：收到 rate_limited 按 retryAfterMs 本地禁用倒计时；
   sent/already_on 后本地禁用 15s。
6. **零改动面**：桌面仓库（src/、scripts/、docs/04）零改动；ecs-relay 零改动；docs/18 §3.17
   已在册无需改。实现中发现协议文档缺口 → 停手上报（约束 #4/#28），不得自行扩帧加字段。

## 2. 交付物清单

1. `:core` `RelayFrames.kt`：`WakeHost`/`WakeResult` 帧类型 + 编解码（WakeResult.status 六态
   枚举 + latencyMs/retryAfterMs/error 可选字段；解析失败抛 JSONException 对齐既有纪律）。
2. `:core` 单测：codec round-trip 六态全覆盖 + 畸形帧拒绝（对齐 `RelaySelfMgmtCodecTest`
   风格；fixture 若需扩对拍件，遵循文件头注偏离单纪律）。
3. `:app` `ConnectionManager.kt`：`submitWakeHost(): WakeSubmit`（sealed 终态：六态映射 +
   NotConnected/Timeout）；帧分发（onText 路径）挂 wake_result → requestId 结算。
4. `:app` 单测：六态映射 + 超时 + NotConnected（fake websocket，对齐 `SelfManageSubmitTest`）。
5. `AgentsScreen.kt`：relay 分支连接区按钮 + 六态文案 + 冷却倒计时；loading/disabled/结果
   三态强制；零 mock（约束 #23/#24）。
6. （**可选**，资源允许才做）模拟器活体：既有公网 e2e 配对物料流（acceptance/agents-mobile/）
   → 配对 → 点按钮 → 期望 already_on（桌面常驻在线）或 sent（常驻下线中，真实走 Pi 链路，
   对已开机 PC 无副作用）→ **结束后测试设备双端撤销 + 模拟器关闭**。做不了如实报「未做+原因」。

## 3. 门禁（每 commit 即 push 分支 `agent/rw1-app-wake`）

- 前置：`android/local.properties` 从主树复制 + `JAVA_HOME` = jbr
  （`D:\Apps\JetBrains\IntelliJ IDEA 2026.1\jbr`）；Android-only 批**无需根仓 npm install**。
- gradle `:core:test :app:testDebugUnitTest :app:assembleDebug`（基线 :core 195 / :app 55 +
  本批新增）；**链尾勿加 `./gradlew --stop`**（Windows 退出码 1 假阴性）。
- 根仓 tsc/smoke 不涉（若发现需要改 TS/脚本文件 = 范围违规，停手上报）；绝不 --no-verify。

## 4. 铁律

- docs/00 28 条合同适用面内全守；凭据三零；不为绿而绿；卡死重试 ≤2。
- gradle 跨 worktree 句柄互斥——本会话 gradle 归本批独占；模拟器（若拉起）结束即关。
- exec_failed 文案含 relay 回传 error 摘要（脱敏后）；六态文案不得美化（disabled=未启用、
  rate_limited=冷却中，如实）。

## 5. 汇报

diff 摘要（:core 帧+codec / :app 提交面+UI）+ 门禁计数表（:core/:app/assembleDebug）+
（若做）活体实录与设备清理证据 + push 状态。
