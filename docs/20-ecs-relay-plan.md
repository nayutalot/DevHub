# DevHub ECS Relay 实施计划（docs/20）

> ECS Relay 改造的**实施编排权威**（Phase 2 设计批，2026-09-04）。覆盖 gaps **G8**（迁移编排）、
> **G11**（门禁与回归面），并给出对应未来三 worktree（relay-client / ecs-relay / android-relay）
> 的批次划分与验收线。协议面见 docs/18，架构见 docs/19，待用户裁决项见 docs/21。
> 里程碑对齐用户原任务书（gaps 头部「任务书摘要」+ gaps §汇总建议实施顺序）。
> 约束基线同 docs/00；每批开工前重读 28 条；smoke 只增不减（约束 #27）。

---

## 1. 里程碑 M1–M5

```
M1 协议与设计冻结（本批）→ M2 三线并行实现 → M3 集成联调与验收 → M4 流量切换 → M5 frp 退役收尾
```

| 里程碑 | 内容 | 完成判据 | 依赖 |
| --- | --- | --- | --- |
| **M1 协议与设计冻结** | docs/18-21 落地（本批次）；G2 已裁决（无域名 IP TLS，U1 DONE 2026-09-05，docs/21 §1）；G10 征询中（推送，docs/21） | 四文档合入 main；三 worktree 按同一契约开工 | 无 |
| **M2 三线并行实现** | R1 relay-client ∥ R2 ecs-relay ∥ R3 android-relay（§2），三者接口 = docs/18 冻结协议 | 各批验收线全绿（§2.4） | M1 |
| **M3 集成联调与验收** | 真机 443 全链路（Relay 版 B1–B8 + TLS 三拒 R-B9，§3）= security-group-policy §3.2 T1；**稳定 ≥72h 无回退 = T2** | R-B1…R-B9 全过 + 72h 稳定记录 | M2 + **自签 IP TLS + 双端 pinning 就绪**（U1 已裁决，docs/21 §1.1；证书/反代/指纹物料 = `docs/ecs-relay-deploy/`） |
| **M4 流量切换** | G8 P1（Relay 443 上线）→ P2（App 双模式验证）→ P3（frpc 停用，观察两周） | P1–P3 判据全过（§4） | M3 |
| **M5 frp 退役收尾** | G8 P4（撤 8746/7000 → 22/3389/ICMP 收敛，security-group-policy S2–S6）；文档收口（natpierce-setup §7 加「已退役」注记、known-limitations 更新、NatPierce 备用标记不动） | 外部探测 8746/7000/3389 filtered、22 限源生效；443 唯一入口复测 | M4 观察期满 |

与用户任务书的对齐：M3 即任务书「原生 Relay 真机验收（T1）+稳定期（T2）」，M4–M5 即
「frpc 停用观察两周 → 撤 8746/7000」（security-group-policy §3.2 删除触发点的正式编排位）。

---

## 2. 批次划分（三 worktree 并行，主控独占 merge）

> 并行前提：三批**共享且只共享** docs/18 协议契约（帧 JSON、错误码、REST 形状）；
> 契约变更必须回 docs/18 修订并广播，禁止实现侧私改字段（「绝不猜」的实现面投影）。

### 2.1 批次 R1 —— relay-client（Windows 侧出站客户端）

| 项 | 内容 |
| --- | --- |
| worktree/分支 | `worktree-relay-client` / `agent/relay-client` |
| 范围 | `src/main/services/agentControl/relayClient/` 八模块（docs/19 §4.1）：wsClient（客户端编解码：发送必掩码）、状态机与重连退避、config（settings `relay_enabled`/`relay_endpoint` + 凭据文件 + 注册码换发）、eventUplink（eventPipeline 多 sink 注入 + `hello.sequence` 断线回填 + `lastSentSeq` 水位）、commandDownlink（auth 校验 → action 翻译 → `submitRemoteCommand` → ack/result 回帧）、pairingBridge（签发同步 + pair/pair_accepted）、rotationBridge（token_rotation 全流程 + post-pairing 自动轮换）、statusProjector（`gatewayStatus.relay` 可选字段）；`ErrorCode` 追加 8 个 Relay 新码（docs/18 §8.2）；L3 追加 `markEventsAckedThrough(seq, deviceId)` 范围批函数；设备撤销注入 relay 踢线；`remote_devices.origin` 落地（D6 两步走：先行 settings/内存投影，若结构判定必要再开 migration 005——**005 开关=主控裁决**，G9） |
| 明确不做 | approve/interrupt 能力授予（仅协议帧接收 + 结构化拒绝，能力验证函数骨架与证据位预留，docs/19 §6.3）；migration 005 的单方开启 |
| 门禁 | tsc 0 错误；smoke 144 + 新增全绿（**本地夹具 Relay 桩**：同进程内存 Relay stub 实现 docs/18 帧面，端口避开 8746–8755 段——G11 夹具化先例延伸）；build；mcp-acceptance 22/22（先 commit） |
| 验收线 | ① smoke 新段：帧编解码 round-trip（16 帧全表逐帧）、重连退避参数、断线回填幂等（重发零重复）、命令排队→上线投递、同幂等键重试返回原结果、token_rotation 落库+宽限、撤销踢线链路、凭据文件红线（日志/DB 抽样零凭据）；② 夹具 Relay 上完成「事件上行→命令下行→ack 回写 deliveries」闭环；③ gateway_enabled=0 + relay_enabled=1 → 结构化告警投影 |

