# Agent Control / ECS Relay 八仓参考映射（agent-control-reference-map）

> ECS Relay 改造的参考研究文档（audit/ecs-ref 分支产出，2026-09-04）。只做设计借鉴映射，
> 零代码改动；**只借鉴设计思想，不复制任何上游代码**。
> 三大改造部件约定：**ECS Relay**（云侧中继服务，阿里云 ECS 上，443 唯一公网入口）/
> **DevHub Relay Client**（PC 侧出站客户端，替代现网 frpc，回源到桌面 Gateway 127.0.0.1:8746）/
> **Android**（手机端 App，OkHttp WS + Keystore，docs/12 L6）。
> 涉及 DevHub 桌面本体部件时按现有文件指名：`src/main/services/agentControl/gateway/ws.ts`、
> `eventPipeline.ts`、`providers/*` 等（docs/12 §9）。

## 0. 网络实况与证据等级（先读）

本会话网络受限，如实声明：

- **直连 GitHub 全部失败**：WebFetch 对 `github.com` 超时、对 `raw.githubusercontent.com`
  与 `r.jina.ai` DNS 解析失败；沙箱内 curl 出网全被拦（HTTP 000）。**八仓均未能读到
  一手资料（README/源码原始页面）**，标注「未能直接访问」。
- 实际信息来源 = **WebSearch 检索汇总**（命中官方文档页、GitHub Issue、官方博客、
  第三方技术文章的二手转述）+ **既有知识**（模型对这批知名开源项目的先验知识）。
- 证据等级标注（逐仓标于节首）：
  - **A** = 本会话一手资料（仅项目内文档：docs/11-16、natpierce-setup.md、HANDOFF.md）；
  - **B** = 检索结果（二手转述，含官方文档/Issue/博客摘要）；
  - **C** = 既有知识（先验，未在本会话验证）。
  通用等级为 **B+C**；涉及具体默认值/字段名等落地前须按仓库 docs 复核的点，逐处标注「落地前复核」。
- frp 的部署拓扑与弱点另有 **A 级**一手证据（docs/natpierce-setup.md §7，已实测端到端）。

---

## 1. OpenHands（All-Hands-AI/OpenHands，现 OpenHands/openhands）— 证据 B+C

检索实况：官方仓库与两篇论文/深潜文（OpenHands 平台论文、OpenHands Software Agent
SDK 论文 arXiv:2511.03690、dev.to 构建指南）确认其事件驱动架构：**append-only 事件流
是唯一事实源**，V0 形态为 AgentSession + EventStream（`ActionEvent` 工具调用 /
`ObservationEvent` 结果），V1 SDK 形态收敛为「无状态 Agent 发出 Action + Conversation
跑循环 + append-only EventLog」；会话状态由事件历史推导（idle/running/paused/finished）；
UI 经 WebSocket 实时收事件；执行面为每会话 Docker 容器 Runtime。未能直接访问（B 级为主）。

**① 借鉴了什么**
- → **eventPipeline + 会话状态模型**：「append-only 事件流为唯一事实源、状态由事件历史
  推导」与 docs/12 §6「先写 SQLite 再 WS 投递、sequence 单调、`delivery_state` 只前进
  不回退」同构——ECS Relay 改造中**中继保持无状态转发、事件事实源留在桌面 SQLite**的
  裁决可引此为旁证（事件重放/断线补发以 seq 游标从事实源重读，而非中继缓存）。
- → **Gateway WS 投递**：OpenHands 后端→前端用 WS 实时推事件（浏览器只是订阅者），
  对应 DevHub `gateway/ws.ts` + Android `/v1/events` 订阅模型；其「事件即会话历史，
  新订阅者可从历史重建视图」支持 Android 重连后先 REST 拉快照再 WS 增量的既有设计。
- → **AgentSession 生命周期**：会话状态机由事件驱动、无独立权威状态存储——对应
  DevHub 9 值会话状态判定器（docs/12 §5）「判定源 > 推断」的纪律。

**② 没借鉴什么（明确排除）**
- **容器执行沙箱**（每会话 Docker Runtime、代码在沙箱内被执行）——DevHub 远程面只有
  reply/pause/resume 三种会话动作，任意执行是 docs/15 §5 六类禁止动作之首；
