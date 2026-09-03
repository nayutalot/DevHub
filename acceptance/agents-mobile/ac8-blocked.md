# AC8 阻塞与未验证项记录（acceptance/agents-mobile）

> 批次：AC8（docs/16 §1 AC8 行）。记录日期：2026-09-03。
> 结论先行：**AC8 主验收路径（真实端到端链路）已全部通过**；唯一未验证域 =
> **NatPierce 隧道下的端到端与防重放公网回归**，阻塞原因 = 用户未提供真实
> NatPierce 凭据（三项环境变量均未配置），属外置依赖缺失，非代码缺陷。

## 1. 阻塞项：隧道下端到端未验证

### 1.1 阻塞原因

- `NATPIERCE_ENDPOINT` / `NATPIERCE_ACCOUNT` / `NATPIERCE_TOKEN` 三个环境变量
  均未配置（真库 `agents:gatewayStatus` 投影实测 `natpierce: {configured:false}`）。
- 按 docs/15 §8 边界，DevHub 不启动/不安装/不代管 NatPierce，凭据必须用户自备；
  本批次铁律禁止伪造任何环节，故隧道下验证只能如实留空。

### 1.2 具体未验证用例（全部依赖「手机经公网隧道地址连上桌面」这一前置）

| # | 用例 | 依赖 |
| --- | --- | --- |
| B1 | 隧道地址连通性：手机 App 网关配置填隧道主机:端口 → `GET /v1/health` 经隧道返回 200 | 公网隧道在线 |
| B2 | 隧道下配对：经隧道地址完成 8 位码 claim（一次性码 + claim 限流在公网来源下行为） | B1 |
| B3 | 隧道下 WS 长连 + 事件实时推送：`session.waiting_input` 事件帧经隧道到手机 → 系统通知 | B2 |
| B4 | 隧道下防重放公网回归：`X-DevHub-Timestamp` 窗外（±300s）请求 → 401 AUTH_REPLAYED；同 nonce 重放 → 401；合法时间戳+新 nonce → 通过 | B2 |
| B5 | 隧道下指令链：手机 `POST /v1/sessions/{id}/reply` 经隧道 → 202 → provider 执行 → `command.result` 回推 | B2 |
| B6 | 断隧道恢复：隧道断开期间指令入离线队列（QueuedOffline）→ 隧道恢复后按幂等键补发 | B2 |
| B7 | `natpierce.reachable=true` 投影：三项环境变量齐备后诊断面显示可达 | 凭据齐备 |
| B8 | 非回环来源的 `/v1/pairing/create` 拒绝（GATEWAY_LOCAL_ONLY 403）在公网来源下复核 | B1 |

说明：B4/B5 的**本地回环版本已验证**（见 §2），隧道只改变传输路径，不改变任何
判定逻辑；列在这里是因为「公网来源 + 真实隧道」形态未经实测，不预支结论。

### 1.3 解除条件（用户提供凭据后按 docs/natpierce-setup.md 执行）

1. 用户设置三项环境变量（见 docs/natpierce-setup.md §3），启动 NatPierce 隧道，
   把 `127.0.0.1:8746` 透传到公网（§4）；
2. 复跑投影：Agents 视图/诊断面确认 `natpierce = {configured:true, reachable:true}`（B7）；
3. 手机网关配置改隧道地址 → 复跑 B1→B2→B3；
4. 复跑防重放公网回归（B4）：窗外时间戳 / 重放 nonce / 合法请求三态；
5. 复跑指令链（B5）与断隧道补发（B6）：可用无害小任务（如 "Reply with exactly: OK. Then stop."）；
6. 复核 B8（从公网来源 POST /v1/pairing/create 应 403 GATEWAY_LOCAL_ONLY）；
7. 复跑后在本文件追加「已解除」记录与证据路径，无需改动任何代码
   （投影/鉴权/指令链实现均已固化，隧道只是传输面）。

## 2. 已验证部分清单（本地回环全链路，2026-09-03 实测）

