# DevHub 已知限制清单（AC9 批次整理）

> 收录时点：2026-09-03（AC9 文档批次，基线 b8a819a）。每条均已对照 wt 仓库
> 代码/文档现状逐条核实，出处随条标注；与早期会话记录措辞不一致处以代码实况
> 为准并注明。每条含**影响面**与**解除路径**（谁能改 / 需要什么）。
> 本清单允许后续批次增补，但不得收录未核实的条目。

## 1. Agent Control — Provider 接入边界

### 1.1 ZCode：首版全部 observed（非公开 CLI，无控制通道）

- **现状**：`getCapabilities` 恒 `observed + 空集`（裁决 4）；sendReply/pause/resume
  结构化 unsupported（`src/main/services/agentControl/providers/zcodeProvider.ts`
  头注释「首版全部 observed」）。approval 判定源已接（tool_usage.approval_status
  匹配 pending/request/await/wait 形态 → approval_required），但本机语料实测
  全集为 `{none}`（resolved 后归 none），未出现 pending 形态；waiting_input 判定
  源（session_input.status）实测无 pending 形态 → 均不产生（绝不猜）。
- **影响面**：ZCode 会话在桌面/手机上只能看，不能回复/暂停/恢复；审批与等待
  输入状态在本机语料下不会出现。
- **解除路径**：需 ZCode 官方公开控制通道或输入注入 API（第三方无法自造）；
  语料出现 pending 形态后判定表按现有映射自动生效，无需改判定逻辑。

### 1.2 DeepSeek Harness：仅骨架检测显示未接入

- **现状**：provider 为骨架 + 能力检测（目录存在性/版本线索 → health）；
  `getCapabilities` 恒 observed + 空集；显式文案
  `DEEPSEEK_NOT_INTEGRATED_NOTE`（"not integrated: harness source tree detected
  but no session/control interface verified (never fabricated)"），
  `deepseekProvider.ts` 头注释与本机实态（源码重建形态 monorepo，无用户侧
  sessions 目录）一致。
- **影响面**：DeepSeek Harness 在 Agents 视图显示「未接入」，无会话/消息投影。
- **解除路径**：等 DeepSeek Harness 出现可验证的会话数据源或控制接口后新批次
  接入（需用户授权真机探测 + 新判定语料）。

### 1.3 Grok CLI：本机存在但本期未接入（预留位）

