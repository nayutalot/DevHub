# ECS Relay 改造差距清单（ecs-relay-gaps）

> 对照对象：`docs/ecs-relay-current-state.md`（同批基线审计，`audit/ecs-code` @ `9077d75`）。
> 目标架构（任务书摘要）：Android ↔ **ECS Relay（443 HTTPS/WSS）** ↔ **Windows DevHub（出站 WSS 长连）** ↔ 本机 Adapter；ECS 只做转发/配对/心跳/ACK/sequence/离线缓存/审计，不跑 Agent、不存敏感；**命令必须回 Windows 校验执行**；统一协议消息集 = `hello / pair / pair_accepted / agent_list / session_list / event / message / command / command_ack / command_result / sync_request / sync_response / heartbeat / token_rotation / disconnect / error`；事件含 `eventId / sequence / deviceId / requiresUserAction` 等字段；命令 action ∈ {send_message, approve, pause, resume, interrupt}；手机端区分本地 Gateway 与 ECS Relay 两模式；公网 8746/7000/3389 收敛、443 唯一正式入口、22 收敛固定 IP；保留 127.0.0.1:8746 本机兼容；NatPierce 标记备用不删码。
> 每条差距五要素：差距描述 / 现有可复用资产 / 需新建或改造点 / 影响面与风险 / 建议归属工作流（relay-client = Windows 出站客户端 | ecs-relay = ECS Relay 服务 | android-relay = Android 端 | 主控 = 编排/部署/安全/域名裁决）。

---

## G1. ECS 侧无原生 Relay 服务（最高优先级阻塞链之首）

- **差距描述**：ECS 上当前只有 frps（TCP 透传进程）+ systemd，没有任何 Relay 应用。目标要求的设备注册/配对、双向转发、心跳、ACK、sequence 对齐、离线缓存、审计日志，全部〔不存在〕。443 上无任何监听。
- **现有可复用资产**：
  - Windows Gateway 四文件（`gateway/httpServer.ts|auth.ts|ws.ts|pairing.ts`）的鉴权/防重放/限流/配对码语义可作为 ECS 侧同构实现的**参考实现**（代码可直接移植到 Node 服务：全部 electron-free、node:crypto/node:sqlite）；
  - 事件管线 `eventPipeline.ts` 的 sequence 单调/delivery 状态机/`eventsSince` 补发语义可整体复用为 ECS 缓存面设计；
  - `event_deliveries` 表结构可直接作为 ECS 离线缓存表蓝本；
  - `security_audit_logs` 结构可平移为 ECS 审计表；
  - ECS 现成资产：Ubuntu 24.04、frps systemd 部署经验、7000/8746 安全组已通（后续要收）、`~/.ssh/devhub_ecs` 通道。
- **需新建或改造点**：全新 Relay 服务（建议 Node 以贴近可移植代码，或按主控裁决选型）；systemd 部署单元；日志轮转；进程看护；与 frps 的并存与最终替换关系；离线缓存容量上限与淘汰策略（"不存敏感"约束 → 缓存内容需脱敏投影或仅元数据+加密 blob，需裁决）。
- **影响面与风险**：全新组件无历史包袱但也无回归保护网；ECS 仅 2C2G/3Mbps 带宽——WS 长连数、事件吞吐、缓存容量都受硬约束（当前真库已达 14.8k 事件量级）；单点故障（无备用实例）。
- **建议归属**：ecs-relay（服务本体）+ 主控（选型裁决、部署、带宽/容量裁决）。

## G2. TLS/443 入口：无域名是硬阻塞项（需用户/主控裁决，代码前置可并行）

