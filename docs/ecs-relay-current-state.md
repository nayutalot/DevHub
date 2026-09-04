# ECS Relay 改造基线审计：源代码真实能力盘点（ecs-relay-current-state）

> 审计批次：ECS Relay 改造前置基线审计（分支 `audit/ecs-code`，基线 `9077d75`，工作树仅含本文档改动）。
> 审计方法：**只读源码 + 只读验收证据 + 只读真库快照**，不照抄文档声称；每一项标注证据等级。
> 证据等级定义：
> - 〔代码+真实联调实证〕= 源码存在，且有真机/真库/真实推理/公网路径的验收证据（acceptance/ 截图、日志、真库快照）。
> - 〔代码+夹具smoke实证〕= 源码存在，经 scripts/smoke.mjs 夹具用例验证（系统 Node 直测，真机路径零触碰）。
> - 〔代码+真库/语料实证〕= 源码存在，判定表/语义经真实数据库或真实语料只读复核。
> - 〔代码存在未验证〕= 源码存在且有意为之的预留/未激活面，无运行证据。
> - 〔仅文档声称〕= 只有文档/提交信息记录，本审计未取得独立运行证据。
> - 〔不存在〕= 目标能力在代码中不存在。

---

## 0. 结论一句话

DevHub 当前是一个**完整的"Windows 本机控制面 + 本机入站 Remote Gateway（127.0.0.1:8746）+ Android 前台服务直连"架构**：Agent Control 管线（五家 Provider、事件管线、Gateway 四文件、Android App）已全部落地并经真机/真库实证；公网可达性目前**完全依赖 ECS frp 透传（方案 B）**，ECS 上**没有任何 Relay 服务进程**，手机→ECS 段为**明文 HTTP/WS**。目标架构中的"出站 WSS Relay Client / ECS 原生 Relay 服务 / 443 TLS 入口 / FCM 唤醒"四要素均〔不存在〕。

---

## 1. Git / 仓库状态

| 项 | 实况 | 证据等级 |
| --- | --- | --- |
| 分支 / 基线 | `audit/ecs-code` @ `9077d75`（"build: electron-builder packaging (nsis+portable), dual-mode tray icon path, icon generation"），工作树审计前干净 | 审计现场 git 实测〔代码+真实联调实证〕 |
| 远程 | `origin = https://github.com/nayutalot/DevHub.git`；`origin/main` 与本地 `main` 均指向 `9077d75`（与审计基线同提交） | 审计现场 git 实测〔代码+真实联调实证〕 |
| 近期提交（基线前 5） | `11d4ba3` zcode 子会话过滤 smoke 补全 → `8442e9d` zcode provider 子会话过滤+真库清理脚本 → `534cdb0` ECS+frp 方案 B 文档/隧道面实测记录 → `c4419e4` HANDOFF 收官 → `cf9344f` 退出滞留根治 | git log 实测〔代码+真实联调实证〕 |
| 技术栈 | Electron 44.1.1 / electron-vite 5 / Vite 7 / React 19.1 / TS strict / node:sqlite（WAL）；electron-builder 26.15.3（nsis+portable，`npm run dist`） | package.json 实测〔代码+真实联调实证〕 |

---

## 2. IPC 网关与白名单（src/shared/channels.ts、src/main/ipc/handlers.ts、gateway.ts）

| 项 | 实况 | 证据等级 |
| --- | --- | --- |
| 唯一 IPC 网关 | Renderer 只见 `devhub:invoke` 一个 channel（`IPC_GATEWAY`），载荷 `{channel,payload}`；白名单外返回 `CHANNEL_NOT_ALLOWED`；electron 侧 `ipc/gateway.ts` 只做注册+兜底 catch（不漏堆栈） | 源码 + smoke step1 断言〔代码+夹具smoke实证〕 |
| channel 总数 | **68 条**（scan 3 + projects CRUD 6 + open 4 + environment 2 + services 2 + dashboard/settings/app 4 + skills 14 + apihub 6 + versions 4 + docker 3 + wsl 2 + archive 5 + agents 13） | channels.ts 实数清点〔代码+夹具smoke实证〕 |
| `agents:` 系列（13 条） | `agents:providers / sessions / sessionDetail / messages / events / sessionAction / pairingCreate / devices / deviceRevoke / gatewayStatus / gatewayRestart / setAutoStart / diagnostics`——全部为 renderer 轮询 channel，**无广播/推送 channel**；`sessionAction` 本地 action 白名单 = `reply|pause|resume`（reply 文本非空 ≤4000） | channels.ts + handlers.ts 实数清点〔代码+夹具smoke实证〕 |
| 指令二次校验 | `createSessionAction` / `submitRemoteCommand` 走 L3 `resolveCommandGate`（capability 门服务端二次校验，能力过期 >300s → `AGENT_CAPABILITY_MISSING`） | handlers.ts + agentControlService.ts〔代码+真实联调实证〕（ac8-e2e-13 pause 403 实测） |

