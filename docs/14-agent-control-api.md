# DevHub Agent Control API 设计（docs/14）

> Phase 2/3 Agent Control / Mobile 设计，约束基线同 docs/00；migration/历史文档零改动。
> 本文是 AC 域的 API 权威：Part A = renderer 面 IPC（13 条新 channel，55→68）；
> Part B = Remote Gateway REST + WS（Android 面）；Part C = 错误码；Part D = 通道职责对照。
> 需求见 docs/11，架构见 docs/12，DDL 见 docs/13，安全见 docs/15。

---

## Part A：IPC（renderer 面，单一网关 `devhub:invoke` 不变）

### A.1 新增 channel 全清单（agents: 前缀，13 条）

Result envelope / BAD_PAYLOAD / CHANNEL_NOT_ALLOWED 语义与 Phase 1 完全一致（约束 #14/#17）。
所有列表类 channel 均为**轮询模式（无广播 channel）**——renderer 不订阅事件推送，
Agents 视图按 2s 间隔轮询 `agents:events` / `agents:sessions`（`archive:status`
先例，docs/10 §11「不新增广播 channel」；同时规避 CSP connect-src 扩面）。

| # | channel | payload | result data |
| --- | --- | --- | --- |
| 1 | `agents:providers` | `{}` | `{ providers: [{ id, displayName, installed, version?, exePath?, health: 'ok'\|'degraded'\|'unavailable'\|'unknown', healthDetail?, capabilities: { mode, granted[], verifiedAt, evidence }, enabled, lastProbeAt }], monitorEnabled, probedAt }` |
| 2 | `agents:sessions` | `{ providerId?, projectId?, status?, limit? }`（limit 正整数 ≤200，缺省 100） | `{ sessions: [{ id, providerId, nativeId, sessionMode, projectId?, title?, status, statusDetail?, startedAt?, lastActivityAt?, endedAt?, stale }] }`（status 九值 = 用户锁定 7 态 + stopped/unknown 辅助态，docs/12 §4；stale = 数据源过期标注，绝不猜实时态） |
| 3 | `agents:sessionDetail` | `{ sessionId }` | `{ session: SessionView, capabilities: CapabilitySet, counts: { messages, events } }` |
| 4 | `agents:messages` | `{ sessionId, after?, limit? }`（after = 消息游标 id；limit ≤200） | `{ items: [{ id, role, contentRedacted, occurredAt, sourceRef? }], nextAfter? }`（contentRedacted 为脱敏投影；完整上下文按需加载，docs/15 §6） |
| 5 | `agents:events` | `{ after?, providerId?, sessionId?, limit? }`（after = sequence 游标；limit ≤200） | `{ events: [{ id, eventId, eventType, providerId?, sessionId?, summary, payload, deliveryState, createdAt }], nextAfter? }` |
| 6 | `agents:sessionAction` | `{ sessionId, action: 'reply'\|'pause'\|'resume', text?, confirmed? }`（reply 必带 text 非空 ≤4000 字符） | 直执行（用户显式输入，不经 CONFIRM_REQUIRED）：`{ commandId, status: 'accepted'\|'executed'\|'rejected', error? }`；能力未验证 → `AGENT_CAPABILITY_MISSING`；observed → `COMMAND_NOT_EXECUTABLE`（服务端能力门，docs/12 §5） |
| 7 | `agents:pairingCreate` | `{ deviceName? }` | `{ pairingId, code, expiresAt }`（code 8 位 Crockford Base32，TTL 300s，一次性；明文只在本次返回中出现，docs/15 §2） |
| 8 | `agents:devices` | `{}` | `{ devices: [{ id, deviceName, platform, status: 'active'\|'revoked', pairedAt, lastSeenAt?, tokenVersion }] }`（绝无 Token 明文/哈希） |
| 9 | `agents:deviceRevoke` | `{ deviceId, confirmed? }` | 未带 confirmed → `{ confirmRequired: true, impacts: { deviceId, deviceName, lastSeenAt?, note } }`（两段式，绝不执行）；confirmed → `{ revoked: true }`（活跃 WS 立即断开 + 审计） |
| 10 | `agents:gatewayStatus` | `{}` | `{ enabled, running, port, actualPort?, activeDevices, natpierce: { configured, reachable?, hint? }, lastError? }`（未启用 → enabled:false + running:false，结构化而非错误） |
| 11 | `agents:gatewayRestart` | `{ confirmed? }` | 未带 confirmed → `{ confirmRequired: true, impacts: { activeConnections, note } }`；confirmed → 重启监听（重读 settings gateway_port/gateway_enabled）→ `{ running, port }`；禁用态重启 → `GATEWAY_DISABLED` |
| 12 | `agents:setAutoStart` | `{ enabled: boolean }` | `{ enabled }`（写 settings `login_autostart` + 经注入胶水调 app.setLoginItemSettings，docs/12 §10） |
| 13 | `agents:diagnostics` | `{}` | `{ providers: [{ id, installed, version?, exeFound, dataSource: { kind, readable, detail? }, control: { hooks?, appServer?, stdin?, note? } }], gateway: GatewayStatusView, tray: { available }, autostart: { enabled }, monitorEnabled }` |