- **差距描述**：目标"443 HTTPS/WSS 唯一正式入口"要求 TLS 终结。当前：无域名〔不存在〕、无证书〔不存在〕、443 无监听〔不存在〕、App 侧 `usesCleartextTraffic="true"` 且现有 WS 客户端只支持 `ws://` 明文。手机→ECS 段全程明文（known-limitations §5.1 自记残余限制①）。
- **选项与评估**（按安全要求递减，需主控+用户裁决）：
  1. **买域名 + Let's Encrypt/ACM 证书（推荐）**：唯一能满足"标准 HTTPS/WSS + 服务端证书校验"的路径；成本=域名年费+DNS 配置；Android 侧零自签信任代码（OkHttp 默认校验即可）。国内注册商实名 + ICP 备案时间线是主要不确定性（用港/海外注册+海外 DNS 可规避备案，但解析稳定性需评估）。
  2. **IP 自签证书 + App 证书指纹锁定（certificate pinning）**：免域名，但 Android 侧要新增 pinning 代码（network_security_config 或 OkHttp CertificatePinner），证书轮换=发版；桌面 relayClient 侧同样要 pinning 逻辑；运维上轮换风险高。
  3. **过渡期 `ws://` 明文跑 443**：与"443 唯一正式入口"形似但**不满足 TLS 安全要求**——公网明文 Token+防重放头暴露，仅可作为开发/联调阶段形态，不应作为验收态；若临时使用须在文档与 App 内安全须知明示（现有"安全须知弹窗"文案需同步更新）。
- **现有可复用资产**：明文路径下三条应用层防线（可撤销 Token+防重放+限流）已公网实测〔代码+真实联调实证〕，TLS 落地后防线只增不减；natpierce-setup §7.5 已有 TLS 升级路径草案。
- **需新建或改造点**：域名/证书获取与部署（G1 服务 TLS 终结或前置 nginx/caddy）；App 与 relayClient 的 `wss://` 支持；（选项 2 时）双端 pinning。
- **影响面与风险**：不解决则 G1/G4/G7 的验收只能停在明文形态；备案/证书时间线不可控，建议与代码改造并行推进；443 收敛与 G5 安全组迁移强耦合。
- **建议归属**：主控（域名/证书采购与备案裁决、部署）+ relay-client / android-relay（wss 与 pinning 代码）。

## G3. Windows 侧无出站 WSS Relay Client（gateway 是被动入站）

- **差距描述**：目标要求 DevHub 作为客户端**出站**连 ECS Relay 长连（家庭 NAT 后无需公网入站）。现状 gateway 全部为入站监听（`server.listen(port,'127.0.0.1')`），仓库内无任何 WS **客户端**实现；公网可达完全依赖 frpc 出站反连（frp 透传，非应用层）。
- **现有可复用资产**：
  - 自研 WS 服务端的帧编解码/心跳/sync-ack 语义（`gateway/ws.ts`）——客户端帧编解码可镜像复用（服务端不掩码/客户端必掩码的差异点明确）；
  - Android `ConnectionManager.kt` 的重连状态机（退避 1s→60s ±20% jitter、hello→sync 对齐、批量 ack、离线队列补发）是**行为规格**，Kotlin→TS 移植路径清晰；
  - `core/Backoff.kt` ↔ smoke 覆盖的退避参数可直接搬；
  - L3 写库层（agentControlService）与指令门（capability 二次校验、TTL 300s）不动——目标架构"命令必须回 Windows 校验执行"恰好就是现有 `submitRemoteCommand` 语义，直接成为 relayClient 的下行指令消费端。
- **需新建或改造点**：`src/main/services/agentControl/relayClient/`（或同级新目录）：出站 WSS 连接管理、断线重连、设备身份持有、上行事件推送（把 eventPipeline 的投递回调从"写 deliveries 行"扩展为"写行+推 relay"）、下行命令接回 `submitRemoteCommand`；与本地 Gateway（127.0.0.1:8746）并行的开关与状态投影（agents:gatewayStatus 面扩展）；自启常驻形态（随主进程，复用 login_autostart）。
- **影响面与风险**：新增一条常驻出站连接，与现有 smoke 的"Gateway 启停/端口"用例面正交（不易回归）；但事件投递语义要处理"本地设备直连 + 经 Relay 设备"双目标投递（event_deliveries 的 device 粒度需要能表达"经 Relay 的设备"）；frp 与 relayClient 的过渡期并存要防双路重复投递（幂等键已有，但投递去重视角要明确）。
- **建议归属**：relay-client。

