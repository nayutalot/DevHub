# DevHub ECS Relay 待用户裁决项（docs/21）

> ECS Relay 改造的**用户裁决项集中清单**（Phase 2 设计批，2026-09-04）。对应 gaps **G2**
> （原「域名/TLS」，**已于 2026-09-05 裁决为无域名 IP TLS 部署**，见 §1）、**G10**（推送）
> 两项主控明示的待用户项，及 docs/17 §7 顺延的 Kimi/Claude 两项。
> 每项含：背景 / 选项（含费用口径）/ 影响 / **不裁决时的默认推进路径** / **代码侧已预留接口形态**。
> 费用为市场常见价位的估算口径（下单时以注册商/云厂商实价为准）；本文零凭据（约束 #13）。
> 相关设计：协议 docs/18、架构 docs/19、计划 docs/20。
> 2026-09-07 追加裁决：§7（#9=B：设备自管理与 managed spawn，含时序约束）、§8（GitHub Release
> 压后统一发布条件链）。

---

## 1. 无域名 IP TLS 部署（G2——**已裁决**，原「域名与 TLS」项）

> **裁决状态：DONE（用户裁决，2026-09-05）：永久不购买域名。** 统一使用 ECS 公网 IP
> `59.110.149.11` + 自签 IP 证书 TLS（证书必须含 IP SAN: 59.110.149.11）。完整裁决内容见
> §1.1；信任模型设计详见 docs/19 §10；部署物料见 `docs/ecs-relay-deploy/`。
> 本节保留原三选项对比文字作为**否决痕迹**（判定列更新为裁决结果），供追溯。

**背景（裁决时点快照）**：443 唯一正式入口要求 TLS 终结；裁决前现状无域名、无证书，手机→ECS
段明文（known-limitations §5.1 残余①）。ECS `59.110.149.11` 为阿里云大陆地域实例——大陆地域
对 80/443 对外 Web 服务按监管要求需 ICP 备案（周期数天至数周，是裁决前评估的主要时间线不确定性）。

原三选项对比（**否决痕迹**，原文保留、判定列已按 2026-09-05 裁决更新）：

| 选项 | 内容 | 费用口径（估） | 优点 | 代价/风险 | 判定（裁决后） |
| --- | --- | --- | --- | --- | --- |
| 一：购域名 + Let's Encrypt（Caddy/Nginx ACME） | 域名解析至 59.110.149.11，反代自动签发续期，443 反代回环 Relay | 域名年费 ≈ ¥30–100/年（.com/.cn/.site 依后缀）；备案免费；证书免费 | 标准 HTTPS/WSS + 系统信任链，Android 零自签信任代码，curl/浏览器可直连调试，运维成本最低 | 大陆 ECS 需 ICP 备案（时间线数天–数周，需尽早启动）；80 端口签发期临时放行（HTTP-01）；续期依赖反代常驻 | **已否决**（否决理由见下） |
| 二：自签证书 + 指纹锁定 | 自签上 443；Android CertificatePinner / relayClient pinning | ¥0 | 免域名免备案，仍为 wss 加密 | 双端 pinning 代码与测试；证书轮换需双指纹窗口（预置多指纹轮换位，不再要求发版）；调试不便（curl 需 `--cacert`） | **已采纳（正式态）**——升级为「无域名 IP TLS 部署」，证书必须含 IP SAN: 59.110.149.11 |
| 三：ws:// 明文时间盒 | 明文跑联调 | ¥0 | 零改动联调 | 凭据/内容公网可观测；配对码可被抢先 claim（security-group-policy §3.3 选项三原文） | **维持仅联调限定**：ws:// 明文**禁止作为正式方案**，只能是不承载真实配对的临时联调时间盒（精确过期条件见 §1.1 第 4 条） |

**否决理由（选项一「购域名」路径，用户 2026-09-05 裁决）**：① 大陆 ECS 的 ICP 备案周期不可控
（数天至数周起算且存在驳回重来风险），持续阻塞上线时间线；② 域名年费 + 长期续费 + 备案维持
成本，对单机自用场景不划算；③ 本项目仅一台 ECS、一个固定公网 IP、设备面 ≤60 的单机场景，
`wss://59.110.149.11` IP 直连 + 双端指纹锁定已满足全部安全目标（传输加密 + 端点认证 + 中间人
防护）；域名带来的「系统信任链/浏览器免告警」收益在本项目客户端面（App + relayClient +
`curl --cacert`）无实际消费者。**该否决为永久性裁决（不设重议触发条件）。**

### 1.1 裁决内容（无域名 IP TLS 部署，2026-09-05）

