# DevHub ECS Relay 待用户裁决项（docs/21）

> ECS Relay 改造的**用户裁决项集中清单**（Phase 2 设计批，2026-09-04）。对应 gaps **G2**
> （域名/TLS）、**G10**（推送）两项主控明示的待用户项，及 docs/17 §7 顺延的 Kimi/Claude 两项。
> 每项含：背景 / 选项（含费用口径）/ 影响 / **不裁决时的默认推进路径** / **代码侧已预留接口形态**。
> 费用为市场常见价位的估算口径（下单时以注册商/云厂商实价为准）；本文零凭据（约束 #13）。
> 相关设计：协议 docs/18、架构 docs/19、计划 docs/20。

---

## 1. 域名与 TLS（G2——硬阻塞项，建议最先裁决）

**背景**：443 唯一正式入口要求 TLS 终结；现状无域名、无证书，手机→ECS 段明文（known-limitations
§5.1 残余①）。ECS `59.110.149.11` 为阿里云大陆地域实例——**大陆地域对 80/443 对外 Web 服务按
监管要求需 ICP 备案**（周期数天至数周，是主要时间线不确定性）。

| 选项 | 内容 | 费用口径（估） | 优点 | 代价/风险 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 一：购域名 + Let's Encrypt（Caddy/Nginx ACME） | 域名解析至 59.110.149.11，反代自动签发续期，443 反代回环 Relay | 域名年费 ≈ ¥30–100/年（.com/.cn/.site 依后缀）；备案免费；证书免费 | 标准 HTTPS/WSS + 系统信任链，**Android 零自签信任代码**，curl/浏览器可直连调试，运维成本最低 | 大陆 ECS 需 ICP 备案（时间线数天–数周，需尽早启动）；80 端口签发期临时放行（HTTP-01）；续期依赖反代常驻 | **推荐（正式态）** |
| 二：自签证书 + 指纹锁定 | 自签上 443；Android CertificatePinner / relayClient pinning | ¥0 | 免域名免备案，仍为 wss 加密 | 双端 pinning 代码与测试；证书轮换=发版（需预置多指纹轮换位）；调试不便 | 过渡态可接受（选项一未就绪时） |
| 三：ws:// 明文时间盒 | 明文跑联调 | ¥0 | 零改动联调 | 凭据/内容公网可观测；配对码可被抢先 claim（security-group-policy §3.3 选项三原文） | **仅联调**：时间盒 ≤14 天、不承载真实配对、到点即切 |

**不裁决时的默认推进路径**：按选项二推进 M3 联调（自签 + 双端 pinning 走通全链），证书生成与
部署动作（ECS 侧 openssl/反代配置）留待用户执行口令；正式态切换待裁决后按选项一替换——App 与
relayClient 的 endpoint 是配置项（settings `relay_endpoint` / Room relayUrl），**切换域名/证书
零代码**。
**代码侧已预留接口形态**：relay 模式强制 `wss://` 校验（docs/19 D7）；pinning 挂点 =
OkHttp `CertificatePinner`（R3 批接口位）+ relayClient 侧 Node `tls.checkServerIdentity`
覆写位（R1 批接口位）；两者均以「指纹列表注入」形态预留，选项一落地时置空即回系统信任链。

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

---

## 6. 裁决状态跟踪表

| # | 项 | 阻塞什么 | 默认路径下可推进到哪 | 建议裁决时点 |
| --- | --- | --- | --- | --- |
| U1 | 域名+TLS | 正式态上线（M5 判据）、选项一替换 | M2 全部 + M3（选项二）+ M4 P1–P3 | **M2 期间尽早**（备案周期） |
| U2 | FCM/厂商推送 | 强停唤醒能力 | P0 全程；接口位预留 | M4 后任意时点 |
| U3 | Kimi 真机 managed | approve 真实验证门、kimi 能力面 | observed 现状 + 夹具级验证 | M3 前后 |
| U4 | Claude hooks 注册 | claude approval 事件面 | observed 现状 | 任意时点 |
| U5 | reject 语义 | approve 授予面（当前恒空） | 协议预留形态冻结 | 与 U3/U4 一并 |
| U6 | 双模式自动切换 | App 体验增强 | 手动切换形态 | M4 后 |