### A.2 ChannelContract 与白名单计数（55→68）

- `src/shared/channels.ts` 的 `IPC_CHANNELS` 追加上述 13 条（追加模式，既有 55 条零改动，
  与 S2–S5 批次同款，docs/04 §4 / docs/09 §9 / docs/10 §11）。
- `src/shared/types.ts` 的 `ChannelContract` 为每条新 channel 增一行
  `{ channel: IpcChannel; request: <payload 类型>; response: <data 类型> }`——
  编译期断言 `AssertContractCoversWhitelist`（src/main/ipc/handlers.ts:227-228）保证
  契约恰好覆盖白名单，漏配一行即 tsc 报错。
- 白名单计数：**55 → 68**（3 scan + 6 projects CRUD + 4 open + 2 environment +
  2 services + 4 dashboard/settings/app + 14 skills + 6 apihub + 4 versions +
  3 docker + 2 wsl + 5 archive + **13 agents** = 68）。
- smoke 三处计数断言**就地更新授权**（沿用 s4-68 注明的「45→50（S5 就地更新 50→55）」
  同一模式）：`step1`（exactly 55→68）、`step6`（registry 55→68）、`s4-68`
  （55→68 + ChannelContract 覆盖断言）；既有用例零删除（约束 #27）。

### A.3 轮询模式说明

不新增任何广播/推送 IPC channel：renderer 的事件获取 = `agents:events { after }`
游标轮询；执行期动作状态 = `agents:sessionAction` 返回 + `agents:events` 跟踪
`command.result` 事件。与 Phase 1 的 scan:status / archive:status 轮询先例一致。

---

## Part B：Remote Gateway REST + WS（Android 面）

监听：Electron Main 内 node:http（docs/12 §2）；默认 `127.0.0.1:8746`
（settings `gateway_port` 可配），Android 模拟器经 `10.0.2.2` 访问；
`gateway_enabled=0`（默认）时零监听。鉴权（除注明外）= `Authorization: Bearer <deviceToken>`。
统一错误结构 `{ "error": { "code": "…", "message": "…" } }`（Part C + HTTP 状态映射）。

### B.1 REST 端点表（13 端点）

| 端点 | 方法 | 鉴权 | 请求 JSON | 响应 JSON（成功） |
| --- | --- | --- | --- | --- |
| `/v1/pairing/create` | POST | **仅限 127.0.0.1 回环**（非回环/隧道来源 → 403 `GATEWAY_LOCAL_ONLY`）；不需要设备 Token | `{ deviceName? }` | `201 { pairingId, code, expiresAt }`。注：桌面常规路径走 IPC `agents:pairingCreate` 进程内直调（不经过 HTTP）；本端点仅为诊断/自动化测试预留，语义与 IPC 完全一致 |
| `/v1/pairing/claim` | POST | 无 Token（凭一次性码）；配对限流（§B.3） | `{ pairingId, code, deviceName, platform: 'android' }` | `200 { deviceId, token, tokenVersion, gatewayName }`——**码即失效**（一次性，成功/过期/作废均不可再用）；token 为 256-bit 随机值，仅此一次明文下发 |
| `/v1/health` | GET | 无（仅活性探测，不含敏感信息） | — | `200 { ok: true, name, version, uptimeSec }` |
| `/v1/diagnostics` | GET | Bearer | — | `200 { providers: [脱敏诊断投影], gateway: {...} }`（与 IPC `agents:diagnostics` 同投影红线） |
| `/v1/devices` | GET | Bearer | — | `200 { devices: [{ id, deviceName, platform, status, pairedAt, lastSeenAt?, tokenVersion }] }` |
| `/v1/devices/{id}` | DELETE | Bearer；**仅可撤销自身**（撤销他设备 → 403 `DEVICE_FORBIDDEN`，必须走桌面 `agents:deviceRevoke`） | — | `200 { revoked: true }`（自身撤销：Token 即拒 + WS 断开 + 审计） |
| `/v1/agents` | GET | Bearer | — | `200 { providers: [{ id, displayName, health, capabilities }] }` |
| `/v1/sessions` | GET | Bearer；query `providerId? / status? / limit?` | — | `200 { sessions: [SessionView] }` |
| `/v1/sessions/{id}` | GET | Bearer | — | `200 { session: SessionView, capabilities: CapabilitySet }` |
| `/v1/sessions/{id}/messages` | GET | Bearer；query `after?（消息游标）/ limit?` | — | `200 { items: [{ id, role, contentRedacted, occurredAt }], nextAfter? }` |
| `/v1/sessions/{id}/reply` | POST | Bearer；能力门（reply ∈ granted） | `{ text, idempotencyKey? }`（text 非空 ≤4000） | `202 { commandId, status: 'accepted' }` |
| `/v1/sessions/{id}/actions` | POST | Bearer；能力门（pause/resume ∈ granted；observed 全禁） | `{ action: 'pause'\|'resume', idempotencyKey? }` | `202 { commandId, status: 'accepted' }` |
| `/v1/events/{id}/ack` | POST | Bearer；`{id}` 为事件 sequence | `{}` | `200 { acked: true }`（delivery_state → acked，只前进不回退） |

