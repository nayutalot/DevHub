# 28 — 对话体验 v2 规格：对齐 ZCode remote v4 形态（元素×数据审计 + 结构/运行态规格）

> 批次：UX-Z1（docs/briefs/uxz-design.md）。设计批零编码；本文为规格承载，供主控裁决后另立 Z2/Z3 实现批。
> 上游裁决：用户 2026-09-15 定调「app 端应该做成 ZCode remote v4 这种形式」——六张 v4 实拍截图（DevHub WebView 内）为规范基线。
> 上游已落：UX-R（docs/24/25/26：人话词表+三标签 IA+组件态矩阵）与 UX-P1/P2/P3（文案/导航 IA/连接单页流+开始对话一键化+空态 CTA）均在 main。
> 走查证据：`acceptance/uxz-walkthrough/`（8 张现状截图，headless 模拟器实拍，2026-09-15，附录 A 逐屏标注）。
> 基线：main=72e0967。

## 1. 范围与不可逾越（红线，继承 docs/24 §1 全部条款）

1. **零编码**：本批纯设计+数据审计+模拟器走查（headless，`-no-window`，零打扰）。
2. **不伪造状态**：审计三档（A/B/C）以代码与 DDL 证据为准（本文全部给出 文件:行号 或 docs 章节）；C 档如实列原因，绝不把不可得画成可得。v4 截图里的云端专属能力（附件/@///技能/记忆 pill/撤销/diff 统计）在 DevHub v1 **不画入口、不留死按钮**。
3. **凭据三零**：走查截图零 token/零配对码/零指纹（已逐张核对；WebView 标题 URL 为 App 自带中段省略形态）。
4. **协议/字段零改动是本批纪律**；Z2/Z3 实现批的改动面在 §8 逐条列出，其中触及协议的项一律标注 C 档留裁决，绝不夹带。
5. **不推翻既有基线**：三标签 IA、置顶卡、provider 过滤 chips、ControlGate 门语义、ErrorPresentation、演示模式纪律全部保留；v2 是在这些面上的**重排+增量**（§7 衔接清单）。

## 2. 规范基线：六图逐元素清单

原图：微信截图目录 6 张 jpg（`9e20f478899dc29eb19741386f9343c8/`，用户已定调）。逐元素编号 E1–E24，审计与规格按此编号引用：

| 图 | 内容 | 元素 |
|---|---|---|
| 图① | 工作区任务列表 | E1 汇总行「当前设备上的工作区和任务 · N 个工作区 · M 个任务」；E2 工作区卡=类型图标+名称+「本地/远程」tag+路径+「N 个任务」+chevron+「+ 新任务」；E3 「更新于 X」相对时间 |
| 图② | composer-first 基础形态 | E4 问候语（时段人话「晚上好呀，今天辛苦啦」）；E5 大输入框（placeholder「向 ZCode 提问…」）；E6 工作区选择器（图标+名称+chevron）；E7 工具排（+ / 盾 / 圆 / 立方 / 脑 / 发送↑）；E8 快捷指令 chips（周报总结/报错修复/PPT 制作…） |
| 图③ | 模型选择弹层 | E9 提供商行（BigModel「个人」）；E10 模型列表+选中勾+模型 tag（「视觉」）；E11 「管理模型」入口 |
| 图④ | 「+」扩展菜单 | E12 添加附件；E13 使用 @ 添加上下文；E14 使用 / 选择能力；E15 使用 $ 选择技能 |
| 图⑤⑥ | 会话运行态 | E16 标题+「已工作 6 分 43 秒」计时器；E17 流式正文（markdown+内联代码片）；E18 「✓ 更新记忆文件」pill；E19 「3 个文件已更改 +36 -6 · 撤销」pill；E20 复制/赞/踩/展开动作行+时间戳；E21 「提出后续修改要求」常驻 composer；E22 整体形态：深色、大间距、头像图标语义、时间人话 |

## 3. 交付一：元素×数据可得性审计（A 已有 / B 需小改 / C 云端专属或协议扩张，v1 不做）