---

## 3. src/main/services/agentControl/ 全目录结构

```
agentControl/
  agentControlService.ts   # L3 唯一写库层：会话/消息/事件/设备/指令/审计全部经此
  eventPipeline.ts         # 事件归一化/event_id 派生/去重/落库/投递状态机/sync 补发
  monitorRegistry.ts       # Map 化可取消监控任务表 + IncrementalJsonlReader + 失败降级
  providerRegistry.ts      # 五家目录 + AgentProvider 九方法接口 + 实例表 + 夹具覆盖位
  natpierce.ts             # NatPierce 隧道三态投影（凭据外置环境变量）
  redact.ts                # 脱敏统一实现（maskKey/redactText/redactValueDeep）
  traySummary.ts           # 托盘摘要投影
  gateway/                 # httpServer.ts / auth.ts / pairing.ts / ws.ts（见 §4）
  providers/               # codex / claude / kimi / zcode / deepseek 五家（见下）
```

### 3.1 五家 Provider 能力真实等级

| Provider | 会话发现 | 状态判定 | 能力授予（getCapabilities 实码） | 证据等级 |
| --- | --- | --- | --- | --- |
| **Codex** | `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` + `~/.codex/sessions/**/rollout-*.jsonl`（session_meta 为 native_id 权威源）+ app-server stdio JSON-RPC（持久连接，0.152.1/0.153.0-alpha.5 真机实测） | running ← `task_started`；waiting_input ← DevHub 自己的 turn 完成登记（managedTurns）；approval_required 判定源缺失→**置空绝不猜** | **`managed + [reply, pause, resume]`**——经 app-server 未知方法探测（-32600 错误枚举 158 protocol methods）逐个验证授予；握手失败落 observed/空集 | 〔代码+真实联调实证〕：真库快照 `ac9-db-snapshot.json`（codex 0.153.0-alpha.5，managed[reply,pause,resume]，"158 protocol methods"）；真机端到端 `ac8-e2e-01..37`（会话 #337 六 turn：托管发起→waiting_input 通知→手机回复 202→真实推理→消息回流→WS ack；resume 实测 executed；pause 因 turn 已结束如实落 failed/COMMAND_NOT_EXECUTABLE） |
| **Claude Code** | `~/.claude/projects/<编码目录>/<sessionId>.jsonl` 转录（行类型全集实测） | **实测转录无等待/审批/终态片段 → observed 判定多为 unknown**；approval_required 判定源 = hooks 审批事件（hooks 写入函数已实现，**默认未注册、判定源未活跃**） | `observed`（无 hooks）或 `attached`（hooks 注册后）**granted 恒空集**——hooks 无输入注入 API，能力验证门收缩；sendReply/pause/resume 结构化 unsupported | 〔代码+真库/语料实证〕（判定表按 2.1.150 真实语料后定）+〔代码存在未验证〕（hooks 回环 listener 未在真机激活） |
| **Kimi** | `~/.kimi-code/session_index.jsonl`（含删除墓碑行）+ `<sessionDir>/state.json` + `wire.jsonl`（行类型全集实机 6 会话语料后定） | running ← `turn.prompt`；approval_required ← `interaction.request(kind='approval')` 未 resolved；api_key 只经 maskKey 尾 4 位 | 真机恒 **`observed + 空集`**（真实托管必写 ~/.kimi-code，红线跳过）；managed 通道（spawnManaged + writeStdin + 终态轮询）**夹具全验证** | 〔代码+真库/语料实证〕（observed 通道）+〔代码+夹具smoke实证〕（managed 通道）；**真机 managed 端到端未验证**（known-limitations §1.5，需用户授权） |
| **ZCode** | `~/.zcode/cli/db/db.sqlite`（WAL，19 表）+ `~/.zcode/v2/tasks-index.sqlite`（task_id 51/51 覆盖）；**子会话双保险过滤**（task_type='subagent_child' + id 前缀 `sess_subagent_agent_`，命中任一即排除，全部发现路径过滤；历史污染行由 `scripts/cleanup-zcode-subagent-sessions.mjs` 一次性清理） | task_status 实测全集 {completed,error} → completed/failed；approval_status 实测全集 {none} → 无审批；未登录取值→unknown，**绝不猜** | **`observed-only` 恒空集**（裁决 4：非公开 CLI 无控制通道，禁 GUI 自动化/逆向）；sendReply/pause/resume 结构化 unsupported | 〔代码+真库/语料实证〕（~165 sessions/8.6k messages 真库只读实测；真库快照 zcode observed/空集）+〔代码+夹具smoke实证〕（子会话过滤 fix-zcode-subagent-141/142 用例） |
| **DeepSeek Harness** | 无会话发现（骨架） | 无 | **`observed + 空集` + "未接入"显式文案**（`DEEPSEEK_NOT_INTEGRATED_NOTE`）；probeHealth 只读目录探测（settings 键 `deepseekHarnessRoot` 指向 pnpm monorepo 源码重建形态），**绝不启动 harness 进程**；startMonitor 空句柄 | 〔代码+真实探测实证〕（真库快照 deepseek 0.1.0-rc.5 observed/空集——"未接入"为设计态而非缺陷） |