以下全部为真机（Android 模拟器 DevHub_API_35）+ 真实桌面 Electron
（gateway_enabled=1）+ **真实 Codex 推理**（codex-cli 0.153.0-alpha.5，用户已登录
账号）取得的客观证据，证据文件均在 `acceptance/agents-mobile/`：

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| 托管会话发起（trigger 文件 → thread/start + turn/start） | 通过（nativeId `01a06803-727a-79c3-9b91-79db4fce78b9`） | `managed-turn.json.result.json` 消费结果 + DB session.started |
| 会话列表出现新 managed 会话 | 通过（#328，managed 徽章 + 等待输入） | `ac8-e2e-06-session-running.png` |
| waiting_input → 手机系统通知 | 通过（id=328，channel=events，标题「DevHub：等待你的输入」，正文含 turn id） | `ac8-e2e-07-notification.png` + `dumpsys notification` 摘录 |
| 通知点击 deep link → 会话详情（回复框） | 通过（VIEW intent `devhub://session/328` → 详情页） | `ac8-e2e-08-deeplink-detail.png` + logcat START 帧 |
| 手机回复 → 202 → command.executed → 第二次真实推理 | 通过（commandId `cmd-d0c6cf35-313e-420f-ad24-1a525c561f4e`，remote_commands 行 status=executed） | `ac8-e2e-09/10-*.png` + 桌面日志 `POST /v1/sessions/328/reply -> 202` |
| 第二次推理回复回流手机消息流 | 通过（assistant "DONE" 16:28:13） | `ac8-e2e-12-messages-flowback.png` + DB agent_messages |
| 事件序列 | 通过（16 事件：session.started → status_changed(running) → message.appended×6 → waiting_input → status_changed(running) → command.result → message.appended → waiting_input，与 docs/12 §6 时序一致） | DB `agent_events WHERE session_id=328`（本报告当日查询摘录） |
| WS ack 推进 | 通过（新设备 event_deliveries 121 行全部 acked，只前进语义） | DB event_deliveries 聚合查询 |
| 能力验证门（managed [reply,pause,resume]，158 protocol methods） | 通过（真机 app-server 握手实测） | 详情页 capabilities 行（`ac8-e2e-08-deeplink-detail.png`） |
| 能力过期门（>300s 结构化拒绝） | 通过（pause 尝试返回 403 AGENT_CAPABILITY_MISSING，手机端显示完整结构化错误） | `ac8-e2e-13-pause-attempt.png` |
| turn/interrupt 活跃中断（pause 加分项） | 未执行——需在真实 turn 进行中打断（第三次真实推理消耗，与「用量最小化 1-2 turn」冲突，失败不阻塞，如实记录） | — |
| NatPierce 三态投影（ac8-140，smoke） | 通过（140/140 基线内） | `node scripts/smoke.mjs` |
| 未配置 NatPierce 的本地模式（模拟器 10.0.2.2） | 通过（本批次全部 e2e 即走此路径） | 同上各证据 |

## 3. 本批次修复的实现缺陷（e2e 过程中发现并最小修复）

1. `src/main/services/agentControl/providers/codexProvider.ts` — getCapabilities 在
   已握手连接上重复 `initialize`，真机 0.153.0-alpha.5 回 -32600 "Already
   initialized" → 能力验证整体失败落 observed/空集（指令门会误拒）。修复：删除
   冗余二次 initialize。
2. `android/.../connect/ConnectionManager.kt` — `baseUrlProvider` 同步读 Room
   （主线程 IllegalStateException 崩溃）→ 改读 AC7b 已有的 `cachedBase` 内存缓存；
   `submitCommand` 同步 OkHttp execute 在主线程抛 NetworkOnMainThreadException
   （am_crash 实录，被前者掩盖）→ 整体移入 `Dispatchers.IO`。
   （该修复使真机回复链路从「必崩」变为可用，见 §2 证据。）

---

## 4. 并发批次 #1（分支 ac8-e2e，基线 b8a819a）真实端到端复验记录（2026-09-03/04）

> 本节为并发批次 #1 在独立 worktree 内对 §2 链路的完整复验与增量。会话 native_id
> `01a0684e-42c2-7531-833c-a1b5b4f49e21`（DB 行 #337），全部证据在
> `acceptance/agents-mobile/ac8-e2e-14..37-*.png|log|json`。

### 4.1 端口裁决与切换记录（母智能体两次裁决，全程可逆）

| 时段 | 端口 | 原因 |
| --- | --- | --- |
| 批次开始 | 8746 → **8750** | 初始裁决：避开并行批次 smoke 对 8746 拒绝连接的断言 |
| 01:40 左右 | 8750 → **8760** | 裁决修正：8750 落在 smoke ac6-121 依赖段（顺序绑 8747–8755 构造 GATEWAY_PORT_IN_USE），改用 fallback 顺延范围外的 8760 |
| 收尾 | 8760 → **8746** | 复原真库缺省；gateway_enabled 全程保持 1 |

手机 App 配置页两次同步改端口（10.0.2.2），health 探测与 WS 重连均实测通过
（`ac8-e2e-16-saved-8750.png`、`ac8-e2e-31-config-8760-health-ok.png`、
`ac8-e2e-32-reconnected-8760.png`）。

### 4.2 逐步结果（真实推理 ×6 turn，全部纯回复类无害小任务）