> 数据面核实基线（全部实读核对，非转抄）：
> - 桌面 DB `agent_sessions`：`(provider_id, native_id) UNIQUE, session_mode(managed/attached/observed), project_id→projects, workdir, title, status(9 值/用户 7 态), status_detail, started_at, last_activity_at, ended_at, created_at, updated_at`（docs/13 §4.2；**无独立 cwd 列，cwd 语义由 workdir 承载**）。
> - workdir 写入路径（两 managed provider 均已落）：zcode `sessions.directory→workdir`（zcodeProvider.ts:1025/:1503 observed 投影、:1315 managed spawn=workspace）；deepseek `proj.cwd→workdir`（deepseekProvider.ts:593/:1565 observed、:1290 managed）。
> - `projects(win_path, wsl_path)`（docs/03 §）：工作区显示名的原料。
> - 网关投影 SessionView（agentControlService.ts:324 sessionView）：出 `projectId?` **不出 workdir**；附加 providerKey/providerLabel/archivedAt（ux 批 A）。Android `SessionDto`/`SessionCacheEntity` 与之同构，且 **projectId 未解析**（Dtos.kt:177）。
> - App 实时事件面 = agent_events 7 型（docs/14 §B.2 WS 帧）：`session.status_changed{from,to,detail}`（agentControlService.ts:2189）、`message.appended{sessionId,role,preview≤120,nativeMsgId,contentLength}`（:2267）、`session.waiting_input{status}`、`session.started/finished/provider.health_changed/command.result`。provider 原生事件**不直接出网关**。
> - provider 原生事件型：zcode 26 型（Z1 侦察 REPORT:22 静态全量：`turn.started/steerQueued/steerDrained/completed(resultType 6 值)/failed, message.upserted, part.started/delta/upserted, tool.updated(scheduled/started/progress/result/error/batch/raw), permission.*, userInput.*, checkpoint.created, rewind.triggered, state.updated…`）；deepseek 44 型 firehose（`turn/start, turn/end(reason 6 值), user/message, assistant/message, tool/call{name,arguments}, tool/result, approval/asked, approval/decided` + **`session.status:'idle'|'running'` 权威收尾沿**，deepseekProtocol.ts:20-25/:223-252）。
> - 工具名投影：zcode/deepseek 双双把 tool 事件投影为 `agent_messages role='tool'` 行，`content_redacted='[tool_call <name>]'` + `segments kind='toolInvocation' label=<工具名>`（zcodeProvider.ts:1100-1113、deepseekProvider.ts:1020-1034）；App 侧 Room `message_cache.segments_json` 已存（DevHubDb.kt:84）。
> - 模型设置键：`zcode_managed_model` / `deepseek_managed_model`（值=`"provider/model"` 串，缺行=托管面停用；settingsService.ts:69/:83）；kimi=CLI 自管无此键；`deepseek_managed_workspace`（DSW）；`capabilities.workspace`=managed 生效工作区一行（Dtos.kt:42 已解析）。**无模型目录端点、无设备侧 settings 写端点**（docs/14 §B 13 端点全集核实）。
> - App 侧时间格式 TimeFmt：`hm/mdHm`（TimeFmt.kt:9-11）；**无相对时间函数**；MessageBubble **无复制按钮**（实读核实）。

### 3.1 审计总表