### 3.2 monitorRegistry / eventPipeline（事件表/sequence/delivery 状态机）

| 项 | 实况 | 证据等级 |
| --- | --- | --- |
| monitorRegistry | `Map<ProviderId, MonitorTask>` 每 provider 至多 1 活跃任务；cancel token 检查点；快轮询 2s / 降级慢轮询 15s；连续 5 次读失败 → health_changed + connection_lost（恢复后重探）；IncrementalJsonlReader（offset 记忆/轮转检测/尾行缓冲 4MB 上限） | 〔代码+夹具smoke实证〕 |
| 事件 7 类型全集 | `session.started / session.status_changed / session.waiting_input / session.finished / message.appended / provider.health_changed / command.result`；waiting_input payload.status ∈ {waiting_input, approval_required}；finished finalStatus ∈ {completed, failed, stopped} | 〔代码+夹具smoke实证〕+真实事件序列核对（ac8-e2e-30 evidence chain 16 事件时序与设计一致）〔代码+真实联调实证〕 |
| sequence / event_id | `agent_events.id AUTOINCREMENT` = 全局单调 sequence（不回绕）；`event_id` 唯一幂等键 = `<provider>:<native_id>:<type>:<16hex 内容指纹>` | 〔代码+夹具smoke实证〕+真库快照（14,871 事件、event_id 形态实测）〔代码+真库/语料实证〕 |
| delivery 状态机 | 裁决 5：先写库（单事务 INSERT event + deliveries(pending)×活跃设备）后投递；`pending → delivered → acked` 只前进不回退（markEventDelivered/markEventAcked）；**未确认事件绝不删除（零 DELETE 路径，smoke 静态断言）**；`eventsSince(seq, deviceId)` 供 WS sync 补发 | 〔代码+夹具smoke实证〕+真实证据（event_deliveries 1,849 行、会话 #337 投递 88 行 acked 22/pending 66——pending 属已撤销设备）〔代码+真实联调实证〕 |
| redact 脱敏 | `maskKey`（尾 4 位+长度，Kimi config.toml 明文 api_key 唯一投影形态）；`redactText`（password/token/secret/api_key/authorization/credential 赋值值段→`***`，幂等）；`redactValueDeep`（敏感键名整值打码）——消息 content_redacted/事件 payload_json/summary 落库前全覆盖 | 〔代码+夹具smoke实证〕+真库快照旁证（安全审计 33 行、无凭据值） |

