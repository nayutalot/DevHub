# token_rotation 补投机制——docs/18 修订提案（W3 纯文档批产出）

> 状态：**提案，未生效**。决策点全部交主控/用户裁决（W3 任务书纪律：不代答）；裁决后由
> 实施批按裁决结果修订 docs/18 §3.14（新增加补节）并按 `docs/briefs/token-rotation-impl.md`
> 执行编码/部署。本文零编码零部署，全部结论以代码实证为据（每条带 文件:行号）。
> 基线：main @ 9da1a22；侦察分支 agent/docs-token-rotation（worktrees/w3-rot-docs）。

---

## 1. 现状实证（只读侦察结论，代码为准）

### 1.1 token_rotation 帧现在如何投递（relay 侧三路，C7a 定案「零新帧」）

产生侧（Windows，H→E）：`rotationBridge.requestTokenRotation` 发帧，前置 **ready 门**——host 腿
非 ready → 拒绝轮换且 L3 零触达（`src/main/services/agentControl/relayClient/rotationBridge.ts:114-119`）；
L3 落点 `rotateDeviceToken` 覆盖 `token_hash` + `token_version+1`，新 Token 明文仅经返回值一次性
流转进帧（`src/main/services/agentControl/agentControlService.ts:1864-1886`；「明文 Token 仅返回值
一次性流转……绝不入日志/审计/DB」见 :1846-1847 注释；docs/19 §2.4 凭据总表「Windows 不存明文」）。

受理侧（ECS）：`handleHostTokenRotation`（`ecs-relay/src/forwarder.ts:1027-1086`）——
sha256(newToken) 同步注册表 + 旧哈希原值转 `grace_token_hash`、`grace_expires_at = now +
rotationGraceSec`（forwarder.ts:1046-1054）。路由要求帧携 `deviceId`（Windows 侧
remote_devices.id），仅 `win_device_id` 命中才路由（forwarder.ts:1030-1042；README 偏离单 #2，
`ecs-relay/README.md:129`）。

投递三路（forwarder.ts:1063-1085 注释 + 实现同处）：

| 路 | 触发条件 | 实现 | 审计 |
| --- | --- | --- | --- |
| ① 已鉴权连接直投 | 设备有活跃 device-leg 连接 | forwarder.ts:1066-1071 | `token_rotation_applied`（:1055） |
| ② pair 冲刷窗 | 轮换发生在 pair_accepted 后 5s 窗内（`pairRotationFlushMs`，默认 5s，`config.ts:101`） | `openPairRotationWindow`/`closePairRotationWindow`（forwarder.ts:192-208）+ :1078-1082 | `token_rotation_flushed(source:'pair-window')`（:1081） |
| ③ 内存补偿表 | 两路皆不可达（设备完全离线）→ 登记内存 Map，grace 窗内旧凭据重连时补投 | `pendingRotations`（forwarder.ts:101）+ `compensatePendingRotation`（:216-226）+ admit 挂钩（:161-167） | `token_rotation_flushed(source:'compensation')`（:225） |

补偿表生命周期（全部代码锚点）：登记 = forwarder.ts:1084（`expiresAtSec = nowSec +
rotationGraceSec`，与 grace 窗同源）；**补投不删登记**——新凭据准入（设备确认切换）才清
（forwarder.ts:167），撤销即清（:1109），窗过期清扫即清（`sweepExpiredGrace` :606-610 首循环）；
补投前再查过期（:219-223）。完整帧（含明文 Token）**仅存内存，绝不落盘/落日志/落审计**
（forwarder.ts:96-99 注释）。

### 1.2 设备离线错过帧的真实后果（按时间线，逐条带证据）

1. **离线 ≤ 300s（`rotationGraceSec` 默认 300，config.ts:105）内重连**：旧凭据经宽限三态之二
   viaGrace 准入（`ecs-relay/src/auth.ts:91-100`，审计 `token_rotation_grace_admitted`）→
   relay 补投当前 token（forwarder.ts:216-226）→ App Keystore 原子换发（tokenVersion 单调门，
   `android/core/.../relay/RelayTokenRotation.kt:46-62`；写入侧
   `android/app/.../connect/ConnectionManager.kt:851-888`）→ 下一帧 heartbeat 携新 tokenVersion
   即确认（ConnectionManager.kt:873-874 发送侧；Windows 侧消费 `noteTokenRotationConfirmed`
   rotationBridge.ts:190-206）。**该情形已闭环，无缺口。**