| 元素 | 档 | 依据与缺口（B 档给最小改动面；C 档给如实原因） |
|---|---|---|
| E1 汇总行「N 个工作区 · M 个任务」 | **B** | 原料=agent_sessions GROUP BY workdir（COUNT/MAX(updated_at)）。缺口：网关无聚合端点→需 1 个只读聚合端点或 sessions 投影扩展（桌面侧小改，零协议破坏，纯追加字段）。 |
| E2a 工作区卡名称/图标 | **B** | 名称=workdir→projects.win_path 尾段（匹配不上=路径尾段兜底，绝不造行，docs/13 §4.2 同纪律）；图标=本地文件夹图标恒定（v1 无远程工作区）。缺口：SessionView 需增 `workdir?`（或按 projectId JOIN 出名），App 解析+分组。 |
| E2b 「本地/远程」tag | **C** | DevHub 无 per-workspace 本地/远程语义：所有会话都在电脑上执行，App↔电脑的连接方式（local/relay，gateway_config.mode）是**通道属性**不是工作区属性；v4 的「远程」=zcode 云端↔树莓派的 relay 概念，不可映射。v1 不做 tag（卡片省略该位），绝不伪造。 |
| E2c 路径行 | **B** | 同 E2a；展示走中段省略既有纪律（RemoteWorkspaceUrl.elideMiddle 先例）。 |
| E2d 「N 个任务」 | **B** | 同 E1 聚合；文案按 docs/25 词表=「N 个对话」（会话→对话改名已定）。 |
| E2e chevron 展开任务行 | **B** | 任务行=该 workdir 下会话行（title/status/时间）。App 已有 title/status/lastActivityAtSec；分组为客户端纯函数（RemoteWorkspaceUi.sort 先例，单测可锁）。 |
| E2f 「+ 新任务」按钮 | **B** | managed spawn 端点已有（POST /v1/providers/{id}/sessions，R6）。v1 语义=「在此工作区上下文新建」收窄为「新建对话」（不带工作区参数，见 E6/C 档）；observed-only 时按钮隐藏（canSpawnManagedSession 门保留，绝不假开）。 |
| E3 「更新于 X」相对时间 | **B** | 数据=MAX(updated_at) 聚合（同 E1）+客户端 TimeFmt 增相对时间函数（刚刚/N分钟/N小时/N天，纯 UI 函数+单测）。 |
| E4 问候语（时段人话） | **A** | 纯客户端文案表（时段→文案映射）；零个性化数据→**固定文案池不伪造称呼**（不显用户名）。 |
| E5 大输入框+placeholder | **A** | 纯 UI；发送=spawn 端点已有。 |
| E6 工作区选择器（展示当前） | **B** | 当前 managed 工作区=capabilities.workspace（字段已有、App 已解析 Dtos.kt:42、桌面 spawn cwd 已接 deepseek_managed_workspace 旋钮）。 |
| E6' 工作区选择器（切换任意工作区并按所选 spawn） | **C** | 需 spawn payload 增 workspace 字段+桌面侧校验面（协议扩张）；v1 不做。诚实降级：选择器=只读展示当前工作区+「在电脑上配置工作区」指引（deepseek_managed_workspace/zcode 配置既有事实）。 |
| E7 工具排 | **A** | 容器纯 UI；各键归属见对应元素（+=E12-15 门、盾=能力说明弹层挂点（ⓘ 先例）、发送=spawn/reply）。 |
| E8 快捷 chips | **B** | App 内置预设文案表（§5.3 预设表）；点击=填入输入框（不自动发送）。自定义持久化（Room 本地表）可行但 v1 留裁决（§9）。 |
| E9 提供商行 | **B** | providerLabel 投影已有；「个人/团队」档案语义 DevHub 无对应字段→v1 省略 tag（不伪造）。 |
| E10 模型列表+选中勾（展示当前模型） | **B** | 当前模型=zcode/deepseek_managed_model 值（需把它加进 provider 投影或 caps——**字段追加小改**）；候选列表=App 内置预设×managed 键过滤（kimi 无模型概念→不显示模型项，如实）。 |
| E10' 切换模型并持久化 | **C** | 需设备侧 settings 写端点（docs/14 §B 无此端点；新增=协议扩张）。v1 不做；诚实降级=当前模型只读+「在电脑上管理模型」指引。 |
| E11 「管理模型」入口 | **C** | 同 E10'；降级形态=跳「打开电脑页面」（remote WebView 既有）或静态指引文案。 |
| E12–E15 +菜单四项（附件/@ 上下文//能力/$ 技能） | **C×4** | zcode 云端+CLI 专属交互；DevHub spawn payload 仅 `{task, idempotencyKey?}`（docs/14 §B.5），无附件存储/上下文注入/能力技能注册面。v1 全部不做、**不画菜单入口**（vs 画了菜单点不动=假可供性，红线）。 |
| E16 计时器「已工作 X 分 Y 秒」 | **B** | 锚点=9 值状态机（**provider 差异已被桌面侧归一**：zcode turn.started→running/turn.completed→waiting_input；deepseek turn/start→running/turn,end→waiting_input+session.status idle 双沿——App 只消费 status_changed 事件，无需知 provider 原生型）。开始沿=to:'running'，停沿=to∈{waiting_input,completed,failed,paused,connection_lost}。缺口：客户端计时器组件+锚点恢复（WS 实时+Room lastActivityAtSec 兜底；锚点持久化可选）。**observed 会话无 turn 概念→不显计时器**（诚实降级，绝不拿 lastActivityAt 冒充工作时长）。 |
| E17 流式正文+markdown | **A** | segments 投影已有（R1：text/thinking/toolInvocation）；deepseek 流式增长同 nativeMsgId upsert 已落（agentControlService.ts:2230 upsert 注）；zcode part.type 实测全集投影已有（zcodeProvider.ts:1057+）。 |
| E18 「✓ 更新记忆文件」pill | **C** | zcode 记忆系统专属语义；agent_events 7 型与消息面无「记忆」类型可判；靠工具名字符串猜=脆弱+伪造语义。v1 不做。 |
| E19a 「已更改 N 个文件」pill | **B**（口径收紧） | 原料=toolInvocation 段（label=工具名）。**诚实口径=N 次文件操作（按工具调用计），非文件数不去重**（arguments 里的路径在红acted 投影中不保证可解析）；文案：「已进行 N 次文件操作」；工具名过滤白名单（Edit/Write/MultiEdit/apply_patch 等）先 Z2 实测两 provider 全集后定。不可得（无 tool 行）→不显。 |
| E19b 「+36 -6」diff 统计 | **C** | 事件面无行数统计；需桌面 diff 计算面（协议/数据扩张）。v1 不做。 |
| E19c 「撤销」 | **C** | 需 DevHub 侧快照/回滚机制；zcode 原生 checkpoint.created/rewind.triggered 存在于 26 型但 DevHub 不消费不代理。v1 只读（显示操作计数，无撤销钮）。 |
| E20a 复制 | **B** | MessageBubble 无复制钮（实读核实）；加长按/按钮+ClipboardManager=纯客户端小改。 |
| E20b 赞/踩 | **C** | 无后端反馈通道与语义；v1 砍（不画）。 |
| E20c 展开（长内容折叠） | **A/B** | falloff 渐隐已有（U2-M5）；完整展开=纯 UI 小改。 |
| E21 常驻 composer（后续修改要求） | **A** | reply 端点+ControlGate 门已有；observed=禁用态「仅查看」既有语义。 |
| E22 深色/大间距/头像/时间人话 | **A** | 深色钉死（D 批）；间距与头像=纯样式；时间人话=TimeFmt 扩展（同 E3）。 |

