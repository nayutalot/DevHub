# DevHub ECS Relay 架构设计（docs/19）

> ECS Relay 改造的**架构权威**（Phase 2 设计批，2026-09-04）。覆盖 gaps **G1**（ECS 服务形态）、
> **G3**（Windows 出站 relayClient）、**G4**（三层身份模型）、**G6**（approve 门控）、
> **G7**（Android 双模式）、**G9**（ECS 独立存储）的主控裁决设计；协议面见 docs/18，
> 实施计划见 docs/20，待用户裁决项见 docs/21。
> 与既有权威的关系：docs/12（六层架构）与 docs/15（安全设计）对本地路径**继续有效**；本文只做
> **增量架构**（新增 Relay 面），并显式声明与 docs/15 威胁模型 W1–W9 的叠加关系（§3）。
> 约束基线同 docs/00。

---

## 1. 目标拓扑

```
┌───────────────────────── Android App（双模式） ─────────────────────────┐
│  local 模式：ws://host:8746/v1/events（docs/14 原样）                    │
│  relay 模式：HTTPS + WSS（docs/18 协议面）                               │
└───────────────┬──────────────────────────────────┬─────────────────────┘
                │ relay 模式                        │ local 模式（保留，零改动）
                │ wss://<域名>/relay/*（443 TLS）    │ 127.0.0.1 / 局域网
                ▼                                  ▼
┌───────────────────────────────────┐   ┌──────────────────────────────┐
│ 阿里云 ECS（2C2G/3Mbps，Ubuntu 24） │   │ 家庭 PC（NAT 后，零公网入站）   │
│  Caddy/Nginx :443（TLS 终结）      │   │  ┌────────────────────────┐  │
│   └→ 反代 127.0.0.1:8443           │   │  │ DevHub Electron Main    │  │
│      ┌──────────────────────┐     │   │  │  Gateway(127.0.0.1:8746)│  │
│      │ devhub-relay 服务     │     │   │  │  agentControl L3(写库)  │  │
│      │  node:http + 自研 WS  │     │◄──┼──┤  eventPipeline(事件源)  │  │
│      │  node:sqlite 独立库   │     │   │  │  ┌──────────────────┐  │  │
│      │  (devices/pairing/   │     │   │  │  │ relayClient(出站) │──┼──┘ 出站 WSS 443
│      │   events缓存/commands│     │   │  │  └──────────────────┘  │  │ （替代 frpc 位）
│      │   /audit)            │     │   │  └────────────────────────┘  │
│      └──────────────────────┘     │   │   （frpc：迁移期并存，G8 后退役）│
│  frps（迁移期并存，最终退役）        │   └──────────────────────────────┘
└───────────────────────────────────┘
```

要点：Windows 侧**零公网入站、零路由器端口**（拓扑与 frp 方案 B 同构，`natpierce-setup.md` §7.1
已实测先例）；ECS 上 Relay 与 frps 迁移期并存（G8 编排，docs/20 §4），最终 443 唯一公网入口、
8746/7000 撤销（`docs/ecs-security-group-policy.md` §2.2 T1–T6）。

---

## 2. 三层身份模型（G4 裁决落地）

### 2.1 L1：ECS 设备注册表（设备 = Android）

- ECS 持 `relay_devices` 表（DDL §5.3）：每台 Android 一行，含 `sha256(端到端 Token)`、
  `token_version`、`status active|revoked`。
- **配对码语义上移**（裁决①）：8 位 Crockford Base32（同字母表）、TTL 300s、一次性、同时至多
  1 活跃码、失败 5 次作废、claim 限流 5 次/5min——全部由 ECS `pairing_codes` 承载（docs/18 §3.2）；
  Windows 保留 pairingId 活性复核与 Token 签发权（L1 只验「设备可入内」，Token 仍出自 Windows）。
- 注册表校验范围：device leg 的 REST/WS 每连接、每请求验证 `sha256(bearer)` ∈ 注册表且
  `status='active'`——**ECS 不解释 Token 的授权含义，只做「注册过」判定 + 限流**（裁决③）。

### 2.2 L2：Windows ↔ ECS 主机 Relay 凭据（每部署一份）

- **签发**：ECS 部署时生成一次性注册码（`openssl rand -hex 32`，存 ECS 配置，属用户外置凭据红线）；
  relayClient 首次连接携带注册码 → ECS `relay_hosts` 建行并签发 **256-bit Relay 凭据**
  （base64url）→ 此后所有 host 连接以 `Authorization: Bearer <Relay 凭据>` 认证（ECS 只存 sha256）。
  「短时效凭据换长期身份」与配对同构（MeshCentral enrollment 模式旁证，reference-map §8）。
- **存储（Windows 侧）**：`%LOCALAPPDATA%\DevHub\relay\credential`（机器本地文件，0600 权限位等效），
  **不入仓库、不入 settings 表、不入 DB、不入日志**——先例 = frp token 的 frpc.toml 存放形态
  （A 级实测先例，natpierce-setup §7.3）+ docs/15 §8 凭据外置红线。
- **等价性**：该凭据即「这台电脑在 Relay 面的身份」。泄露 = 攻击者可伪装 host 接收事件缓存、
  排空命令队列——**但伪造不了事件内容之外的东西**（命令必须由真 host 侧 L3 执行；伪造 host
  无法产生 `command_result` 因为事实源在 Windows DB）。撤销 = ECS 侧 `relay_hosts.status=revoked`
  + 全部 host 连接关闭 + 桌面重新走注册码换发。

### 2.3 L3：Android ↔ Windows 端到端设备 Token（现有 remote_devices 语义保留）

- 端到端 Token 仍由 **Windows 签发**（256-bit CSPRNG、base64url、`remote_devices.token_hash`
  只存 SHA-256、`token_version` 备用字段转正）——`remote_devices` 表结构与「撤销即拒不可复活」
  语义**零改动**（docs/13 §4.5 / docs/15 §3）；新增可选列 `origin TEXT DEFAULT 'local'`
  ∈ {local, relay}（migration 005 候选项之一，docs/20 §2 R1 裁决），仅作投递/展示区分。
