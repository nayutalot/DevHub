# DevHub ECS Relay 协议设计（docs/18）

> ECS Relay 改造的**协议权威**（Phase 2 设计批，2026-09-04）。回应 gaps **G5**（协议冻结）、
> **G4**（身份承载）、**G6**（事件字段/动作集）三条差距；基线事实见 `docs/ecs-relay-current-state.md`，
> 差距清单见 `docs/ecs-relay-gaps.md`，架构与身份模型见 docs/19，实施计划见 docs/20。
> 与 docs/14（现协议权威）的关系：**docs/14 对本地直连路径（Android ↔ 127.0.0.1:8746 Gateway）
> 继续完全有效、零改动**；本文定义的是 **Relay 模式（Android ↔ ECS ↔ Windows relayClient）** 的
> 新协议面，重叠语义一律以「兼容映射」（§10）呈现，不改 docs/14 任何行文语义。
> 约束基线同 docs/00（28 条合同对协议面的投影：结构化错误 #14、SQL 参数绑定 #11、日志脱敏 #13）。

---

## 1. 协议定位与设计原则

### 1.1 混合制（主控裁决落地）

| 面 | 形态 | 承载内容 | 依据 |
| --- | --- | --- | --- |
| **REST 面**（HTTPS，语义化路径） | 列表 / 详情 / 消息初载 | `/v1/health`、`/v1/agents`、`/v1/sessions`、`/v1/sessions/{id}`、`/v1/sessions/{id}/messages` —— 响应 JSON 形状与 docs/14 §B.1 **逐字段一致**（含 ux 批 A 的 `last/before/after` 分页、segments 可选分段、providerKey/Label/archivedAt） | G5 裁决：列表/详情/消息初载保留 REST，复用现投影与分页 |
| **WS 实时面**（WSS） | 16 消息集 | 事件推送、命令下发/回执、配对、同步补发、心跳、token 轮换、断连、错误 | G5 裁决：实时面走 WS 16 消息集 |

原则：**ECS 是转发/配对/心跳/ACK/sequence 镜像/离线缓存/审计面，不是事实源**。事件与命令的
事实源永远是 Windows 侧 SQLite（`agent_events` / `remote_commands`，docs/13 §4）；ECS 缓存只服务
断线补发与降级展示（见 docs/19 §5.4）。

### 1.2 两条腿与三种角色

```
Android 设备（device 角色）                          Windows relayClient（host 角色）
      │ WSS /relay/device（443，TLS 由反代终结）            │ WSS /relay/host（443，出站）
      ▼                                                    ▼
┌─────────────────────────── ECS Relay ───────────────────────────┐
│  device leg（设备腿）          │           host leg（主机腿）      │
└─────────────────────────────────────────────────────────────────┘
```

- **device leg**：Android ↔ ECS。鉴权 = `Authorization: Bearer <端到端设备 Token>`，ECS 以
  `sha256(token)` 比对自身设备注册表（docs/19 §2.1）——**ECS 只验「设备是注册过的」**。
- **host leg**：Windows relayClient ↔ ECS（**出站**，家庭 NAT 后零入站）。鉴权 =
  `Authorization: Bearer <Relay 凭据>`（每部署一份 256-bit，ECS 首次注册时签发，docs/19 §2.2）。
- 同一帧类型在两条腿上语义对称（如 `event` 在 host leg 是上行、device leg 是下行）；逐帧方向见 §3.0。

### 1.3 通用帧规则

1. **传输**：RFC 6455 文本帧，单帧/单消息上限 **1MB**（与 `gateway/ws.ts` 一致）；payload 一律
   JSON 对象，UTF-8；二进制帧 → 关闭（1003，ws.ts 同款纪律）。
2. **帧编解码蓝本**：ECS 侧复用 `gateway/ws.ts` 服务端编解码（服务端发送不掩码/客户端帧必掩码/
   close 回显/ping→pong）；relayClient 侧为**客户端编解码**（发送必掩码），解析逻辑镜像复用
   （差异点仅掩码方向，docs/19 §4.2）。
3. **关联键**：
   - `requestId`：客户端生成的 UUID，用于**帧级**请求-响应关联，响应帧原样回显；不落库。
   - `idempotencyKey`：命令的**业务幂等键**（Android 生成 UUID），落 `remote_commands`（Windows）
     与 `relay_commands`（ECS）双表，语义同 docs/14 §B.5。
   - `sequence`：全局单调事件序号，权威值 = Windows `agent_events.id`（AUTOINCREMENT，
     docs/13 §4.4）；ECS 镜像存储，绝不自行编号。
4. **绝不猜纪律**：帧字段解析失败/未知类型/未知枚举值 → 结构化 `error` 帧（或按严重度关闭连接），
   绝不猜测语义、绝不静默吞掉后当成功处理。
5. **脱敏前置**：凡跨 leg 的内容（事件 payload/summary、消息投影、命令 payload）在**离开 Windows 前**
   已按 docs/15 §6 完成脱敏（redact.ts 同源实现）；ECS 只经手已脱敏数据，自身不做二次脱敏、
   绝不在日志/审计中记录任何 Token/配对码明文（约束 #13）。

---

## 2. 连接与鉴权

| 项 | device leg（Android → ECS） | host leg（relayClient → ECS） |
| --- | --- | --- |
| 路径 | `wss://<relay>/relay/device` | `wss://<relay>/relay/host` |
| upgrade 鉴权 | `Authorization: Bearer <端到端 Token>`；无效/已撤销 → HTTP 401 拒绝升级（错误 JSON 形态同 docs/14 §B.2） | `Authorization: Bearer <Relay 凭据>`；无效 → 401 |
| 未配对例外 | 允许**无 Authorization**升级一条「裸连接」，但**首帧必须为 `pair` 且 10s 内发出**，否则服务端关闭（1000，`pair required`） | 不存在（relayClient 必持凭据；首装经一次性注册码换凭据，docs/19 §2.2） |
| 多连接 | 同设备允许多连接（与 ws.ts 注册表语义一致），撤销时全断 | 同主机允许多连接（滚动重启不互踢），撤销凭据时全断 |
| hello 首帧 | 升级成功后服务端首帧 `hello`（§3.1） | 同左 |
| 心跳 | 应用层 `heartbeat` 帧 30s 双向 + 传输层 ping/pong（服务端 30s 发 ping，10s 无 pong 关闭——ws.ts 参数不动） | 同左 |
| 撤销即断 | 桌面撤销 → host 通知 ECS 踢线（§3.15）→ 该设备全部连接立即服务端关闭，后续连接 401 | 凭据撤销（`relay_hosts.status=revoked`）→ 全部 host 连接关闭 |

