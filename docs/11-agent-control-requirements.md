# DevHub Agent Control / Mobile 需求设计（docs/11）

> Phase 2/3 Agent Control / Mobile 设计，约束基线同 docs/00；migration/历史文档零改动。
> 本文是 AC 域的需求权威：功能目标 / 术语 / 五家 Agent 接入边界 / 桌面与手机页面需求 /
> 托盘后台 / NatPierce / 测试与交付需求 / 非目标。架构见 docs/12，数据库见 docs/13，
> API 见 docs/14，安全见 docs/15，批次计划见 docs/16。
> MCP 本期零改动（边界见 §3.3），docs/09 §10 计划的 4 个只读 tool 属遗留待办，不在 AC 范围。

---

## 1. 功能定位

Agent Control（AC）把 DevHub 从「开发环境控制平面」扩展为「**开发控制平面 + 本机 AI Agent
的统一监控与受限遥控面**」：

- DevHub 不在内部运行任何大模型（Phase 1 定位不变，docs/01 §1）：AC 只**观察**本机
  已安装的 AI Agent（Codex / Claude Code / Kimi Code / ZCode / DeepSeek Harness）产生的
  会话数据，并在能力真实验证存在时**受限注入**（回复 / 暂停 / 恢复）。
- 桌面侧：新增第 10 个视图 **Agents**，五家 provider 的健康、会话（9 值状态，对外展示
  用户锁定 7 态）、事件、
  脱敏摘要一站式可见。
- 移动侧：Electron Main 内嵌 **Remote Gateway**（本机回环默认），经 NatPierce 隧道
  （可选）连接 Android 手机（工程固定 `F:\Active_Project\DevHub\android`），
  实现「Agent 等待输入 → 手机通知 → 手机回复 → Agent 收到」的端到端闭环。
- 数据一律真实探测（约束 #23 无 mock）：取不到的实时态显示 `unknown` / `stale`
  （skills 先例「实时探测 + 缓存投影 + stale 标注，绝不猜实时态」；
  docker 先例「daemon down 是常态，结构化降级三态」），绝不伪造在线/成功。

## 2. 功能目标（8 条）

| # | 目标 | 验收口径 |
| --- | --- | --- |
| G1 | 五家 provider 统一接入：真实探测安装/版本/数据源，健康三态（ok / degraded / unavailable）+ unknown | `agents:providers` 返回真实健康与能力集 |
| G2 | 会话统一模型：原生 session ID 幂等入库，9 值状态（用户锁定 7 态：running / completed / failed / waiting_input / approval_required / paused / connection_lost + 辅助态 stopped / unknown），project 归一关联 | 会话列表真实反映本机会话 |
| G3 | 事件管线：7 类型事件先写 SQLite 再投递，sequence 单调，event_id 去重，未确认事件不删 | 断线重连后补发不丢不重 |
| G4 | 桌面 Agents 视图：provider 列表 / 会话 / 详情 / 消息（脱敏）/ 事件 / 诊断，loading/empty/error 三态强制 | 真实数据、无 mock |
| G5 | 受限控制：仅 managed/attached 且能力真实验证才暴露 reply；手机第一版仅 reply/pause/resume | 越权动作结构化拒绝 |
| G6 | Remote Gateway：Electron Main 内嵌 node:http + WS，默认 127.0.0.1 监听（端口可配），默认关闭远程面 | 未启用时零监听 |
| G7 | Android 端：配对、会话列表、事件通知、受限操作、设备管理；v1 无 FCM（WS 长连 + 本地通知） | 真机/模拟器构建与端到端可验 |
| G8 | 托盘常驻 + 开机自启：关窗不退出，监控持续；自启经 settings 显式开关 | 托盘退出 / 自启均真实生效 |

## 3. 术语表