### 3.2 分档计数与代表性结论

- **A 档 9 项**（E4/E5/E7/E17/E20c/E21/E22 + 空态通用律 + 深色形态）：纯呈现层或端点已有，Z2 可直接落。
- **B 档 12 项**（E1/E2a/E2c/E2d/E2e/E2f/E3/E6/E8/E9/E10/E16/E19a/E20a，含同族合并计）：共同缺口=①1 个桌面只读聚合投影（workdir 分组）②SessionView 追加 workdir/provider 当前模型字段 ③客户端相对时间/计时器/分组纯函数 ④toolInvocation 计数聚合。**零协议破坏**（全部=追加只读字段/端点+客户端聚合）。
- **C 档 9 项**（E2b/E6'/E10'/E11/E12/E13/E14/E15/E18/E19b/E19c/E20b，含同族合并计）：三类原因如实——per-workspace 本地/远程语义不存在（E2b）；设备侧 settings 写/spawn 扩张/附件上下文能力（E6'/E10'/E11/E12-15）属协议扩张；记忆 pill/diff/撤销/赞踩无数据语义（E18/E19b/E19c/E20b）。**v1 一律不做且不画入口。**

## 4. 交付二（上）：工作区任务列表规格

### 4.1 载体与 IA

- 载体=**对话 tab 顶部段控**：「最近对话｜工作区」二分段（默认最近对话=现状不回归；「工作区」段=v4 列表形态）。不新增底部标签、不加一级页（三标签 IA 不动）。
- 置顶卡（ZCode 工作区卡）保留：它是 WebView 遥控入口（v4 原页继续可用）；工作区分段是**原生投影**，两者并存、职责分离（原生=快览+动线；WebView=全功能遥控）。