2. **离线 > 300s 后重连**：旧哈希命中但窗已过 → **401 `RELAY_DEVICE_UNKNOWN`**
   （auth.ts:101-103，审计 `token_rotation_grace_expired`）→ App `onAuthFatal`：停连接循环 +
   **清凭据（Keystore 密文 + 设备行）** + 停前台服务 + UI 回配对页
   （ConnectionManager.kt:1555-1576，状态置 `ConnState.Unpaired`）。即：**token 失配被拒 →
   设备端自清凭据 → 必须人工重新配对**（新配对码走 §9.1 全流程）。窗内仍存活的宽限连接由
   清扫先发 `disconnect{superseded}` 再关闭（forwarder.ts:611-625）。

3. **重启缺口（本批新识别，代码实证）**：`pendingRotations` 是纯内存 Map（forwarder.ts:101），
   **relay 进程重启即失**；而 `grace_expires_at` 持久于 relay_devices
   （`ecs-relay/sql/0002_rotation_grace.sql:15`）。时序：轮换时设备离线 → 帧（明文）入内存表 →
   relay 重启 → 设备在 300s 窗内以旧凭据重连 → viaGrace 准入成功但补偿表已空
   （`compensatePendingRotation` :217-218 get undefined 直接 return）→ **补投不发生** → 设备
   滞留旧版运行至窗过 → 后果同第 2 条（401 → 重配对）。且该场景下**帧无法从任何持久层补发**：
   Windows 不存明文（docs/19 §2.4；agentControlService.ts:1846-1847）、relay 落盘即触红线
   （docs/19 §3.2 问 2「端到端 Token……红线 = 不落盘、不落日志、不落审计」）→ 窗外重配对是
   契约明文的唯一恢复路径（README 偏离单 #11，`ecs-relay/README.md:160-163`）。

4. **审计确认信道（Windows 半边）**：帧发出起 300s 未观察到新 tokenVersion → 审计
   `token_rotation_grace_expired` + 维持新 Token 生效（Windows 单哈希列无回滚位）
   （rotationBridge.ts:159-176）；**现无任何自动重试/重轮换跟进**。`periodic` 触发源已预留
   reason 值但触发器属后续批次（rotationBridge.ts:111-113；docs/18:369、:850）。

### 1.3 附带发现（如实上报，本批不处理）

- **README 偏离单 #11 文档漂移**：`ecs-relay/README.md:160-163` 仍写「**离线设备不补投
  rotation 帧**……若需『重连补投』须先修订 docs/18」——与 C7a 修② 现状不符（C7a 提交
  15ef864 晚于 README 最后提交 6b54916，均未互改）。docs/18 §3.14 已有 C7a 实现层增补
  （docs/18:382-389），README 未跟随。建议随本提案落地时一并更正（属 ecs-relay/，本批只读）。
- Windows gateway 侧存在宽限镜像（`previous_token_hash` + `rotated_at` 300s，M3-C7b 修②，
  `src/main/services/agentControl/gateway/auth.ts:124-139`）——本地/局域面；relay 模式设备不直连
  gateway，与本提案正交。
- App pair 腿接帧由 `PairLegFrameRouter` 承载（`android/app/.../connect/RelayPairingClient.kt:140,
  :341`）——C7a 修①的 App 半边，已就位。

### 1.4 设计空间硬约束（由证据链导出，候选形态必须服从）

- **C-1 明文红线**：补投帧只能来自内存。任何「持久化待投帧」方案直接违反 docs/19 §3.2 问 2
  红线与 W-R3 论证链（攻破的 ECS 手中只有 sha256）。→ 持久层至多存**元数据**
  （deviceId/tokenVersion/时间戳/状态），存明文帧的方案不在候选之列。
- **C-2 帧形零扩展优先**：C7a 先例（docs/18:382「帧形不变、无新帧」）；补投 = 同一
  token_rotation 帧原样重发（forwarder.ts:1056-1062 构造后复用）。
- **C-3 单调门兜底**：App 端 tokenVersion 单调（RelayTokenRotation.kt:54 `Stale`）使重复/乱序
  补投天然幂等；ECS 端仅登记「当前版本」一帧（forwarder.ts:1084 覆盖写）。
- **C-4 窗界收口**：补偿绝不越 grace 窗（forwarder.ts:219-223 + :608-610 + auth 层 401 收口
  auth.ts:97-103）；撤销即拒优先（auth.ts:92-95；撤销清登记 forwarder.ts:1109）。

---