| 术语 | 定义 |
| --- | --- |
| provider | 一类本机 AI Agent 的接入适配器（五家：codex / claude-code / kimi / zcode / deepseek；与 ApiHub adapterId `claude-cli` 分属不同命名域，不共用） |
| session | provider 的一个原生会话（Codex rollout / Claude 转录 / Kimi sessionDir / ZCode db.session 行）；以 (provider, native_id) 幂等 |
| session_mode | 会话的接入深度三态：managed（DevHub 托管启动，有输入通道）/ attached（外部启动但存在受支持输入通道）/ observed（纯观察，全禁控制） |
| event | 会话/provider 生命周期事件的统一投影（7 类型，见 docs/12 §6），先落库后投递 |
| command | 对会话的控制指令（reply / pause / resume），幂等键唯一 + expires_at 过期 |
| device | 已配对的远程设备（Android），以设备 Token 身份访问 Gateway；表名锁定 `remote_devices`（不复用 001 预留的 `devices` 表） |
| pairing | 桌面签发一次性短时效码 → 设备 claim 换 Token 的绑定流程 |
| NatPierce | 用户自备的第三方内网穿透/隧道工具，仅做 TCP 透传，不参与鉴权（docs/15 §8） |

## 4. Agent 接入范围（五家，逐家需求与验证边界）

以下「实测盘点」为 AC0 审计在本机确认的事实（路径/版本/数据源直接引用，实现批次以
同样的探测纪律复核，不重新考证）。

### 4.1 Codex（codex，本机 0.152.1）

| 项 | 需求 |
| --- | --- |
| 探测优先级 | ① `codex app-server`（stdio JSON-RPC，`--help` 已证实存在，另有 mcp-server/exec/agents/remote-control/queue 子命令）> ② `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` + `session_index.jsonl` 增量解析。**禁止窗口标题判态** |
| 可执行文件 | `C:\Users\sakuya\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe`，**不在 PATH**——发现规则 = bin 下取最新 hash 目录的 codex.exe，探测 `--version` 确认可执行 |
| 双向条件 | 仅当会话由 DevHub 经 spawnManaged 托管启动（app-server 握手成功）→ managed，可 reply/pause（协议能力以握手结果为准）；外部自启会话一律 observed |
| 降级规则 | app-server 起不来 / 协议不识别 / exe 未找到 → 降级 rollout jsonl 观察模式（observed），health=degraded + 结构化 health_detail；rollout 也读不到 → unavailable |
| 禁止事项 | 禁窗口标题判态；禁写 `~/.codex` 任何文件；未知子命令/协议字段不猜测（容忍并丢弃，计入解析失败统计） |

### 4.2 Claude Code（claude-code，本机 2.1.150，npm 全局）

| 项 | 需求 |
| --- | --- |
| 探测优先级 | ① `claude --version`（npm 全局）+ 官方 hooks 注册状态 > ② `~/.claude/projects/` 转录目录增量解析（实现批次以实机复核目录结构与 schema，解析纪律同 ZCode 防御条款） |
| 双向条件 | 仅当官方 hooks 已合并写入且回调打通（managed）才可回复；未写 hooks → observed。hooks 写入是**唯一**允许触碰的 provider 配置 |
| hooks 合并写入 | `~/.claude/settings.json` 当前无 hooks 键且 `env.ANTHROPIC_BASE_URL=http://127.0.0.1:15721` 是 ApiHub 代理写入目标——hooks 合并必须：写前备份（`.bak_<stamp>`）+ 提供恢复脚本/动作 + **只合并 hooks 子键，绝不覆盖其余任何键**（尤其 env.*，apihub 域与 AC 域共用该文件）；原子写（tmp + rename） |
| 降级规则 | hooks 不可用/被外部覆盖 → 降级转录观察（observed）；转录目录不可读 → unavailable + unknown 会话态 |
| 禁止事项 | 禁整文件覆写 settings.json；禁伪造「已接入」；hooks 与 ApiHub/env 的共写冲突必须在文档与 UI 双双声明（docs/16 风险清单） |

### 4.3 Kimi Code CLI（kimi，本机 0.36.0）