1. **拓扑与监听（现状设计不变）**：Caddy/Nginx 继续监听 443 终结 TLS；证书为**自签 IP 证书，
   SAN 必须含 `IP:59.110.149.11`**（生成命令模板见 `docs/ecs-relay-deploy/gen-ip-cert.sh`）；
   Relay 服务只监听 `127.0.0.1:8443`（docs/19 §5.1/§5.6 不变）。
2. **客户端 endpoint**：手机（Android relay 模式）与 Windows relayClient 统一使用
   `wss://59.110.149.11`（REST 面 `https://59.110.149.11`）；endpoint 仍是配置项
   （settings `relay_endpoint` / Room relayUrl）。
3. **证书信任模型（注入式指纹配置）**：Android = OkHttp `CertificatePinner`
   （`:core` `TlsPinningConfig` 注入，本批已铺注入缝）；Node relayClient =
   `tls.checkServerIdentity` 覆写 + CA 指纹校验（注入式，示例见 `docs/ecs-relay-deploy/README.md`）。
   指纹形态 `sha256/{hex}`；**证书轮换 = 重分发指纹配置，轮换窗口内同时配置旧+新双指纹
   （任一匹配即信任）**。详见 docs/19 §10。
4. **明文时间盒（精确文字，写死）**：`ws://` 明文**禁止作为正式方案**，仅当同时满足以下全部
   条件时可作为临时联调形态：(a) 限定 M3 集成联调窗口内；(b) 明文链路**绝不承载真实配对**——
   配对码明文、`pair`/`pair_accepted` 帧、端到端设备 Token 明文、Relay 凭据明文均不得出现在
   `ws://` 链路上（配对只在 wss 链路或本机回环完成）；(c) 时间盒到期即关闭明文入口（明确过期
   条件：M3 联调窗口结束或真实配对需求出现，两者先到为准），过期后明文入口视为事故。
5. **同步验收标准（M3 前置，docs/20 §3）**：① 证书 SAN 含 `59.110.149.11`；② Android App、
   Windows relayClient、`curl --cacert` 三端均能完成 TLS 握手；③ **TLS 三拒**：错误证书被拒、
   错误指纹被拒、过期证书被拒；④ 443 可访问，8746/7000 按 docs/20 §4 迁移计划处理；
   ⑤ **浏览器不受信如实声明**：自签 IP 证书**不受浏览器/系统默认信任**——浏览器直接访问
   `https://59.110.149.11` 会出安全告警，属预期行为；App 与 relayClient 经 pinning 信任，
   绝不在任何文档/验收口径中声称「浏览器默认信任该证书」。
6. **交付物**：`docs/ecs-relay-deploy/`（gen-ip-cert.sh 一键生成 + Caddyfile/nginx 反代模板 +
   README 部署验收步骤）；U1 相关文档一致性已随本批同步（docs/18/19/20、security-group-policy、
   known-limitations）。

**代码侧接口形态（随本批落地）**：relay 模式强制 `wss://` 校验（docs/19 D7）；pinning 挂点 =
`:core` `TlsPinningConfig`（指纹归一化/双指纹匹配纯逻辑 + 单测，本批）→ OkHttp
`CertificatePinner` 注入缝（app 层可选参数，null=现行为不变；R3 批 relay 模式接线）+
relayClient 侧 Node `tls.checkServerIdentity` 覆写位（R1 批接口位，README 附示例片段）。

---

## 2. FCM / 厂商推送（G10——现无任何推送通道）

**背景**：实时性完全依赖前台服务常驻 WS，应用被杀即失联（known-limitations §4.1）。两个外部
阻塞：①FCM 需 Firebase 项目（Google 账号/服务配置）；②**国内真机无 GMS**（华为系等）——FCM
不可用，须厂商通道（小米/华为/OPPO/vivo）或降级方案。

**分期建议（裁决对象）**：

| 期 | 内容 | 外部依赖 | 实时性收益 |
| --- | --- | --- | --- |
| P0（现状延续） | 前台服务 + WS 唯一通道；Relay 改造不改变此形态 | 无 | 应用存活时实时；强停后失联（现状如实） |
| P1 | FCM 接入（有 GMS 设备）：waiting_input/approval_required 事件 → Relay 判定设备 WS 离线 → 推送唤醒 → App 拉起重连 sync | Firebase 项目 + google-services.json | 有 GMS 真机强停可唤醒 |
| P2 | 厂商通道（按用户真机型号定优先级，华为/小米等） | 各厂商开发者后台账号 | 无 GMS 真机覆盖 |
| 备选降级 | WorkManager 周期拉取（Doze 窗口内心跳式 sync） | 无 | 实时性显著下降（分钟级），需用户接受度确认 |