- Android 侧存储不变：Android Keystore（docs/15 §3）；同一 Token 在 local/relay 两模式通用。
- **命令帧内嵌端到端 Bearer**（docs/18 §3.8）：ECS 只按 L1 验「设备注册过」并转发；Windows 侧
  relayClient 用**现 auth.ts 同源函数**（`authenticateBearerToken`：sha256 比对 +
  `timingSafeEqual`）校验 + ts/nonce 防重放（docs/14 §B.4 同参）——校验代码路径与今日 Gateway
  完全同源，新增零套利空间。
- **ECS 存端到端 Token 的形态**：仅 `sha256`（配对瞬间捕获、token_rotation 帧同步更新）——与
  Windows 同等粒度的哈希镜像，满足 G9「不存敏感」（256-bit 随机值的 SHA-256 不可逆推，
  与 docs/15 §3 同一论证）。

### 2.4 凭据总表（谁持有什么、在哪、怎么换）

| 凭据 | 持有方 | 签发方 | 明文存储位置 | 哈希存储位置 | 轮换 | 撤销 |
| --- | --- | --- | --- | --- | --- | --- |
| 配对码（8 位） | 瞬时（桌面展示/手机输入） | Windows（ECS 落 hash） | 不落盘（内存秒级） | ECS `pairing_codes.code_hash` | TTL 300s / 一次性 | 失败 5 次作废、新码废旧码 |
| 端到端设备 Token | Android（Keystore） | **Windows** | Keystore（Android）；Windows 不存明文 | Windows `remote_devices.token_hash` + ECS `relay_devices.token_hash` | `token_rotation` 帧（docs/18 §3.14）+ 撤销重配 | 桌面 deviceRevoke / 设备自撤销 → 两平面同时失效 |
| Relay 凭据（主机） | Windows relayClient（本地文件） | **ECS** | `%LOCALAPPDATA%\DevHub\relay\credential` | ECS `relay_hosts.credential_hash` | 撤销后重新注册换发（周期轮换 backlog） | ECS 侧 revoke + 踢线 |
| 一次性注册码 | 用户（部署期输入一次） | 用户（ECS 上生成） | ECS 配置文件（外置凭据红线） | ECS 注册校验 | 用后可重生成 | 不适用（建议用后从配置移除） |
| frp token（迁移期） | frpc/frps | 用户 | frpc.toml / frps.toml | — | 换 token 重启两端 | G8 退役时整体消亡 |

---

## 3. 威胁模型（含「ECS 被攻破」论证）

### 3.1 与 docs/15 W1–W9 的关系

docs/15 威胁模型全部继续成立（本地 Gateway 面、配对安全、防重放、脱敏红线、撤销即拒、指令幂等）。
下表只列 **Relay 面新增/变化** 的威胁（编号续接 W 系列）：

| # | 威胁 | 面 | 防御 |
| --- | --- | --- | --- |
| W-R1 | Relay 凭据被盗（host 身份伪装） | host leg | 凭据仅存机器本地文件（§2.2 红线）；ECS 只存 sha256；撤销即踢；泄露即换发。伪造 host 拿不到 L3 事实源，无法伪造 command_result/事件内容（事件只能来自真 Windows 的 eventPipeline） |
| W-R2 | ECS 设备注册表泄露 | ECS 存储 | 表内凭据只有 sha256（不可逆推，同 docs/15 §3 论证）；泄露不等于 Token 泄露 |
| W-R3 | **ECS 服务被攻破（核心论证，§3.2）** | 全 Relay 面 | 分「伪造」「窃听」「重放/拒绝」三问论证——协议根：命令校验权在 Windows |
| W-R4 | 手机 → ECS 段被动窃听 | device leg | G2 落地后为 TLS（443 唯一入口，正式态 wss://）；明文仅限联调时间盒（docs/21 §1 选项三）；应用层三防线（可撤销 Token/防重放/限流）全程不变 |
| W-R5 | 中继层重放命令帧 | ECS | 命令帧内嵌 ts/nonce（Windows 侧防重放）+ TTL 300s + 幂等键 UNIQUE——重放已执行命令 = 原结果无副作用；TTL 窗外 = COMMAND_EXPIRED |
| W-R6 | 双路重复投递（frp 与 relay 并存期） | 迁移期 | App 同一时刻仅一条活跃连接（单连接模型）；事件以 eventId/sequence 幂等 upsert（Room 现机制）；deliveries 设备粒度天然去重（G3 差距项显式回应） |
| W-R7 | ECS 缓存容量滥用 / DoS | ECS | 缓存硬上限 + TTL 淘汰（§5.4）；命令排队上限（docs/18 §3.9）；限流同参 docs/14 §B.4；2C2G 容量预算显式化（§5.5） |
| W-R8 | 家庭 NAT 半开连接（假活） | host leg | 应用层 heartbeat 30s×2 判死 + 传输层 pong 10s 超时（双层，rathole keepalive 思想旁证 reference-map §5） |
| W-R9 | 配对码经中继被抢先 claim | ECS pair | 码空间 32^8 + TTL 300s + 一次性 + 限流 + 失败作废（语义原样上移）；TLS 落地后明文截获面关闭（G2） |

### 3.2 「ECS 被攻破」论证（裁决要求逐条写出）

**前提设定**：攻击者获得 ECS 上 devhub-relay 进程的完全控制（读写其内存/DB/配置、可任意篡改
中继行为），但 **Windows 侧与 Android 侧端点未被攻破**、TLS 证书链未被伪造（攻击发生在服务端
而非链路中间）。

**问 1：能否伪造指令（远程代批/注入回复）？——不能（除配对瞬间窗口，见问 3）。**
- 协议根：`command` 帧必须内嵌有效端到端 Bearer（docs/18 §3.8），Windows 侧以与今日 Gateway
  **同源代码**（auth.ts `authenticateBearerToken`）校验 sha256 + timingSafeEqual。攻破的 ECS
  手中没有 Token 明文——注册表里只有 sha256，无法通过校验。