## G4. 设备身份模型：Token 由 Gateway 签发 → Relay 架构下归属重设计

- **差距描述**：现状设备身份 = `remote_devices` 行（Gateway 签发 256-bit Token、只存 sha256、token_version 字段备而未用）。Relay 架构下配对发生在 ECS（pair 消息），设备对 Windows 证明身份需经 ECS 中转——"谁签发、谁校验、撤销谁来执行"三层关系全部要重定。当前 token_rotation **协议帧预留但服务端绝不发送**〔代码存在未验证〕，目标把它列入消息集为正式语义。
- **现有可复用资产**：8 位配对码语义（Crockford、TTL 300s、一次性、失败 5 次作废、限流）可整体上移到 ECS pair/pair_accepted；`token_hash`/`token_version`/撤销即拒语义可平移；`security_audit_logs` 的 pairing/auth 事件目录可平移到 ECS 审计。
- **需新建或改造点**：裁决身份模型（建议方向：ECS 持设备注册表并签发 Relay 域凭据；Windows 侧持有"本机密钥/设备凭据"用于 Relay 双向认证；端到端一层可再叠加现有 Token 语义，使 ECS 不可伪造指令——"ECS 不存敏感"要求下，指令内容加密或仅 ECS 见密文需设计）；token_rotation 落地为真实帧（Windows relayClient 收帧→落库新 token→设备侧持久化轮换；Android SecureStore 更新路径）；撤销链路（桌面 revoke → 通知 ECS 踢下线 → 设备 401，现有 `closeDeviceConnections` 注入缝可平移）。
- **影响面与风险**：身份模型是协议冻结的前置项，返工代价最高的一条；涉及密码学选型（是否引入公钥/每设备密钥），影响 android-relay 与 relay-client 双端；现有 4 台真库设备与新模型的迁移/并存策略需明确（可接受旧直连设备与新 Relay 设备并存，remote_devices 增加 origin 字段类方案）。
- **建议归属**：主控（模型裁决）+ relay-client + ecs-relay + android-relay（按裁决分头实现）。

## G5. 协议差距：现有 WS 窄集 vs 目标 16 消息集

- **差距描述**：现网 WS 帧仅 `hello / sync / event / ack / (ping/pong) (+token_rotation 预留)`。目标消息集 16 种中缺失：`pair / pair_accepted / agent_list / session_list / message / command / command_ack / command_result / sync_request / sync_response / heartbeat / disconnect / error`——其中一部分语义现由 **REST 端点**承担（列表/详情/回复走 GET/POST，202 accepted + `command.result` 事件），并非 WS 帧；`error` 目前是 HTTP 结构化错误码体系（docs/14 Part C），无帧形态。
- **现有可复用资产**：
  - `agent_list/session_list/message` ≈ 现有 GET /v1/agents、/v1/sessions、/v1/sessions/{id}/messages 的投影逻辑（含 sourceRef 剥离、脱敏同源）——帧化主要是搬运投影函数；
  - `command/command_ack/command_result` ≈ 现有 POST reply|actions（202 + idempotency_key + remote_commands 状态机 + command.result 事件）——语义已完备，缺帧通道；
  - `sync_request/sync_response` ≈ 现有 sync 帧双向化（现在是客户端→服务端单向）；
  - `heartbeat` ≈ 现 ping/pong + hello.heartbeatSec 参数化（30s/10s）已实测；
  - `disconnect` ≈ close 语义 + 撤销踢线注入缝；
  - Android `WsFrames.kt` 已是 sealed class，扩展消息类型不动架构。
- **需新建或改造点**：协议文档冻结（建议新 docs 或 docs/14 增补版）；双端帧编解码扩展；REST 与 WS 双通道的取舍（建议：列表/详情初载保留 REST（可复用缓存与分页），实时面全走 WS——需裁决）；`error` 帧与 HTTP 错误码的统一映射表。
- **影响面与风险**：协议膨胀会放大 ECS 带宽压力（3Mbps）；REST 保留度决定 Android 改造量；smoke 对 WS 协议的现有断言（ac6 段）为 append-only，扩展不能破坏旧帧断言。
- **建议归属**：主控（协议冻结裁决）+ relay-client / ecs-relay / android-relay 各自实现侧。

