# DevHub App 体验整改批（R1–R11）任务书

> 生成：2026-09-04（基于用户 App 端实测 11 项问题）。本文件是**可直接派发给 omni-agent 的自包含任务书**：
> 可整版发给一个执行代理，也可按 §6 批次拆成三份分别派发（夜间并发 = 一 Agent 一 Worktree 一任务，主控独占 merge）。
> 执行前必读：`docs/00-execution-constraints.md`（28 条合同）、`docs/11-16`（AC 域权威设计）、`HANDOFF.md`、`docs/known-limitations.md`。

## 0. 角色

你是 DevHub 的实现代理。DevHub = Electron 桌面中枢（监控本机五家编码 Agent）+ Remote Gateway（REST 13 端点 + WS `/v1/events`，Bearer 设备 Token + 防重放 + 限流）+ Android App（Jetpack Compose，`android/app` + 纯逻辑 `android/core`）。公网通道已部署（ECS+frp，手机连 `59.110.149.11:8746` → 回本机 Gateway）。

本批目标：修复用户真机实测提出的 11 项体验缺陷（R1–R11），**只按本任务书裁决的方案执行；发现方案与代码现实冲突时，停止该项并上报，不擅自改设计**。

## 1. 事实基线（自包含，勿再考古）

- 仓库：`F:\Active_Project\DevHub`，git main。桌面 TS 严格模式；DB = node:sqlite WAL，migration 004（user_version=4，27 表）。
- 桌面 Agent Control：`src/main/services/agentControl/`（agentControlService / monitorRegistry / eventPipeline / redact / providers/ ×5 / gateway/{httpServer,ws,auth,pairing}.ts）。
- App 屏幕：`android/app/src/main/java/com/devhub/mobile/ui/screens/`（MainTabs / Agents / Sessions / SessionDetail / Device / Diagnostics / GatewayConfig / Pairing）；网络层 `data/remote/GatewayApi.kt` + `Dtos.kt`；本地缓存 Room（`data/db/DevHubDb.kt`）。
- 能力矩阵（docs/known-limitations §1，以代码为准）：**Codex = managed（reply/pause/resume 已授予，AC8 真机端到端已证实，但仅对 DevHub 托管启动的会话生效；用户外部自启的会话 = observed 只读）**；Claude/Kimi/ZCode/DeepSeek = observed（各有明确原因，见 R7）。
- 延迟链路现状（R5 根因，已核实）：
  - PC 侧观察链路是**文件扫描**（providers 轮询转录文件），不是抓包。节流两级：monitorRegistry `FAST_POLL_MS=2s` / 降级 `SLOW_POLL_MS=15s`（monitorRegistry.ts:23-25）；`SESSIONS_REFRESH_MIN_INTERVAL_SEC=15`（agentControlService.ts:1152，全量会话刷新最快 15s 一次）。
  - App 侧 = 固定轮询 REST：会话列表 2s 全量（SessionsScreen.kt:65,90）、详情+消息增量 3s（SessionDetailScreen.kt:79-98）。WS 事件帧已存在但**不驱动列表/详情刷新**，只用于通知。
- 消息投影：`GET /v1/sessions/{id}/messages` 仅 `{id, role, contentRedacted, occurredAtSec}` 单字符串（gateway/httpServer.ts:704-721）；思维链、工具/插件调用原文全部平铺在 contentRedacted 里。
- 会话列表行显示 `provider #N`（SessionsScreen.kt:152）；`GET /v1/agents` 已有 provider 名录，App 已封装（GatewayApi.agents()）。
- zcode 子代理会话被有意过滤（提交 8442e9d，主智能体会话专用，避免子会话污染列表）——过滤逻辑所在即父/子识别逻辑所在。
- IPC 白名单 68 条，`agents:` 13 条（channels.ts:110-122）；**无 spawn 通道**；`exec.spawnManaged`（双上限）目前仅 codex/kimi provider 内部调用。
- 门禁基线：tsc 0 错误；smoke **144/144**（跑前 8746-8755 必须空闲）；mcp-acceptance **22/22**（**先 commit 再跑**，A12 断言工作树干净）；`:core:test` 37/37；gradle 构建需 JAVA_HOME。

## 2. 需求清单（用户原话 → 根因 → 裁决方案 → 验收）

### R1 思维链可折叠（"思维链无法收起，查看极为冗长"）
- 根因：消息投影单字符串平铺，App 端无分段渲染。
- 方案：
  1. 服务端消息投影增加**可选** `segments: [{kind:'text'|'thinking'|'toolInvocation', label?, content}]`（gateway messages 端点 + 桌面 `agents:messages` 同步透传；contentRedacted 保留不动，向后兼容）。分段只在转录源有明确结构时产生（zcode/claude/kimi 转录各自的消息类型映射），**无结构则整段 text，绝不猜**（项目红线）。
  2. App：`kind='thinking'` 渲染为折叠行「💭 思维链 · N 字 ▸」，点按展开/收起，**默认收起**。