- 即便绕过（假设攻击者能注入任意帧到 host leg）：能送达 Windows 的命令仍要过 L3
  `resolveCommandGate` 能力门 + 授权矩阵二次校验（docs/15 §5）——observed 会话全禁、能力未验证
  拒绝、approve/interrupt 默认不授予。**伤害上限 = 已授予的三种会话动作**，shell/exec/文件通道
  在协议与实现中都不存在（docs/18 §11 N-R3）。
- 伪造 `event` 帧（向手机注入假事件）**可能**（ECS 是中继），但事件仅是脱敏投影 + 手机端展示，
  不驱动任何 Windows 侧执行（W7 纪律延续：解析产物绝不派生本机执行）；假事件可被「sequence 断裂
  + REST 权威刷新」暴露（docs/18 §6.1 对齐规则：本地游标不被回退）。

**问 2：能窃听什么？——已脱敏的元数据与摘要；完整内容不在其手。**
- 事件 payload/summary 在**离开 Windows 前**已脱敏（redact.ts 同源管线），且 payload 本身就是
  有界投影（preview ≤ 截断、无 sourceRef、无密钥）——ECS 能看到的与今天手机通知能看到的同粒度。
- 完整消息内容（contentRedacted 全文）**不经过 ECS 缓存**（REST 消息取数实时中继，§5.4），
  host 离线时手机拿到的是 RELAY_UPSTREAM_OFFLINE 而非缓存全文。
- 端到端 Token / Relay 凭据 / 配对码明文：ECS 进程内存中瞬时可见（传输必然），红线 = 不落盘、
  不落日志、不落审计（实现纪律 + 自检脚本断言，docs/20 §2 R2）。

**问 3：残余风险窗口与缓解（如实声明，不粉饰）。**
1. **配对瞬间窗口**：`pair_accepted` 携带 Token 明文过境（§2.4）——攻破窗口恰好覆盖配对的 ECS
   可捕获 Token。缓解：(a) 配对是一次性 300s 窗口，事后 ECS 无法重放（码即废）；(b) **配对完成
   后 Windows 自动发起一次 `token_rotation`**（post-pairing 轮换，docs/18 §9.4）——把「过境
   Token」立即作废，攻击者需在轮换帧过境时**再次**在线截获；(c) 若攻击者**持续**控 ECS，轮换帧
   同样可见——此为 N-R1（不做端到端加密）下的固有残余，诚实记录：**持续攻破的 ECS 可发现轮换后
   Token 并伪造命令**，最终防线 = L3 能力门伤害上限（问 1）+ 用户可随时物理侧撤销（桌面操作不经
   ECS）+ ECS 自身系统加固（22 收敛/密钥登录，security-group-policy §6）。
2. **重放/拒绝服务**：可丢弃/延迟/重放帧（W-R5 缓解）——可用性攻击，非完整性攻击；表现为
   「事件迟到/命令排队」，客户端退避与排队上限显式化，不产生错误执行。
3. **降级误信**：ECS 谎报 `upstream:"connected"` 或 `stale:false`——设备侧以 sequence 连续性
   与 REST 刷新交叉验证（docs/18 §6.3 hasGaps）；最坏后果 = 展示层误导，无执行面。

**结论一句话**：ECS 被攻破的**完整性**边界 = 「手机看到假的/旧的展示」；**执行**边界不变
（命令校验权、能力门、事实源全在 Windows）；**保密性**边界 = 已脱敏投影粒度 + 配对/轮换瞬间的
Token 过境窗口（缓解 = post-pairing 轮换 + 持续攻破场景依赖 ECS 主机加固）。这满足「ECS 只做
转发、不存敏感、命令必须回 Windows 校验执行」的目标语义。

---

## 4. Windows relayClient 设计（G3）

### 4.1 模块布局（新增目录，既有文件仅注入缝级改动）

```
src/main/services/agentControl/relayClient/
├─ index.ts            # RelayClient 编排：状态机、生命周期（随 Main 进程）、对外句柄
├─ config.ts           # settings（relay_enabled/relay_endpoint）+ 凭据文件加载 + 注册码换发
├─ wsClient.ts         # WS 客户端编解码（发送必掩码；解析镜像 ws.ts；重连退避 1s→60s ±20% jitter）
├─ eventUplink.ts      # 事件上行桥：eventPipeline 注入 sink → event 帧推送 + 断线回填
├─ commandDownlink.ts  # 命令下行桥：command 帧 → 鉴权 → L3 submitRemoteCommand → ack/result 回帧
├─ pairingBridge.ts    # 配对桥：pairingCreate 注入同步码到 ECS；pair/pair_accepted 处理
├─ rotationBridge.ts   # token_rotation 发起/落库/宽限跟踪（L3 轮换函数）
└─ statusProjector.ts  # gatewayStatus.relay 投影（enabled/connected/endpoint/lastError/queued）
```

### 4.2 出站连接与重连状态机

- 状态机：`disabled → connecting → hello → ready`；`ready --断线--> connecting`（退避 1s→2s→…→
  60s 封顶，±20% jitter——**行为规格移植自 Android `ConnectionManager.kt`/`core/Backoff.kt`**，
  参数与 docs/14 §B.2 断线行一致）；连续失败 ≥10 次 → UI 提示（投影 lastError）。
- 握手：WSS upgrade（`/relay/host` + Bearer Relay 凭据）→ `hello{sequence, hostId, heartbeatSec}` →
  **三步恢复序**：① 按 `hello.sequence` 回填 ECS 缺失事件（§4.3）；② 接收 ECS 排队命令按
  `requested_at` 序投递（§4.4）；③ 恢复实时推送。
- 帧编解码：客户端帧必掩码（RFC 6455 §5.1）——与 ws.ts 服务端唯一的对称差异点；解析/分片/
  close 回显/ping-pong 镜像复用（1MB 上限、1002/1009/1003 语义同款）。
