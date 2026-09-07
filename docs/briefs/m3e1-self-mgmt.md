# M3-E 实施批任务书（设备自管理与 managed spawn——#9 裁决 B 落地：App/桌面/ECS 三侧接线 + R-B5/R-B8 活体复验 + 安装包备料）

> **开工前置 = M3-D 72h 终报通过（T0=2026-09-07 08:49，窗毕 ≥2026-09-10 08:49）；窗内零编码零部署——
> 终报通过前本任务书仅作评审稿，任何编码/构建/部署动作禁止执行。**
> 依据：用户裁决 2026-09-07 #9=B（逐字保真见 docs/21 §7）；协议落点 docs/18 §5.3（M3-E 修订，
> 帧形零扩展）；判据 docs/20 §3 R-B5/R-B8（修订版，待本批活体复验）。
> 发布纪律：GitHub Release 暂不发布——条件链（docs/21 §8）= 稳定性终报通过 → B 方案复验 →
> 安装包更新 → 统一发布；本批只做第②③环，发布动作待主控统一裁定。
> 基线：main @ 6062cd0（M3-E0 文档批后；门禁计数以 m3c8a 实测为基线，开工日实跑复核）。

## 0. 占用资源

- worktree `F:/Active_Project/DevHub-worktrees/e1-self-mgmt`（分支 `agent/e1-self-mgmt`，自 main 切）；
  npm install + android/local.properties 从主树复制 + JAVA_HOME=jbr（`D:\Apps\JetBrains\IntelliJ IDEA 2026.1\jbr`）
- 门禁计数基线（m3c8a 批 c834c6f 实测）：smoke 172 / mcp 27 / :core 189 / :app 47 / ecs-relay 97
- **M3-D 窗毕后交接**：常驻/巡检进程的处置（保留/重启/清零）由主控在终报通过时裁定，本批不单方触碰；
  ECS 部署更新仅在 §2.6 收尾步执行（既有部署流程，`docs/ecs-relay-deploy/`）
- 不碰：8746 本地 Gateway 常驻（窗毕交接前）、模拟器（§2.6 活体复验时才拉起）

## 1. 主控已查明事实链（开工前不重复侦查）

1. **协议面已备（本批 M3-E0 落档）**：docs/18 §5.3 定义 `spawn_session`/`revoke_device` 两 action，
   帧形零扩展（§3.8/§3.9/§3.10 原形；幂等/TTL/排队走 §5.2）；§8.2 增 `SPAWN_REJECTED`（WS 专属，
   HTTP 列为「—」）；§3.15 撤销链/§7.1 注/§7.2 范围修订/§10 映射/N-R3 追加注同批生效。
   实现不得扩字段/加帧/加第三 action；发现契约不可实现 = 停该项上报（docs/20 §2.4 纪律）。
2. **ECS 白名单拦路（必改点）**：`ecs-relay/src/forwarder.ts:27` `RELAY_ACTIONS` 五值白名单
   （send_message/approve/pause/resume/interrupt），L441-443 对未知 action 抛 `BAD_PAYLOAD`——
   两新值不同步追加，命令到不了 host 腿。ECS 侧仅值域扩展、零新逻辑分支（命令仍纯透传）。
3. **App spawn 现走 REST 误走面**：`GatewayApi.kt` `POST /v1/providers/{providerId}/sessions`
   （本地模式正确，docs/14 面；relay 模式打到 ECS——ECS 无此端点，§7.2 明示不开放 → 必败）。
   UI 入口 `AgentsScreen.kt` spawn 面板与 `canSpawn` 能力门已有；响应 Dtos 对
   `sessionId/nativeId` 字段级 opt 容忍已有（Dtos.kt:251 注）。
4. **App 自撤销现走 REST**：`GatewayApi.kt` `DELETE /v1/devices/{id}`（仅自撤销，docs/14 §B.1；
   DeviceScreen.kt:53 入口已有）。relay 模式同上不可达；m3c6c 修②已保证 401 不伪报撤销成功。
5. **桌面命令下行已有承接缝**：`relayClient/commandDownlink.ts`（auth 校验 → action 翻译 →
   `submitRemoteCommand` → ack/result 回帧，幂等键先登记再执行）；L3 既有 spawn 托管通道
   （`agentControlService.ts` action='spawn'：exec.spawnManaged 双上限、幂等行重试还原
   sessionId/nativeId、能力门 COMMAND_NOT_EXECUTABLE/AGENT_CAPABILITY_MISSING 二次校验）；
   撤销链 `relayClient/index.ts:366`（addDeviceRevokedListener → `disconnect{deviceId,reason:'revoked'}`）
   现成——`revoke_device` 只需触发 L3 revoke，链路自动接管。
6. **Windows `remote_commands.action` 值域**：现 CHECK 含 'spawn'（REST 面既有）；`revoke_device`
   无对应行。实现取「relay action → L3 通道映射」或 append-only 扩 CHECK 值域二选一
   （docs/20 §2 R1 纪律：值域变化非新增 channel，IPC 白名单 68 条不动）；若开 migration 必须
   append-only（新列/新表，禁止改旧迁移）。

## 2. 任务

### 2.1 ECS 侧（最小面：白名单 + 自检）

1. `RELAY_ACTIONS` 追加 `'spawn_session'`、`'revoke_device'`（仅值域；命令仍纯透传，ECS 不解释语义）
2. `selfcheck.mjs` 增两 case：新 action 命令正常中继；未知 action 仍 `BAD_PAYLOAD`
3. 门禁：`node --test` 全绿（97+2）+ 该仓 `tsc --noEmit`；**部署更新压到 §2.6 收尾步**

### 2.2 桌面 host 腿（commandDownlink 扩两 action）