## G6. 事件模型字段差与动作集差（requiresUserAction / approve / interrupt）

- **差距描述**：
  - 事件字段：现有 event 帧 = `{seq, eventId, eventType, sessionId?, summary?, payload, createdAt}`；目标要求 `eventId/sequence/deviceId/requiresUserAction` 等——`sequence`（现名 seq）、`eventId` 已有；**`deviceId` 级路由信息在 event 帧本体缺失**（由 event_deliveries 表达）；**`requiresUserAction` 字段不存在**（现由 `event_type=session.waiting_input` + payload.status ∈ {waiting_input, approval_required} 隐含）。
  - 动作集：现有 action 全集 = `{reply, pause, resume}`；目标 = `{send_message, approve, pause, resume, interrupt}`。`reply→send_message` 为改名映射；**`approve` 与 `interrupt` 两动作全链路不存在**：IPC 白名单、remote_commands.action CHECK、Gateway actions 路由白名单、Android ControlGate/按钮、provider 能力集（granted 五档）均无此二者。
- **现有可复用资产**：
  - `approve`：判定源已按"绝不猜"原则预备——codex 实测**无审批片段**（APPROVAL_FRAGMENT_TYPES 置空）；kimi 有 `interaction.request(kind='approval')` 判定源〔代码+真库/语料实证〕；claude hooks 审批事件为设计判定源但未激活——即 approval_required 事件已有产生通道（kimi），缺的是"批准/拒绝"执行通道（kimi 有 `interaction.resolved` 闭环语料，存在实现路径）。
  - `interrupt`：codex `turn/interrupt` 方法在 app-server 158 方法清单内〔代码+真实联调实证〕，executeCommand 走持久连接的通道已就绪；未验证点=活跃 turn 中打断的真实效果（ac8 未执行，记为加分项）。
  - 事件字段扩展：agent_events.payload_json 为 JSON，加字段零 migration；帧结构加字段向后兼容。
- **需新建或改造点**：协议层 requiresUserAction 投影规则（event_type→布尔映射即可起步）；capability 五档扩为七档（granted 数组、ControlGate、REST actions 白名单、remote_commands.action 值域、IPC sessionAction 白名单联动——注意 IPC 白名单 68 条冻结，`agents:sessionAction` 的 action 白名单扩展属值域变化非新增 channel）；每 provider 的 approve/interrupt 能力验证函数与"绝不猜"落点（无判定源即恒不授予）。
- **影响面与风险**：approve 是"人在环"语义，错误授予=远程代批，风险等级最高——能力验证门必须逐 provider 真实验证；zcode/claude(clause)/deepseek 大概率长期不授予；smoke ac3-ac8 段对 granted 集合的断言面较宽。
- **建议归属**：relay-client（动作执行桥接）+ android-relay（按钮/门）+ 主控（approve 安全裁决）。

## G7. Android：Relay 模式双形态、approve/interrupt 按钮、token_rotation

- **差距描述**：
  - 双模式：现 App 只有"直连 Gateway"单形态（host:port + http/ws 明文）。需增加"ECS Relay 模式"（wss://… 或 域名+证书）与本地模式并存的连接管理 UI 与连接状态机（含两模式切换、状态展示、故障隔离——本地模式不可用时 Relay 模式兜底或反之，需交互裁决）。
  - 动作按钮：现仅回复框+pause/resume（granted 门）；需加 approve（含拒绝？目标未提 reject——需裁决）与 interrupt 按钮，同样走 granted 门；approval_required 事件的通知文案与 deep link 落点要区分"等待输入"与"等待批准"。
  - token_rotation：客户端仅能解析帧类型〔代码存在未验证〕；需落地"收帧→SecureStore 原子更新→失败回退→旧 token 作废时序"全流程。