- 常驻形态：随 Main 进程（托盘退出收尾顺序追加「关 relayClient」一步，docs/12 §10 顺序表延伸）；
  自启复用 `login_autostart` 现路径，**不新增进程形态、不新增 Run 键**（与 frpc 的 Run 键+vbs
  形态对照——relayClient 在 Electron 进程内，天然常驻，退役 frpc 后删其 Run 键即净）。

### 4.3 事件上行桥（含断线回填）

- **注入缝**：eventPipeline 的投递回调（`EventDeliverySink`，现签名服务 Gateway WS）扩展为
  **多 sink**：gateway WS sink（原样）+ relay sink（新增）。投递语义不变：先落库（事件 +
  deliveries×活跃设备）COMMIT 后回调；relay sink 失败不回滚（sync/回填兜底）——裁决 5 零改动。
- relay 设备的 deliveries 行：`origin='relay'` 设备是 `remote_devices` 正常行，事件落库时 deliveries
  照建（G9「经 Relay 设备的投递粒度」由此自然成立，无需新表）。
- 上行：事件 → `event` 帧（deviceId 省略，ECS 扇出填充，docs/18 §3.6）→ 写 socket 成功即该帧
  已交 ECS（host 腿 delivered）；设备侧 ack 由 ECS 以 `sync_request{after,deviceId}` 中继回来 →
  批量 `markEventAcked`（新增 L3 范围批：`markEventsAckedThrough(seq, deviceId)`，事务内循环现函数）。
- **断线回填**：重连 `hello.sequence` 给出 ECS 缓存水位；relayClient 查 L3
  `eventsSince(hello.sequence, null)` 分页（100/页）补推 `event` 帧（ECS 按 sequence UNIQUE 幂等
  去重）。本地持久化 `lastSentSeq`（settings 键 `relay_last_sent_seq`，普通键值，非凭据）防进程
  重启后重复回填（重复也无害，幂等双保险）。
- 双目标投递（G3 差距项）：本地直连设备收 Gateway WS 帧（docs/14 原样字段名），relay 设备收
  Relay event 帧（docs/18 字段名）——同一事实源、两套投影，投影函数集中一处防止漂移。

### 4.4 命令下行桥（接 submitRemoteCommand）

```
ECS command 帧 → commandDownlink：
  1) auth 校验：authenticateBearerToken(auth.token)（现 auth.ts 同源）
     + checkReplayHeaders 等效（auth.ts ±300s / nonce LRU 10min，同参）
     失败 → error{AUTH_INVALID_TOKEN|AUTH_REPLAYED}（不触达 L3）
  2) action 翻译：send_message→reply；pause/resume 原样；approve/interrupt → G6 门控路径（§6）
  3) 执行：L3 submitRemoteCommand（与 Gateway REST 同一入口：能力门二次校验 + 幂等 + TTL + 审计）
  4) 回帧：受理 → command_ack{accepted|rejected, errorCode}；终态 → command_result
     （终态同时经 eventPipeline 产生 command.result 事件，双通道按 commandId 去重，docs/18 §3.10）
```

选型说明（次级决策 D4）：直调 L3 进程内函数而非 loopback HTTP 回打 Gateway——submitRemoteCommand
本就是 REST handler 的底层入口（现审计确认），直调免去端口依赖与双重限流干扰；代价是 handler 层
载荷校验需在 commandDownlink 复刻（≤4000 字符等），以同一校验函数共享避免漂移。Gateway 的
`gateway_enabled` 前提：relay 模式**要求本地 Gateway 启用**（命令审计/设备面/本地模式共用）；
未启用 → 命令回 `GATEWAY_DISABLED`（docs/18 §8.2），投影显式提示。

### 4.5 配对桥 / 4.6 轮换与撤销

- 配对桥：`agents:pairingCreate` IPC handler 成功签发后通知 relayClient（注入缝）→
  `registerPairing{pairingId, codeHash? no——明文码 hash 由 Windows 计算后同步}`：同步
  `{pairingId, code_hash, expiresAt}` 给 ECS 落 `pairing_codes`；relay 关闭时跳过（配对退化为
  本地模式专用）。`pair_accepted` 回帧 → L3 落 `remote_devices(origin='relay')` → 触发
  post-pairing `token_rotation`（§3.2 缓解 b）。
- 撤销：L3 revoke 路径追加 relayClient 通知（`disconnect{deviceId, reason:'revoked'}`，注入缝与
  `closeDeviceConnections` 同点）。
- 轮换：rotationBridge 实现 docs/18 §3.14 全流程（L3 新 Token 生成 + token_hash 覆盖 +
  token_version+1 + 帧发送 + 宽限跟踪 + 双侧审计）。

### 4.7 状态投影与设置键

- `agents:gatewayStatus` 响应**追加可选字段** `relay?: {enabled, connected, endpoint, hostId?,
  lastError?, queuedCommands?}`（次级决策 D5：不新增 IPC channel，白名单 68 条不动，向后兼容）。
- settings 新键（`ALLOWED_KEYS` 10→12）：`relay_enabled`（默认 `'0'`，零连接）、
  `relay_endpoint`（如 `wss://relay.example.com`）。**凭据与注册码绝不入 settings**
  （§2.2 红线，文件承载）。
- `agents:diagnostics` 追加 `relay` 数据源只读探针（凭据文件存在性布尔 + endpoint 可达性），
  零凭据值。

### 4.8 与本地 Gateway 的关系

| 关注点 | 结论 |
| --- | --- |
| 端口 | Gateway 仍绑 127.0.0.1:8746（零改动）；relayClient 不监听任何端口（纯出站） |
| 启停耦合 | relay 模式要求 gateway_enabled=1（§4.4）；gateway_enabled=0 且 relay_enabled=1 → 投影结构化告警（非错误） |
| 本机兼容 | 127.0.0.1:8746 本机路径永久保留（任务书语义）；relay 是叠加面不是替换面 |
| 审计 | 同一 `security_audit_logs`；relay 来源命令 detail 注明 `origin:'relay'`（迁移期与本地来源可分账，G8 审计要求） |

---

## 5. ECS Relay 服务设计（G1/G9）

### 5.1 服务形态（主控裁决锁定）