TLS 终结在反代（Caddy/Nginx，443 唯一公网入口，`docs/ecs-security-group-policy.md` §2.1 T1）；
Relay 本体只绑 `127.0.0.1`。明文 `ws://` 仅限本地模式（docs/14 路径），Relay 模式客户端**必须拒绝**
非 `wss://` endpoint（G2/G7，docs/21 §1）。

---

## 3. WS 16 帧全表

### 3.0 总表

方向记号：`D→E` = Android→ECS；`E→D` = ECS→Android；`H→E` = relayClient→ECS；`E→H` = ECS→relayClient。
「中继」= 该帧经 ECS 校验路由后转发到另一条腿（ECS 不解释业务语义，仅补路由字段与落审计/缓存）。

| # | type | 方向 | 腿 | 中继 | 幂等键 | 超时 | 重试上限 | 用途 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `hello` | E→D / E→H | 各腿服务端首帧 | 否 | —（连接级） | — | —（连接级） | 连接建立、sequence 基准、心跳参数 |
| 2 | `pair` | D→E →（E→H） | device→host | 是 | pairingId（一次性码） | 15s | 5 次（同码，受失败 5 次作废约束） | 配对：码校验上移 ECS，Token 仍由 Windows 签发 |
| 3 | `pair_accepted` | H→E →（E→D） | host→device | 是 | requestId | —（响应帧） | — | 配对成功：端到端 Token 一次性下发 |
| 4 | `agent_list` | D→E →（E→H）/ H→E →（E→D） | 双向中继 | 是 | requestId | 10s | 1 次（无副作用，可重发） | provider 列表（REST /v1/agents 的帧形态） |
| 5 | `session_list` | 同 #4 | 双向中继 | 是 | requestId | 10s | 1 次 | 会话列表（含 ECS 缓存 stale 降级） |
| 6 | `event` | H→E →（E→D） | host→device | 是 | eventId + sequence | —（推送帧） | 断线由 sync 补发 | 事件推送（§4 投影规则） |
| 7 | `message` | D→E →（E→H）/ H→E →（E→D） | 双向中继 | 是 | requestId | 10s | 1 次 | 消息分页取数（REST messages 的帧形态） |
| 8 | `command` | D→E →（E→H） | device→host | 是 | idempotencyKey | 10s（等 command_ack） | 3 次（同 key，退避 2s/4s/8s） | 命令下发（§5） |
| 9 | `command_ack` | H→E →（E→D） | host→device | 是 | idempotencyKey | —（响应帧） | — | 受理回执（对应 REST 202/4xx；ECS 排队时 `queued:true`） |
| 10 | `command_result` | H→E →（E→D） | host→device | 是 | commandId | —（推送帧） | — | 终态回执（与 `command.result` 事件双通道，按 commandId 去重） |
| 11 | `sync_request` | D→E（E→H 转发 ack 部分） | device→host | 部分 | after 游标（累计幂等） | 15s | 3 次 | 断线补同步 + **累计 ACK**（§6） |
| 12 | `sync_response` | E→D（H→E = 对齐探测） | 双向 | 部分 | requestId | —（响应帧） | — | 补发事件页（页上限 100，hasMore 翻页） |
| 13 | `heartbeat` | 双向 × 两腿 | 保活 | 否 | —（lastAckedSeq 累计幂等） | 30s 周期；连丢 2 帧判死 | — | 应用层保活 + ACK 进度 + 上游状态信标 |
| 14 | `token_rotation` | H→E →（E→D） | host→device | 是 | tokenVersion 单调 | 300s 确认宽限 | — | 轮换端到端 Token（docs/15 §3 预留帧转正） |
| 15 | `disconnect` | 双向 × 两腿 | 优雅关闭 | 部分（携 deviceId 时定点） | — | — | — | 关闭前告知原因（撤销/维护/被替代） |
| 16 | `error` | 双向 × 两腿 | 错误 | 否 | requestId（可关联） | — | — | 结构化错误（§8 映射表） |

### 3.1 hello（服务端首帧）

```json
// E→D（device leg）
{
  "type": "hello",
  "sequence": 14871,          // ECS 缓存中该设备可见的最高 sequence（= Windows 全局 sequence 镜像）
  "deviceId": 4,              // ECS 设备注册表 id（连接已鉴权时；裸 pair 连接缺省）
  "heartbeatSec": 30,
  "relayVersion": "1.0.0",
  "upstream": "connected"     // host leg 连接态：connected | disconnected（降级模式信标，§7.3）
}
// E→H（host leg）：字段相同，deviceId 换为 hostId；sequence = ECS 缓存最高 sequence
//   → relayClient 据此判定断线期事件回填起点（docs/19 §4.3）
```

### 3.2 pair（配对请求）

```json
// D→E（device leg，裸连接首帧）
{
  "type": "pair",
  "requestId": "uuid-…",
  "code": "A3K7M9XY",          // 8 位 Crockford Base32（docs/15 §2 语义原样上移）
  "deviceName": "Pixel 8",
  "platform": "android",       // 强制 android（与现 pairing.ts 一致）
  "clientVersion": "1.0.0"
}
// E→H（host leg 中继；ECS 已完成码校验，明文码不出 device leg）
{
  "type": "pair",
  "requestId": "uuid-…",
  "ecsDeviceId": 7,            // ECS 已登记的设备行（pair_accepted 时绑定）
  "pairingId": "pair-…",       // Windows 签发，ECS 原样回传供 Windows 校验
  "deviceName": "Pixel 8",
  "platform": "android"
}
```

校验归属与参数（全部沿用现值，G4 裁决「配对码语义上移 ECS」）：