- **现有可复用资产**：前台服务/通知/离线队列/退避重连/Room 缓存/deep link 全部不动；SecureStore（Keystore）已有；GatewayConfigScreen 的 host:port 表单可扩为模式选择；EventNotification 映射器可扩 requiresUserAction 维度。
- **影响面与风险**：`usesCleartextTraffic="true"` 在引入 Relay 模式后应收敛（本地模式保留 cleartext、Relay 模式强制 TLS——network_security_config 可按域区分）；华为/无 GMS 真机上的前台服务存活问题已记录（known-limitations §4.1），Relay 不解决推送面（见 G9）；两模式并存的状态展示复杂度是 UI 评审点。
- **建议归属**：android-relay。

## G8. 安全组与入口收敛（8746/7000/3389/22/ICMP → 目标表）

- **差距描述**：现状（主控实测记录，本审计未复测）：公网 8746（frp 对外服务面）、7000（frp 控制面）、22（ssh，建议已给"收敛固定 IP"）OPEN；3389/443/80 无监听。目标：443 唯一正式入口；8746/7000/3389 收敛关闭；22 收敛固定 IP；保留 127.0.0.1:8746（本机，不在安全组面）。
- **现有可复用资产**：阿里云安全组操作路径已熟悉（natpierce-setup §7.2 步骤 4）；frps/frpc 的启停脚本与 systemd 单元已有；App 与模拟器双连接形态已验证（切换入口=改 App 配置，零代码）。
- **需新建或改造点**：迁移顺序编排（①Relay 上线 443 → ②App 切换验证 → ③frpc 停用观察期 → ④撤 frps、收 8746/7000 → ⑤22 固定 IP 复核）；frp 退役判据（建议：Relay 模式真机全链路+B1–B8 等价回归全过后，frpc 停用两周观察再撤）；NatPierce（方案 A）按任务书标记备用不删码——natpierce.ts 投影与文档保留，零改动即满足。
- **影响面与风险**：8746 收敛后所有现存"直连公网 8746"路径失效（当前仅验收环境使用，风险小）；7000 关闭前必须先确认 frpc 已全网停用否则无限重连；ICMP 现状未在仓内记录（主控面事项）；迁移窗口内双入口并存的安全审计要分清来源。
- **建议归属**：主控（安全组操作、退役判据、迁移窗口编排）。

## G9. 数据层：ECS 独立存储与 Windows 侧 migration 005

- **差距描述**：
  - ECS 侧：需要设备注册表、会话/事件缓存元数据、审计——**必须由 Relay 服务自己的存储承担（独立 schema/独立 DB 文件），不进 DevHub migration 序列**；容量上限与"不存敏感"约束（缓存脱敏投影 or 仅元数据+加密）需裁决。
  - Windows 侧：现 schema 尚无 Relay 概念——relayClient 的运行状态/对端配置（ECS 地址、本机 Relay 凭据）、"经 Relay 设备"的投递粒度表达，可能需要 migration 005（settings 键扩展可走现有 settings 表零迁移；结构性字段才需要 005）。
- **现有可复用资产**：migration 框架（migrate.ts 字面量 user_version switch、append-only 纪律）；`event_deliveries`/`remote_devices`/`security_audit_logs` 结构蓝本（ECS 侧照抄改造）；settings 表的 key-value 通道（gateway_port/gateway_enabled 先例——relay_enabled/relay_endpoint 等可同路径种子）。
- **需新建或改造点**：Windows migration 005（按最小需求裁决：优先 settings 键方案，避免 005）；ECS 侧建库脚本+备份策略；两侧行保留/淘汰策略（ECS 缓存按 ACK+TTL 清理；Windows 侧维持"未 ack 不删"不变）。
- **影响面与风险**：migration 是 append-only 铁律域，005 一旦发布不可撤回——建议宁可 settings 先行；ECS SQLite（node:sqlite）在 2C2G 上的 WAL 性能与磁盘量要留观测。
- **建议归属**：relay-client（Windows 侧）+ ecs-relay（ECS 存储）+ 主控（是否开 005 裁决）。

## G10. 推送唤醒：FCM 或等效通知（现无）