- 验收：含思维链的会话首屏不显示长推理原文；展开后完整可见；无思维链消息渲染不回归；smoke 新增投影分段用例。

### R2 子智能体会话入口（"子代理调用会话完全隐藏…"）
- 根因：zcodeProvider 有意过滤主智能体之外的子会话（8442e9d）。
- 方案：
  1. **默认列表仍只显示主会话**（保留 8442e9d 的意图），但子会话不再丢弃：快照增加 `parentNativeSessionId`，落库 `agent_sessions.parent_session_id`（migration 005，nullable 自引用 + 索引）。
  2. `GET /v1/sessions` 支持 `parentId=` 过滤；`GET /v1/sessions/{id}` 返回 `childSessions: [...]`（**含已结束**，带状态/时间/标题）。
  3. App SessionDetail：存在子会话时显示入口行「🤖 子智能体会话 (N)」→ 子会话列表页（可再下钻，行上标注层级与状态；已结束的照常可点入回看）。
- 验收：一次含子代理调用的真实/夹具会话，从父会话一步进入子会话并看到完整消息；子会话不出现在默认列表；smoke 新增父子链用例。

### R3 归档与删除（"对话记录越来越多"）
- 方案：
  1. migration 005：`agent_sessions.archived_at`（nullable）。**删除/归档只动 DevHub 本地投影行**（agent_sessions + 该会话消息/事件/deliveries 相关行级联清理），**绝不触碰 ~/.zcode、~/.claude 等源文件**（红线，UI 文案要写明"仅移除 DevHub 记录"）。
  2. 新端点（沿用 Bearer+防重放+限流+幂等框架，docs/15 复核，绝不携带本地路径出网）：`POST /v1/sessions/{id}/archive`、`POST /v1/sessions/{id}/unarchive`、`DELETE /v1/sessions/{id}`；`GET /v1/sessions` 默认过滤 archived，`includeArchived=1` 可见。
  3. App：会话行**长按**菜单（归档/取消归档/删除，删除二次确认）；列表页「显示归档」开关；桌面 AgentsView 至少尊重服务端默认过滤（最小改动）。
- 验收：归档后默认列表不可见、开关下可见；删除后该会话在桌面/App 均不可达且源文件原样；smoke 新增三端点正反用例（含 401/403 面沿用既有安全回归模式）。

### R4 会话列表识别 Agent（"只有 provider1234"）
- 方案：SessionView 增加 `providerKey`/`providerLabel`（如 "ZCode" / "Codex" / "Claude Code"，投影自 provider 注册名，附加字段向后兼容）；App 列表行首加**固定色板 + 首字母徽标**（每 agent 一色，全 App 统一），替换 `provider #N` 文案；列表页顶部 provider 过滤 chips（数据用 `/v1/agents`）。桌面 AgentsView 顺手同色标（可选、低优先）。
- 验收：不看数字也能一眼区分五家 Agent 的会话；过滤 chips 生效；R11 头像色与列表色一致。

### R5 刷新延迟（"可能是抓包过慢，也可能是中转频率过低"）
- 根因澄清：无抓包环节。三层叠加：PC 扫描节流（15s 全量刷新下限）+ App 固定轮询（2s/3s）+ WS 事件不驱动 UI 刷新。
- 方案：
  1. **先实测归因**：打点/日志测量"源文件落盘 → agent_events 入库 → WS 帧到达 → App Room 更新"各段耗时，给出改造前后 p50/p95 对比表（写进验收报告）。
  2. PC：`SESSIONS_REFRESH_MIN_INTERVAL_SEC` 改自适应——"活跃 provider"（近 X 分钟有 lastActivityAt，或 App端正打开其会话，经 WS sync/请求头可感知）2–5s，空闲保持 15s；读失败降级（SLOW_POLL）逻辑不动。
  3. App：WS 事件帧（`session.started`/`session.updated`/`message.appended`）到达即触发对应 Room 失效 + 定向补拉；固定轮询降为兜底（列表 30s、详情 10s），退到后台/断网自动回退兜底。
- 验收：公网隧道全链路（模拟器 → ECS → PC）新消息出现延迟 p95 ≤ 5s；断 WS 后兜底轮询仍工作；打点数据附报告。