| 校验 | 执行方 | 参数（不变） |
| --- | --- | --- |
| 码存在 / TTL 300s / 一次性 / 新码废旧码 | **ECS**（`pairing_codes` 表） | `PAIRING_TTL_SEC=300`、同时至多 1 活跃码 |
| 失败 5 次码作废 | **ECS**（fail_count） | `PAIRING_MAX_FAILURES=5` |
| claim 限流 5 次/5min/源 | **ECS**（替代现 Gateway 同源限流） | `CLAIM_LIMIT` 同参 |
| pairingId 活性 / Token 签发 / token_hash 落库 | **Windows**（L3，`remote_devices` 新行 `origin='relay'`） | 256-bit Token base64url，明文仅此一次 |

### 3.3 pair_accepted（配对成功）

```json
// H→E（Windows → ECS；ECS 记录 sha256(deviceToken) 后转发）
{
  "type": "pair_accepted",
  "requestId": "uuid-…",
  "ecsDeviceId": 7,
  "device": { "deviceId": 12, "deviceName": "Pixel 8", "platform": "android", "tokenVersion": 1 },
  "deviceToken": "<256-bit base64url>",   // 端到端 Token：唯一一次明文过境（红线：ECS 不落盘不落日志，docs/19 §3）
  "gatewayName": "devhub-gateway"
}
// E→D（去掉 ECS 内部字段后的设备视图）
{
  "type": "pair_accepted",
  "requestId": "uuid-…",
  "deviceId": 12,
  "deviceToken": "<256-bit base64url>",
  "tokenVersion": 1,
  "heartbeatSec": 30
}
```

失败路径：任何一步失败 → E→D `error { requestId, code, message }`（码错/过期/作废/限流的 code 见 §8.2）。
`deviceToken` 明文出现在帧中的**全部时刻** = 配对响应 + token_rotation 帧两种（红线受控面，docs/19 §3 W-R3）。

### 3.4 agent_list

```json
// D→E（= REST GET /v1/agents 的帧形态；Android v1 首选 REST 直连，本帧为 ECS↔host 的承载 + 可选客户端用法）
{ "type": "agent_list", "requestId": "uuid-…" }
// H→E → E→D 响应体 = docs/14 §B.1 GET /v1/agents 响应 JSON 原样内嵌
{ "type": "agent_list", "requestId": "uuid-…",
  "providers": [ { "id": "codex", "displayName": "Codex", "health": "ok",
                   "capabilities": { "mode": "managed", "granted": ["reply","pause","resume"],
                                     "verifiedAt": 1757000000, "evidence": "app-server handshake ok" } } ] }
```

### 3.5 session_list

```json
// D→E：query 语义 = REST GET /v1/sessions（providerId?/status?/limit?/parentId?/includeArchived?，docs/14 §B.1）
{ "type": "session_list", "requestId": "uuid-…",
  "query": { "providerId": "codex", "limit": 100 } }
// 响应：sessions 数组元素 = SessionView（docs/14 §B.1，含 providerKey/providerLabel/archivedAt 可选附加）
{ "type": "session_list", "requestId": "uuid-…", "stale": false,
  "sessions": [ { "id": 337, "providerId": "codex", "nativeId": "…", "sessionMode": "managed",
                  "status": "waiting_input", "title": "…", "lastActivityAt": 1757000000 } ] }
```

`stale:true` 仅出现在 host leg 断开时由 ECS 缓存元数据降级应答（§7.3）；此时 ECS 只答缓存中有
元数据的字段，缺失字段缺省，**绝不构造猜测值**。

### 3.6 event（事件帧，投影规则见 §4）

```json
// H→E（deviceId 可省略，ECS 扇出时填充）→ E→D（deviceId 必填）
{
  "type": "event",
  "sequence": 14871,            // = agent_events.id（原帧 seq 改名，§10 映射）
  "eventId": "codex:<native>:session.waiting_input:<16hex>",
  "deviceId": 4,                // 目标设备（ECS 扇出填充；现协议该信息在 event_deliveries 表，G6 差距项）
  "provider": "codex",          // 自 agent_events.provider_id 投影（现帧无此字段，G6 差距项）
  "sessionId": 337,
  "type": "session.waiting_input",   // = 原 eventType 改名
  "timestamp": 1757000000,      // = 原 createdAt 改名（unix 秒）
  "summary": "Codex 会话等待输入（≤120 字符脱敏摘要）",
  "payload": { "sessionId": 337, "status": "waiting_input" },   // 已脱敏、有界（≤4KB）
  "requiresUserAction": true    // §4.2 投影规则
}
```

### 3.7 message

```json
// D→E：取数语义 = REST GET /v1/sessions/{id}/messages（after/last/before 互斥 → BAD_PAYLOAD，ux A R10）
{ "type": "message", "requestId": "uuid-…", "sessionId": 337, "last": 200, "limit": 200 }
// 响应体 = REST messages 响应 JSON 原样内嵌（items[].contentRedacted，可选 segments；绝无 sourceRef）
{ "type": "message", "requestId": "uuid-…",
  "items": [ { "id": 9001, "role": "assistant", "contentRedacted": "…", "occurredAt": 1757000000,
               "segments": [ { "kind": "thinking", "content": "…" } ] } ],
  "prevAfter": 8800 }
```

### 3.8 command（命令帧，端到端 Bearer 内嵌）

```json
// D→E → E→H
{
  "type": "command",
  "requestId": "uuid-…",
  "idempotencyKey": "uuid-…",        // 业务幂等键（同 key 重试返回原结果，docs/14 §B.5）
  "sessionId": 337,
  "action": "send_message",          // send_message | approve | pause | resume | interrupt（§5.1 映射）
  "payload": { "text": "继续" },     // send_message 必带非空 ≤4000；approve 带 decision（§6）；其余缺省
  "auth": {                          // 端到端 Bearer 内嵌（G4 裁决③）——ECS 不解释、只转发
    "token": "<端到端 256-bit Token>",
    "ts": 1757000000,                // = X-DevHub-Timestamp 语义（±300s 窗口，docs/14 §B.4）
    "nonce": "<128-bit 随机>"        // = X-DevHub-Nonce 语义（Windows 侧 LRU 10min 去重）
  },
  "createdAt": 1757000000            // 客户端时刻；Windows 按 expires_at = created_at + 300s 复核（以 Windows 时钟为准）
}
```