**不裁决时的默认推进路径**：P0 继续（Relay 的 443 长连已改善链路安全面，不改变推送面）；
P1/P2 的接口位在 R3 批以 `PushAdapter` 空实现预留（`onRelayWake(summary)` no-op），
不接任何 SDK、不加任何 gradle 依赖——裁决后按期接入，App 版本节奏不受阻。
**代码侧已预留接口形态**：ECS 侧 `forwarder` 预留「设备 WS 离线 + 事件 requiresUserAction=true
→ 调用推送出站」判定缝（默认 no-op）；App 侧通知构建/渠道/deep link 全部现成（只差传输通道）。

---

## 3. Kimi 真机 managed 启用（docs/17 §7.1 顺延 + G6 依赖项）

**背景**：Kimi managed 通道（spawnManaged + writeStdin + 终态轮询）夹具级已全验证；真机未验证
的唯一原因是**授权红线**：真实托管会话必写 `~/.kimi-code`（会话索引/会话目录），且消耗少量真实
推理额度。同时 **Kimi 是当前唯一具备 approve 判定源语料的 provider**（`interaction.request
kind='approval'`，G6）——真机 managed 不启用，approve 的真实验证门（docs/19 §6.3 第 2 步）
永远停在夹具级。

**裁决内容**：是否授权 ① DevHub 托管启动真实 Kimi 会话（写 `~/.kimi-code` 由 kimi 自身进程完成，
DevHub 仍对其零直接写入）+ ② 消耗真实推理额度做端到端验证。
**不裁决时的默认推进路径**：Kimi 保持 observed + 空能力集（真库现状）；approve 对全部 provider
维持恒不授予（默认安全态不受影响）；R2/R1 批的夹具级验证照常完成，真机验证项记入
known-limitations（与 §1.5 同款阻塞记录形态）。
**代码侧已预留接口形态**：kimiProvider 托管通道全量在库（夹具验证过）；approve 验证函数骨架
（判定源枚举 + resolved 闭环写入）在 R1 批以「验证可运行、授予位恒关」形态落地。

---

## 4. Claude hooks 注册入口（docs/17 §7.2 顺延 + G6 关联项）

**背景**：hooks 合并写入（备份/恢复/只动 hooks 键/env.* 零改动）已实现；注册后带来**审批事件**
（approval_required 判定源活跃）但**不带来 reply 能力**（hooks 无输入注入 API，docs/12 §8.2）——
即注册后 Claude 从「observed 恒空集」变为「attached + 事件面更丰富，控制面仍空」。

**裁决内容**：是否在真实 `~/.claude/settings.json` 上注册 hooks（ApiHub 同文件共写点，docs/16
风险 R3 场景）。
**不裁决时的默认推进路径**：不注册，Claude 保持 observed；requiresUserAction 事件面对 Claude
恒为 status_changed/finished 类（waiting_input 通知依赖转录判定，现状不变）；approve 对 claude
维持恒不授予。
**代码侧已预留接口形态**：hooks 回环 listener + 审批事件→事件管线通路已实现（回环 listener 未
在真机激活，known-limitations 记录态）；注册入口 = 桌面 Agents 视图动作位（CONFIRM_REQUIRED
两段式，接线即可用）。

---

## 5. 其他小项（主控可代裁，列出供一并确认）

### 5.1 approve 的 reject 语义

- 背景：目标动作集为 `{send_message, approve, pause, resume, interrupt}`，未含 reject；但
  「只能批准不能拒绝」不构成人在环（docs/19 §6.3 第 3 步要求 allow/deny 双通道验证）。
- **建议裁决**：approve 帧的 `payload.decision ∈ {'allow','deny'}`（协议已预留，docs/18 §5.1），
  deny 映射 provider 的拒绝语义；无拒绝通道的 provider 连 allow 一起不授予。
- 默认路径：协议按此实现；授予面不受影响（恒不授予）。

### 5.2 双模式自动故障切换

- 背景：G7 留白项——local 不可用时是否自动切 relay（或反向）。
- **建议裁决**：v1 手动切换（状态并排展示），自动切换 backlog——自动切换的状态机复杂度与
  「绝不猜实时态」纪律的张力大（误切导致静默走公网路径）。
- 默认路径：手动切换 + 结构化降级文案（R3 批已按此实现）。

### 5.3 relay 模式 REST 面扩量