### 4.2 分组与排序（客户端纯函数，单测锁定）

- 分组键=`workdir` 归一串（大小写/尾斜杠归一；workdir 缺失的会话归「未分组」尾部组，绝不丢弃）。
- 组内排序=lastActivityAtSec 降序（现列表同口径）；组间排序=MAX(组内 lastActivityAtSec) 降序（对齐 v4「更新于」语义）。
- 显示名=projects.win_path 匹配→尾段；未匹配=workdir 尾段；中段省略纪律适用于全路径行。
- 汇总行=`N 个工作区 · M 个对话`；刷新走既有 refreshSignal 事件驱动（Agents 同款，无轮询回归）。

### 4.3 卡片数据映射（v4 → DevHub）

| v4 元素 | DevHub 映射 | 数据源 |
|---|---|---|
| 类型图标 | 本地文件夹图标恒定 | —（无远程工作区概念） |
| 名称 | 工作区名 | workdir→projects 尾段（B 档投影） |
| 本地/远程 tag | **不显示** | C 档（§3.1 E2b） |
| 路径 | workdir 中段省略 | 同上 |
| N 个任务 | N 个对话 | GROUP BY 聚合 |
| 更新于 X | 相对时间 | MAX(updated_at)/lastActivityAtSec + TimeFmt.rel（新纯函数） |
| chevron | 展开=组内对话行（标题+状态角标+相对时间；点行进详情=既有路由） | session_cache |
| + 新任务 | 新建对话（composer-first 动线，预填该工作区为「上下文提示」仅展示） | spawn 已有；工作区绑定=C 档不做 |
| 空态 | 未连接：复用 S5 引导；已连接无会话：「电脑上还没有对话，去助手或输入框开始第一个」 | docs/24 §4.3 通用律 |

### 4.4 状态矩阵钩子

加载=段控骨架屏；错误=ErrorPresentation（S8 同款）；离线=显示缓存+离线横幅语义（列表既有）；演示模式=夹具投影+琥珀标注（S2/S3 纪律）。

## 5. 交付二（中）：composer-first 新建流规格

### 5.1 与 P3「开始对话」的关系：升级替换，不并存两套

- P3 现状（04-spawn-panel.png）：助手页 ProviderCard 内联单输入框+「开始/取消」。v2 将其**升级迁移**为对话 tab 的 composer-first 新建页（下拉/空态/「+」动线进入）；助手页卡片保留能力披露（可以对话/仅查看+原因卡）与「开始对话」按钮——按钮点击后**跳转对话 tab 新建页并聚焦**（autoOpenSpawn 机制复用，跨 tab 一次性语义已有先例）。
- 通道纪律不变：canSpawnManagedSession 门（无 managed provider 不画输入提交路径）；「正在创建…」进行态；拒绝三态 H19；离线暂存 A18。

### 5.2 问候语规则

- 时段映射（客户端本地时间）：05–11「早上好」；11–13「中午好」；13–18「下午好」；18–23「晚上好呀，今天辛苦啦」；23–05「夜深了，注意休息」。取句尾人话池随机/固定其一（实现批定），**不带用户称呼**（无数据，不伪造）。
- 问候语仅在空输入态显示；输入聚焦后收缩为小标题或隐藏（对齐 v4 聚焦形态）。