- **ECS 不校验 `auth`**（它无法也不应解释）；ECS 仅按连接态确认「设备已注册」，把命令原样中继并存入
  `relay_commands` 幂等表（脱敏后 payload，G9）。防重放/Token 校验/能力门/幂等/过期**全部在 Windows**
  ——这是「ECS 被攻破也伪造不了指令」的协议根（docs/19 §3 论证）。
- 超时未收到 `command_ack`：同 `idempotencyKey` 重试（2s/4s/8s，3 次后放弃转离线队列——Android
  QueueReplay 现有机制）；重连后按序补发，Windows 幂等去重兜底。

### 3.9 command_ack（受理回执）

```json
// H→E → E→D：对应 REST 202/4xx 语义
{ "type": "command_ack", "requestId": "uuid-…", "idempotencyKey": "uuid-…",
  "commandId": "cmd-<uuid>", "status": "accepted" }
// 受理被拒（能力门/授权矩阵/校验失败）：
{ "type": "command_ack", "requestId": "uuid-…", "idempotencyKey": "uuid-…",
  "commandId": "cmd-<uuid>", "status": "rejected", "errorCode": "AGENT_CAPABILITY_MISSING" }
// host 断线期间 ECS 排队受理（Windows 尚未见到该命令）：
{ "type": "command_ack", "requestId": "uuid-…", "idempotencyKey": "uuid-…",
  "status": "accepted", "queued": true }
```

`queued:true` 是 Relay 新增语义（docs/14 无对应物）：ECS 以 `(deviceId, idempotencyKey)` 去重，
同 key 重复 command 在排队态返回同一 `queued` 应答（幂等）；Windows 上线后按序投递，终态经
`command_result` 回流。排队上限：每设备 100 条、全局 1000 条（超出 → `error RELAY_QUEUE_FULL`）。

### 3.10 command_result（终态回执）

```json
// H→E → E→D（镜像 remote_commands 终态；同一终态同时以 command.result 事件走 §3.6 事件帧——按 commandId 去重）
{ "type": "command_result", "commandId": "cmd-<uuid>", "idempotencyKey": "uuid-…",
  "sessionId": 337, "action": "send_message", "status": "executed",       // executed|rejected|expired|failed
  "errorCode": null, "timestamp": 1757000100 }
```

双通道去重规则：Android 以 `commandId` 为键保留**先到者**，后到者仅刷新时间戳；事件流中的
`command.result` 历史行不受影响（Room 缓存幂等 upsert，现机制）。

### 3.11 sync_request（补同步 + 累计 ACK）

```json
// D→E：after = 本机已持久处理（Room 已落）的最高 contiguous sequence
{ "type": "sync_request", "requestId": "uuid-…", "after": 14800 }
// E→H（仅 ACK 部分中继）：ECS 通知 relayClient「设备已确认 ≤ after」→ Windows markEventAcked
{ "type": "sync_request", "requestId": "uuid-…", "after": 14800, "deviceId": 4 }
```

- 语义对现协议的变化：现 `sync`（客户端→服务端单向）+ `ack {seqs[]}`（批量 ≤500）两帧，在 Relay
  面合并为**累计游标**一帧（映射表见 §10）。累计游标是 `ack seqs[]` 的超集：`after = max(连续已处理)`；
  事件按 leg 内 TCP 有序到达，无乱序空洞；若 ECS 缓存本身有洞（§6.3），以 `hasGaps` 显式标注。
- 设备本地尚未持久化的事件**不得**计入 `after`（ACK 只前进语义与现 `delivery_state` 一致，docs/12 §6）。

### 3.12 sync_response

```json
// E→D：按 sequence > after 升序补发，页上限 100（= EVENTS_SINCE_DEFAULT_LIMIT，现值不动）
{ "type": "sync_response", "requestId": "uuid-…", "upTo": 14860, "hasMore": true, "hasGaps": false,
  "events": [ { …event 帧完整形态… } ] }
// H→E（host 腿对齐探测；host 不消费事件，恒空页）
{ "type": "sync_response", "requestId": "uuid-…", "upTo": 14871, "hasMore": false, "events": [] }
```

客户端循环：`after = upTo` 再发 `sync_request` 直到 `hasMore:false`。`hasGaps:true`（缓存洞，
host 曾离线且事件未回填/已被淘汰）→ 事件缺口的权威补齐在 Windows 侧 DB；设备侧应对 =
触发一次 `session_list` + 当前会话 `message` 刷新（REST 面），并以 UI 降级提示——**绝不静默跳号**。

### 3.13 heartbeat（应用层保活 + 状态信标）

```json
// 双向 × 两腿，30s 周期（= hello.heartbeatSec；传输层 ping/pong 并行保留，参数同 ws.ts 30s/10s）
// D→E
{ "type": "heartbeat", "ts": 1757000000, "lastAckedSeq": 14800, "tokenVersion": 1 }
// E→D
{ "type": "heartbeat", "ts": 1757000000, "upstream": "connected", "queuedCommands": 0 }
// H→E / E→H
{ "type": "heartbeat", "ts": 1757000000, "lastSentSeq": 14871 }   // host 上行进度 / ECS 对 host 恒回 ack 进度
```

- 判死规则：连续 2 帧（≈60s）未收到对端 heartbeat，或传输层 10s 无 pong → 关闭（两者取先）。
- `lastAckedSeq` 是 §3.11 累计 ACK 的周期性兜底（防 sync_request 丢失）；ECS 取 max 只前进。
- `tokenVersion` 兼作 token_rotation 的确认信道（§3.14）。
- `upstream:"disconnected"` 是降级信标：设备据此切换 UI 状态（命令走排队、REST 只读缓存降级，§7.3）。

### 3.14 token_rotation（预留帧转正，docs/15 §3）

```json
// H→E → E→D（Windows 发起：配对完成自动轮换 / 用户触发 / 周期轮换 backlog）
{ "type": "token_rotation", "requestId": "uuid-…",
  "newToken": "<256-bit base64url>", "tokenVersion": 2, "reason": "post-pairing" }
```

- Android 收帧：Keystore **原子更新**（写入失败保留旧值并按旧值继续重连）；随后下一帧 `heartbeat`
  携带新 `tokenVersion` 即为确认。