SessionView（REST 与 IPC 同构）：`{ id, providerId, nativeId, sessionMode, projectId?,
title?, status, statusDetail?, startedAt?, lastActivityAt?, endedAt?, stale }`。

> **实现注记（AC7b 裁决，上表 `/v1/pairing/claim` 行）**：`pairingId` 可选；code-only
> claim 依赖同时仅 1 活跃码的唯一定位语义；两者同给必须全匹配。响应/审计/限流/TTL/
> 一次性语义零变化。

### B.2 WS `/v1/events` 协议

| 项 | 规格 |
| --- | --- |
| 连接鉴权 | upgrade 请求头 `Authorization: Bearer <deviceToken>`；无效/撤销 → 拒绝升级（401），Token 撤销后**已建立连接立即服务端关闭**（docs/15 §4） |
| hello | 连接建立后服务端首帧：`{ type:'hello', sequence: <当前全局 sequence>, device: <deviceId>, heartbeatSec: 30 }` |
| 增量同步 | 客户端 → `{ type:'sync', after: <已确认 sequence> }`；服务端把 `sequence > after` 的未 ack 事件按序补发（**未确认不删**，裁决 5；来源 agent_events × event_deliveries） |
| 事件帧 | 服务端 → `{ type:'event', seq, eventId, eventType, sessionId?, summary, payload, createdAt }`（seq = agent_events.id，全局单调） |
| ack | 客户端 → `{ type:'ack', seqs: number[] }`（批量）；服务端置 event_deliveries.acked + 聚合 delivery_state 前进；REST `POST /v1/events/{id}/ack` 等效 |
| 心跳 | 服务端每 30s 发 ping；10s 内无 pong → 服务端关闭连接（客户端亦每 30s 发 ping 保活） |
| 断线重连 | 指数退避：1s → 2s → 4s → 8s → 16s → 32s → 封顶 60s，±20% jitter；连续失败 ≥10 次后 UI 提示手动重试；重连成功必发 `sync` 补齐缺口 |
| 预留帧 | 服务端 → `{ type:'token_rotation', newToken, tokenVersion }`（协议预留：客户端持久化新 Token 后回 ack，旧 Token 失效。v1 不暴露触发 UI，实际轮换路径 = 撤销重配，docs/15 §4） |

### B.3 配对流程时序

```
桌面 UI                Gateway(Main)                     Android
   │ agents:pairingCreate   │                                │
   ├────────────────────────► 签发 pairingId + 8 位码      │
   │ ◄─ { pairingId, code,  │ （同时仅 1 个活跃码；新码签发   │
   │     expiresAt=T+300s } │  即废旧码；审计落库）           │
   │   （码只在签发瞬间展示） │                                │
   │                        │ ◄─ POST /v1/pairing/claim ─────┤ 用户输入码
   │                        │   校验：码存在/未过期/未用/     │
   │                        │   限流内（失败 5 次 → 码作废）  │
   │                        │   → 生成 256bit Token，存 SHA-256
   │                        │ ►─ 200 { deviceId, token } ────┤ Keystore 入库
   │                        │   码即失效（一次性）            │
   │ ◄─ 设备出现在 agents:devices（active）                  │
```

### B.4 防重放与限流参数表

| 参数 | 值 | 说明 |
| --- | --- | --- |
| 时间戳窗口 | ±300s | 受保护请求必须带 `X-DevHub-Timestamp`（unix 秒）；窗口外 → 401 `AUTH_REPLAYED` |
| nonce 缓存 | 128-bit 随机，LRU 10 分钟 | 请求带 `X-DevHub-Nonce`；重复 → 401 `AUTH_REPLAYED`（`/v1/pairing/claim` 与 `/v1/health` 豁免 nonce——claim 以一次性码为防重放本体，health 无副作用） |
| 鉴权失败限流 | 同源 5 次/60s | 触发 → 429 `AUTH_RATE_LIMITED` + `Retry-After: 60`；审计落库 |
| 配对 claim 限流 | 同源 5 次/5min | 码爆破面收敛（docs/15 §2） |
| 常规请求限流 | 120 次/min/设备 | 超出 → 429 `AUTH_RATE_LIMITED` |