| 项 | 需求 |
| --- | --- |
| 探测优先级 | ① `~/.kimi-code/session_index.jsonl`（每行 `{sessionId, sessionDir, workDir}`）> ② `C:\Users\sakuya\.kimi-code\bin\kimi.exe` 进程/版本探测 |
| 双向条件 | DevHub 经 spawnManaged 托管启动的 kimi 会话（stdin 可写）→ managed，可 reply；外部自启会话 observed。**禁止仅凭进程退出判成功**——kimi.exe 进程消失 ≠ 会话失败，成功与否一律以会话文件终态为准 |
| 降级规则 | session_index 缺失/不可读 → 扫描 sessionDir 目录兜底；都不可得 → unavailable |
| 红线 | `~/.kimi-code/config.toml` 含**明文 api_key**——任何投影（IPC/Gateway/通知/日志/DB）只允许尾 4 位 + 长度（apihub `apiKeyTail` 同款），绝无全值（约束 #13 具体化，docs/15 §6） |
| 禁止事项 | 禁写 `~/.kimi-code`（config.toml 归 ApiHub kimi 适配器域，AC 零写入） |

### 4.4 ZCode（zcode，本机实测 161 sessions / 8295 messages）

| 项 | 需求 |
| --- | --- |
| 数据源 | `~/.zcode/cli/db/db.sqlite`（19 表，含 session / message / tool_usage（审批状态）/ sequence）；辅助 `~/.zcode/v2/tasks-index.sqlite`（workspace_path / task_id / title / task_status / provider） |
| 只读纪律 | **只读增量**：优先 readOnly 打开；不支持/被锁 → 复制 db + -wal + -shm 快照到临时目录后读快照。绝不以读写模式打开第三方库、绝不 checkpoint、绝不写 |
| 控制边界 | **首版全部 observed，无任何控制按钮**（母智能体裁决 4）；reply/pause/resume 一律不暴露 |
| 降级规则 | schema 防御：启动时按 PRAGMA table_info 白名单比对期望表/列，不匹配（ZCode 非公开 CLI，schema 可能变）→ provider 降级 unavailable + health_detail 说明，绝不猜测字段含义 |
| 禁止事项 | 禁 GUI 自动化；禁逆向 ZCode 协议；禁写 `~/.zcode` 任何文件 |

### 4.5 DeepSeek Harness（deepseek，骨架）

| 项 | 需求 |
| --- | --- |
| 范围 | 只做骨架 + 能力检测：安装目录（settings 键 `deepseekHarnessRoot` 已预留，本机 `D:\Apps\deepseek-harness`）存在性 / 本地版本文件 / 进程探测 |
| 显示规则 | 无法验证的能力一律显示「未接入」，绝不伪造状态、绝不做不可验证的投影 |
| 禁止事项 | 禁猜测其会话数据格式；禁在未验证前暴露任何控制能力 |

### 4.6 Grok（本期不做）

Grok CLI 1.0.5 本机存在但不在用户首批清单：本期不实现 provider（docs/12 §11 注记架构
兼容点——providers 目录 + providerRegistry 目录化，后续批次增补文件即可）。

## 5. 桌面 Agents 视图需求清单

| # | 需求 | 说明 |
| --- | --- | --- |
| D1 | Provider 列表 | 五家行卡：名称 / 版本 / 安装态 / 健康徽标（ok / degraded / unavailable / unknown）+ 健康原因 |
| D2 | 健康 | `agents:providers` 真实探测；每 provider 可单独重探；探测中 loading 态 |
| D3 | 会话列表（9 值状态，对外展示 7 用户态） | running / completed / failed / waiting_input / approval_required / paused / connection_lost（+ stopped / unknown 辅助态透明展示）；waiting_input（等文本输入）与 approval_required（等工具批准）高亮区分；connection_lost 显式标注（监控源失联）；stale 数据显式标注（绝不猜实时态） |
| D4 | 详情 | 单会话元数据 + 消息分页（脱敏投影）+ 能力集（mode + granted[]，未经真实验证的能力绝不显示为可用） |
| D5 | 事件 | 事件流（7 类型过滤可选），脱敏摘要，deliveryState 徽标 |
| D6 | 脱敏摘要 | 消息/事件/通知一律脱敏投影：密钥/Token/Cookie 尾 4 位 + 长度；完整上下文按需加载（docs/15 §6） |
| D7 | 能力 | 每 provider 显示接入深度（managed / attached / observed）与真实验证过的能力清单及验证依据 |
| D8 | 配对 | 「配对新设备」签发一次性码并展示（含 TTL 倒计时）；配对码明文只在签发瞬间展示 |
| D9 | NatPierce 状态 | Gateway 监听状态 / 端口 / 隧道配置提示；结构化降级（未启用 / 端口占用 / 隧道未配置） |
| D10 | 监控开关 | 总开关（settings `agents_monitor_enabled`）+ 每 provider enabled；关闭即停止监控管线 |
| D11 | 自启 | settings `login_autostart` 开关，真实落 app.setLoginItemSettings |
| D12 | 诊断 | `agents:diagnostics`：每家数据源可读性 / 控制通道状态（hooks / app-server / stdin）/ Gateway / 托盘 / 自启 |
| D13 | 设备撤销 | 已配对设备列表 + 撤销（CONFIRM_REQUIRED 两段式，撤销即拒 + 活跃连接断开） |
| D14 | 四态强制 | 视图与每个子区块 loading / empty / error 三态（约束 #24）+ 降级态（provider unavailable 结构化文案，约束 #26） |