---

## 4. gateway/ 四文件（src/main/services/agentControl/gateway/）

### 4.1 httpServer.ts — REST 13 端点（实测形态）

| # | 端点 | 鉴权 | 实测 |
| --- | --- | --- | --- |
| 1 | GET `/v1/health` | 无（防重放豁免） | 200 `{ok,name,version,uptimeSec}`；真机/公网路径均实测 |
| 2 | POST `/v1/pairing/create` | 仅回环（`GATEWAY_LOCAL_ONLY` 403）+ 防重放必带 | 桌面签发实测；AC7b 公网语义实证（经隧道来源恒回环 → 不可触发，见 §6 弱点） |
| 3 | POST `/v1/pairing/claim` | 无 Token；claim 限流 5 次/5min | 模拟器经公网地址输码 claim 成功（tunnel-ecs-02） |
| 4 | GET `/v1/diagnostics` | Bearer | 真机诊断页实测 |
| 5 | GET `/v1/devices` | Bearer | 真机设备页实测 |
| 6 | DELETE `/v1/devices/{id}` | Bearer + 仅自撤销（`DEVICE_FORBIDDEN`） | 探针设备自撤销 200 实测 |
| 7 | GET `/v1/agents` | Bearer（受限投影） | 真机 Agents 列表实测（5 provider 能力徽章） |
| 8 | GET `/v1/sessions` | Bearer（status/providerId/limit 过滤，200 封顶） | 真机列表 200 条实测 |
| 9 | GET `/v1/sessions/{id}` | Bearer | 真机详情页实测 |
| 10 | GET `/v1/sessions/{id}/messages` | Bearer（**绝不携带 sourceRef**——本地源指针不出本机） | 真机消息流实测 |
| 11 | POST `/v1/sessions/{id}/reply` | Bearer + 幂等键 | 202 → executed → 回流，真机实测（含公网路径门 403 实测） |
| 12 | POST `/v1/sessions/{id}/actions` | Bearer；action ∈ {pause, resume} | resume executed / pause failed 结构化，真机实测 |
| 13 | POST `/v1/events/{id}/ack` | Bearer | acked 只前进，真机实测 |

综合证据等级：〔代码+真实联调实证〕（ac6 smoke 全覆盖 + AC7b/AC8/tunnel 真机与公网路径）。

### 4.2 ws.ts — 自研 RFC6455 服务端 + 协议

- 帧：掩码校验/分片续帧/close 回显/ping→pong/帧与消息 1MB 上限；服务端发送不掩码。
- 鉴权：upgrade 头 `Authorization: Bearer <token>`，无效/撤销 → HTTP 401 拒绝升级。
- 协议实测形态：
  - 服务端 hello 首帧 `{type:'hello', sequence, device, heartbeatSec}`（默认心跳 30s，pong 超时 10s 关闭；客户端 ping 一律回 pong）；
  - 客户端 `{type:'sync', after}` → 按 sequence > after 且对该设备未 ack 补发（eventsSince）；
  - 服务端 `{type:'event', seq, eventId, eventType, sessionId?, summary?, payload, createdAt}`；
  - 客户端 `{type:'ack', seqs[]}`（批量 ≤500）→ markEventAcked；
  - **`token_rotation`：仅 ServerFrame 类型定义预留，v1 服务端绝不发送**〔代码存在未验证〕；
  - 撤销即断：`closeDeviceConnections(deviceId)` 由 L3 撤销路径触发。
- 公网长连专项：探针设备经 `ws://59.110.149.11:8746` 保持 300,137ms 零断连，t≈270s 实时收到事件帧〔代码+真实联调实证〕（ac8-blocked.md §5.3）。

证据等级：协议主体〔代码+真实联调实证〕；token_rotation〔代码存在未验证〕。

### 4.3 auth.ts — 鉴权