- 多租户 SaaS/浏览器内完整 IDE 产品形态；V1 SDK 的 Python Agent/LLM 框架本体
  （DevHub 的 provider 是外部既有 CLI，不重写 Agent）。

**③ 为什么不能直接当 DevHub 完整方案**：OpenHands 是承载「替用户执行」的重型自托管
Agent 平台（服务端+容器运行时+前端一体），其安全边界允许服务端执行代码，与 DevHub
「远程面零执行、只观察+三受限动作」的红线根本不同。

---

## 2. OpenAI Codex（openai/codex）— 证据 B+C+A（A = DevHub 已真机对接其 app-server）

检索实况：codex-rs 内置 **app-server**：长驻进程承载 Codex core threads，经
**JSON-RPC 2.0（JSONL over stdio，线上省略 `jsonrpc` 字段）双向协议**暴露；
会话组织为 **Thread（持久会话）→ Turn（一轮）→ Item（消息/命令/推理等条目）**三级原语；
典型流 = 一个客户端请求 + 多条服务端通知（如 `turn/started` 等 stream 事件）；
线程持久化为 rollout `.jsonl`，支持 resume/fork；协议含审批（approvals）与沙箱控制事件。
官方工程博客（openai.com "Unlocking the Codex harness"）与 app-server README 佐证。
未能直接访问（B 级为主）；DevHub AC3 已真机握手 codex app-server（HANDOFF：158 methods，
A 级一手事实）。

**① 借鉴了什么**
- → **ECS Relay 控制协议形态**：「一个请求 + 多条单向通知」的 JSONL 双向流是 Relay
  控制面（注册/心跳/事件下发）可对齐的协议骨架——Relay Client↔Relay 若走 WS，
  帧 = 请求帧（要 ack）+ 通知帧（只投递）+ 心跳帧，语义与 app-server 同构；
- → **Thread→Turn→Item 三级组织**：Android 会话详情的「消息按轮分组展示、同一轮多条
  折叠」（docs/12 §6 `message.appended` 可折叠语义）与该模型直接对应；Relay 转发层
  按 turn/seq 分片补发可简化断线恢复；
- → **rollout 追加式持久化 + resume**：DevHub observed 通道已按此读（docs/12 §8.1）；
  Relay 的断线补发沿用同一「offset/seq 游标 + 幂等去重」思路；
- → **审批事件独立类型**：approval_required 判定源（ZCode tool_usage / rollout 审批
  片段）证明「审批/等待输入必须是一等事件类型」，Android 通知触发面据此设计。

**② 没借鉴什么（明确排除）**
- Codex 本体的推理/sandbox policy（workspace-write 等执行沙箱策略）——DevHub 不改造
  Agent 本体（docs/12 L1 铁律）；
- app-server 全量协议面（158 methods）——DevHub 只取会话/事件/回复子集。

**③ 为什么不能直接当 DevHub 完整方案**：app-server 是本机 stdio 协议，无网络传输层、
无鉴权/多设备/审计语义，只解决「与单个 Agent 的会话通道」，不解决公网中继与设备治理。

---

## 3. ttyd（tsl0922/ttyd）— 证据 B+C

检索实况：ttyd 经 WebSocket 流式传输终端：连接生命周期 = HTTP 拉页面/token 端点取
token → WS upgrade（token 常随 query/首帧携带）→ **首字节 opcode 的二进制分帧**
（OUTPUT=终端输出 / INPUT=键入 / JSON_DATA=控制·鉴权·resize / PING=保活）→ 断开即回收
PTY；前端 xterm.js；支持 basic auth 与 TLS；NCC Group 技术通告证实其弱点：未配置鉴权时
`JSON_DATA` 可无凭据直连并下发命令，AuthToken 机制弱。未能直接访问（B 级为主）。

**① 借鉴了什么**
- → **gateway/ws.ts + ECS Relay 的 WSS 生命周期**：「HTTP 先取一次性 token → 再 upgrade
  → 分帧 → 心跳保活 → 断开回收」五段式生命周期，与 DevHub 配对→设备 Token→WS upgrade
  校验→心跳（30s 实测）→撤销即断的链路同构；Relay 的 443 WSS 入口连接管理按此分段实现
  与排障；