### 5.3 快捷 chips 预设表（v1 固定四~六枚，点击=填入输入框不自动发送）

| chip | 填入文案（人话，可改后发送） | 备注 |
|---|---|---|
| 报错修复 | 「电脑上 {项目} 报错了，帮我看看日志并修复」——实际填「帮我看看电脑上报错的日志并修复」 | 与 DevHub 语境对齐，不照抄 v4 的 PPT/周报办公语境 |
| 代码解读 | 「给我讲讲 {工作区名} 这个项目的结构」 | 工作区名取当前 caps.workspace 尾段；缺省省略花括号段 |
| 写个脚本 | 「帮我写一个脚本：」 | 开放式 |
| 继续上次 | 「继续电脑上最近一个未完成的对话」 | v1 文案即可，不做会话选择器 |
- 可自定义：v1 不做（Room 本地表可行，留 §9 裁决）。预设表放 ：core 文案常量（P1 先例，改词表即全局生效）。

### 5.4 模型选择弹层（诚实降级三态）

| 态 | 判定 | 弹层形态 |
|---|---|---|
| 可选面 | ≥1 个 managed provider 且其 managed_model 键非空 | 当前模型勾选态只读展示+候选预设列表灰显（可看不可选）；底部入口=「在电脑上管理模型」（跳打开电脑页面） |
| 托管停用 | managed_model 缺行=托管面停用（settingsService 既有语义） | 弹层=「模型在电脑上配置后可用」+当前 provider 一行；**绝不画可选勾** |
| observed/未配置 | 无 managed provider | 模型入口不画（假可供性红线）；composer 提交路径同门收敛 |
- 数据源：当前模型=managed_model 值经 provider 投影（B 档字段追加）；候选列表=App 内置预设（GLM 系/DeepSeek 系文案常量）×键过滤；kimi 无模型概念→模型区对 kimi 隐藏。

## 6. 交付二（下）：会话运行态规格

### 6.1 计时器（E16）

- **语义**：「已工作 X 分 Y 秒」=本 turn 进行时长。turn 活跃定义=9 值状态机之 running 态区间：开始沿=session.status_changed to:'running'；停沿=to∈{waiting_input,completed,failed,paused,connection_lost}。provider 差异（zcode turn.started/turn.completed resultType 六值；deepseek turn/start/turn/end reason 六值+session.status idle）**已在桌面侧状态归一层吸收**，App 不消费原生事件型（审计证据 §3 头注）。
- **兜底**：WS 断线重连/进程重启后，锚点不可考→降级显示「运行中…」无计时数字（绝不拿 lastActivityAtSec-startedAtSec 冒充本轮时长）。
- **observed 会话**：无 turn 概念→整块不显计时器；状态照旧走状态角标（仅查看语义）。
- **多 turn 历史**：v1 只显当前 turn 计时；历史 turn 时长不做（事件面有 from/to 但缺 turn id 关联，聚合口径不可靠——如实）。

### 6.2 工具活动 pill（E19a 收紧版）

- 聚合口径（deepseek 先行、zcode 同面）：本 turn 起点之后 `role='tool'` 且 segments 含 toolInvocation 的行计数=N；pill 文案「已进行 N 次文件操作」仅当命中文件类工具名白名单；非文件类工具→通用「运行中 · 第 N 步」。
- zcode 口径：同上（managed 流式与 observed 监控同库转录面，工具名投影一致）；`tool.updated` 六态不直接可用（不出网关），**如实不区分 started/result**。
- 不可得降级：无 tool 行→只显「运行中…」。**不做**：+N -M diff（C）、撤销（C）、记忆 pill（C）。
- 完成态转场：停沿触发后 pill 变「本轮完成 · N 次操作」（waiting_input/completed）或人话失败卡（failed→H 族词表）。