## 6. 托盘与后台需求

- 关窗即退出（`src/main/index.ts:84-86` 现状 `window-all-closed → app.quit()`）改为
  **托盘常驻**：关窗 = 隐藏窗口，监控/Gateway 持续运行；托盘菜单含「显示主窗口 /
  监控开关（快捷）/ 退出」；退出前关闭 Gateway 与监控管线、释放 SQLite（WAL 落盘）。
- 仓库现无托盘图标资源、无 `app.setAppUserModelId`——Windows 通知需先设置
  AppUserModelID；托盘图标资源随 AC5 批次新增。
- 开机自启：`app.setLoginItemSettings`（Electron 44 Windows 可用），由 settings
  `login_autostart` 驱动，启动时应用。
- second-instance 既有逻辑（`focusExistingWindow`）复用并扩展：窗口隐藏时 show + focus。

## 7. Android 页面与后台行为需求

- 工程固定 `F:\Active_Project\DevHub\android`；Kotlin + Compose + Room + OkHttp +
  Keystore；第一版无 FCM（裁决 6）。
- 页面：配对页（输入一次性码）→ 设备页（本机身份/撤销自己）→ Agent/会话列表（9 值状态，
  对外展示 7 用户态，docs/12 §4）
  → 会话详情（脱敏消息分页）→ 事件通知（WS 长连 + 系统通知，仅脱敏摘要；
  通知触发 = session.waiting_input 输入等待类事件（waiting_input / approval_required
  两种 status 均通知）或 session.status_changed 且 to ∈ {completed, failed}）→
  操作（reply 文本输入 / pause / resume；仅当服务端返回的能力集允许时显示按钮）。
- 后台行为：前台服务（类型 dataSync 或按目标 API 要求声明）维持 WS；断线重连
  指数退避（docs/14 §B.4）；WS 断开期间不做轮询兜底——重连后以 sequence 增量同步 +
  未确认补发兜底（事件落库不删保证不丢，裁决 5）。
- Android 只经 REST + WS 访问 Gateway，绝不直连 SQLite/文件系统（与 renderer CSP 规避同构）。

## 8. NatPierce 需求

- NatPierce 是用户自备的第三方隧道工具：只做 TCP 透传（手机 → NatPierce 服务端 →
  本机 Gateway 端口），**不替代鉴权**；不开路由器端口。
- DevHub 侧仅提供：Gateway 状态展示、隧道连通性提示、端口配置（settings `gateway_port`）、
  远程面开关（settings `gateway_enabled`，默认关）。凭据只来自环境变量 / 密钥服务 /
  外置配置（不入仓库、不入 settings 表、不入日志，docs/15 §8）。

## 9. 测试需求清单（21 条，smoke/验收对照）