- → **opcode 首字节分帧的轻量多路复用**：控制面（鉴权/resize/心跳）与数据面（输出流）
  同一条 WS 上按首字节分流——DevHub 自研 WS 的帧类型（事件帧/ack 帧/心跳帧/
  token_rotation 帧，docs/15 §3）可参考其「一个字节定类型、解析零依赖」的极简分帧，
  而非引入子协议协商；
- → **断开即释放对端资源**：ttyd 断 WS 即杀 PTY；Relay 断开（Android 侧或 Relay Client
  侧）必须立即回收对应回源通道与投递缓冲，不留孤儿连接。

**② 没借鉴什么（明确排除）**
- **终端流暴露本体**（PTY 直通浏览器、`--writable` 任意键入=任意 shell）——DevHub 远程
  面无任何终端/命令执行通道（docs/15 §5 禁止动作 1）；
- **query/首帧携带凭据的弱鉴权形态**（NCC 通告的绕过面）——DevHub 凭据只走受保护头 +
  防重放（`X-DevHub-Timestamp`/`X-DevHub-Nonce`），不做「token 当门票一次验完不再管」。

**③ 为什么不能直接当 DevHub 完整方案**：ttyd 把可执行 shell 直通浏览器且鉴权模型弱
（token 走 query、无重放防护、未配置时可完全绕过），与 DevHub「远程面零执行、凭据全
程受保护」的红线正面冲突。

---

## 4. frp（fatedier/frp）— 证据 B+C+A（A = docs/natpierce-setup.md §7 已实测部署）

检索实况：C/S 架构，frps 部署于公网机，frpc 于 NAT 后；frpc **出站**拨号
`bindAddr:bindPort`（惯用 7000）建控制连接，Login 消息携 token 鉴权，随后逐 proxy 发
NewProxy 注册；外部流量打 frps 的 remotePort，frps 经已建控制通道回开 work connections
回源；心跳默认 10s 间隔 / 服务端 90s 超时（`transport.heartbeatTimeout`）；
`additionalScopes = ["HeartBeats"]` 可令心跳也过鉴权；支持 `transport.tls`、dashboard
（webServer 7500）、tcp/udp/http/https/stcp/xtcp visitor 等多类型。未能直接访问
（B 级为主，官方文档摘要充分）。

**① 借鉴了什么**
- → **DevHub Relay Client 出站拓扑**：「客户端出站反连穿 NAT、服务端与家里 PC 均零入站
  要求」是现网已验证的正确拓扑（A 级：natpierce-setup.md §7.1），原生 Relay Client 完整
  沿用——PC 侧不开任何入站、不开路由器端口；
- → **控制面/数据面分离**：控制连接（注册/心跳/鉴权）与工作连接（实际转发）分离——
  Relay 的控制 WS 与事件/请求转发通道分离同构，控制面重建不影响在途数据面的优雅降级
  策略可按此设计；
- → **心跳与重连参数基线**：10s 心跳 / 90s 超时 / 断线自动重拉（现网 frpc-run.vbs 的
  5s 重拉等效 `Restart=always`，A 级）——Relay Client 的保活/退避参数以此为对照基线；
- → **token 认证 + 心跳可鉴权**：`additionalScopes=["HeartBeats"]` 说明「长连接生命周期
  内的持续凭证校验」是隧道类系统的已知最佳实践——Relay 心跳帧应带凭证/会话态校验，
  而非仅在握手时验一次。

**② 没借鉴什么（明确排除）**
- **remotePort 公网裸暴露模型**（8746 对 0.0.0.0/0 直接监听）——目标架构收敛到 443
  唯一入口（安全组策略见 docs/ecs-security-group-policy.md）；
- 通用代理全家桶（http/https/udp/stcp/xtcp visitor/P2P）与 dashboard/配置热加载等
  运维面——DevHub 只需一条固定拓扑转发；
- 「单 token 即全部身份」的模型——DevHub 需要设备级身份/授权矩阵/审计。

**③ 为什么不能直接当 DevHub 完整方案**：frp 的安全模型是「端口暴露+对称 token」，无
设备身份、授权矩阵、审计与事件语义，且把公网面摊到两个非 443 端口，与「443 单入口+
设备级治理」的目标形态不符。

---

## 5. rathole（rapiz1/rathole，现 rathole-org/rathole）— 证据 B+C