## 2. 修订提案正文（拟增补为 docs/18 §3.14 追加节；【待裁决】处按决策点回填）

### 提案节名：§3.14.1 token_rotation 离线补投（修订草案）

现状三路投递（§3.14 M3-C7a 增补）已覆盖「设备离线、窗内重连」；本节将「错过帧」的处置
契约化为三段：

```
错过 token_rotation 的设备：
  T+0     帧入内存补偿表（明文仅内存；expiresAt = grace_expires_at 同源）     [现状]
  T ≤ 300s 重连 → viaGrace 准入 → 补投 → Keystore 原子换发 → heartbeat 确认  [现状]
  T > 300s → 401 RELAY_DEVICE_UNKNOWN → 设备清凭据 → 重配对路径              [现状，契约明文]
  relay 重启（T ≤ 300s 内）→ 补投表丢失 → 设备滞留旧版至窗过 → 同上         [缺口，本提案标的]
```

针对重启缺口的候选处置（互斥，单选；【待裁决 → 决策点 D2】）：

- **D2-甲 接受现状**：重启窗口概率低（systemd 常驻）+ 设备端重配对兜底成立；补投语义
  「尽力面」（投递不回滚 DB 同款语义，forwarder.ts:213-215 注释先例）不变。零改动。
- **D2-乙 桌面侧重轮换**：以 Windows 侧 `token_rotation_grace_expired` 审计（rotationBridge.ts:159-176）
  为触发源，在设备重新可达时派发全新轮换（tokenVersion 绝对值语义，App 端单调门可跨版本
  接受，RelayTokenRotation.kt:54）。风险：重轮换会把 `grace_token_hash` 从 v N 切到 v N+1
  （forwarder.ts:1046-1054）→ 仍持 v N 的设备瞬间失去宽限资格 → **若派发时设备不在线则
  锁死**。故乙方案必须门控「设备当前存在活跃 device-leg 连接」——而桌面现无该信号
  （relayClient 无设备连接态投影，`src/main/services/agentControl/relayClient/index.ts` heartbeat
  面仅 lastAckedSeq）。若采乙，需先解决连接态信号（引入 E→H 帧或 REST 诊断端点，两者均
  破 C-2/REST 范围，需显式裁决）。
- **D2-丙 E→H 新帧「补投失败告知」**：relay 重启后恢复时（或补偿表丢失时）向 host 发新帧，
  请求侧重发/重轮换。帧形扩展（破 C-2 优先序），docs/18 §3.0 帧表 +1 行组，双端实现量最大。

> 草案注记：若裁决为 D2-甲，则 §3.14.1 仅固化现状三段时间线 + README #11 更正，零编码批
> 可取消，本提案降级为纯契约文档修订。

---

## 3. 决策点清单（每点：选项 → 推荐 → 理由；全部交主控/用户裁决，不代答）

### D1. pending 补投登记的存储位置

| 选项 | 内容 | 代价/收益 |
| --- | --- | --- |
| 甲（现状） | 内存 Map（forwarder.ts:101），寿命=grace 窗 | 零改动；重启即失（缺口保留） |
| 乙 | relay 库新表 `relay_pending_rotations`（0005，append-only；**仅元数据**：device_id、token_version、issued_at、expires_at、state；UNIQUE(device_id) 对齐 CP4 `contest_reminder_log` UNIQUE(reminder_id, fire_key) 账本去重根精神，docs/22:37） | 重启后可观测「谁错过」（审计/排障/驱动 D2-乙触发）；**不能**补投明文帧（C-1）→ 对恢复率零直接贡献 |
| 丙 | relay_audit 复用（append-only 日志当队列） | 不推荐：无状态生命周期列；180 天滚动删除与补投窗 300s 错配（audit.ts:46-48）；审计与队列语义混淆 |

**推荐：甲**（若 D2 裁决为甲）／**乙**（仅当 D2 裁决需要重启后可观测面驱动触发）。
理由：C-1 决定了持久层对「补投本身」无贡献；新表的唯一价值是可观测与触发源，若无人消费
则属过度设计。丙方案在语义与保留期上均错配。

### D2. 重启缺口处置（§2 提案正文三选一）

**推荐：D2-甲（接受现状）**。理由：缺口触发需「轮换 ∩ 设备离线 ∩ relay 恰在 300s 窗内重启 ∩
设备窗内未回」四条件交叠，概率极低；兜底路径（401 → 清凭据 → 重配对）契约明文、设备端
已闭环（ConnectionManager.kt:1555-1576）；乙/丙的额外复杂度（连接态信号/新帧）与收益不成比。
若用户要求「重配对零人工化」，则乙优先于丙（零新帧），但须接受其前置（连接态信号面）的
再一轮设计。