| 项 | 裁决值 | 说明 |
| --- | --- | --- |
| 运行时 | **Node 22 LTS**（单进程） | 与 DevHub 桌面同族（node:sqlite 可用）；无 Electron 依赖 |
| HTTP | `node:http` | upgrade 挂 WS；REST 路由轻量手写（无框架，零新依赖纪律延续） |
| WS | **自研**（`gateway/ws.ts` 编解码为蓝本移植） | Relay 恒为 WS 服务端（两腿都是服务端角色），掩码/分片/心跳参数原样 |
| 存储 | **node:sqlite 独立库** `/var/lib/devhub-relay/relay.db`（WAL，busy_timeout 5000） | **绝不进 DevHub migration 序列**（G9 裁决）；独立 schema 独立生命周期 |
| TLS | 不终结（Caddy/Nginx 前置，Relay 只绑 `127.0.0.1:8443`） | 443 唯一公网入口（security-group-policy §2.1） |
| 看护 | systemd 单元 `devhub-relay.service`（`Restart=always`）+ journald 日志轮转（logrotate） | frps 部署经验平移（natpierce-setup §7.2 先例） |
| 密钥面 | 一次性注册码 + Relay 凭据 hash 落其自身 DB；配置文件权限 0600 | 零凭据入日志/审计（约束 #13 同款红线） |

### 5.2 模块划分

```
devhub-relay/
├─ src/server.ts        # node:http 装配 + upgrade 分路（/relay/device | /relay/host）+ 优雅停机
├─ src/ws.ts            # ws.ts 移植（服务端编解码；两腿复用同一连接类，registry 按腿分册）
├─ src/rest.ts          # REST 面（docs/18 §7 端点表：鉴权/防重放/限流/中继编排）
├─ src/auth.ts          # 注册表校验（sha256+timingSafeEqual 镜像）+ 防重放 + 滑窗限流（auth.ts 蓝本）
├─ src/pairing.ts       # 配对码落表/校验/作废/限流（pairing.ts 蓝本，TTL 参数原值）
├─ src/forwarder.ts     # 中继编排：帧路由、扇出、command 排队/投递、ack 中继、错误映射
├─ src/cache.ts         # relay_events 缓存写入/查询/淘汰（TTL + 容量）
├─ src/store.ts         # node:sqlite 访问层（? 绑定，约束 #11 同款；WAL；迁移脚本独立）
├─ src/audit.ts         # relay_audit 写入（pairing/auth/command/device/relay 五类，镜像 docs/15 §10 目录）
└─ src/selfcheck.mjs    # 部署自检脚本（脱离仓库门禁的独立验证，G11：帧一致性/淘汰/限流/重启恢复）
```

### 5.3 schema 草案（relay.db，独立 migration 文件 `0001_init.sql`）

```sql
PRAGMA foreign_keys = ON;

-- 设备注册表（L1，docs/19 §2.1）
CREATE TABLE relay_devices (
  id             INTEGER PRIMARY KEY,              -- ECS 侧设备号（独立命名域）
  win_device_id  INTEGER,                          -- Windows remote_devices.id（pair_accepted 回填，可空）
  device_name    TEXT    NOT NULL,
  platform       TEXT    NOT NULL DEFAULT 'android',
  token_hash     TEXT    NOT NULL UNIQUE,          -- sha256(端到端 Token)：配对捕获/轮换同步；仅哈希（G9）
  token_version  INTEGER NOT NULL DEFAULT 1,
  status         TEXT    NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','revoked')),   -- 撤销即拒不可复活（语义同 remote_devices）
  paired_at      INTEGER NOT NULL,
  last_seen_at   INTEGER,
  revoked_at     INTEGER,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_relay_devices_status ON relay_devices(status);

-- 配对码（语义上移：TTL 300s/一次性/失败5次作废/单活跃码）
CREATE TABLE pairing_codes (
  id             INTEGER PRIMARY KEY,
  pairing_id     TEXT    NOT NULL UNIQUE,          -- Windows 签发 id（原样回传校验）
  code_hash      TEXT    NOT NULL,                 -- sha256(8位码明文)；明文绝不落盘
  expires_at     INTEGER NOT NULL,                 -- created + 300s
  fail_count     INTEGER NOT NULL DEFAULT 0,       -- ≥5 → status='voided'
  status         TEXT    NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','used','expired','voided')),
  created_at     INTEGER NOT NULL
);

-- 主机身份（L2）
CREATE TABLE relay_hosts (
  id               INTEGER PRIMARY KEY,
  host_name        TEXT,
  credential_hash  TEXT    NOT NULL UNIQUE,        -- sha256(Relay 凭据)
  status           TEXT    NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','revoked')),
  enrolled_at      INTEGER NOT NULL,
  last_seen_at     INTEGER,
  updated_at       INTEGER NOT NULL
);

-- 连接审计（当前态在内存 registry；落库仅供审计与断线诊断）
CREATE TABLE relay_connections (
  id           INTEGER PRIMARY KEY,
  side         TEXT    NOT NULL CHECK (side IN ('device','host')),
  device_id    INTEGER REFERENCES relay_devices(id) ON DELETE SET NULL,
  host_id      INTEGER REFERENCES relay_hosts(id)   ON DELETE SET NULL,
  remote_ip    TEXT,
  connected_at INTEGER NOT NULL,
  closed_at    INTEGER,
  close_reason TEXT                                 -- 零凭据零 payload
);

-- 事件缓存（脱敏帧元数据 + payload；权威 sequence 的镜像，G9 裁决：只存脱敏摘要与元数据）
CREATE TABLE relay_events (
  sequence            INTEGER PRIMARY KEY,          -- = Windows agent_events.id（镜像，绝不自编号）
  event_id            TEXT    NOT NULL UNIQUE,      -- 幂等（host 回填重发去重）
  type                TEXT    NOT NULL,
  provider            TEXT,
  session_ref         TEXT,                         -- Windows sessionId + provider 冗余定位串
  summary             TEXT,                         -- ≤120 字符已脱敏
  payload_json        TEXT,                         -- 已脱敏有界 payload（≤4KB）；淘汰后 NULL
  requires_user_action INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL              -- = Windows createdAt
);
CREATE INDEX idx_relay_events_created ON relay_events(created_at);

-- 每设备 ACK 游标（累计制，只前进）
CREATE TABLE relay_event_acks (
  device_id      INTEGER PRIMARY KEY REFERENCES relay_devices(id) ON DELETE CASCADE,
  acked_through  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- 命令幂等 + 离线队列
CREATE TABLE relay_commands (
  id              INTEGER PRIMARY KEY,
  command_id      TEXT,                             -- Windows 回填
  device_id       INTEGER NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  idempotency_key TEXT    NOT NULL,
  action          TEXT    NOT NULL CHECK (action IN ('send_message','approve','pause','resume','interrupt')),
  payload_json    TEXT,                             -- 脱敏后
  status          TEXT    NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','acked','accepted','executed','rejected','expired','failed')),
  requested_at    INTEGER NOT NULL,
  acked_at        INTEGER,
  result_at       INTEGER,
  result_json     TEXT,
  UNIQUE(device_id, idempotency_key)                -- 幂等根（docs/18 §3.9）
);
CREATE INDEX idx_relay_commands_status ON relay_commands(status);

-- 审计（目录镜像 docs/15 §10；detail 零凭据零码明文零 payload 全文）
CREATE TABLE relay_audit (
  id          INTEGER PRIMARY KEY,
  category    TEXT NOT NULL,   -- pairing|auth|command|device|relay
  action      TEXT NOT NULL,   -- pairing_code_registered|pairing_claimed|pairing_failed|auth_failed|
                               -- replay_rejected|rate_limited|command_queued|command_relayed|
                               -- command_expired|device_paired|device_revoked|
                               -- host_enrolled|host_revoked|relay_started|relay_stopped
  device_id   INTEGER REFERENCES relay_devices(id) ON DELETE SET NULL,
  host_id     INTEGER REFERENCES relay_hosts(id)   ON DELETE SET NULL,
  outcome     TEXT NOT NULL,   -- success|denied|error
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_relay_audit_created ON relay_audit(created_at);

CREATE TABLE relay_meta (key TEXT PRIMARY KEY, value TEXT);  -- schema 版本/水位等
```