检索实况：Rust 单二进制轻量反向代理（frp/ngrok 替代品）；TOML 配置、可按配置自动判定
server/client 模式；服务以 **service token** 配对（`default_token`/逐服务 token）；
加密可选项 **Noise 协议**（`Noise_NK_25519_ChaChaPoly_BLAKE2s` 模式，服务端 `private_key`
/客户端 `remote_public_key`，免自签证书）或 TLS；重连参数 `retry_interval`（默认 5s，
检索值）/退避乘数、`heartbeat_interval`（检索值默认 30s，落地前以 docs/config.md 复核）；
传输层 `idle_timeout`/`keepalive_secs`/`nodelay`；支持服务热重载、UDP 透传与
nftables/iptables 透明代理。未能直接访问（B 级为主；具体默认值落地前复核）。

**① 借鉴了什么**
- → **DevHub Relay Client 的极简配置面**：单二进制 + 三要素配置（服务地址/凭据/回源
  目标）是「用户自助可完成」的体验标杆——现网 frpc.toml 已是此形态（A 级），Relay
  Client 的配置面按同量级设计，不膨胀；
- → **重连状态机参数**：`retry_interval` + 指数退避 + 心跳/空闲超时分离的参数组——
  Relay Client 重连策略直接对标（退避上限、抖动，避免服务端重连风暴）；
- → **Noise NK 模式作为备选加密控制面**（仅记录，非推荐路径）：NK = 客户端持服务端公钥
  认证服务端、服务端零证书——若未来出现「443 反代之外需要第二条加密控制通道」的场景，
  NK 是比自签证书+指纹轻的方案；目标态 443 WSS + 正式证书仍是首选；
- → **传输层 keepalive/idle_timeout 兜底**：WS 心跳之外的低层保活兜底，避免半开连接
  假活（NAT 表项过期场景，家庭宽带高频出现）。

**② 没借鉴什么（明确排除）**
- UDP 透传与透明代理（DevHub 纯 TCP/WS 消息面）；
- 又一个 remotePort 公网暴露模型（同 frp 排除理由）；
- 「服务自动判定 server/client 模式」类隐式行为——DevHub 配置显式化纪律（凭据/端点
  全部显式声明）优先。

**③ 为什么不能直接当 DevHub 完整方案**：rathole 与 frp 同属通用隧道，目标形态仍是
公网端口暴露+对称 token，缺少 DevHub 需要的设备身份、443 单入口、事件流语义与审计。

---

## 6. Langfuse（langfuse/langfuse）— 证据 B

检索实况：LLM 可观测平台（可自托管）；数据模型三层：**Session → Trace → Observation**
（Observation 分 span/generation/event 等约 10 种语义类型）；trace/observation 摄取后
**不可变**，score（评分）可事后追加；session 级「回放时间线」视图（整段交互时间轴）；
Ingestion API 支持批量+幂等；自托管栈重（Postgres/ClickHouse/对象存储）。未能直接访问
（B 级，官方 docs 摘要充分）。

**① 借鉴了什么**
- → **eventPipeline 投影 + Android 时间线 UI**：Session→Trace→Observation 三层与 DevHub
  「remote_devices → agent_sessions → agent_events」分层同构；Android 会话详情的
  时间线交互（每事件带类型/时刻/摘要、错误醒目化）对标其 trace 时间线视图；
- → **主体不可变 + 评价可后补**：事件本体不可变、附加性元数据（如设备 ack 状态）单独
  走 `delivery_state` 单调前进——与 docs/12 §6 语义 4「未确认事件不删、状态只前进」
  相互印证；
- → **错误/延迟时间线**：generation 型观测携带时延/用量——Relay 链路的关键延迟与错误
  （回源失败/投递超时/重连次数）应作为独立事件类型进入审计/诊断投影，而非只进日志；
- → **批量+幂等摄取**：事件上报幂等键（DevHub `event_id` 派生唯一约束已具备）在 Relay
  批量补发场景直接复用。

**② 没借鉴什么（明确排除）**
- Langfuse 服务端本体（Postgres/ClickHouse/对象存储/多租户/评估/数据集/prompt 管理）
  ——DevHub 只留本地 SQLite 投影，零新增服务（docs/12 进程模型铁律）；
- LLM 评估/标注/prompt 实验功能（与 AC 域无关）。

**③ 为什么不能直接当 DevHub 完整方案**：Langfuse 是重型「采集-分析」可观测平台而非
实时双向控制通道，栈重且无鉴权化的设备控制语义，无法充当低延迟转发面。