### B.5 指令幂等 / 过期语义（裁决 5）

- `idempotencyKey` 由客户端生成（建议 UUID）；`remote_commands.idempotency_key` UNIQUE。
- **同 key 重试**：返回原 command 的原结果（HTTP 202 + 原 commandId，不重复执行）。
- **同 key 异 payload**：409 `COMMAND_KEY_CONFLICT`（拒绝，防键冲突误吞指令）。
- **过期**：`expires_at = created_at + 300s`；到达仍未执行 → status=expired，
  再触发 → 409 `COMMAND_EXPIRED`；正在执行中的指令不受过期影响（已 accepted 的执行到底，
  结果照常回写 command.result 事件）。
- 执行链：REST 202（accepted，落库）→ L3 能力门/授权矩阵复检（docs/15 §5）→
  provider 执行 → `command.result` 事件（WS 推送 + 落库）。

---

## Part C：错误码（`src/shared/types.ts` ErrorCode 新增值）

结构统一 `{ code, message }`（约束 #14）；IPC 走 Result envelope，REST 走
`{ "error": { code, message } }` + HTTP 状态。Phase 1 既有枚举
（EXEC_TIMEOUT / EXEC_FAILED / CHANNEL_NOT_ALLOWED / NOT_FOUND / DB_ERROR / DEGRADED /
BAD_PAYLOAD / INTERNAL，docs/02 §3）不变，AC 域新增 17 值：

| code | HTTP | 语义 |
| --- | --- | --- |
| `AGENT_PROVIDER_UNAVAILABLE` | 503 | provider 未安装/数据源不可用（health_detail 携带原因） |
| `AGENT_PROVIDER_DISABLED` | 409 | 该 provider 监控被停用（总开关或单开关） |
| `AGENT_MONITOR_DISABLED` | 409 | 监控总开关关闭（agents_monitor_enabled=0） |
| `AGENT_CAPABILITY_MISSING` | 403 | 能力未真实验证/已过期（docs/12 §5 能力验证门） |
| `AGENT_SOURCE_UNREADABLE` | 503 | 会话/消息源读取失败（投影 stale，绝不猜实时态） |
| `GATEWAY_DISABLED` | 503 | gateway_enabled=0，远程面未启用 |
| `GATEWAY_PORT_IN_USE` | 503 | 端口占用且 8747–8755 顺延全失败 |
| `GATEWAY_LOCAL_ONLY` | 403 | 非回环来源访问仅限本机的端点 |
| `DEVICE_NOT_PAIRED` | 401 | 请求无有效设备身份 |
| `DEVICE_REVOKED` | 401 | 设备已撤销（Token 即拒） |
| `DEVICE_FORBIDDEN` | 403 | 越权（如撤销他设备） |
| `AUTH_INVALID_TOKEN` | 401 | Token 校验失败 |
| `AUTH_REPLAYED` | 401 | 时间戳窗口外 / nonce 重复 |
| `AUTH_RATE_LIMITED` | 429 | 触发限流（附 Retry-After） |
| `COMMAND_KEY_CONFLICT` | 409 | 同 idempotency_key 异 payload |
| `COMMAND_EXPIRED` | 409 | 指令过期（expires_at 已过） |
| `COMMAND_NOT_EXECUTABLE` | 403 | session_mode/授权矩阵不允许该动作 |

（BAD_PAYLOAD / NOT_FOUND / INTERNAL 复用既有枚举，语义不变。）

---

## Part D：通道职责对照表

| 面板 | 通道 | 模式 | AC 能力 |
| --- | --- | --- | --- |
| Renderer（Agents 视图） | `devhub:invoke` 白名单 13 条 `agents:` channel | **IPC 轮询**（无广播 channel；CSP `default-src 'self'` 零修订） | 全量：providers/sessions/messages/events/配对/设备/Gateway/诊断/控制动作 |
| Android（远程设备） | Gateway REST 13 端点 + WS `/v1/events` | **REST + WS 长连**（Bearer 设备 Token + 防重放 + 限流） | 受限子集：health/diagnostics/agents/sessions/messages/reply/actions/ack/自撤销 |
| MCP Client | `scripts/run-mcp.mjs` 既有 12 tools | **零改动**（docs/09 §10 计划的 4 个只读 tool 属遗留待办，不在 AC 范围；远程控制能力绝不进 MCP，docs/11 N4） | 无 AC 工具 |