### D3. 补投条数上限

选项：单设备单槽（现状，新轮换覆盖旧登记，forwarder.ts:1084 直接 set）／多条队列。
**推荐：单槽**。理由：设备只需「当前版本」token（版本绝对值语义 + App 单调门使旧帧无用）；
多条队列徒增清理面。若 D1-乙 新表落地，则 UNIQUE(device_id) 天然单槽，语义对齐。

### D4. 过期 rotation 是否补投

选项：①绝不越窗（现状：forwarder.ts:219-223、:608-610、auth 401 收口 auth.ts:97-103）；
②延长/取消宽限窗（改 `rotationGraceSec` 或语义）；③过期后增强「重配对引导」（设备 401 时
App 端直接给出明确文案/入口——现状 UI 已回配对页但文案为通用 401，ConnectionManager.kt:619、:1563-1571）。
**推荐：①维持 + ③作为独立的 App 体验打磨项（另立批）**。理由：300s 是 docs/18 §3.14 权威值
（docs/18:377「旧 Token 自帧发出起 300s 后失效」）；延长窗口 = 旧凭据暴露面线性增大，且
Windows 侧镜像窗（gateway previous_token_hash 300s）需同步改，双面一致性风险大；④「补投
过期帧」在 C-1 下根本不可行（明文早已随窗焚毁）。

### D5. 与既有 grace/重连补偿的交界

**推荐（约束式，非选择题）：任何扩展机制必须锚定同一寿命源与同一清退路径**——
`expiresAt = grace_expires_at 同源`（forwarder.ts:1084 先例）、撤销即清（:1109）、新凭据准入
即清（:167）、窗过期清扫即清（:608-610）。绝不引入第二时钟或第二清退规则（否则三态语义
auth.ts:67-74 与清扫语义 forwarder.ts:601-626 出现双源歧义）。本条为红线级交界规则，请裁决
确认或否决。

### D6. ECS schema 版本递进方式（仅当 D1-乙 采纳时适用）

选项：①新迁移文件 `sql/0005_pending_rotations.sql`（append-only 新表，经 `ensureSchema`
字典序自动应用 + `relay_meta.schema_version` 登记，store.ts:88-106；先例 0002 加列/0003 表重建/
0004 加列）；②`PRAGMA user_version` 记版本。**推荐：①**。理由：store.ts 迁移器只认文件序 +
relay_meta（:92-104）；relay 库不用 user_version 已是部署实测口径（docs/briefs/ecs-m3e1-deploy.md:18-19
「PRAGMA user_version=0……先查 relay_meta 内容确认在册方式」）。

### D7. 补投帧的认证/重放边界（安全边界）

**推荐（约束式）：维持现状三防线，零新认证材料**——
①补投只经**已鉴权连接**发送（viaGrace 准入本身即认证事实，auth.ts:91-100；直投路径同理），
不新增任何认证握手或材料；
②重放防线 = App 端 tokenVersion 单调门（RelayTokenRotation.kt:54，重复帧 `Stale` 零写入）+
ECS 端单槽只持当前版本（D3）+ 窗界清扫（D5）——同一帧重复补投无副作用；
③帧形零扩展（C-2）：补投帧与首发帧逐字节同形（forwarder.ts:1056-1062 同一构造）。
若未来任何方案要求「relay 主动请求重发」（D2-丙），必须作为新帧走 docs/18 §3.0 帧表增补 +
双端实现 + selfcheck 覆盖，不接受「借道现有帧捎带」的隐式扩展。

---

## 4. 影响面与不做什么

- 本提案**不改动**：16+2 帧协议面（除非 D2-丙）、auth 三态语义、宽限窗权威值 300s、撤销即拒、
  App 端 Keystore 原子换发合同、docs/14 本地面。
- 明确不做（N 系列延续）：端到端加密补投信道（N-R1 精神）；多设备广播式轮换（帧为 per-device
  路由语义，deviceId 必填，README #2 :129-131，广播面不存在亦无需求）；把 token_rotation 纳入
  sync 补发（§3.12 sync 仅承载 event 帧，README #11 :161 锚定；且 event 缓存为脱敏面
  ——relay_events 纪律 0001_init.sql:62-73，Token 明文绝不容入）。