### 2.2 批次 R2 —— ecs-relay（ECS 服务，独立仓/独立目录）

| 项 | 内容 |
| --- | --- |
| worktree/分支 | 独立仓 `devhub-relay`（或 DevHub 子目录 `ecs-relay/`，**形态=主控裁决**；默认建议独立目录零污染 DevHub 门禁，G11「永远存在的未验证区」隔离原则） |
| 范围 | Node 22 + node:http + 自研 WS（ws.ts 服务端编解码移植）+ node:sqlite（docs/19 §5.1）；模块 server/ws/rest/auth/pairing/forwarder/cache/store/audit（§5.2）；schema `0001_init.sql`（§5.3）+ 独立迁移脚本；缓存淘汰（TTL 72h + 容量两级，§5.4）；命令排队/过期；限流三件套（同参 docs/14 §B.4）；错误映射（docs/18 §8）；systemd 单元 + Caddy 反代配置模板；**自签 IP 证书生成/部署脚本 + 指纹分发物料**（U1 已裁决：`gen-ip-cert.sh` + Caddyfile/nginx 模板 + README，见 `docs/ecs-relay-deploy/`）；`.backup` 每日滚动备份；`selfcheck.mjs` 自检脚本（§5.7） |
| 明确不做 | 任何 TLS 终结（反代职责）；多 host/多租户；approve 能力语义理解（纯透传） |
| 门禁 | **独立自测**（DevHub 仓门禁不可达——外部组件如实隔离）：`node --test` 覆盖 §5.7 清单全绿；`tsc --noEmit`（该仓自身 tsconfig）；启动冒烟（systemd --user 或裸进程）+ selfcheck 全过 |
| 验收线 | ① selfcheck 全绿（帧一致性/配对/排队/淘汰/限流/重启恢复/红线断言）；② 与 R1 夹具对拍：同帧集双端解析一致（契约一致性测试，防三线漂移）；③ 部署演练记录：2C2G 实机（或等容器）启动 → 注册 → 64 连接压测脚本 ≤ 预算（§5.5）→ 优雅停机零帧丢失（排队命令恢复） |

### 2.3 批次 R3 —— android-relay（App 双模式）

| 项 | 内容 |
| --- | --- |
| worktree/分支 | `worktree-android-relay` / `agent/android-relay` |
| 范围 | Room 配置扩展（mode/relayUrl，android schema 版本自增）；FrameCodec（Local/Relay 双编解码，模式显式选择，docs/18 §10 映射表逐字段）；ConnectionManager 参数化（单连接互斥）；RelayCodec 帧全集（sync_request 累计游标、heartbeat lastAckedSeq/tokenVersion、command/command_ack/command_result、token_rotation、disconnect、error）；离线队列接 relay 命令排队语义（queued:true 期间挂起重试）；GatewayConfig 模式选择 UI + wss 强制校验 + 降级态文案（`upstream:disconnected`）；通知扩 requiresUserAction（等待输入/等待批准文案分叉）；ControlGate 接 approve/interrupt 门（当前恒不显按钮）；token_rotation SecureStore 原子更新全流程 |
| 明确不做 | FCM/厂商推送 SDK（G10，docs/21 §2）；approve/interrupt 按钮（能力恒空，仅门控代码路径）；自动故障切换（docs/21 §5.2） |
| 门禁 | `:core:test` 37 + 新增全绿（RelayCodec 逐帧解析/累计游标/去重/轮换原子性放 core 纯逻辑）；gradle assembleDebug；模拟器安装冒烟 |
| 验收线 | ① core 单测：16 帧解析 round-trip、字段映射表逐项（docs/18 §4.1/§10）、hasGaps 降级路径、queued 命令生命周期；② 模拟器对夹具 Relay 桩完成 local↔relay 双模式切换零状态串扰；③ UI 截图：模式选择/降级态/轮换提示 |