| # | 步骤 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 托管发起（trigger 文件） | 通过：requestId `ac8-e2e-t1-…`，nativeId `01a0684e…`，thread/start+turn/start ok | `managed-turn.json.result.json` + DB session.started(14853) |
| 2 | turn 1（"Reply with exactly: OK."） | 通过：17:25:54 发起 → 17:26:01 waiting_input（约 7s），assistant 回复 "OK." | DB 事件 14853-14862 + `ac8-e2e-22-db-events-turn1.json` |
| 3 | 会话列表新 managed 会话 | 通过：#337 managed 徽章 + 等待输入高亮 | `ac8-e2e-25-sessions-list-managed.png` |
| 4 | waiting_input → 系统通知 | 通过：通知 id=337，channel=events，正文 "turn 01a0684e ended; awaiting next user input" | `ac8-e2e-24-notification-shade.png` + `ac8-e2e-23-dumpsys-notification-turn1.log` |
| 5 | deep link → 详情（回复框） | 通过：`devhub://session/337` VIEW intent（onNewIntent 热路径）直达详情，capabilities 行 = managed [reply, pause, resume] 158 methods | `ac8-e2e-26-deeplink-detail.png` |
| 6 | 手机回复 → 202 → 第二次真实推理 → 回流 | 通过：commandId `cmd-b975cbcf…`（reply，executed，exec_lag 1s，device_id=4）；assistant "DONE" 17:33:33 回流 | `ac8-e2e-27/28/29-*.png` + `ac8-e2e-30-db-evidence-chain.json` |
| 7 | resume 能力（误触即真实验证） | 通过：`cmd-6fc4f4be…`（resume，executed）→ "RESUMED." 17:36:15 回流 | 同上 |
| 8 | pause 能力（可选） | 结构化拒绝（诚实结果）：turn 已结束（单句任务 2-8s 完成，快于操作窗），remote_commands 行 `cmd-d03d81f2…` = failed / COMMAND_NOT_EXECUTABLE + command.result 事件，会话保持 waiting_input 不伪造 paused | `ac8-e2e-33-pause-attempt.png` + DB |
| 9 | WS ack 推进 | 通过：session #337 相关投递 88 行（acked 22 / pending 66——pending 属已撤销/陈旧设备 1-3 的投递行，活跃设备 4 均已 ack） | `ac8-e2e-30-db-evidence-chain.json` |
| 10 | 事件序列全类型按序 | 通过：session.started → status_changed(running) → message.appended×N → waiting_input ×3 轮 + command.result ×4，与 docs/12 §6 一致 | 同上 + 桌面 AgentsView 事件面板截图 |
| 11 | 端口切换后 App 重连（8760） | 通过：冷启动后 "已连接 · 心跳 30s" | `ac8-e2e-32-reconnected-8760.png` |
| 12 | 修复后实时回流复验（LIVE turn） | 通过：详情页停留期间手机回复 → "LIVE." 17:52:15 实时出现（无需退出重进） | `ac8-e2e-36-flowback-live.png` |

### 4.3 本批次新修复的实现缺陷（最小 diff，均在 android/）

1. `SessionDetailScreen.kt` — 详情页消息只在首屏加载，停留期间新
   message.appended 永远不可见（只能退出重进）。修复：3s 详情轮询循环内按本地
   缓存 maxMessageId 增量补拉一页入库（Room Flow 自动刷新；失败静默游标不动）。
   实测：`ac8-e2e-36-flowback-live.png`（LIVE turn 实时回流）。
2. `GatewayConnectionService.kt` — 常驻连接通知文本为启动时一次性构建，配置改
   端口后仍显示旧地址（实测：已连 8760 仍显示「10.0.2.2:8746 · 未启动」）。
   修复：订阅 ConnectionManager.state，文本变化即同 ID 重发通知。实测：
   `ac8-e2e-37-dumpsys-notification-final.log`（"远程面 10.0.2.2:8760 · 已连接
   （心跳 30s，服务端 seq 14931）"）。

### 4.4 环境怪癖（非代码缺陷，如实记录）

- 模拟器通知栏点击未触发 PendingIntent（点按事件通知后 AUTO_CANCEL 未发生、
  无 intent 投递日志）→ deep link 改经同一 VIEW intent（`am start -a
  android.intent.action.VIEW -d devhub://session/337`，即 Notifier contentIntent
  的同源 intent）驱动验证；通知本身的存在性与内容已由 dumpsys + 通知栏截图独立
  证实。桌面宿主处于锁屏会话，物理点击不可用，桌面侧 UI 操作经 CDP
  （--remote-debugging-port=9222，AC5 先例）完成。
- 桌面 Electron 重启后 codexProvider.managedTurns（内存登记）清空，监控重放旧
  rollout 时会把该线程的 task_complete 判为 unknown 一瞬（事件 14924），随后
  任一 DevHub 侧指令（reply/resume）重新登记 managed 即恢复 waiting_input 判定
  ——与代码内「内存态、重启回退 observed 判定」的设计注释一致，DB 行
  session_mode 始终保持 managed（L3 护栏）。

### 4.5 门禁执行说明

- 本批次代码改动全部位于 `android/`（Kotlin），`scripts/smoke.mjs` 不覆盖
  Android 工程；TS 源码零改动。已跑 `npx tsc --noEmit`（通过）。smoke.mjs 无
  用例过滤参数（全量 140 条一起跑），按批次铁律不跑全量（留给并行批次），
  夹具用例 ac8-139/140 基线内已绿且本批次未触碰对应 TS 路径。
- Android 侧门禁 = `./gradlew assembleDebug` 两次（BUILD SUCCESSFUL）+ 真机
  安装 + 实测复验（见上表 #12）。