- Bearer Token：`sha256(token)` 比对 `remote_devices.token_hash` + `timingSafeEqual` 常数时间比较；撤销 → `DEVICE_REVOKED`。
- 防重放：`X-DevHub-Timestamp`（±300s 窗口）+ `X-DevHub-Nonce`（128-bit，内存 LRU 10 分钟去重）；窗外/重复 → 401 `AUTH_REPLAYED`；豁免 = `/v1/pairing/claim`、`/v1/health`。**公网三态回归已实测**（同 nonce 重放 401 / 窗外 -400s 401 / 合法 200）。
- 限流（内存滑动窗口，重启清零）：鉴权失败同源 5 次/60s → 429；claim 5 次/5min；常规 120 次/min/设备。
- 证据等级：〔代码+真实联调实证〕（B4 公网三态全做；限流 smoke 覆盖）。

### 4.4 pairing.ts — 配对

- 8 字符 Crockford Base32（去 I/L/O/U，码空间 32^8≈1.1e12），256-bit 随机折叠取 40bit；**TTL 300s；一次性；同时至多 1 活跃码，新码废旧码**；单码连续失败 5 次作废；码明文只在签发响应与 claim 请求出现（内存只存 SHA-256）。
- claim：`pairingId` 可选（AC7b code-only 裁决——未提供按唯一活跃码定位）；成功 → 256-bit Token（base64url）**明文仅此一次**，token_hash 经 L3 `pairDevice` 落库；platform 强制 `android`。
- 证据等级：〔代码+真实联调实证〕（模拟器经公网地址完成配对，tunnel-ecs-02；ac7b-03/04 截图）。

### 4.5 监听面

- **绑定 `127.0.0.1`**（`listenOn(server, port, '127.0.0.1')` 硬编码）；默认 8746（settings `gateway_port`），占用顺延 **8747–8755**（9 个，全部占用 → `GATEWAY_PORT_IN_USE`）；`gateway_enabled` 默认 0（零监听）。
- 证据等级：〔代码+夹具smoke实证〕（ac6-121 顺延断言）+ 真机端口切换实测（8750/8760 往返）〔代码+真实联调实证〕。

---

## 5. natpierce.ts — 隧道投影三态

- 三态实测：①三者全缺 → `{configured:false}`（AC2 契约形状逐字节锁定）；②部分缺 → `+hint`（只含变量名，绝不含值）；③齐备 → `{configured:true, reachable?}`（reachable = 一次出站 GET 探测，任意 HTTP 响应=可达，3s 超时，60s 缓存，协议白名单 http/https）。
- 凭据外置：`NATPIERCE_ENDPOINT / NATPIERCE_ACCOUNT / NATPIERCE_TOKEN` 环境变量，不入仓库/设置表/日志。
- 现网状态：**三变量未配置 → 投影恒 `{configured:false}`**（方案 B frp 不经此投影，语义不受影响）；方案 A（NatPierce）仍待用户凭据（B7 未解除）。
- 证据等级：〔代码+夹具smoke实证〕（ac8-140 三态用例，reachable 探测以 live loopback http/关闭端口/非法 scheme 实测）。

---

## 6. android/ 工程（Kotlin + Compose，双模块）