- ECS 转发同时更新注册表 `token_hash = sha256(newToken)`、`token_version`（两平面凭据同步，docs/19 §2.4）。
- 宽限：旧 Token 自帧发出起 **300s** 后失效（窗口内旧连接不断）；确认超时未观察到新 tokenVersion →
  维持新 Token 生效（Windows 单哈希列，无回滚位），设备将 401 → 走重配对路径（与现「撤销重配」等价，
  docs/15 §3）；该结果审计落库（Windows 与 ECS 双侧 `device` 类目）。
- Windows 侧落库：`remote_devices.token_hash` 覆盖 + `token_version+1`（现 schema 已备字段，
  零 migration）。

### 3.15 disconnect（优雅关闭）

```json
// E→D / E→H（关闭前告知）
{ "type": "disconnect", "reason": "server_shutdown" }        // server_shutdown|maintenance|superseded
// H→E（撤销定点踢线：桌面 deviceRevoke → relayClient 通知 ECS）
{ "type": "disconnect", "deviceId": 4, "reason": "revoked" }
// E→D（被踢设备收到的最后一帧）
{ "type": "disconnect", "reason": "revoked" }
```

`disconnect` 后必须紧跟 WS close 帧（code 1000）；对端收到后**不得**对 `reason:"revoked"` 做自动重连
（其余 reason 按退避重连）。撤销链路闭环：L3 revoke → 本地 `closeDeviceConnections`（现缝）+
relayClient `disconnect{deviceId,reason:'revoked'}` → ECS 踢线 + `relay_devices.status=revoked` →
该设备后续连接 401（错误码映射 §8.2 `DEVICE_REVOKED`）。设备自撤销（REST DELETE 代理路径）同链路反向生效。

### 3.16 error（结构化错误帧）

```json
{ "type": "error", "requestId": "uuid-…",            // requestId 可省（连接级错误）
  "code": "RELAY_UPSTREAM_OFFLINE",
  "message": "host offline; try again later",        // 零凭据零堆栈（约束 #14）
  "retryable": true, "retryAfterSec": 30 }
```

错误码全集与 docs/14 Part C 的映射见 §8。协议级违规（非 JSON、未知 type、字段类型错）→
`error` 帧 + 关闭（1002/1003，ws.ts 同款状态码语义）；业务级错误只回 `error`/`*_ack` 帧不断连。

---

## 4. 事件帧投影规则（G6）

### 4.1 字段映射（现帧 → Relay 事件帧）

| 现帧字段（docs/14 §B.2 / ws.ts） | Relay 字段 | 变化 |
| --- | --- | --- |
| `seq` | `sequence` | 改名（值不变，= agent_events.id） |
| `eventId` | `eventId` | 不变 |
| `eventType` | `type` | 改名 |
| `sessionId?` | `sessionId` | 不变（可缺省） |
| `summary?` | `summary` | 不变 |
| `payload` | `payload` | 不变（已脱敏、有界） |
| `createdAt` | `timestamp` | 改名 |
| —（在 event_deliveries 表达） | `deviceId` | **新增**：ECS 扇出时填充目标设备 id |
| —（投影自 provider_id） | `provider` | **新增**：事件所属 provider 业务键 |
| —（由 waiting_input 隐含） | `requiresUserAction` | **新增**：显式布尔（§4.2） |

### 4.2 requiresUserAction 投影规则（白名单制，绝不猜）

| event `type` | payload 条件 | `requiresUserAction` |
| --- | --- | --- |
| `session.waiting_input` | `payload.status ∈ {waiting_input, approval_required}` | **true** |
| 其余全部 6 类（`session.started / session.status_changed / session.finished / message.appended / provider.health_changed / command.result`） | 任意 | **false** |

- 规则为**白名单**：未来新增事件类型缺省 false，只有再次裁决扩表才可为 true——延续「绝不猜」。
- 与**通知触发规则**（docs/12 §6 语义 6）显式分离：通知 = `session.waiting_input`（两种 status）
  ∪ `session.status_changed` 且 `to ∈ {completed, failed}`；`requiresUserAction` 只表达「等待用户
  动作」。两者重叠面 = waiting_input 类；`status_changed→completed/failed` 通知但不要求动作。
- Android 侧用途：通知文案区分「等待输入 / 等待批准」（approval_required）、详情页 banner、
  （G6 落地后）approve 按钮的显隐前提之一（docs/19 §6）。

---

## 5. 命令面（action 映射与门控）

### 5.1 action 集与现 {reply, pause, resume} 的映射

| Relay action | 现协议对应 | Windows 执行通道 | 门控 |
| --- | --- | --- | --- |
| `send_message` | `reply`（≡ 改名映射） | L3 `submitRemoteCommand` → provider sendReply（REST /reply 同源） | `reply ∈ granted`（现状） |
| `pause` | `pause` | 同上（actions 通道） | `pause ∈ granted` |
| `resume` | `resume` | 同上 | `resume ∈ granted` |
| `approve` | **不存在**（新增） | 协议/ECS 透传支持；Windows 通道按 G6 门控实现 | **默认不授予**：仅对「判定源真实验证存在」的 provider 开放（当前仅 kimi `interaction.request` 语料证实），docs/19 §6 |
| `interrupt` | **不存在**（新增；codex `turn/interrupt` 通道已实证在 158 方法清单内） | 同上（executeCommand 持久连接） | 同 approve 门控流程；活跃 turn 打断真实效果未验证（ac8 未执行），授予前必须补验 |

- `payload.decision`（仅 approve）：`'allow' | 'deny'`。deny（拒绝批准）为 approve 的伴生语义；
  协议面保留，Windows 授予门前 deny/allow 一起门控（reject 语义的用户裁决项见 docs/21 §5.1）。
- `remote_commands.action` CHECK 值域、Gateway actions 白名单、ControlGate granted 五档→七档的
  联动扩展，属实现批次范围（值域变化非新增 channel，IPC 白名单 68 条不动）——见 docs/20 §2 R1。
- 风险声明（G6，最高风险项）：**approve 错误授予 = 远程代批**。在判定源/执行通道双双真实验证通过
  并经主控复核前，`approve`/`interrupt` 对全部 provider 恒 `AGENT_CAPABILITY_MISSING`——与
  「无判定源即恒不授予」的既有能力验证门同一纪律（docs/12 §5）。

### 5.2 幂等 / 过期 / 时序