### 2.4 批次依赖与合入序

```
M1（契约冻结）──┬─► R1 relay-client ──┐
                ├─► R2 ecs-relay ─────┼─► 契约一致性对拍（R1×R2、R3×R2 夹具）─► M3 联调
                └─► R3 android-relay ─┘
```

- 三批可完全并行（接口=docs/18）；联调前各批先对拍**夹具**（R1 的内存 Relay stub 与 R2 的
  selfcheck 用同一帧集 fixture，fixture 文件随 M1 提交一次、三批只读）。
- 合入序建议：R2 → R1 → R3（服务先行便于两端对拍）；主控独占 merge 不变。
- 契约漂移防线：任何一侧实现发现 docs/18 字段/语义不可实现 → 停该项上报（约束 #4/#28 精神），
  禁止就地改契约。

---

## 3. 联调与验收线（Relay 版 B1–B8 对照表，M3 = security-group-policy §3.2 T1）

| # | 场景 | 现网 frp 版对照（ac8-blocked §5） | Relay 版判据 |
| --- | --- | --- | --- |
| R-B1 | health | B1 health 200（RTT 85–269ms） | `GET https://59.110.149.11/v1/health` 200（`curl --cacert` 显式信任自签 CA），`upstream.connected=true` |
| R-B2 | 公网配对 | B2 配对 claim | 桌面签发 → 手机 relay 模式 pair → pair_accepted → 设备双侧列表可见（origin=relay）；post-pairing 自动轮换发生（token_version=2） |
| R-B3 | 长连 + 实时事件 | B3 WS 长连（300,137ms 零断连先例） | wss 长连 ≥5 分钟零断连；waiting_input 事件实时到达且 requiresUserAction=true |
| R-B4 | 防重放/限流三态 | B4 三态全做 | REST 面同 nonce 重放 401 / 窗外 401 / 合法 200；命令帧面同 nonce 重放被 Windows 拒（AUTH_REPLAYED） |
| R-B5 | 指令门 | B5 公网路径门 403 | observed 会话 command → command_ack rejected `COMMAND_NOT_EXECUTABLE`；managed 会话 send_message 202 等价（accepted）→ 真实推理回流 |
| R-B6 | 断链补发 | B6 未跑（frp 版欠账） | **必跑**：杀 App → 期间产生事件 → 重连 sync_request 补齐零丢失（sequence 连续）；host 断链 → 命令 queued → 上线投递 → result 回流 |
| R-B7 | token 轮换 | —（frp 版无此面） | 手动触发轮换：Keystore 原子更新 → heartbeat 确认 → 旧 Token 宽限后 401；轮换失败路径（拒更新）→ 重配对引导 |
| R-B8 | 撤销踢线 | B8 回环限制不可触发（frp 属性） | 桌面 revoke → disconnect(revoked) 到达 → 设备停止重连；再连 401 `DEVICE_REVOKED`；ECS 注册表同步 revoked |
| R-B9 | TLS 信任三拒 | —（frp 版明文无此面） | 错误证书被拒 / 错误指纹被拒 / 过期证书被拒；正确证书+正确指纹（含双指纹窗口内新旧任一）握手成功（专项说明见表后） |

R-B1…R-B9 全过 + 72h 稳定（T2）= G8 §3.2 删除触发点成立 → 允许进入 M4 P3/P4。

TLS 三拒专项（R-B9，U1 验收标准 docs/21 §1.1 第 5 条）：**错误证书**（客户端指纹配置与实际
部署证书不匹配或装错证书）被拒；**错误指纹**（指纹列表全部不匹配当前 SPKI）被拒；**过期证书**
被拒（加载过期证书或前推系统时间演练）。通过形态：Android CertificatePinner 握手失败、Node
`checkServerIdentity` 拒绝、`curl --cacert` 对错误 CA 报错——三端均拒绝且错误可诊断；反向用例
（正确证书+正确指纹、双指纹窗口内新旧任一）握手成功。浏览器直接访问 443 出告警属预期
（docs/19 §10.5），不计为失败。