### R6 Codex 交互（"显示能交互，实际没有"）
- 根因：**能力是"会话级"的，展示却是"Provider 级"的**。Codex 只有 DevHub 托管启动的会话（managed）可 reply/pause/resume（AC8 已真机证实）；用户外部自启的 Codex 会话全是 observed 只读。App Agents 页按 provider 展示 managed 能力，造成"能交互"的错觉。
- 方案：
  1. 诚实化：AgentsScreen provider 卡片文案改为「托管会话可交互；外部会话只读」；会话详情的能力展示维持会话级 ControlGate 门控（现状已对）。
  2. 让交互真实可达：新增 `POST /v1/providers/{providerId}/sessions`（启动托管会话，内部走 `exec.spawnManaged` 双上限；安全面沿用既有四件套，幂等；**仅对 capabilities 已授予 managed 的 provider 开放，其余 403 COMMAND_NOT_EXECUTABLE**）。App Agents 页对 codex 显示「启动托管会话」按钮 → 创建后跳入会话详情，reply/pause/resume 可用。
  3. 若实现中判定新端点安全面与 docs/15 冲突：**只交付第 1 步并上报冲突点**，不降安全标准。
- 验收：App 内一键启动托管 Codex 会话并完成一次 reply 回流（模拟器 + 公网隧道）；对外部 observed Codex 会话仍零控件、文案如实。

### R7 observed 提供商交互（"claude/kimi/zcode/deepseek 只能看不能交互"）
- 事实（known-limitations §1）：这四家**当前不存在可用的第三方控制通道**——ZCode 无公开控制通道；Claude hooks 无输入注入 API（reply 不可达）；Kimi managed 通道已实现但真机授权验证留用户；DeepSeek 未接入（无会话数据源）。
- 方案（本批只做诚实化，**不伪造交互**）：
  1. SessionDetail 的 observed 提示从通用一句话升级为 **per-provider 原因卡**（文案从 known-limitations §1 摘取，如「ZCode：官方未提供控制通道，DevHub 只能观察」）。
  2. AgentsScreen provider 行只展示该 provider **会话级真实可用**的动作；不可用的不显示为可点。
  3. Kimi 真机 managed 启用、Claude hooks 注册入口 = **用户裁决项（§7），本批禁止动手**。
- 验收：四家任何界面不再出现"看似可交互"的控件或文案；原因卡内容与 known-limitations 一致。

### R8 原指令渲染（"显示 `\[Android 模拟器\]\(plugin://…\)` 可读性为 0"）
- 方案：
  1. 服务端：messages 投影对 `plugin://`、`skill://`、`mcp://` 类引用，在 text 段内替换为「`[插件] Android 模拟器`」式短标签（原始 URI 保留在 contentRedacted 兼容字段，不出现在 segments 展示路径；仍绝不携带本机路径）。
  2. App：`AnnotatedString` 迷你渲染器（**纯 Compose，禁止 WebView/HTML**）：行内/块级代码等宽底色、markdown 链接只显 label、工具/插件名渲染为 chip、清理转义符。渲染失败回退纯文本。
- 验收：含插件/技能调用原文的会话行内显示为可读 chip/标签；代码块不丢内容；smoke 新增投影替换用例（断言 segments 不含 `plugin://` 原文）。

### R9 进度条 / 快速定位（"只能手翻，不能拖动"）
- 方案：SessionDetail 消息列表（LazyColumn，reverseLayout，见 R10）底部加**拖动 scrubber**：映射已加载窗口的索引区间，拖动实时显示邻近消息时间戳气泡，释放即跳转（未加载区间触发按锚点翻页，依赖 R10 的 `last`/游标能力）；另加「⏬ 跳到最新」FAB（不在底部时显示）。列表页暂不需要 scrubber。
- 验收：千级消息会话中，从任意位置拖到目标区 ≤ 2 次翻页内命中；跳到最新一键直达；拖动不卡顿（模拟器实测）。

### R10 默认展示最新（"点进会话先看到最早的对话"）
- 根因：messages 端点只有 oldest-first + after 正向游标，首屏取的是最早一页。
- 方案：
  1. 服务端 messages 端点增加尾部取数：`last=<n>` 返回最新 n 条 + `prevAfter` 游标（继续向旧翻页用）；after 正向语义保持不变。桌面 `agents:messages` 同步透传。
  2. App：进入会话即请求 `last=200`，列表 `reverseLayout=true`（最新在底、初始停在底部）；向上滚动到窗口边缘自动按 prevAfter 加载更早消息（替换现有"加载更多"按钮）。
- 验收：新开任意历史会话首屏即最新一轮对话；上滑可无限回溯到最早；与 R1/R9 组合后思维链折叠、拖动定位均按最新优先工作。

### R11 用户/Agent 消息区分（"参考微信"）
- 方案：气泡式对话流——`role=user` 右侧主色气泡右对齐；`role=assistant` 左侧 surfaceVariant 气泡；system/tool/事件类居中灰 chip；每侧带头像（R4 色板首字母，user 侧固定"我"）；跨天日期分隔线；时间戳移入气泡尾注。沿用既有脱敏投影，不新增数据。
- 验收：一眼可分谁在说话；与 R1 折叠、R8 chip、R10 逆序布局组合无样式回归（截图评审覆盖长/短消息、代码块、日期边界四种样例）。