### 5.4 缓存策略（脱敏边界与淘汰，G1/G9 裁决具体化）

| 项 | 策略 |
| --- | --- |
| 缓存内容 | 事件帧粒度：元数据 + **已脱敏有界 payload**（≤4KB/条）+ summary。完整消息正文（contentRedacted 全文）、代码、密钥**永不入缓存**——消息取数实时中继（docs/18 §7.1），host 离线即 503 |
| 脱敏责任边界 | 脱敏发生在 Windows（出帧前，redact.ts 同源）；ECS 不二次处理、只按原样缓存与淘汰——「绝不存完整提示词/代码/密钥」由上游投影粒度 + 4KB 界 + 自检断言三层保证 |
| ACK 淘汰 | 事件被**全部活跃 relay 设备** ack 且 `created_at` 超过 **72h** → 删 payload_json（保元数据行 7 天供 hasGaps 判定）后整行删除 |
| 容量淘汰 | 软上限 **25,000 行 / 100MB**；触顶 → 先删已全 ack 最旧行；仍超 → 删最旧行（含未 ack，删前审计 `relay_cache_evicted`，触发 hasGaps 语义）——硬上限 **50,000 行 / 200MB** 绝不突破（2C2G 磁盘保护） |
| 命令队列 | queued 状态 TTL = 300s（与命令 TTL 同步，过期置 expired 回流）；上限 docs/18 §3.9 |
| 审计淘汰 | 180 天滚动删除（audit 只留标识符与 outcome，无敏感体） |

### 5.5 容量预算（2C2G / 3Mbps 硬约束，G1）

| 维度 | 预算 | 依据 |
| --- | --- | --- |
| WS 长连接 | 预算 **≤64 条**（设备 ≤60 + host ≤4），内存 ≈ 64×~60KB ≈ 4MB —— 非瓶颈 | 每连接缓冲（1MB 上限仅为帧界，实际 JSON 帧 KB 级）+ fd/堆；2GB 内存余量充足 |
| 心跳开销 | 64 连接 × (30s heartbeat 帧 ≈ 100B + 30s ping/pong) ≈ **<0.5KB/s** | 可忽略 |
| 事件吞吐 | 现网量级 14,871 事件/数周 ≈ 0.02 events/s；**设计预算：持续 50 events/s、突发 200 events/s**（每帧 ≤4KB → 突发带宽 800KB/s 超 3Mbps，故突发按扇出×时长限幅，持续值留 3× 余量） | 3Mbps ≈ 375KB/s ≈ 持续 ~90 帧/s @4KB；设计值取 1/2 安全系数 |
| 扇出 | 设备数 ≤60 全推同事件：**扇出 ≤60 × 持续 50 events/s 不可同时成立**——流量守恒式预算：`Σ(设备数×事件率×帧均) ≤ 300KB/s`；超限侧（事件率×设备数 > 75 帧出/s）触发 ECS 侧每连接发送队列背压 → 降速 + 靠 sync 补齐（不丢，只延迟） | 3Mbps 上行是唯一硬瓶颈；文本事件流实际远低于此（natpierce-setup §7.5 弱点④同结论） |
| 缓存 | 100MB 软上限 ≈ 25k 事件 ≈ 现网真库 1.7 倍全量；72h TTL 后稳态远低于此 | §5.4 |
| SQLite | WAL 写入 QPS 峰值 <100（事件插入 + ack 游标 + 审计）；2C2G 无压力（DevHub 真库同引擎先例） | docs/08 §2 同款论证 |
| 命令 | 命令为低频动作（人工触发），预算 10/min 全局 | 实测量级 |
| 带宽占比 | 反代 TLS 开销 ≈ ×1.2~1.5（已含在上行预算内） | Caddy 终结 |