- **差距描述**：目标要求"FCM 或等效通知唤醒"。现状：无任何推送通道〔不存在〕——实时性完全依赖前台服务常驻 WS（应用被杀即失联，App 内已明示；known-limitations §4.1）。Relay 架构本身也不解决推送（ECS 仍需长连或推送二选一）。
- **阻塞项**：①FCM 需要 Firebase 项目/Google 服务配置（外部账号依赖，等用户）；②**国内真机无 GMS**（华为系等）——FCM 不可用，必须列厂商通道备选（小米/华为/OPPO/vivo 推送或统一推送联盟）或"等效"降级方案（自建轻量唤醒：Relay 下发静默推送的替代=Doze 窗口内的心跳拉取/WorkManager 周期同步——实时性显著下降，需用户接受度裁决）；③App 当前未接任何推送 SDK，.gradle/Manifest 零改动可从头接入。
- **现有可复用资产**：通知构建/通知渠道/deep link 点击路径已完备（EventNotification/Notifier）；waiting_input/approval_required 事件分类已实测——推送内容生成端现成，缺的只是"设备不在前台时把事件送达到系统"的传输通道。
- **影响面与风险**：外部依赖（Firebase 项目、厂商推送后台）都不在代码工作流内，排期不可控；多通道接入显著增加 android-relay 面积；建议分期：先 Relay 长连（保持现形态）→ FCM（有 GMS 设备）→ 厂商通道（按用户真机型号定优先级）。
- **建议归属**：android-relay（SDK 接入）+ 主控（Firebase/厂商账号与通道优先级裁决）。

## G11. 门禁与回归面（smoke / mcp / :core:test / 打包）

- **差距描述**：现门禁基线 = smoke 144 用例（append-only，含 ac6 Gateway 全量断言、ac8-140 natpierce 三态、fix-zcode-subagent 两批）+ mcp-acceptance 22 + :core:test 37 + tsc + electron-vite build + gradle assembleDebug。Relay 改造将新增大量无回归保护的新面（relayClient、ECS 服务、Android 双模式、协议扩展），而 smoke 对"ECS 远端"天然不可自动化（外部依赖）。
- **现有可复用资产**：smoke 夹具化设计（provider override 注入、electron-free 分层、端口协调教训：smoke 占 8746-8755，真实 Gateway 避开）可直接延伸——relayClient 的 ECS 端可做**本地夹具 Relay**（同进程起一个内存 Relay 桩）实现全自动化；:core:test 纯 Kotlin 单测模式可继续承载 Android 协议/门控新逻辑；mcp-acceptance A12"树净断言"提醒验收产物先提交再跑门的流程照旧。
- **需新建或改造点**：smoke 新段（relay 协议帧编解码、双模式连接状态机、token_rotation 流程、approve/interrupt 能力门、事件字段投影）；ECS 服务的独立自测（脱离 DevHub 仓或以子仓/脚本形态）；真机验收脚本化清单（B1–B8 的 Relay 版等价表）。
- **影响面与风险**：smoke append-only 且用例已 144，新增面越大跑时越长；端口占用面扩大（夹具 Relay 端口选择要避开 8746-8755 与真实服务）；ECS 侧无法纳入仓库门禁的"永远存在的未验证区"要靠文档+部署自检脚本补偿。
- **建议归属**：各工作流各自补自己域的用例 + 主控（门禁编排与"ECS 侧自检"形态裁决）。

---

## 汇总：建议实施顺序（供主控编排参考，非本审计裁决）

1. **先裁决**：G2 域名/TLS 选项、G4 身份模型、G5 协议冻结、G6 approve 安全边界（四项是其余条目的地基）；
2. **并行开工**：G1 ECS 服务（含存储 G9-ECS 侧）∥ G3 relayClient ∥ G7 Android 双模式——三者接口即 G5 冻结协议；
3. **随后**：G6 动作扩展（依赖 G5/G4）、G10 推送分期（外部依赖另计）；
4. **收尾迁移**：G8 安全组收敛与 frp 退役（判据=G11 的 Relay 版 B1–B8 全过）；
5. 全程保留 127.0.0.1:8746 本机兼容与 NatPierce 备用（零删码）。