---

## 4. G8 迁移编排（四阶段，判据与回滚）

> 安全组动作 S0–S6 全部引 `docs/ecs-security-group-policy.md` §4（人工控制台执行）；本节只做
> **编排与判据**，不复制操作细节。

### P1 —— Relay 443 上线（Relay 独立可达，frp 照旧承载）

| 项 | 内容 |
| --- | --- |
| 前置 | M2 的 R2 部署包就绪；**自签 IP TLS + 双端 pinning 就绪**（U1 已裁决为正式态，docs/21 §1.1；证书生成/反代装载/指纹分发 = `docs/ecs-relay-deploy/`）；S1（新增 443 规则）已执行 |
| 动作 | 部署 devhub-relay + 反代 → 注册码换发 Relay 凭据 → relayClient 出站连接 ready → R-B1/R-B3 以探针设备过 |
| 判据 | selfcheck 全绿；R-B1/R-B3 真实链路过；frp 路径（8746）全程不受影响 |
| 回滚 | 删 443 规则（S1 零风险回滚，policy §5.2）；frp 路径不受影响即业务无损 |

### P2 —— App 双模式验证（relay 模式成为可用路径，frp 仍兜底）

| 项 | 内容 |
| --- | --- |
| 前置 | P1 过；R3 合入（App 双模式版）；真机可用 |
| 动作 | 真机切 relay 模式 → **R-B1…R-B8 全量**；local 模式回归（127.0.0.1/局域网不变式）；双模式往返切换无状态串扰 |
| 判据 | R-B1…R-B8 全过 + **72h 稳定（T2）**；frp 版 B1–B4 抽查不回归（本地模式零改动证明） |
| 回滚 | App 切回 local/frp 配置（改配置零代码，先例 tunnel-ecs-01..04）；无安全组动作 |

### P3 —— frpc 停用，观察两周

| 项 | 内容 |
| --- | --- |
| 前置 | P2 判据全过（T1+T2 成立）；用户知悉切换窗口 |
| 动作 | 退出 frpc-loop 重拉器 + 移除 HKCU Run 键 `DevHubFRP`（policy §3.2 前置原文）；**安全组 8746/7000 暂不动**（保留回滚一键性）；观察 **≥2 周** |
| 判据 | 观察期内 relay 链路无 P0/P1 级故障（断链/丢事件/命令丢失）；审计面 relay 来源流量分账清晰（docs/19 §4.8）；设备侧无回切诉求 |
| 回滚 | 重启 frpc（Run 键重建）即恢复 frp 路径——8746/7000 未撤，一键可行（policy §5.2 S4 回滚序的保留原因） |

### P4 —— 撤 8746/7000 与全面收敛

| 项 | 内容 |
| --- | --- |
| 前置 | P3 观察期满通过 |
| 动作 | **S4 删 8746 → 观察 ≥24h → S5 删 7000**（policy §3.2 删除顺序原文）；同批或随后 S2（22 限源）、S3（删 3389）、S6（ICMP 收敛）；frps systemd 停用 disable（NatPierce 投影与文档保留零删码，任务书语义） |
| 判据 | 外部探测 8746/7000/3389 filtered、443 OPEN、22 仅管理 IP；R-B1–R-B3 抽查复测通过；known-limitations §5.1 更新（明文段消亡） |
| 回滚 | 按 policy §5.3 存档表重加规则 + 重启 frpc（回滚代价表 §5.2）；触发回滚 = 视为 M3 判据不成立，回 P2 重验 |

---

## 5. 门禁与回归面扩展（G11）

| 面 | 扩展 |
| --- | --- |
| smoke（append-only） | 新增 relay 段：帧编解码 16 帧全表、重连退避、断线回填幂等、命令排队/幂等/过期、token_rotation、approve/interrupt 默认拒绝、凭据红线断言；**夹具 Relay 桩**（内存实现，端口避开 8746–8755 与真实服务）——ECS 不可自动化部分的仓内等价物 |
| :core:test | RelayCodec/累计游标/去重/轮换原子性（R3 批） |
| ECS 自测（仓外） | selfcheck.mjs（R2 批，§5.7）——**不进 DevHub 四门禁**，以「部署前置检查」身份存在（外部组件如实隔离，G11 差距项的文档+自检补偿） |
| 契约 fixture | 16 帧样例集单文件随 M1 提交，R1/R2/R3 三批对拍共用（防漂移） |
| 真机验收 | R-B1–R-B8 清单（§3）替代/叠加原 B 系列成为 M3 门槛 |
| 端口纪律 | 夹具 Relay 端口避让 8746–8755（smoke）与 8760 段（真实 Gateway 验证先例）；建议夹具用 127.0.0.1 高位随机 |