预算护栏：selfcheck 脚本对「连接数/缓存行数/队列深度/出带宽采样」做超限告警（日志 + 审计），
不自动拒绝服务（限流与队列上限已兜底）。

### 5.6 部署形态（概要，操作属主控面）

```
Caddy :443（TLS/ACME，域名待用户，docs/21 §1）
  reverse_proxy /relay/*  h12://127.0.0.1:8443   # WebSocket 透传
  reverse_proxy /v1/*     http://127.0.0.1:8443
devhub-relay.service（Node 22，EnvironmentFile=/etc/devhub-relay/env（0600，仅注册码））
  WorkingDirectory=/opt/devhub-relay  ExecStart=/usr/bin/node src/server.js
  Restart=always  User=devhub-relay（非 root）  NoNewPrivileges=yes
relay.db：/var/lib/devhub-relay/（0700）；每日 sqlite3 .backup 滚动 7 份（缓存可丢，重建即回填）
```

安全组动作只引不抄：S1 新增 443 → S4/S5 撤 8746/7000 全按 `docs/ecs-security-group-policy.md`
§4 执行顺序与回滚表。

### 5.7 自检与可观测（G11 的 ECS 侧补偿）

- `selfcheck.mjs`：帧编解码一致性（与 docs/18 全表逐帧 round-trip）、配对全流程（夹具码）、
  命令排队/过期、缓存淘汰与 hasGaps、限流三态、重启后排队命令恢复、红线断言（DB/日志抽样
  不含 Token 明文/码明文）。部署时与版本升级后必跑；结果人工留存（不进仓库门禁——外部依赖
  面如实隔离，G11）。
- 运行观测：journald 结构化日志（零凭据）+ relay_audit 表即审计面；不引外部监控栈（零新增服务）。

---

## 6. approve 门控（G6，风险等级最高项）

### 6.1 门控位置与默认态

| 层 | approve/interrupt 支持形态 | 默认态 |
| --- | --- | --- |
| 协议（docs/18） | action ∈ 五值全集，帧形态冻结 | 协议就绪 |
| ECS | 透传 + 排队 + 幂等，不理解能力语义 | 就绪 |
| **Windows L3** | `AgentCapability` 扩 `'approve'`/`'interrupt'`；`getCapabilities` 新增逐 provider 验证函数；`resolveCommandGate` 复检 approve ∈ granted | **恒不授予**（granted 不含 → command_ack rejected `AGENT_CAPABILITY_MISSING`） |
| Android | ControlGate + 按钮显隐（granted 门现状机制复用） | 不显示按钮 |

### 6.2 「错误授予 = 远程代批」风险分析

- 语义：approve 远程执行 = Agent 的**工具调用获得授权**（如写文件/执行命令类工具），而批准决定
  可能基于手机上一行 ≤120 字符的脱敏摘要——**上下文不对称是风险本体**。
- 攻击链：转录/数据源中的提示注入内容诱导 Agent 发起危险工具调用 →伪造/夸大 waiting_input
  （approval_required）→ 用户在小屏上无完整上下文批准。防线与残余：事件与摘要由 Windows 侧
  脱敏投影产生（不可被数据源直接伪造执行），但**摘要永远不足以支撑高危批准**——因此 approve
  的授予标准必须比 reply 更严（reply 的内容用户亲手输入，approve 的内容用户未见过）。
- 结论：approve 授予 = 把「人在环」的环缩到最弱点（手机通知）。在验证门全过 + 主控复核前，
  默认不授予是唯一安全态。

### 6.3 能力验证门流程（「绝不猜」的 approve 版）

1. **判定源真实验证**：该 provider 存在可程序读取的「待批准请求」判定源——当前语料证实仅
   **kimi `interaction.request(kind='approval')`**（未 resolved 行可枚举）；codex 无审批片段
   （APPROVAL_FRAGMENT_TYPES 置空先例）；claude hooks 审批事件为设计判定源但默认未注册；
   zcode/deepseek 无。无判定源 → 验证函数恒 false。
2. **执行通道真实验证**：存在已验证的批准写入通道（kimi `interaction.resolved` 闭环语料 →
   夹具级验证可行）；真实效果需真机（kimi 真机 managed 为用户裁决项，docs/21 §3）。
3. **双向验证**：allow 与 deny（reject）两路径都必须真实验证通过（拒绝通道不可用时**连 allow
   一起不授予**——只能批准不能拒绝的批准权不是人在环）。
4. **证据落库**：granted 变更经 `capabilities_json.evidence` 记录验证方式与时刻（verifiedAt
   ≤300s 新鲜度复检，docs/12 §5 原样）。
5. **主控复核**：任一 provider 首次授予前，验证证据与 smoke 用例面必须经主控复核（对应
   G6「错误授予风险等级最高」），复核记录进批次报告。

预期长期态（如实记录）：codex/interrupt 可能在补验「活跃 turn 打断真实效果」后率先授予；
kimi approve 待真机 managed 授权；zcode/deepseek 恒不授予（无通道）；claude 待 hooks 注册 +
（hooks 无输入注入 API 的）通道验证——大概率长期不授予（G6 原判断）。

---

## 7. Android 双模式设计（G7）

### 7.1 配置与模式模型

- 配置单行扩展（Room，android 侧 schema 版本自增，与 DevHub migration 无关）：
  `{ mode: 'local' | 'relay', host?, port?, relayUrl?, deviceName }`。
- GatewayConfigScreen → 模式选择：local = host:port 表单（现状）；relay = endpoint URL 输入
  （`https://` 或 `wss://` 域形态）+ 「使用同一设备 Token」说明。
- **凭据共用**：同一 Keystore Token 两模式通用（§2.3）；relay 模式首次使用若未配对 → 走
  WS `pair` 帧（UI 复用现 Pairing 页，仅传输层换）。

### 7.2 连接层