| 项 | 值 | 说明 |
| --- | --- | --- |
| 幂等键 | `(deviceId, idempotencyKey)` UNIQUE（ECS `relay_commands`）+ `idempotency_key` UNIQUE（Windows `remote_commands`） | 同 key 重试返回原结果；同 key 异 payload → `COMMAND_KEY_CONFLICT`（docs/14 §B.5 语义原样） |
| TTL | `expires_at = Windows 收帧时刻 + 300s` | 过期 → `expired`，`error COMMAND_EXPIRED`；已 accepted 的执行到底 |
| 受理时序 | command → command_ack（10s 内）→ … → command_result | 终态同时落 `command.result` 事件（事实源不变） |
| host 离线 | ECS 排队（`queued:true`，上限 §3.9） | 重连后按 `requested_at` 序投递；投递前过期的直接置 `expired` 回流 |
| 执行结果安全 | Windows L3 能力门 + 授权矩阵**二次校验**（resolveCommandGate，现状不动） | UI 门是第一道，服务端拒绝才是合同（docs/15 §5） |

---

## 6. 同步与 ACK 语义（断线补发）

### 6.1 sequence 权威与基准对齐

1. 权威 sequence = Windows `agent_events.id`；ECS `relay_events.sequence` 为镜像（UNIQUE，幂等插入，
   host 重发去重）。
2. 连接建立（hello）后的对齐规则（设备侧）：
   - `hello.sequence > 本地 maxSeq` → 发 `sync_request {after: 本地 maxSeq}` 补齐；
   - `hello.sequence ≤ 本地 maxSeq` → **本地为准**，发 `sync_request {after: 本地 maxSeq}`（应答空页），
     不回退本地游标（防 ECS 缓存重置倒灌）。
3. 事件帧处理次序固定：**先落 Room（持久）→ 再推进 after（sync_request/heartbeat）**——与现
   「先写库后投递、未确认不删」同构（docs/12 §6 裁决 5 的客户端镜像）。

### 6.2 累计 ACK 与 Windows 侧回写

`sync_request {after}` / `heartbeat {lastAckedSeq}` 到达 ECS → ECS 更新 `relay_event_acks`（只前进）
→ 中继 `sync_request {after, deviceId}` 到 host → relayClient 调 L3 批量 `markEventAcked(≤after,
deviceId)`。Windows `event_deliveries` 的 `pending→delivered→acked` 状态机与「未确认事件绝不删除」
不变式**原样生效**（relay 设备在 `remote_devices` 有行，投递粒度天然成立，G3/G9）。

### 6.3 缓存洞（hasGaps）

洞的成因：host 离线窗口内事件尚未回填（docs/19 §4.3 回填在先，洞应趋零）或缓存按 TTL/容量淘汰
（docs/19 §5.4）。`hasGaps:true` 时设备侧以 REST 刷新权威状态，事件流缺口**显式降级展示**，绝不
伪造连续性。

---

## 7. REST 面（HTTPS，ECS 终结）

### 7.1 端点表（v1 范围）

| 端点 | 方法 | 鉴权 | ECS 行为 | 响应 |
| --- | --- | --- | --- | --- |
| `/v1/health` | GET | 无 | Relay 自身活性 | `200 {ok:true, name:"devhub-relay", version, uptimeSec, upstream:{connected:bool}, uptime 兼容字段}`——与现 health 形状字段兼容（超集） |
| `/v1/agents` | GET | Bearer（注册表校验） | 中继为 `agent_list` 帧 → host → 原样回传 | `200 {providers:[…]}`（docs/14 §B.1 同形状） |
| `/v1/sessions` | GET | Bearer | 中继为 `session_list` 帧；host 离线 → 缓存 stale 降级（`X-DevHub-Stale: true` 头 + 会话行仅缓存字段） | `200 {sessions:[SessionView…]}` |
| `/v1/sessions/{id}` | GET | Bearer | 中继（无独立帧——以 `session_list {sessionId}` 语义承载，实现可合并） | `200 {session, capabilities}` |
| `/v1/sessions/{id}/messages` | GET | Bearer | 中继为 `message` 帧；query `after/last/before/limit` 语义与互斥规则**逐字复用** docs/14 §B.1（ux A R10） | `200 {items:[…], nextAfter?, prevAfter?}`（绝无 sourceRef） |

### 7.2 明确不在 ECS REST 面的动作（v1 范围裁决）

| 动作 | Relay 面的承载 | 说明 |
| --- | --- | --- |
| 配对 claim | WS `pair`/`pair_accepted` | §3.2/§3.3；ECS 无 REST claim 端点 |
| reply / pause / resume（+ approve/interrupt） | WS `command` | 实时面走 WS（G5 混合制裁决）；对 ECS REST POST → `405 {error:{code:"RELAY_REST_READONLY"}}` |
| 事件 ack | WS `sync_request`/`heartbeat` 累计游标 | REST `POST /v1/events/{id}/ack` 不在 ECS 开放 |
| 设备管理 / 诊断 / 归档删除 / spawn | **v1 不开放**（本地模式功能） | 防线等价：桌面侧全功能保留；设备遗失场景由桌面撤销覆盖（docs/21 §5.3 记录扩展 backlog） |

范围理由：ECS 面收敛到「核心控制环」（配对/观察/通知/回复/暂停恢复），最小化「经中继的写面」，
与「ECS 只做转发」及 2C2G 容量预算一致（docs/19 §5.5）；后续批次按同一帧机制扩 `rest_proxy`
帧族即可（backlog，协议形态不变）。

### 7.3 降级行为（host leg 断开时）

| 请求 | 行为 |
| --- | --- |
| GET /v1/agents、/v1/sessions/{id}、messages | `503 {error:{code:"RELAY_UPSTREAM_OFFLINE", retryAfterSec:30}}` |
| GET /v1/sessions（列表） | `200` + `X-DevHub-Stale: true`，内容 = ECS 缓存元数据投影（缺失字段缺省，绝不构造） |
| WS command | 排队（`queued:true`，§3.9） |
| 事件流 | 无新事件；重连后由 host 回填 + 设备 sync 补齐（docs/19 §4.3） |

### 7.4 REST 鉴权与防线（与 docs/14 §B.4 同参）