1. `spawn_session` 分支：帧校验（payload.providerId 非空 + task 非空 ≤4000，违反 → command_ack
   rejected `BAD_PAYLOAD`）→ action 翻译接 L3 既有 spawn 托管通道（复用幂等行/能力门/双上限，
   不旁路任何既有校验）
2. 拒绝映射：managed 能力缺失/未验证 → `AGENT_CAPABILITY_MISSING`；session_mode/授权矩阵不允许 →
   `COMMAND_NOT_EXECUTABLE`；spawn 特有拒绝（provider 无托管通道/并发上限）→ `SPAWN_REJECTED`
   （新码，`src/shared/types.ts` ErrorCode 追加——docs/18 §8.2 权威定义点同步）；拒绝统一经
   command_ack(rejected) 回程（§3.0 增补注载体语义不变，本批不定义专用回程帧）
3. `revoke_device` 分支：目标 = auth Token 对应 deviceId（帧无目标字段天然自指，禁止接受任何
   「代撤销他设备」语义）→ 调 L3 revoke → 既有撤销链自动接管（disconnect(revoked) → ECS 踢线 →
   注册表 revoked → 401）；commandId 终态照常落库（回帧不保证送达，docs/18 §5.3 终态语义）
4. `spawn_session` 终态：command_result（action='spawn_session', status='executed',
   sessionId=新会话 id）；nativeId 仅经 command.result 事件 payload 回流（帧形零扩展，§5.3）

### 2.3 App 侧（relay 模式命令面接线；本地模式零改动）

1. `:core` 帧面：CommandAction 值域 +`spawn_session`/`revoke_device`（FrameCodec 编解码
   round-trip 用例；WsFrames sealed class 仅 additive 扩展，docs/18 §10 尾注纪律）
2. relay 模式 spawn：AgentsScreen spawn 面板 → WS command `spawn_session`（**替换现 REST 误走面**；
   本地模式仍走 REST 不动——docs/14 零改动不变式）；accepted → result(executed) 取 sessionId
   刷新列表；rejected 按 errorCode 文案分叉（含 SPAWN_REJECTED）；host 离线 → queued 挂起（§3.9）
3. relay 模式自撤销：DeviceScreen → WS command `revoke_device`；**以 disconnect(revoked) 为成功
   收口（非 command_result——§5.3 终态语义）**，随后清本地凭据走既有 onAuthFatal 路径回配对页；
   **不得自动重连**（§3.15 纪律）；重试在连接被踢后自然终止（幂等键兜底）
4. 超时/重试：沿用 command 3 次退避（2s/4s/8s）与 QueueReplay（§3.8），不发明新参数

### 2.4 测试面

- smoke 新段（append-only）：commandDownlink 两 action 单测（spawn 幂等/拒绝映射/revoke 自指校验
  + 他设备目标拒绝）；夹具 Relay 桩对拍（新 action 透传通过、未知 action BAD_PAYLOAD——与 ECS
  selfcheck 同帧集）
- `:core`：新 action 帧编解码 round-trip + revoke 收口状态机（disconnect(revoked) → 清凭据且
  不重连）
- `:app`：spawn 面板 relay 分支 + 自撤销 relay 分支单测（对齐既有测试文件风格；本地 REST 分支
  回归不破）

### 2.5 分支门禁（全跑，每 commit 即 push `agent/e1-self-mgmt`）

typecheck / smoke:fast / smoke 全量（172+新增）/ mcp 27 / gradle
`:core:test :app:testDebugUnitTest :app:assembleDebug` / ecs-relay `node --test`；绝不 --no-verify。

### 2.6 活体复验 + 收尾（**部署/复验仅在终报通过后执行**）

1. ECS 部署更新（既有流程）+ 桌面/relayClient 构建替换；常驻处置按主控窗毕裁定执行
2. **R-B5 活体复验**（判据 = docs/20 §3 修订原文）：observed 会话 command → command_ack rejected
   `COMMAND_NOT_EXECUTABLE`；managed 会话经 WS command `spawn_session` → accepted → 真实推理回流
3. **R-B8 活体复验**（判据 = docs/20 §3 修订原文）：经 WS command `revoke_device`（或桌面 UI）→
   disconnect(revoked) 到达 → 设备停止重连；再连 401 `DEVICE_REVOKED`；ECS 注册表同步 revoked
4. 复验实录（帧审计/commandId/注册表快照/截图）落 `acceptance/agents-mobile/`（m3c8a 同款
   证据结构）；**安装包更新按 `docs/m3-dist-repack.md` 流程重打备料（为 Release 统一发布第③环），
   不发布**；回报主控——统一发布由主控按 docs/21 §8 条件链裁定

## 3. 铁律

- **开工前置硬闸**：M3-D 72h 终报未通过 → 零编码零构建零部署；期间绝不干扰常驻/巡检进程
- 协议面已冻结于 docs/18 §5.3——实现不得扩字段/加帧/加第三 action；空白点 = 停手上报（约束 #4/#28）
- 本地模式（docs/14 REST 面）零改动；IPC 白名单 68 条不动；migration append-only（如需）
- 凭据三零（不落盘/不落日志/不落审计）；绝不 --no-verify；不为绿而绿；卡死重试 ≤2；
  收尾进程清零复查（以主控窗毕裁定为准）

## 4. 汇报（四分类）

三侧 diff 摘要（ECS 白名单+自检 / 桌面两 action 处理器 / App 接线与状态机）+ 门禁终态表
（五面计数：smoke/mcp/:core/:app/ecs-relay）+ R-B5/R-B8 活体复验实录（对照 docs/20 §3 修订判据
逐条 PASS/FAIL）+ 安装包备料状态与 push 状态。