| # | 测试需求 |
| --- | --- |
| T1 | migration 004：fresh 库直接迁到 4；v3 库升级仅应用 004 且既有 19 表数据零改动（行数与内容断言） |
| T2 | migrate.ts 遗漏 case 4 时显式报错（负向用例，编译期/运行期护栏） |
| T3 | 白名单 55→68：step1 / step6 / s4-68 三处计数断言就地更新（s4-68 注明模式授权），ChannelContract 恰好覆盖 |
| T4 | 五家 provider 真实探测：本机安装态/版本/health 三态结构化，夹具化路径不污染真实 home |
| T5 | Codex rollout jsonl 增量解析：轮转（offset > size 重置重读）、截断、不完整 JSON 行缓冲、解析失败行计数 |
| T6 | Codex app-server：spawnManaged 托管握手成功 → managed + 能力集；握手失败 → observed 降级 |
| T7 | Claude hooks 合并写入（夹具 home）：备份存在 / 只动 hooks 键 / env.* 零改动 / 恢复动作还原原文件 |
| T8 | Claude hooks 事件回调 → waiting_input 事件落库（先写 DB 后投递语义可断言） |
| T9 | Kimi session_index.jsonl 解析 + 托管 reply 环回（stdin 注入 → 会话文件出现回复） |
| T10 | Kimi 红线：任何 IPC/Gateway/通知/日志/DB 投影 JSON 序列化后不含 config.toml key 全值（假 key 断言） |
| T11 | ZCode 只读：探测前后第三方库文件 mtime/内容 hash 不变；schema 不匹配 → 结构化降级不崩溃 |
| T12 | DeepSeek 骨架：未接入文案显式，无任何伪造状态/能力 |
| T13 | 事件 sequence 单调递增 + event_id 幂等（同源重放不重复入库） |
| T14 | 未确认事件不删：设备断连期间产生的事件在重连 sync 后全量补发 |
| T15 | 配对全流程：create → claim → 码即失效；过期码 / 重复用码 / 超限流均结构化拒绝 |
| T16 | Token：校验失败 401；撤销后旧 Token 立即拒绝且活跃 WS 断开 |
| T17 | 防重放：过期时间戳 / 重复 nonce 拒绝；鉴权失败限流触发 429 |
| T18 | 命令幂等：同 idempotency_key 重试返回原结果；同 key 异 payload 冲突拒绝；expires_at 过期拒绝 |
| T19 | 授权矩阵：observed 全禁 / attached 无 pause / 能力未验证 → AGENT_CAPABILITY_MISSING |
| T20 | 托盘常驻：关窗进程存活 + 托盘退出真实收尾；自启开关生效；second-instance 聚焦恢复 |
| T21 | Android 构建 + 端到端：至少一个真实 Agent waiting_input → 手机通知 → 手机回复 → Agent 收到（NatPierce 隧道可选，回环直连亦可验证） |

## 10. 交付需求

- 每批四门禁（`npx tsc --noEmit` / `node scripts/smoke.mjs` / `electron-vite build` /
  `mcp-acceptance` 22/22）全绿；Android 批次加构建与测试（docs/16 §2）。
- 文档同步：实现与本文偏差必须如实上报（约束 #6/#28），docs/11–16 与代码一致。
- 终验收（AC9）：截图、SHA-256 清单、known-limitations、最终报告。
- 阻塞显式记录：缺凭据/真机/接口时完成可测部分并记录明确阻塞点（docs/16 §4）。

## 11. 非目标清单（明确不做）

| # | 非目标 |
| --- | --- |
| N1 | 不在 DevHub 内运行/集成任何大模型（延续 docs/01 §3） |
| N2 | 禁独立项目：Android 工程必须位于 `F:\Active_Project\DevHub\android`，不另建仓库 |
| N3 | 禁微信系推送：第一版无 FCM、无任何第三方推送 SDK（WS 长连 + 本地通知） |
| N4 | 禁 MCP 混入：MCP 本期零改动；远程控制能力绝不注册为 MCP tool（docs/09 §10 的 4 个只读 tool 为遗留待办，不在 AC 范围） |
| N5 | 禁任意远程命令执行：设备只能触发 reply/pause/resume 三种会话动作，不存在 shell/exec/文件通道 |
| N6 | 不做 Grok provider（本期）、不做 iOS/鸿蒙、不做多用户/账号体系 |
| N7 | 不复用 001 预留表 `devices` / `mcp_servers`（AC 设备表锁定新表 `remote_devices`；skills/skill_agents 已被 Skills 域占用，AC 实体全新建表） |