### 6.3 常驻 composer 与动作行

- composer 常驻（E21）：managed/attached=「提出后续修改要求」placeholder 复用现 reply 面；observed=禁用+「这里只能看内容」（H9 词表）。
- 动作行：复制（B，新增）；展开（渐隐已有）；时间戳 hh:mm（已有 TimeFmt.hm）；赞/踩不画（C）。

## 7. 组件态矩阵增量（接 docs/24 §5，仅列新增行/格）

| 屏/组件 | L | E | C | Er | Off | Up | Demo |
|---|---|---|---|---|---|---|---|
| 对话 tab·工作区分段 | ✓ 骨架 | ✗ 补「还没有工作区」+CTA（去助手/输入框） | △ E1-E3 映射 | △ ErrorPresentation | △ 缓存+离线语义 | — | △ 夹具+标注 |
| composer-first 新建页 | — | ✓ 问候语+chips 空输入态（本页主态） | ✓ 输入中 | ✓ H19 三态拒绝 | ✓ A18 暂存文案 | —（Up 时本页不可达） | △ 夹具标注+提交禁用 |
| 模型弹层 | ✓ | —（并入停用态） | ✓ 三态（§5.4） | — | — | — | ✓ 停用态同款 |
| 运行态计时器 | — | — | ✓ running 区间；observed 不显 | — | ✓ 降级「运行中…」 | — | △ 夹具可演示+标注 |
| 活动 pill | — | — | ✓ N 次操作口径 | — | ✓ 降级「运行中…」 | — | △ |

实现批验收以本增量矩阵+docs/24 §5 全表逐格销账。

## 8. 落地路线（Z2 结构层 / Z3 运行态层）

### Z2 结构层：工作区分组列表 + composer-first + chips + 模型弹层

- **改动面**：
  - 桌面（小改，只读追加）：sessions 聚合投影（workdir 分组：count/lastActivity）+SessionView 追加 `workdir?`、provider 投影追加当前模型键值；网关对应字段透传（REST+IPC 同构，docs/14 纪律）。
  - Android：对话 tab 段控+工作区分组纯函数（sort/group 单测）；SessionDto/Room session_cache 增列（workdir/projectId 解析；缓存库破坏性迁移先例可循 v2 注）；composer-first 页（问候语/chips 文案常量/模型弹层三态）；助手页 autoOpenSpawn 跨 tab 接线。
- **风险**：Room 迁移（缓存库，破坏性先例在）；双列表段控的状态保持与深链回归（devhub://session/{id} 不动）；假可供性红线（模型弹层三态门、+ 菜单不画）。
- **验收口径**：①工作区分段与 v4 并排对照（附录 A 图号）逐元素过 A/B 档清单，C 档元素零出现；②workdir 分组单测（归一/未分组兜底/排序）；③模型弹层三态在 键有/键无/无 managed 三夹具下断言；④chips 点击仅填入不发送；⑤U-Aud 七任务+docs/24 §5 全矩阵回归全过。

### Z3 运行态层：计时器 + 活动 pill + 动作行

- **改动面**：Android 为主——计时器组件（状态沿驱动+降级态）；toolInvocation 聚合（Room 查询+白名单常量）；复制/展开动作行；statusDetail 人话化收尾（见 Top 差距 #5）。桌面侧零改动（Z2 已备字段）。
- **风险**：计时器锚点在 WS 重连/进程重建后的恢复语义（降级路径必须真实可走）；工具名白名单需实测两 provider 全集（zcode tool_usage 8601 行 approval_status=none 教训：先测后定）；流式高频事件下的重组纹（refreshSignal 节流既有）。
- **验收口径**：①managed 会话全 turn 生命周期（start→tool 数次→stop）模拟器实拍：计时器起/停与状态沿一致（±1s）；②断线重连中段截图=「运行中…」降级态；③observed 会话详情零计时器零 pill；④pill 计数与消息流 tool 行数一致（单测锁聚合函数）；⑤statusDetail 面零工程串直出（grep 断言）。