---

## 7. Phoenix（Arize-ai/phoenix）— 证据 B

检索实况：AI 应用观测平台；**OpenInference 语义约定叠在 OpenTelemetry 之上**：span 为
基本单位，必带 `openinference.span.kind` 类型属性，另有 model/input/output/token 用量
等属性约定；span 父子树构成 trace；Project/Session 分组上层；`phoenix-otel` 为 OTEL
原语的轻封装；兼容 OTLP 导出，GenAI 语义约定可互转。未能直接访问（B 级）。

**① 借鉴了什么**
- → **事件 payload 字段命名纪律**：「每条观测必带类型标识 + 受控属性表」——DevHub
  7 类事件的 payload 要点表（docs/12 §6）与 Relay 新增链路事件（回源/投递/重连）应
  遵循同款约定：固定类型字段 + 受控 payload 键集 + 脱敏红线（docs/15 §6），禁止自由
  文本塞语义；
- → **span 树归因 / Project-Session 分组**：Relay 链路的故障归因应按「设备 → 会话 →
  事件」树定位（对应其 trace 树 + project 分组），审计 detail 记录可定位标识符链
  （sessionId/commandId，docs/15 §10）；
- → **OTel 兼容出口思想**（backlog，不引入依赖）：若 Relay 未来需要接外部监控，
  OTel 语义是低耦合出口——先在事件模型上保持语义兼容（类型/时刻/属性三元），
  不提前引入任何 SDK。

**② 没借鉴什么（明确排除）**
- Phoenix 服务端本体（Python server、评估实验 UI、embedding 可视化）——零新增服务；
- instrumentor 自动埋点生态——DevHub 事件由 provider 解析器显式产出（docs/12 §7 监控
  管线），不做自动埋点，避免「自动捕获」触碰脱敏红线。

**③ 为什么不能直接当 DevHub 完整方案**：Phoenix 是离线/准实时的 trace 摄取分析平台，
只解决「看」，不提供鉴权、设备治理与双向控制语义。

---

## 8. MeshCentral（Ylianst/MeshCentral）— 证据 B+C

检索实况：开源 RMM（远程设备管理）。**MeshAgent 常驻在被管设备上、主动出站 TLS 连接
MeshCentral 服务端**（设备侧零入站）；agent 会做服务端证书校验（置于 NGINX 后时服务端
需让 agent 拿到真实证书以完成服务器认证）；设备以**设备组（mesh）**组织，用户权限为
「对确切设备集的确切权限集」的细粒度委托（权限位系统）；注册走安装 URL/二维码 enrollment
（一次凭据换长期设备身份）；安全面含连接日志、事件审计、会话录制、设备端 consent 确认
提示、agent 自更新；撤销即时生效。未能直接访问（B 级为主，官方 docs/博客摘要充分）。

**① 借鉴了什么**
- → **ECS Relay + Relay Client 的双向信任**：「设备/客户端出站连接 + 客户端校验服务端
  证书」——Relay Client 与 Android 都必须校验 443 证书（wss 正式证书链；自签过渡期用
  指纹锁定），不能只做服务端单侧认证；
- → **配对换长期身份的 enrollment 流**：安装 URL/二维码一次性凭据 → 长期设备身份，
  与 DevHub 8 位配对码（32^8 空间/300s TTL/一次性）换设备 Token 同构，验证了「短时效
  凭据换长期凭据」是成熟模式；未来多桌面/多设备扩展可借鉴其「设备组 × 权限位」模型
  演进 docs/15 §5 授权矩阵（当前单桌面单设备表不扩，仅记录方向）；
- → **审计与 consent 面**：连接日志/事件审计/设备端确认提示——对应 security_audit_logs
  （pairing/auth/command/device/gateway 五类，docs/15 §10）与 approval_required 通知
  （设备侧「用户确认」语义的远端投影）；撤销即时生效（撤销即拒 + 掐断活跃 WS，
  docs/15 §3）与其模型一致；
- → **agent 出站自恢复**（自更新/常驻重连）——Relay Client 常驻化（现网 frpc 的
  Run 键+重拉器为 A 级先例）沿用「掉线自动恢复、无需人工」的运维姿态。