- **现状**：`providerRegistry.ts` 明确「Grok 预留位（docs/12 §11）：Grok CLI
  1.0.5 本机存在但不在用户首批清单，本期零实现、零注册」，并写明后续接入
  步骤（providers/ 新增 grokProvider.ts，数据源 ~/.grok/** 待实现批次复核）。
- **影响面**：Grok 不出现在 Agents 视图 provider 目录（apihub 的 grok 适配器
  属另一域，不受此限）。
- **解除路径**：用户发令后按 providerRegistry.ts 预留位注释接线（数据源盘点
  → provider 实现 → 夹具 smoke）。

### 1.4 Claude Code：attached 模式 reply 未授予；hooks 写入已实现但默认未注册

- **现状**：attached 通道的 reply 注入无可验证执行路径——Claude Code hooks
  无输入注入 API → 能力验证门收缩为**空集**（`claudeProvider.ts`：「attached
  通道的 reply 注入在 AC3 无可验证执行路径（hooks 无输入注入 API）」；pause/
  resume 同因无输入通道不支持）。hooks 写入/恢复功能已实现
  （`writeClaudeHooks`/`restoreClaudeHooks`：只合并 hooks 子键、时间戳备份、
  tmp+rename 原子写、幂等、恢复逐字节还原；smoke 夹具覆盖），**默认未注册**
  ——真机 `~/.claude/settings.json` 当前无 hooks 键，且**代码实况：两个函数
  目前无生产调用方（仅 smoke 调用）**，即「在 Agents 视图显式操作」的注册
  入口尚未接线（早期会话记录称入口已备，以代码为准注明）。
- **影响面**：Claude Code 会话 observed 通道状态判定只能 unknown（转录行实测
  无等待输入/审批片段）；approval_required 依赖 hooks 审批事件，而 hooks 未
  注册前该判定源不活跃 → 手机对 Claude Code 会话无任何动作能力。
- **解除路径**：Claude Code 官方提供输入注入 API 后重评 attached 能力门；
  hooks 注册入口接线（IPC/UI 暴露 writeClaudeHooks）属产品决策，需用户发令。

### 1.5 Kimi：managed 通道夹具全验证，真机端到端未验证；api_key 只展示尾 4 位

- **现状**：真机边界明确写在 `kimiProvider.ts`——「kimi 真实托管启动必然写入
  ~/.kimi-code（sessions/logs）且无法保证不触发推理 → 真机 managed 探测跳过
  （getCapabilities 保持 observed + 空集）；managed 通道全部由夹具假进程验证，
  真机端到端 reply 留 AC8」；AC8 实际端到端走 Codex（见
  `acceptance/agents-mobile/ac8-blocked.md` §2），Kimi 真机托管仍未验证。
  `~/.kimi-code/config.toml` 明文 api_key 的任何投影只经 maskKey（尾 4 位 +
  长度），smoke 用假 key 断言投影不含全值（docs/15 §6 Kimi 红线）。
- **影响面**：Kimi 会话目前只读观察；手机回复链路对 Kimi 未验证（实现已就位，
  差真机验证）；用户在 UI 只能看到 api_key 尾 4 位（设计如此，非缺陷）。
- **解除路径**：用户授权一个可写入 `~/.kimi-code` 的验证场景（愿意消耗少量
  真实推理）后按 codex AC8 同法补真机 e2e；api_key 展示策略如需放宽属红线
  变更，需用户明确裁决（不建议）。

### 1.6 Codex：observed 状态判定依赖 rollout 内容；app-server 为 experimental 协议

- **现状**：observed 通道状态只从 rollout 行内容判定（running ← event_msg
  task_started；实机全部语料无审批请求片段 → `APPROVAL_FRAGMENT_TYPES` 置空，
  observed 绝不产生 approval_required；task_complete/turn_aborted 仅证明一轮
  结束 → unknown）。app-server 为 experimental stdio JSON-RPC 协议：未知方法
  /未知字段一律容忍丢弃 + 计数（`codexProvider.ts` 头注释），不保证第三方
  版本升级后字段语义不变。
- **影响面**：Codex 会话的完成/取消终态在 observed 通道显示 unknown；Codex
  CLI 升级若变动 app-server 行为，managed 通道可能需适配（未知字段本身不致
  崩溃）。
- **解除路径**：rollout 出现审批片段语料后按判定表补映射；Codex 升级后复跑
  managed 握手冒烟（AC8 用例可复用）。

## 2. MCP

### 2.1 docs/09 §10 计划的 4 个只读 tool 未实现（遗留待办，非本期范围）

- **现状**：MCP 保持既有 12 tools / 6 resources / 4 prompts 零改动；docs/15
  §7 明确「docs/09 §10 计划的 4 个只读 tool（devhub.skills.list 等）属遗留
  待办，不在 AC 范围（母智能体裁决 3）」。
- **影响面**：MCP 客户端暂不能经 tool 读 Skills/ApiHub/版本等 AC 域数据。
- **解除路径**：用户发令后按 docs/09 §10 增批实现（仍限只读）。
- **同期红线（非限制，声明）**：远程控制能力绝不注册为 MCP tool、绝不与 MCP
  共享传输/鉴权/代码路径（docs/15 §7）——MCP 保持只读，远程控制零混入。

## 3. 桌面 UI

### 3.1 Agents 会话列表 100 条分页；Load more 上限 200（AC6 已有服务端过滤）

- **现状**（以代码核实）：`AgentsView.tsx`「服务端 limit（Load more = limit
  提升，100 → 200 封顶，docs/14 §A.1 #2）」；列表标注 "server-side filter,
  limit 100, newest first"。早期会话记录的「仅 100 条分页」已被 AC6 的
  服务端过滤 + Load more 部分解除，现存限制 = **200 封顶**：超过 200 条的
  历史会话在列表内不可达（可用搜索/过滤缓解）。
- **影响面**：超长会话历史的尾部在 UI 不可见（DB 内数据完好，API 可达）。
- **解除路径**：调大封顶或改真分页游标（小改动，需用户发令）。

### 3.2 per-provider 单独重探未实现（全局 Refresh 已有）

- **现状**：IPC 白名单无 per-provider rescan channel；Agents 视图仅有全局
  refresh（`usePagedCollection.refresh`）。
- **影响面**：单 provider 卡顿时只能整体刷新。
- **解除路径**：新增白名单 channel + UI 按钮（需门禁四跑，用户发令）。

### 3.3 事件 7 类型过滤未做

- **现状**（以代码核实）：`AgentsView.tsx` 事件流只按 eventType 上色
  （waiting_input=warn / command.result=accent，其余 dim），无类型过滤控件。
- **影响面**：事件多时需人工扫读，无按类型筛选。
- **解除路径**：前端过滤控件即可（纯 UI 小改动，服务端已返回 eventType）。

## 4. Android

### 4.1 无 FCM/厂商推送；强停期间无实时通知保证（App 内已明示）

- **现状**：`AndroidManifest.xml` 注释明示「第一版无 FCM/厂商推送（docs/11
  N3），事件通道 = 前台服务 + OkHttp WebSocket（docs/14 §B.2）」；前台服务
  `GatewayConnectionService.kt` 保活；强停（swipe away/force stop）期间推送
  不可达——App 内已明示此限制。
- **影响面**：应用被强停或后台被系统回收期间，等待输入/审批事件不会产生
  系统通知；重进 App 后靠离线队列/事件补发对齐。
- **解除路径**：接入 FCM 或厂商通道（需服务端推送面 + 用户发令，属新特性）；
  后台连接稳定性待真机长期验证（续航/厂商杀后台策略差异）。

## 5. 公网隧道

### 5.1 隧道面实测状态（2026-09-04 更新：方案 B 已部署并实测）

- **现状更新**：方案 B（用户自备 ECS + frp，docs/natpierce-setup.md §7）已部署
  并实测：模拟器（等价远端手机）经 ECS 公网地址完成 health / 8 位码配对 /
  真实数据列表 / WS 长连（5 分钟零断连），防重放公网回归三态全过、observed
  reply 指令门 403 实证——明细见 `acceptance/agents-mobile/ac8-blocked.md` §5。
  **真机（用户手机装同一 APK）待用户执行**，App 与模拟器唯一差异 = 网络路径。
- **残余限制（如实）**：
  1. 手机→ECS 段明文 HTTP/WS（无 TLS），公网防线 = 可撤销 Token + 防重放 +
     限流三条应用层防线（全部公网路径实测）；TLS 升级路径见
     docs/natpierce-setup.md §7.5；
  2. 经任何隧道（frp/NatPierce 同理）Gateway 视角来源恒为回环：
     GATEWAY_LOCAL_ONLY 不可触发、「同源」限流按 frpc 单点计（判定逻辑零变化）；
  3. `waiting_input` 通知帧经隧道的专项触发与 B5/B6（真实推理 turn 场景）留
     真机阶段复跑（本地版本已证，判定与推送逻辑不在传输面）；
  4. frpc 自启为用户级（HKCU Run + 重拉循环）——SYSTEM 级 schtasks 需管理员
     提权，本部署环境非提权（部署环境限制，非产品缺陷）。
- **方案 A（NatPierce）不变**：`NATPIERCE_*` 三环境变量仍未配置，B7 维持待
  用户凭据；B1–B4 的 NatPierce 版等价路径已由方案 B 覆盖证实（隧道只改传输
  面，不改判定）。

## 6. 旧已知项（Phase 1 / 并库阶段遗留，HANDOFF.md §7 + 代码复核）

| # | 条目 | 出处（已核实） | 影响面 | 解除路径 |
| --- | --- | --- | --- | --- |
| 6.1 | relativeTime 输出中文（"N 分钟前"）混英文 UI | `src/renderer/src/lib/format.ts`（中文文案写死，smoke 中文断言锁定） | 观感不一致；改动会碰 smoke 断言（append-only，需 docs 授权说明） | 用户定夺目标语言后统一文案 + 同批改 smoke 断言 |
| 6.2 | docker:action 的 remove 与 wsl shutdownAll 未实现 | `src/shared/channels.ts` 两 channel 存在；`src/main` 无 remove/shutdownAll 实现（docs/09 §8 DOUBLE_CONFIRM 设计，S4 范围裁剪） | 容器删除、WSL 整体关停无 UI 路径 | 按 docs/09 §8 两段确认设计补实现（用户发令） |
| 6.3 | MCP services:refresh 的 scanId 取「最新 scans 行」（并发扫描源理论错位） | HANDOFF.md §7；单进程内无影响 | 仅并发扫描时报告可能挂错 scanId（理论） | scanId 显式传递重构（小改动） |
| 6.4 | 版本中心无 cancel channel（超时兜底） | HANDOFF.md §7 | 检测中无法手动取消，只能等超时 | 新增 cancel channel + UI 按钮 |
| 6.5 | DeepSeek Harness 更新路径未真机验证 | HANDOFF.md §7 | 版本中心对 DeepSeek Harness 的升级流程无实测结论 | 真机验证一次更新（需用户授权） |
| 6.6 | npm 解析已收敛为 where.exe 单一来源（AC9，007d8b3）；env 候选回退被移除 | 007d8b3 提交「npm resolution single-source (where.exe)」；AC9 终验核实 | 安全钩子对 node_modules 内 npm 解析的误报已消解（单一可信来源，杜绝 env 注入候选路径）；代价是若 where.exe 不可用（PATH 无 System32）npm 探测退化为 unknown，无第二候选 | 恢复 env 候选回退前，必须先在安全钩子侧为 env 来源加白（防误报复发），再恢复多候选逻辑（用户发令） |

## 7. 验收数字口径（防混淆声明）

- smoke 基线：wt2 基线提交信息与 `acceptance/agents-mobile/ac8-blocked.md`
  均记 **140/140**；母智能体会话记录为 141/141。**AC9 终验已实跑收口：
  141/141 passed**（第 141 例 = 合并批次新增 sec-fix 用例），最终口径以
  `acceptance/agents-mobile/final-report.md` §2 为准。
- mcp-acceptance：**22/22**（`scripts/mcp-acceptance.mjs` 用例数实数核实；
  AC9 终验树净后复跑确认）。

## 8. 体验整改批（R1–R11）后的现状更新（2026-09-04，批次 C 收口）

> 以下为本清单 §1 相关条目在体验整改批（批次 A/B/C 合并）之后的现状增补；
> 原条目事实基础未变，此处只记**变化**与**新增边界**。证据见
> `acceptance/agents-mobile/ux-final-report.md` 与 `ux-c-latency-report.md`。

### 8.1 R6 交互真实性：Codex 托管会话可交互已真实验证（更新 §1.6 关联面）

- **新增能力（批次 A 服务端 + 批次 C App）**：`POST /v1/providers/{providerId}/sessions`
  托管启动端点已上线；App Agents 页对 managed provider（现 = Codex）显示
  「启动托管会话」→ 202 → 跳入新会话 → reply/pause/resume 可用。批次 C 已完成
  **模拟器 + 公网隧道 + 真实 Codex 端到端验证**：spawn commandId
  `cmd-204a1b54…`（executed）+ 会话 #506 + 4 次手机 reply 全部 executed 并回流。
- **边界不变（仍如实）**：能力是**会话级**的——仅 DevHub 托管启动的会话可交互；
  用户外部自启的 Codex 会话依旧 observed 只读。App 文案已诚实化（
  「托管会话可交互；外部会话只读」），observed 四家零控件现状保持，
  per-provider 原因卡产品化（文案 = 本清单 §1 摘取，`:core` InteractionHonesty 单测锁定）。
- §1.5 Kimi 条目不受影响：managed 通道真机端到端仍未验证（App 的启动按钮由
  `capabilities.mode==managed` 数据驱动，Kimi 授权后自动出现，无需改 App）。

### 8.2 R5 延迟现状（实测数字）

- 公网隧道全链路（模拟器 → ECS frp → 常驻桌面 → 真实 Codex）**新消息出现延迟
  （源 occurredAt → App 可见）：p50 = 2.70s / p95 = 4.76s（n=4，全部 ≤5s，达标）**。
- 分段：源→库（活跃消息，秒粒度）p50=1s / max=2s；库→WS p50=535ms / p95=941ms
  （latencyStats 窗口含启动回填，取上界）；库→App 可见 p50=1.4s / max=2.76s。
- **残余限制（如实）**：① App 侧仍为 REST 轮询驱动（列表 2s/详情 3s），R5.3 的
  "WS 事件驱动刷新"未实施——当前主导延迟段即轮询相位，进一步压低需立 App 改造批；
  ② WS 事件 delivery_state 实测全程 `pending`（App 在线但投递标记未发生；功能无损，
  属服务端投递面观察项）；③ source-to-db 的 latencyStats 汇总行被启动历史回填
  主导（p50 数万 ms），该口径**不可**当作活跃延迟读数，活跃值以逐消息差值为准。
- 改造前形态（15s 全量刷新下限 + 固定轮询）同链路最坏 ≈18s+，p95 ≤5s 不可达
  （定性对比，docs/17 §1 基线）。

### 8.3 跨批契约教训（防复发）

- 批次 B 以夹具联调的新 UI 字段形态与批次 A 服务端实现存在两处错位
  （`archivedAt` vs 布尔 `archived`；`childSessions` 嵌套 vs 顶层），夹具下不可现、
  真实网关首跑暴露，批次 C 已修 App 侧。后续批次凡新增投影字段，**必须以真实
  Gateway 响应样例为准**（docs/14 补样例 JSON 的文字修订留文档批）。