排批建议：Z2 先行（结构承载）；Z3 依赖 Z2 的会话详情无改动，可并行动工但验收在 Z2 合入后。两批均零协议破坏性改动（Z2 桌面侧只读追加留主控裁决，见 §9#1）。

## 9. 未决裁决点（留主控）

1. Z2 桌面侧只读聚合投影/字段追加（workdir 进 SessionView、managed_model 进 provider 投影、聚合端点）是否授权——B 档成立的前提。
2. chips 可自定义（Room 本地表+管理 UI）是否纳入 Z2。
3. 「+ 新任务」按钮 v1 语义=不带工作区绑定的「新建对话」，是否接受（工作区绑定 spawn=C 档）。
4. 相对时间词表（刚刚/N分钟/N小时/N天/日期回退）终稿。
5. 活动 pill 文案终稿（「已进行 N 次文件操作」vs「N 步操作」）与文件类工具名白名单（Z3 前置实测）。
6. 对话 tab 段控默认段（最近对话 vs 记忆上次选择）。

## 10. 与既有基线衔接（不推翻清单）

- docs/24 全部红线与 §5 矩阵继续有效（本文 §7 只做增量行）。
- UX-P3 产物（连接单页流/开始对话一键化/空态 CTA/唤醒联动）全部保留；§5.1 为其升级路径而非替换删除。
- WebView 遥控（ZCode 工作区智能卡/remote-manage）与原生工作区分段并存分工（§4.1）。
- U-Aud/U1-U5 修复面（ErrorPresentation/falloff/ⓘ/删除确认/深色钉死）零回退。

---

## 附录 A：截图对照走查（证据：`acceptance/uxz-walkthrough/`，headless 模拟器实拍 2026-09-15，APK=main 当日构建含 P3 全量）

| 图 | 现状屏 | 对照 v4 基线 | 差距标注（元素号） |
|---|---|---|---|
| 01 | 对话 tab：置顶卡+provider 过滤 chips+归档开关+会话平铺行（真实 relay 数据 200 条） | 图① | 无工作区分组（E1-E3 缺）；行时间绝对式无相对人话（E3）；置顶卡与 v4 列表职责并存方案见 §4.1 |
| 02 | 会话详情：气泡流+未知/可以对话徽章+滑条+跳到最新 | 图⑤⑥ | **statusDetail 工程串直出「turn/end (seq 806)」**（词表漏网，Z3 收尾）；无计时器（E16）；无活动 pill（E19a）；无复制钮（E20a）；composer 非常驻（E21 缺） |
| 03 | 助手 tab：ProviderCard 五家+二态徽章+原因卡 | 图② | 助手页=能力披露面，v2 后保留（§5.1）；无 composer-first 动线（E4/E5 缺） |
| 04 | P3 开始对话面板：单输入框+开始/取消（placeholder「想让它先做什么？」） | 图② | 升级替换对象（§5.1）；无问候语（E4）/chips（E8）/模型入口（E10）/工作区选择器（E6） |
| 05 | 我的 tab：电脑卡（laurdesktop·在线·云端连接）+六入口+开发者折叠 | —（v4 无对应） | 合格保留；与 v2 无冲突 |
| 06 | 电脑页面管理：ZCode 工作区智能条目（已就绪 laurdesktop）+空态引导 | 图①旁证 | WebView 遥控入口现状；v4 列表的原生投影分工见 §4.1 |
| 07 | ZCode 工作区 WebView 实拍：**6 个工作区·30 个任务，DevHub 工作区展开=4 任务行（运行中/已完成 pill+相对时间）** | 图①（同源） | 规范基线活体证据；原生投影需达成的形态即此（E1/E2/E3 全要素在一张图内） |
| 08 | 连接帮助页（电脑那头 加载失败：请求的资源不存在） | — | R12/R13 错误态既有合格样本；证据链完整性收录 |

凭据核查：八张图零 token/零配对码/零指纹/零 URL 明文（07 标题栏为 App 自带中段省略）。