```
ConnectionManager（现状态机不动：退避 1s→60s ±20%、hello→sync、批量 ack、离线队列）
  ├─ FrameCodec 接口（模式显式选择，绝不字段嗅探，docs/18 §10）
  │    ├─ LocalCodec  = docs/14 原样（hello/sync/event/ack/token_rotation 预留）
  │    └─ RelayCodec  = docs/18（hello/sync_request/sync_response/event/heartbeat/
  │                     command/command_ack/command_result/token_rotation/disconnect/error）
  ├─ 传输：local = OkHttp ws://（明文，内网前提）；relay = OkHttp wss://（**强制 TLS**，
  │        非 wss endpoint 拒绝保存 + UI 安全提示；cleartext 收敛见次级决策 D7）
  ├─ ACK：relay 模式 ack 语义 = 累计游标（Room 持久化后推进 after/lastAckedSeq）
  └─ 双连接互斥：同一时刻仅一条活跃连接（切模式 = 断旧连新）——W-R6 双路投递防线
```

### 7.3 UI 与通知

- 状态展示：MainTabs 顶部连接徽标区分模式与降级态（`upstream:"disconnected"` 信标 →
  「Relay 已连接，电脑离线（命令将排队）」结构化文案，绝不显示为正常态——容错降级纪律）。
- 事件通知：EventNotification 扩展 `requiresUserAction` 维度 → 文案区分「等待输入」/
  「等待批准」；deep link 落点不变（`devhub://session/{id}`）。
- 控制按钮：reply/pause/resume 现状 + approve/interrupt 按钮**仅当** RelayCodec 的
  agent 投影 granted 含对应能力（当前恒无 → 不显示，§6.1）。
- token_rotation：RelayCodec 收帧 → SecureStore 原子更新 → 下帧 heartbeat 带新 tokenVersion
  （docs/18 §3.14）；失败回退旧值 + 重连；401 → 重配对引导页。

### 7.4 功能矩阵（v1）

| 功能 | local 模式 | relay 模式 |
| --- | --- | --- |
| 配对 / 会话列表 / 详情 / 消息 / 通知 / reply / pause / resume / ack / 自撤销 | 全量（docs/14 原样） | 配对、列表、详情、消息、通知、reply、pause、resume、ack 可用（docs/18 面）；自撤销/诊断/归档 v1 不开放（docs/18 §7.2，桌面侧覆盖） |
| approve / interrupt | 按能力门（当前恒无） | 同左 |

---

## 8. 数据红线与审计（对 docs/15 §6/§10 的 Relay 投影）

- 不落（全 Relay 面增量）：端到端 Token 明文、Relay 凭据明文、注册码明文、配对码明文、
  完整消息正文、sourceRef、任何未脱敏 payload——ECS 的 DB、日志、审计、错误消息一律不含；
  Windows 侧 relayClient 同红线（凭据仅本地文件、日志零凭据）。
- 缓存即脱敏投影（§5.4）；通知/事件摘要粒度与今日一致。
- 审计：Windows 侧沿用 `security_audit_logs`（relay 来源命令 detail 注 `origin:'relay'`）；
  ECS 侧 `relay_audit` 目录镜像（§5.3）；两侧独立落、标识符（deviceId/commandId/pairingId）
  可互查。

---

## 9. 次级决策清单（本设计的自由裁量点，供主控复核）

| # | 决策 | 内容 | 备选与理由 |
| --- | --- | --- | --- |
| D1 | 事件 ACK 合并为累计游标 | `sync_request{after}` + `heartbeat{lastAckedSeq}` 取代现 `ack{seqs[]}`（映射见 docs/18 §10） | 备选=新增第 17 种 ack 帧，违背 16 帧冻结；累计游标是批量 ack 的超集且实现更简 |
| D2 | Android 单凭据（端到端 Token 兼作 ECS 注册表键） | ECS 存 `sha256(e2e Token)` 作注册表键，手机不持有第二凭据 | 备选=独立 Relay 设备凭据（双头更隔离）；取单凭据因 G4 裁决只要求 Windows↔ECS 凭据化，手机双凭据徒增 SecureStore/轮换复杂度；ECS 侧可独立撤销（status 位）已覆盖隔离需求 |
| D3 | post-pairing 自动 token_rotation | 配对成功即轮换一次，收窄「Token 过境 ECS」窗口（§3.2） | 备选=不轮换（窗口=Token 全生命周期）；轮换成本一枚帧，收益明确 |
| D4 | 命令下行直调 L3（submitRemoteCommand），不经 loopback HTTP | §4.4 | 备选=回打 127.0.0.1:8746（复用 handler 全链但引入端口依赖与双重限流）；主控任务书原语即 submitRemoteCommand |
| D5 | 状态投影走 `agents:gatewayStatus.relay` 可选字段 | 不新增 IPC channel（白名单 68 冻结约束下的最小面） | 备选=新增 `agents:relayStatus` channel（需动白名单计数三处断言）；可选字段零破坏 |
| D6 | origin 区分以可选列 + 投影字段表达 | `remote_devices.origin`（migration 005 候选，可先以 settings/内存态起步） | G4 差距项「origin 字段类方案」的落地形态；是否开 005 尊重 G9「宁可 settings 先行」原则，docs/20 §2 R1 给出两步走 |
| D7 | relay 模式强制 wss 于代码层（拒绝保存非 TLS endpoint），cleartext 全局开关暂不收紧 | `usesCleartextTraffic` 现状保留（local 模式必要），relay 模式代码层校验兜底 | 备选=network_security_config 按域区分（更严但配置复杂，待域名落定后一并做，docs/21 §1） |
| D8 | command_result 与 command.result 事件双通道并存 | 低延迟直回 + 事实源事件流，Android 按 commandId 去重 | 备选=仅事件通道（多一跳 RTT）；直回帧是 16 帧集成员，语义已冻结 |
| D9 | ECS 缓存含已脱敏 payload（非仅元数据） | §5.4；host 离线时设备仍可补齐「摘要级」事件 | 备选=仅元数据（更保守但断线补发失去意义）；payload 上游已脱敏+4KB 界，符合「不存敏感」裁决原文 |
| D10 | REST 中继范围 v1 收敛到 5 端点 | docs/18 §7.2；设备管理/诊断/归档留本地模式 | 最小化经中继写面；扩 rest_proxy 帧族为 backlog |