`Authorization: Bearer <端到端 Token>`（ECS 注册表校验：sha256 比对 + status=active）+
`X-DevHub-Timestamp`（±300s）+ `X-DevHub-Nonce`（LRU 10min，ECS 侧去重；豁免 `/v1/health`）+
限流（鉴权失败 5 次/60s/源；常规 120 次/min/设备；429 `AUTH_RATE_LIMITED`）。ECS 校验通过后中继
**不重放这些头**给 host——host 腿信任边界 = Relay 凭据认证的 host 连接；命令帧的端到端防重放由帧内
`auth{ts,nonce}` 在 Windows 落地（§3.8）。

---

## 8. 错误码映射（error 帧 / HTTP ↔ docs/14 Part C）

### 8.1 统一形态

REST 面：`{ "error": { "code", "message" } }` + HTTP 状态（docs/14 Part C 原样）。WS 面：`error` 帧
（§3.16），`code` 取值同一命名域。零堆栈零凭据（约束 #13/#14）。

### 8.2 映射表

| code | HTTP（REST 面） | WS error 帧 | 语义与归属 |
| --- | --- | --- | --- |
| `AUTH_INVALID_TOKEN` | 401 | error + 升级拒绝 | Token 校验失败（ECS 注册表 / Windows 双侧同码） |
| `DEVICE_REVOKED` | 401 | error + disconnect(revoked) | 撤销即拒（两平面各自维护状态，语义同码） |
| `DEVICE_NOT_PAIRED` | 401 | error | 无有效设备身份 |
| `AUTH_REPLAYED` | 401 | error | 时间窗/nonce 重放（REST=ECS 面；命令帧=Windows 面） |
| `AUTH_RATE_LIMITED` | 429 | error（retryAfterSec） | 限流（参数同 docs/14 §B.4） |
| `BAD_PAYLOAD` | 400 | error / close 1002 | 帧字段缺失/类型错/取数参数互斥 |
| `NOT_FOUND` | 404 | error | 会话/资源不存在 |
| `AGENT_CAPABILITY_MISSING` | 403 | command_ack(rejected) | 能力未验证/过期（含 approve/interrupt 默认全拒） |
| `COMMAND_NOT_EXECUTABLE` | 403 | 同上 | session_mode/授权矩阵不允许 |
| `COMMAND_KEY_CONFLICT` | 409 | 同上 | 同幂等键异 payload |
| `COMMAND_EXPIRED` | 409 | 同上 | TTL 300s 已过 |
| `AGENT_PROVIDER_UNAVAILABLE` / `AGENT_MONITOR_DISABLED` / `AGENT_PROVIDER_DISABLED` / `AGENT_SOURCE_UNREADABLE` | 503/409/409/503 | 同码透传 | Windows 侧原码中继，ECS 不改写 |
| `GATEWAY_DISABLED` | 503 | 同码透传 | host 侧本地 Gateway 未启用（relay 模式前置条件，docs/19 §4.8） |
| `INTERNAL` | 500 | error | 兜底 |
| `PAIRING_INVALID_CODE` | 400 | error | **新码**：码不存在/不对（计入失败 5 次） |
| `PAIRING_CODE_EXPIRED` | 400 | error | **新码**：TTL 300s 已过 |
| `PAIRING_CODE_VOIDED` | 400 | error | **新码**：失败 5 次作废/新码废旧码 |
| `RELAY_UPSTREAM_OFFLINE` | 503 | error（retryable） | **新码**：host leg 断开 |
| `RELAY_UPSTREAM_TIMEOUT` | 504 | error（retryable） | **新码**：host 应答超时（帧超时表 §3.0） |
| `RELAY_REST_READONLY` | 405 | error | **新码**：该动在 Relay 面须走 WS（§7.2） |
| `RELAY_QUEUE_FULL` | 503 | error | **新码**：命令排队超上限（§3.9） |
| `RELAY_DEVICE_UNKNOWN` / `RELAY_HOST_UNKNOWN` | 401 | error + 升级拒绝 | **新码**：注册表/凭据表中无此身份 |

新码为 Relay 域**新增值**（append-only 精神，不改 docs/14 Part C 任何既有码的语义与 HTTP 映射）；
`docs/18` 为其权威定义点，实现批次在 `src/shared/types.ts` ErrorCode 同步追加（docs/20 §2 R1）。

---

## 9. 时序图

### 9.1 配对（Relay 版，对照 docs/14 §B.3）

```
桌面 UI              relayClient            ECS Relay                 Android
   │ agents:pairingCreate(IPC,不变)  │              │                        │
   ├──────────────► L3 签发 pairingId+8位码         │                        │
   ├──────────────► registerPairing ───► pairing_codes 落表（hash）          │
   │ ◄─ {pairingId, code, TTL 300s} │              │                        │
   │ （码只在签发瞬间展示）           │              │                        │
   │                                │              │ ◄─ WSS 裸连接 ─────────┤
   │                                │              │ ◄─ pair{code,…} ───────┤
   │                                │              │ 校验 TTL/一次性/限流/5次 │
   │                                │ ◄─ pair{pairingId, ecsDeviceId} ─────│（中继）
   │                                │ L3 复核 pairingId → 签发 256-bit Token │
   │                                │ 落 remote_devices(origin='relay')     │
   │                                ├─ pair_accepted{deviceToken} ─► 存 sha256│
   │ ◄─ 设备出现在 agents:devices    │              ├─ pair_accepted{deviceToken} ─► Keystore │
   │                                │              │                        │ 随后自动：
   │                                │（post-pairing token_rotation，§9.4）   │
```

### 9.2 命令往返（send_message，host 在线）

```
Android                 ECS Relay                    relayClient                Windows L3 / Gateway
   │ command{action:'send_message',                     │                          │
   │  idempotencyKey:K, auth{token,ts,nonce}}           │                          │
   ├──────────► relay_commands 落表(脱敏)               │                          │
   │            ── command 原样中继 ──►                 │                          │
   │                              │            auth 校验(authenticateBearerToken      │
   │                              │            + ts/nonce 防重放，docs/14 §B.4)       │
   │                              │            ── submitRemoteCommand ──► 能力门二次校验 │
   │                              │            ◄─ {commandId, accepted} ──┐            │
   │ ◄─ command_ack{commandId, accepted} ─┘              │                          │
   │                              │            provider 执行（stdin/app-server）      │
   │                              │ ◄─ command_result{executed} ──────┤（remote_commands 终态）
   │ ◄─ command_result ───────────┤                                   │
   │ ◄─ event{type:'command.result'} ─┘（同一终态的事件流副本，按 commandId 去重）
```