| 项 | 实况 | 证据等级 |
| --- | --- | --- |
| 模块结构 | `:app`（com.devhub.mobile，minSdk 26 / target 35 / versionCode 1）+ `:core`（纯 Kotlin 六件套：Backoff / ControlGate / EventNotification / Idempotency / QueueReplay / Redaction，各配单测） | build.gradle.kts + 源码树实测〔代码+真实联调实证〕 |
| 连接面 | `connect/GatewayConnectionService`（前台服务 foregroundServiceType=dataSync，常驻通知"DevHub Agent 连接中"，文本随配置实时更新）+ `connect/ConnectionManager`（OkHttp WS：hello→sync→事件消费→批量 ack ≤400/批；断线指数退避 1s→…→60s ±20% jitter；重连必发 sync，after 从 Room 恢复；401 处理） | 源码 + 真机实测（5 分钟公网长连零断连）〔代码+真实联调实证〕 |
| WS 帧 | `WsFrames`：Hello / Event / **TokenRotation（仅解析类型，预留）** / Sync / Ack / Unknown | 〔代码+真实联调实证〕（token_rotation 为预留〔代码存在未验证〕） |
| 数据/UI | Room 本地库（DevHubDb：gateway 配置单行+事件/消息缓存）；SecureStore（Android Keystore 存 Token）；Screens = GatewayConfig（host:port 输入+连接测试）/ Pairing（8 位码）/ Sessions / SessionDetail（回复框+pause/resume 按钮，**仅当 CapabilitySet.granted 包含才显示**；回复 idempotencyKey=UUID，断网自动入离线队列）/ Agents / Diagnostics / Device / MainTabs；deep link `devhub://session/{id}` 直达详情 | 真机逐页验收 ac7b-01..12 + ac8-e2e〔代码+真实联调实证〕 |
| 通知/离线 | 系统通知（waiting_input/approval_required → EventNotification 映射）；离线队列 QueueReplay（重连按序补发，幂等键防重） | ac7b-12/ac8-e2e-07/24 通知实测；离线补发为夹具级验证+真机断连重连实测〔代码+真实联调实证〕 |
| 控制动作 | **reply / pause / resume 三种**（ControlGate：modeAllows + granted 门）；**无 approve、无 interrupt 按钮** | 源码实数〔代码+真实联调实证〕 |
| 两种连接形态 | ①本地：默认 `10.0.2.2:8746`（模拟器回环映射宿主机 127.0.0.1:8746）；②公网：App 配置改填 ECS 公网 `59.110.149.11:8746`（经 frp 隧道回源 PC）——同一 APK 仅网络路径不同，tunnel-ecs-01..04 四截图实证 | 〔代码+真实联调实证〕 |
| 无 FCM/厂商推送 | Manifest 注释明示"第一版无 FCM"；事件通道 = 前台服务 + WS 唯一 | 〔代码+真实联调实证〕（known-limitations §4.1 同记） |
| cleartext | Manifest `android:usesCleartextTraffic="true"`——当前明文 http/ws 为**必要条件**（无 TLS） | 源码实测〔代码+真实联调实证〕 |

---

## 7. 数据层：migration 001–004（user_version=4，27 表）

- 001 建 14 表 → 002 重建 environment_tools_v2（DROP environment_tools）→ 003 并库 7 表（DROP skills/archives）→ 004 agent 域 8 表；**存活表合计 27**（30 建 − 3 删）。`migrate.ts` 应用后按字面量 switch 赋 `user_version = 4`（迁移文件内无 PRAGMA）。
- agent 域 8 表语义（与 Relay 相关的关键点）：

| 表 | 关键语义 |
| --- | --- |
| `agent_providers` | provider UNIQUE（codex/claude-code/kimi/zcode/deepseek，Grok 预留）；capabilities_json `{mode,granted[],verifiedAt,evidence}` |
| `agent_sessions` | `UNIQUE(provider_id, native_id)` upsert 幂等；`session_mode` CHECK ∈ managed/attached/observed（授权矩阵判定根）；status 9 值全集（用户 7 态 + stopped/unknown） |
| `agent_messages` | `content_redacted` 只存脱敏文本；`source_ref` 源指针不出本机（REST 已剥离）；`UNIQUE(session_id, native_msg_id)` 增量幂等 |
| `agent_events` | `id AUTOINCREMENT` = 全局 sequence；`event_id` UNIQUE 幂等；`delivery_state` pending→delivered→acked 只前进 |
| `remote_devices` | **Token 只存 SHA-256**（token_hash UNIQUE）；`token_version` 轮换递增字段已备（v1 轮换语义 = 撤销重配 + WS token_rotation 帧预留）；status active/revoked **撤销即拒不可复活** |
| `remote_commands` | `command_id` + `idempotency_key` 双 UNIQUE（重试返回原结果，同 key 异 payload 拒绝）；action ∈ {reply, pause, resume}；`expires_at`（TTL 300s）过期拒绝；status pending/accepted/executed/rejected/expired/failed |
| `event_deliveries` | 每 (事件×设备) 投递状态，`UNIQUE(event_id, device_id)`，WS 补发依据 |
| `security_audit_logs` | pairing/auth/command/device/gateway 五类；detail_json 绝不含凭据值 |