- 背景：v1 收敛到 5 端点（docs/18 §7.2），设备自撤销/诊断/归档在 relay 模式不开放（桌面覆盖）。
- **建议裁决**：维持 v1 范围；扩展按 `rest_proxy` 帧族 backlog 另批。
- 默认路径：不变。
- **2026-09-07 更新（用户裁决 #9=B）**：设备自撤销与 managed spawn 已裁决经 WS command 面开放
  （docs/18 §5.3、本文 §7）；本项对 **REST 面**「维持 v1 范围」的裁决语义不变。

---

## 6. 裁决状态跟踪表

| # | 项 | 阻塞什么 | 默认路径下可推进到哪 | 建议裁决时点 |
| --- | --- | --- | --- | --- |
| U1 | 无域名 IP TLS 部署（原「域名+TLS」，§1） | —— **DONE（用户裁决 2026-09-05）**：裁决=自签 IP 证书（SAN: 59.110.149.11）+ 双端注入式指纹 pinning + 双指纹轮换；阻塞解除 | M2 全部 + M3（前置=自签 IP TLS+pinning 就绪）+ M4 P1–P3 | 已裁决（永久不购域名） |
| U2 | FCM/厂商推送 | 强停唤醒能力 | P0 全程；接口位预留 | M4 后任意时点 |
| U3 | Kimi 真机 managed | approve 真实验证门、kimi 能力面 | observed 现状 + 夹具级验证 | M3 前后 |
| U4 | Claude hooks 注册 | claude approval 事件面 | observed 现状 | 任意时点 |
| U5 | reject 语义 | approve 授予面（当前恒空） | 协议预留形态冻结 | 与 U3/U4 一并 |
| U6 | 双模式自动切换 | App 体验增强 | 手动切换形态 | M4 后 |
| U7 | 设备自管理与 managed spawn（B 方案，§7） | R-B5/R-B8 闭环（docs/20 §3）；设备侧 spawn/自撤销在 relay 模式可用 | 协议（docs/18 §5.3）+验收判据+实施任务书（`docs/briefs/m3e1-self-mgmt.md`）先行落档（M3-E0）；编码与部署待 M3-D 72h 终报通过（≥09-10 08:49） | **已裁决（#9=B，2026-09-07）** |
| U8 | GitHub Release 发布时点（§8） | 安装包对外分发 | 无先行发布诉求；条件链（§8）全满足后统一发布 | **已裁决（压后统一发布，2026-09-07）** |

---

## 7. 设备自管理与 managed spawn（#9——**已裁决 B**，2026-09-07）

> **裁决原文（2026-09-07，逐字保真）**：#9 选 B——复用现有 WS command 通道，补齐设备自管理和
> managed spawn，闭环 R-B5/R-B8。**先更新协议、任务书和验收标准，编码与部署等 72 小时稳定期
> 结束后再做，期间不要干扰常驻和巡检**；GitHub Release 暂不发布，等稳定性终报通过、B 方案完成
> 复验、安装包更新后再统一发布。

**裁决内容（#9=B）**：

- **通道**：复用现有 WS `command`/`command_ack`/`command_result` 帧形（零扩展），新增
  `spawn_session`、`revoke_device` 两 action（docs/18 §5.3 规范性落点）；不新增 REST 端点、
  不定义专用帧形；既有 G5 读面已覆盖读取需求，零重复定义（最小面原则）。
- **时序约束（硬性）**：编码与部署等 M3-D 72 小时稳定期结束后再做（T0=2026-09-07 08:49，
  窗毕 ≥2026-09-10 08:49，以稳定性终报通过为准）；**窗内零编码零部署，不干扰常驻与巡检进程**。
- **闭环目标**：R-B5（managed 回流）与 R-B8（撤销主链）经新命令面活体复验——判据已按本裁决
  修订（docs/20 §3，均标「待 M3-E 实施后复验」）。
- **配套落档（M3-E0 文档批，本批）**：docs/18 §5.3/§7.1/§7.2/§8.2/§3.15/§10/N-R3 修订 +
  docs/20 §3 R-B5/R-B8 判据更新 + 实施任务书草案 `docs/briefs/m3e1-self-mgmt.md`。

---

## 8. GitHub Release 发布时点（**压后统一发布**，2026-09-07）

- **裁决**：GitHub Release 暂不发布。
- **压后条件链（逐级串联，全部满足后才统一发布）**：
  ① M3-D 72h 稳定性终报通过 → ② B 方案（#9=B）实施并完成复验（R-B5/R-B8 活体，判据 =
  docs/20 §3 修订原文）→ ③ 安装包更新（含 M3-E 改动，备料流程见 `docs/m3-dist-repack.md`）→
  ④ 统一发布。
- 发布动作本身待主控在条件链满足后统一裁定执行；本条不改变 docs/20 §4 P 系列迁移判据。