### 9.3 断线补同步（Android 断网 → 重连）

```
Android                    ECS Relay                        relayClient/Windows
   │ （断网期间事件 seq=14861..14871 在 Windows 落库；host 在线 → 实时推 ECS 缓存）
   │ 重连 WSS → hello{sequence:14871}                    │
   ├─ sync_request{after:14860} ──► relay_events 查 >14860
   │ ◄─ sync_response{events[14861..14871], hasMore:false}│
   │ 先落 Room → heartbeat{lastAckedSeq:14871} ──► acks 只前进
   │                                 ── sync_request{after:14871, deviceId} ──► markEventAcked
```

### 9.4 token 轮换（post-pairing 自动 + 通用流程）

```
relayClient/Windows               ECS Relay                    Android
   │ L3 生成新 Token；token_hash 覆盖、token_version+1        │
   ├─ token_rotation{newToken, v2} ──► 转发 + 注册表同步 hash ──► Keystore 原子更新
   │                                │ ◄─ heartbeat{tokenVersion:2} ─┤（确认信道）
   │ （300s 宽限内旧 Token 仍可连；未确认 → 维持新 Token，401 → 重配对路径，审计双侧落库）
```

### 9.5 撤销踢线

```
桌面 deviceRevoke(confirmed) → L3 revoke（撤销即拒）→ closeDeviceConnections(本地缝)
   → relayClient ── disconnect{deviceId, reason:'revoked'} ──► ECS 踢线 + status=revoked
   → E→D disconnect{reason:'revoked'} → 设备停止自动重连；后续任何连接 401 DEVICE_REVOKED
```

---

## 10. 与 docs/14 现协议的兼容映射

> 本表是两协议面的**翻译权威**。本地模式（127.0.0.1:8746）继续按 docs/14 原样运行；Relay 模式
> 按本文执行。冲突一律以「映射」呈现，docs/14 行文零改动。

| docs/14 现协议 | Relay 协议（本文） | 映射性质 |
| --- | --- | --- |
| REST `POST /v1/pairing/claim` | WS `pair` / `pair_accepted` | **通道迁移**：码校验/限流上移 ECS；Token 签发与落库仍在 Windows（语义不变） |
| REST `GET /v1/agents`、`/v1/sessions`、`/v1/sessions/{id}`、`/v1/sessions/{id}/messages` | 同路径 HTTPS（ECS 终结）＋ 内部以 `agent_list`/`session_list`/`message` 帧承载 | **形状不变**：请求参数与响应 JSON 逐字段一致（含 last/before/after 分页、segments） |
| REST `POST /v1/sessions/{id}/reply`、`/actions` | WS `command`（`send_message`≡`reply`）+ `command_ack`/`command_result` | **通道迁移 + 改名**：202 accepted ≡ command_ack(accepted)；幂等/TTL/终态语义原样（§5.2） |
| WS `hello {sequence, device, heartbeatSec}` | `hello {sequence, deviceId, heartbeatSec, relayVersion, upstream}` | 字段改名 device→deviceId + 附加字段 |
| WS `{type:'sync', after}` | `sync_request {after}` | 改名 + 兼任累计 ACK（见下两行） |
| WS `{type:'ack', seqs[]}`（≤500） | `sync_request {after}` / `heartbeat {lastAckedSeq}` 累计游标 | **语义合并**：`after = max(连续已处理)`；等价且更强（游标单调，无逐条列举） |
| WS `{type:'event', seq, eventType, createdAt, …}` | `event {sequence, type, timestamp, deviceId, provider, requiresUserAction, …}` | 字段改名 + 3 新增（§4.1）；值域与脱敏纪律不变 |
| WS `token_rotation`（预留，v1 绝不发送） | `token_rotation`（转正：post-pairing/用户触发/周期 backlog） | **预留转正**：帧形状兼容原定义（newToken/tokenVersion），新增 requestId/reason |
| REST `POST /v1/events/{id}/ack` | `sync_request` 累计游标（ECS REST 不开放该端点） | 通道合并（§7.2） |
| 心跳：传输层 ping/pong 30s/10s | 保留原参数 ＋ 应用层 `heartbeat` 帧（状态信标） | 参数不变，面扩展 |
| 错误：HTTP `{error:{code,message}}`（Part C 17 码） | 同码域 ＋ 8 个 Relay 新码（§8.2） | append-only，既有码零改动 |
| 动作全集 `{reply, pause, resume}` | `{send_message, approve, pause, resume, interrupt}` | `reply≡send_message` 改名；approve/interrupt 新增且默认门禁关闭（G6） |
| 设备身份：`remote_devices` Token（Gateway 签发） | 同一 Token 端到端保留；ECS 另持设备注册表（sha256 镜像） | 身份语义不变（G4 裁决③）；撤销/轮换双面联动（docs/19 §2.4） |

**双模式客户端映射责任**：Android 端以显式 mode 选择帧编解码映射（local=docs/14 原样；relay=本文），
**不做字段嗅探猜测**（绝不猜纪律）；映射层集中在 FrameCodec（docs/19 §7.2），`WsFrames.kt` sealed
class 仅 additive 扩展。

---

## 11. 非目标（协议面明确不做）

| # | 非目标 |
| --- | --- |
| N-R1 | 不做端到端内容加密（payload 加密/密钥协商）——ECS 威胁面以「不落盘+脱敏前置+最小缓存」约束（docs/19 §3），端到端加密列 backlog |
| N-R2 | 不做多用户/多桌面租户模型——单 host（每部署一份 Relay 凭据），多桌面为 backlog（reference-map MeshCentral 设备组方向记录） |
| N-R3 | 不做任意远程命令通道——action 全集锁死 §5.1 五值，shell/exec/文件通道不存在（docs/15 §5 禁止动作 1/2 延续） |
| N-R4 | 不在 WS 面复刻完整 REST（诊断/设备管理/归档等）——v1 REST 范围 §7.1/§7.2 |
| N-R5 | 不做协议版本协商（v1 单版本；`relayVersion` 仅观测字段；不兼容 = error + close） |