- settings 种子 4 条：`gateway_port=8746` / `gateway_enabled=0` / `agents_monitor_enabled=1` / `login_autostart=0`（WHERE NOT EXISTS 不覆盖用户值）。
- 真库体量（2026-09-03 快照）：sessions 337 / events 14,871 / messages 14,140 / devices 4 / deliveries 1,849 / audit 33；settings 实况 `gateway_enabled=1`。
- 证据等级：〔代码+夹具smoke实证〕（ac2 段）+〔代码+真库/语料实证〕（ac9-db-snapshot.json 只读快照实测）。

---

## 8. frp 隧道现状（方案 B，ECS + frp）

> 证据等级总注：本节部署事实以 `acceptance/agents-mobile/ac8-blocked.md` §5 + `docs/natpierce-setup.md` §7 的**部署期实测记录**为据，本审计未登录 ECS 复测——除 ssh 密钥文件存在性（本机只读确认）外，标记为〔仅文档声称（部署期实测记录，本审计未复测）〕。

- **ECS 侧**：Ubuntu 24.04（2C2G 3Mbps）frps 0.71.0 systemd 常驻（Restart=always），token 强认证（凭据已配置，仅存 ECS frps.toml 与 PC frpc.toml 两处，零入仓库/日志/截图），dashboard 仅绑 127.0.0.1:7500；安全组放行 7000/tcp（frp 控制面）+ 8746/tcp（对外服务面）。
- **PC 侧**：frpc 0.71.0 常驻于 `%LOCALAPPDATA%\DevHub\frp\`（机器本地不入仓库）；自启 = HKCU Run 键 `DevHubFRP` → vbs 隐藏启动器 + 5s 重拉循环（非提权环境建不了 SYSTEM schtasks，部署环境限制）。
- **公网端口面（主控实测记录）**：8746/7000/22 OPEN（22 建议收敛固定 IP）；3389/443/80 无监听。审计复核：本 worktree 无法验证云安全组，端口现状按主控实测记录采纳。
- **DevHub 侧零代码改动**：Gateway 仍绑 127.0.0.1:8746，经隧道流量在 Gateway 视角来源恒为 frpc 回环——因此 `GATEWAY_LOCAL_ONLY` 防线在隧道形态下**不可触发**，公网防线收敛为 Token+防重放+限流三条（natpierce-setup.md §7.5 弱点②已自记）。
- **传输明文**：手机→ECS 段为明文 HTTP/WS（无 TLS）；ECS→PC 段为 frp 隧道（token 认证）。
- **B1–B8 隧道面实测状态**：B1 health 200（公网 RTT 85–269ms）/ B2 公网配对 / B3 WS 长连+实时事件 / B4 防重放三态 = 通过；B5 指令门 403 公网路径实证（202→执行→回流留真机阶段）；B6 断隧道补发未跑；B7 NatPierce 投影不适用（方案 B 不经环境变量）；B8 回环限制不可触发（隧道属性）。
- **ssh 通道**：`~/.ssh/devhub_ecs`（私钥+pub）存在〔本审计只读确认文件存在性〕。

---

## 9. 测试门禁基线

| 门禁 | 数字 | 本审计核验方式 | 证据等级 |
| --- | --- | --- | --- |
| smoke（node scripts/smoke.mjs） | **144 用例**（含 fix-zcode-subagent-141/142 两批新增；含 ac8-140 natpierce 三态、ac7b-137/138 code-only 配对、ac6-121..136 Gateway 面、ac3/ac4 夹具段） | 静态清点 `registerCase(` 调用位 = 144（139 单行 + 5 多行，含 harness 自检首例）；基线历史：AC9 终验实跑 141/141（final-report §2）→ 其后两提交各新增用例至 144。**本审计未实跑**（用例 ac6-121 需顺序占用 8746–8755，触犯端口禁令） | 用例数=静态实证；"144/144 全绿"=〔仅文档声称（提交信息+基线记录，待主控复跑确认）〕 |
| mcp-acceptance | **22 用例** | 静态清点用例注册 = 22；AC9 树净后实跑 22/22 | 用例数=静态实证；22/22=〔代码+夹具smoke实证〕（AC9 终验记录） |
| `npx tsc --noEmit` / `npm run build` | PASS / 三 bundle OK | AC9 终验四门禁记录（007d8b3）+ 基线后 9077d75 为纯打包配置提交 | 〔仅文档声称（终验记录），本审计未复跑〕 |
| `:core:test`（android） | **37 用例** | 静态清点 `@Test` = 7+7+4+9+7+3 = 37；HANDOFF/终验记录 37/37 | 用例数=静态实证；37/37=〔仅文档声称（构建期记录）〕 |
| APK 产物 | `android/app/build/outputs/apk/debug/app-debug.apk`，10,819,083 字节，versionName 1.0，SHA-256 `81278d5a…454c19`（final-report §5 固定） | 本 worktree 无 build 产物目录；以终验 SHA-256 清单为据（SHA-256-SUMS.txt 149 文件 --check 全过） | 〔仅文档声称（产物在主仓路径，清单化固定）〕 |

---

## 10. spawn 纪律与 electron-free 分层

- **唯一 spawn 入口 `src/main/core/exec.ts`**：`run()`（参数数组+shell:false+默认 15s 超时+BOM 解码+结构化结果）与 **`spawnManaged()`**（托管长驻进程：idle/lifetime 双上限、BOM 感知行切分、killTree、退出 Promise）——全仓 `spawn` 仅 exec.ts 一处 import；providers 中仅 codex（app-server 持久连接）与 kimi（夹具探测）使用 spawnManaged。
- **electron-free 分层**：`src/main/services|core|db` 零顶层 electron import（本审计 grep 实证；electron import 仅存在于 `src/main/index.ts`、`ipc/gateway.ts`、三个 `*Wire.ts`；`core/paths.ts` 为运行期受守卫的 nodeRequire，非顶层 import）——smoke 可在系统 Node 下直测全部业务层。
- 证据等级：〔代码+夹具smoke实证〕（smoke 全量即此纪律的持续回归）。

---

## 11. 能力面总表（vs 目标架构要素速查）

| 目标架构要素 | 现状 | 证据等级 |
| --- | --- | --- |
| Windows 本机 Agent 观测/控制（五家 Provider） | 已落地（能力等级见 §3.1） | 〔代码+真实联调实证〕（codex）/ 其余见 §3.1 分级 |
| 本机 Gateway：REST 13 + WS（hello/sync/event/ack/心跳） | 已落地，被动入站监听 127.0.0.1 | 〔代码+真实联调实证〕 |
| 配对/设备 Token/撤销/审计 | 已落地（code-only、TTL 300s、撤销即拒、审计流水） | 〔代码+真实联调实证〕 |
| token_rotation | 仅协议预留（服务端绝不发送；Android 仅解析类型；remote_devices.token_version 字段已备） | 〔代码存在未验证〕 |
| approve / interrupt 动作 | **不存在**（action 全集 = reply/pause/resume） | 〔不存在〕 |
| ECS 原生 Relay 服务（转发/配对/心跳/ACK/sequence/离线缓存/审计） | **不存在**（ECS 上只有 frps 透传进程） | 〔不存在〕 |
| Windows→ECS 出站 WSS Relay Client | **不存在**（gateway 是被动入站监听，无任何出站 WS 客户端） | 〔不存在〕 |
| 443 HTTPS/WSS + TLS 证书 + 域名 | **不存在**（无域名、无证书、无 443 监听；现网 8746 明文） | 〔不存在〕 |
| 统一协议消息集 pair/pair_accepted/command_ack/command_result/error 等 | 部分语义由 REST 端点承担（202 accepted + command.result 事件），无独立 WS 消息帧 | 部分语义存在〔代码+真实联调实证〕，帧形态〔不存在〕 |
| requiresUserAction / eventId / deviceId 事件字段 | eventId/seq/payload 有；requiresUserAction **无**（由 event_type=session.waiting_input 隐含表达） | 〔代码+真实联调实证〕/ 字段〔不存在〕 |
| FCM 或等效通知唤醒 | **不存在**（前台服务+WS 唯一通道） | 〔不存在〕 |
| NatPierce（方案 A） | 投影代码+文档在，凭据未配置，标记备用不删码 | 〔代码+夹具smoke实证〕 |