**② 没借鉴什么（明确排除）**
- **MeshAgent 代理模型**（设备上常驻近乎全能的代理：远程桌面/终端/文件/执行）——
  DevHub 禁止远程命令执行与文件通道（docs/15 §5 禁止动作 1/2）；
- MeshCentral 服务端本体（全功能 RMM、多用户体系、Web 管理界面、屏幕流与会话录制
  ——录制与会话内容留存触碰数据红线）。

**③ 为什么不能直接当 DevHub 完整方案**：MeshCentral 是「管理员管机器」的全能 RMM，
其代理在设备上拥有近全能执行面，直接引入会把 DevHub 已收敛到「脱敏观察+三受限动作」
的执行面风险重新放大。

---

## 9. 映射总表

| 仓库 | 对应本项目部件 | 借鉴要点（具体设计点） | 排除要点 | 不能当完整方案的一句话理由 |
| --- | --- | --- | --- | --- |
| OpenHands | eventPipeline / 会话状态模型 / gateway/ws.ts + Relay 事件语义 | append-only 事件流为唯一事实源、状态由事件推导、WS 实时推送、新订阅者从历史重建 | 容器执行沙箱、SaaS/IDE 形态、Python Agent 框架本体 | 其安全边界允许服务端执行代码，与远程面零执行的红线根本不同 |
| OpenAI Codex | providers(app-server 通道) / Relay 控制协议 / Android 会话展示 | Thread→Turn→Item、单请求+多通知 JSONL 双向流、rollout 追加持久化+resume、审批一等事件 | Agent 推理/沙箱策略本体、158 methods 全量协议 | app-server 是本机 stdio 协议，无网络层/鉴权/设备/审计语义 |
| ttyd | gateway/ws.ts + Relay WSS 连接生命周期 | token 先取后 upgrade、首字节 opcode 分帧、心跳保活、断开即回收对端资源 | 终端/PTY 暴露、query 传 token 弱鉴权 | 把可执行 shell 直通浏览器且鉴权可绕过，与凭据红线正面冲突 |
| frp | DevHub Relay Client 出站拓扑 + ECS Relay 回源链路 | 出站反连穿 NAT、控制面/数据面分离、10s/90s 心跳+自动重拉、token(+可选 tls)、心跳也可鉴权 | remotePort 公网裸暴露、通用代理全家桶、dashboard | 「端口暴露+对称 token」模型无设备身份/审计，公网面摊在非 443 端口 |
| rathole | DevHub Relay Client（配置面/重连状态机/保活） | 单二进制三要素配置、指数退避重连参数、Noise NK（备选记录）、keepalive/idle 兜底 | UDP/透明代理、公网端口暴露模型、隐式模式判定 | 与 frp 同属通用隧道，缺设备身份、443 单入口、事件流与审计 |
| Langfuse | eventPipeline 投影 + Android 时间线 + Relay 诊断投影 | Session→Trace→Observation 三层、主体不可变+评价后补、错误/延迟独立事件、幂等批量摄取 | 服务端本体（重栈）、评估/prompt 管理 | 重型采集-分析平台，无低延迟双向控制与设备治理能力 |
| Phoenix | 事件 payload 约定 + Relay 可观测出口（backlog） | 类型标识+受控属性表、span 树归因、Project/Session 分组、OTel 语义兼容出口 | 服务端本体、自动埋点生态 | 只解决「看」，不提供鉴权、设备治理与双向控制 |
| MeshCentral | 配对/remote_devices/授权矩阵/审计 + Relay 双向信任 | 出站+客户端校验服务端、短凭据换长期身份、设备组×权限位（方向记录）、审计+consent+撤销即断 | MeshAgent 全能代理、RMM 本体、屏幕流录制 | 全能 RMM 的执行面模型会把已收敛的远程面风险重新放大 |

---

## 10. 复核清单（落地前必做）

- 本文档全部八仓为检索+先验级证据（B/C）。任何「默认值/字段名/协议方法名」进入实现
  前（如 rathole 心跳默认值、frp 心跳参数、ttyd opcode 具体字节、app-server 方法名），
  必须在可联网环境打开对应仓库 docs/源码复核，并在 ECS Relay 设计文档（后续批次）中
  改引一手来源。
- 本文档为纯研究产出：零代码改动、不入实现路径；引用本项目内部事实（A 级）以
  docs/12、docs/15、docs/natpierce-setup.md、HANDOFF.md 为准。