---

## 6. 风险清单

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| PR1 | 3Mbps 带宽扇出饱和（多设备×高事件率） | 事件延迟、心跳挤占 | 容量预算显式化（docs/19 §5.5）+ 背压降速 + sync 补齐（不丢只延迟）；预算护栏告警 |
| PR2 | ECS 单点故障 | relay 链路全断 | 迁移期 frp 路径为回滚兜底（P3 前一键可回）；systemd Restart + 每日 DB 备份；M5 后单点残余=known-limitations 如实记录（单实例形态，多实例 backlog） |
| PR3 | 配对/轮换瞬间 Token 过境 ECS（docs/19 §3.2 残余 1） | 持续攻破 ECS 时可被截获 | post-pairing 自动轮换 + ECS 不落盘红线 + 主机加固（22 收敛）+ 桌面随时撤销；端到端加密列 backlog（N-R1） |
| PR4 | ~~域名/备案时间线不可控（G2）~~ **已消除（U1 裁决 2026-09-05：永久不购域名）**；转化的新风险=自签证书运维（过期/轮换失误断链） | M3 后 443 断链 | 90 天有效期 + 续期提示（`gen-ip-cert.sh`）；双指纹轮换窗口（docs/19 §10.4）；TLS 三拒验收含过期证书项（§3 R-B9） |
| PR5 | 三线契约漂移 | 联调返工 | docs/18 冻结 + 契约 fixture 对拍 + 漂移即停上报（§2.4） |
| PR6 | WS 客户端编解码缺陷（掩码/分片/半包） | 帧解析崩坏 | ws.ts 镜像移植 + 16 帧 round-trip 用例 + 对拍 fixture；客户端帧必掩码单测 |
| PR7 | 迁移期双路并存重复投递 | 重复通知 | App 单活跃连接互斥（docs/19 §7.2）+ eventId/sequence 幂等 upsert + deliveries 设备粒度（W-R6） |
| PR8 | frpc 停用后 frps 无限重连噪音（7000 未关期） | 日志噪音 | P3 前置即移除 Run 键/重拉器（policy §3.2）；残余连接由 systemd disable 兜底 |
| PR9 | approve 提前/错误授予 | 远程代批（最高风险） | 默认恒不授予 + 逐 provider 验证门 + 主控复核（docs/19 §6.3）；smoke 断言默认拒绝 |
| PR10 | node:sqlite（ECS）在断电/WAL 异常下的库损坏 | 缓存丢失（非事实源） | 缓存可重建（host 回填即恢复）；每日 .backup；事实源永在 Windows DB |
| PR11 | 国内真机无 GMS 的推送缺口（G10） | 强停后失联（现状延续） | 分期推进（docs/21 §2）；Relay 不改变前台服务形态，known-limitations §4.1 持续有效直至推送裁决 |
| PR12 | IPC 白名单/settings 键扩展诱发 smoke 计数断言破坏 | 门禁假红 | 只用可选字段与新 settings 键（D5），不新增 channel；断言面变更单列说明 |

---

## 7. 待用户项指针

~~域名+TLS 三选项与费用~~（**已裁决 DONE 2026-09-05**：永久不购域名，无域名 IP TLS 部署——
自签 IP SAN 证书 + 双端注入式指纹 pinning + 双指纹轮换，docs/21 §1.1）、FCM/厂商推送分期、
Kimi 真机 managed、Claude hooks 注册、approve 的 reject 语义、双模式自动切换——全部集中
docs/21（含每项「不裁决时的默认推进路径」）。
本计划在未裁决项上的推进不阻塞：M2 全部批次、M3（自签 IP TLS 路径）、M4 P1–P2 均可执行；
TLS 面不再依赖用户输入（证书/反代/指纹物料已模板化于 `docs/ecs-relay-deploy/`）；
仅「FCM」的实现落地点依赖用户输入。