## 3. 红线（违反即整批拒收）

1. **绝不猜**：任何状态/能力/分段判定必须有可验证来源；转录无结构就整段 text，不启发式切思维链。
2. observed 会话零控制控件（服务端 L3 门 + UI 门现状保持）；不可用能力绝不显示为可用。
3. 删除/归档只动本地投影；源文件零触碰；投影绝不携带 sourceRef/本机路径出网。
4. 新端点沿用 Bearer + 防重放 + 限流 + 幂等；不新增广播 IPC channel（renderer 仍走白名单轮询/透传）。
5. smoke 断言 append-only：改既有断言必须在报告中单列说明并等母智能体裁决。
6. Mimosa 钩子：「env→path→fs」模式必拦（误报），appeasement 无效时移除构造或上报；**绝不 --no-verify**。
7. smoke 与真实 Gateway 端口互斥（8746-8755 段留给 smoke，真实验证用 8760 类段外端口）。
8. mcp-acceptance 前先 commit（A12 干净树断言）。
9. 真库 WAL 只读：直连失败用三文件快照法，不写生产库。

## 4. 技术注记（踩坑速查）

- Android 构建需 JAVA_HOME；SDK 在 `%LOCALAPPDATA%\Android\Sdk`，AVD `DevHub_API_35`；APK 输出 `android/app/build/outputs/apk/debug/app-debug.apk`。
- 模拟器验收截图用 adb screencap；视觉评审派 omni-agent 看图法（Read 内联逐屏）。
- 桌面截图用 PrintWindow+PW_RENDERFULLCONTENT；桌面 UI 可经 CDP 9222 驱动。
- 消息指纹去重沿用 `message.appended` 的 native_msg_id 指纹机制（agentControlService.ts:1418 附近），新分段投影不得破坏重放零重复语义。
- SessionView / messages 投影是桌面+App 共用契约（docs/14 §A/§B.1）：新字段一律可选附加，两端口径同步更新 docs/14。

## 5. 门禁（每批全跑，原始输出进报告）

1. `tsc` 0 错误。
2. smoke：基线 144/144 + 本批新增用例全绿（跑前确认 8746-8755 空闲）。
3. mcp-acceptance 22/22（先 commit）。
4. `:core:test` 全绿 + 新增纯逻辑单测（分段解析/归档过滤/scrubber 映射等可测逻辑放 core）。
5. gradle `assembleDebug` 成功；模拟器安装并按 R1–R11 验收标准逐屏截图。
6. R5 延迟打点前后对比表；R6 端到端证据（命令 id + 回流事件链）。

## 6. 批次划分（建议 3 worktree 并行；也可单代理串行整批）

- **批次 A（服务端数据与端点）**：migration 005（parent_session_id/archived_at）→ segments 投影 + plugin/skill 标签化 + last/prevAfter 取数 → archive/unarchive/DELETE + parentId 过滤 + childSessions → providerKey/Label 投影 → 自适应刷新节流 + 延迟打点 → spawn 托管端点 → smoke 新用例 + docs/14 增补。
- **批次 B（App 阅读体验）**：R11 气泡 + R4 徽标/过滤 chips + R1 折叠 + R8 渲染器 + R10 逆序首屏 + R9 scrubber/跳最新 + 子会话入口 UI + 归档/删除交互（依赖 A 的端点契约，可先按本任务书契约写 DTO + 夹具联调）。
- **批次 C（交互诚实化与验收编排）**：R6/R7 文案与能力展示修正 + R6 端到端（模拟器→公网隧道）+ R5 全链路延迟实测报告 + 逐屏截图评审 + final-report。
- 依赖关系：B 依赖 A 的契约（DTO 字段名以本任务书为准）；C 收口依赖 A/B。冲突上报母智能体裁决。

## 7. 用户裁决项（本批禁止动手，只可在报告中提醒）

1. Kimi 真机 managed 启用（需授权写 `~/.kimi-code` + 消耗少量真实推理）。
2. Claude hooks 注册入口（注意：hooks 只带来审批事件，**不带来 reply 能力**）。
3. ZCode / DeepSeek 官方控制通道出现后的接入批次。
4. FCM/厂商推送、隧道 TLS（独立特性）。

## 8. 汇报要求（每批）

1. 改动文件清单（含新增）+ 每文件一句话说明。
2. 六门禁原始输出（不是转述）。
3. R1–R11 验收标准逐条对照（含截图路径）。
4. 偏离任务书的任何决定：单独列出 + 理由，等裁决。
5. 遗留与风险（含 Mimosa 拦截记录）。
