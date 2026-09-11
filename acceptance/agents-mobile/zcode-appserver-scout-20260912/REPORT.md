# Z1 侦察报告：zcode CLI 托管可行性（app-server 协议 + 无头面）

- 批次：Z1 scout / 分支 `agent/zcode-appserver-scout`（基线 main c32f526）
- 日期：2026-09-11；对象：ZCode 桌面 3.11.2 内嵌 CLI `zcode.cjs` v0.16.5（win32-x64）
- 侦查方式：静态（反混淆 grep 12.6MB bundle）+ 最小活体（3 次协议探测，**零推理任务**）+ 1 次无头尝试（配额 1/2）
- 红线自查：令牌三零合规（证据全量敏感串扫描通过，titles masked，未读取任何凭据文件内容）；探测进程用毕即杀（提交前无 zcode.cjs 残留进程）；未改任何产品代码与用户全局配置。

## 结论（四问四答）

### Q1 app-server 协议形态
**不是 JSON-RPC 2.0，是自定义 "ZCode Protocol" v1**（ndjson over stdio）。

- 帧格式（zod strict，服务端逐行校验，非法帧回 `-32600` id="invalid-message"）：
  - 请求 `{id: string|int, method, params?, trace?}` — **无 `jsonrpc` 字段**，`trace` 为可选分布式追踪四字段
  - 通知 `{method, params?, trace?}`；响应 `{id, result}`；错误响应 `{id, error:{code,message,data?}}`
- **无 initialize/hello 握手**：方法总表（50+ 方法）里不存在 initialize；活体验证首帧直接 `session/list` 立即应答（run1）。
- 错误码：-32601 method not found（活体验证）/-32700 parse error（id="parse-error"）/-32600/-32603 internal/-32004 sessionUnavailable/-32010 同会话并发 prompt/-32022 客户端请求超时/-32031 restore 告警。
- 生命周期（T2 核心路径）：
  - `session/create` `{workspace:{workspacePath,workspaceKey}, mode?, model?, runtimeModel?, persistence?, toolAllowlist/toolDenylist?, importedHistory?}` → result `{protocol:{name:"ZCode Protocol",version:1}, session{sessionId,mode,model,workspace,status}, projection, runtime{eventSeq,stateRevision}, settings, slashCommands, todos}`（run3 活体全量捕获）
  - `session/send` `{sessionId, content, attachments?, inputId?, queryId?, expectedRevision?}`（并发发送拒 -32010）；`session/stop` **旁路处理队列**（可中断进行中的 turn，代码级确认）
  - `session/subscribe` `{sessionId, deliveryKind, afterSeq?, includeSnapshot?}` / `session/events`（拉补历史）/ `session/close`
- 事件推送：服务端通知 `session/event`（params 含 `seq,eventId,sessionId,turnId,deliveryKind,payload`）。payload.type 枚举（静态全量）：session.created/resumed/updated/titleUpdated/closed；turn.started/steerQueued/steerDrained/**completed**（resultType: success|cancelled|error_max_turns|error_max_budget|error_during_execution|error_max_tool_calls）/failed；message.upserted/removed；part.started/delta/upserted/removed；model.streaming；tool.updated（scheduled/started/progress/result/error/batch/raw）；permission.requested/resolved；userInput.requested/resolved；checkpoint.created；rewind.triggered；streamRecovery.updated。另有 `state.updated` {scope: server|workspace|session, revision, patch}。deliveryKind 枚举：`desktop-continuous` | `web-remote-replayable`。
- **服务端→客户端反向请求**（id 命名空间 `server-N`，codex 没有的形态，活体观察到 2 种）：
  - `session/requestRuntimePreferences` `{sessionId, scope:"runtime-materialization"}` → 期望 `{nativeSearchEnhancementsEnabled, memoryEnabled, askUserQuestionAutoResolutionEnabled, modelContextBudgetStrategy}`；15s 超时（-32022）；客户端回 -32601/-32020 时服务端回退默认值。**session/create 期间会发出并等待**（run2 实测不答则 create 挂起）。
  - `interaction/requestOfficialMcpAuthHeaders`（run1 实测，官方 MCP 认证头）；方法表还有 interaction/requestPermission、requestUserInput、requestProviderRuntimeHeaders、browserList/Execute。
  - 服务端通知：`process/mcpTelemetry`、`plugins/operationProgress`、`process/resourceSample`。
- 传输层（X3e "ZCodeProtocolNdjsonConnection"）：双向逐行 JSON；stdin EOF → 排空在途处理后干净退出 **exit 0**（活体验证）；启动到首帧应答 ≈2s（后台 MCP 引导不阻塞收帧）。
- **模型配置前置条件（关键）**：独立 CLI 必须自行提供模型 provider 配置（`createModelAdapter` 读 `config.model`，缺失抛 `model_config_missing`）；桌面版是注入自己的 modelConfig（sourceTitle "electron"）。**env 引导已活体验证**：`ZCODE_MODEL="provider/model"` + `ZCODE_BASE_URL` + `ZCODE_API_KEY`（+`<PROVIDER>_API_KEY`），dummy 值跑通 session/create（run3，零网络请求）。桌面登录（~/.zcode/v2/credentials.json）**不**自动供 CLI 使用。
- 其他可用 env：`ZCODE_SESSION_DB_PATH`（重定向会话库）、`ZCODE_STORAGE_DIR`、`ZCODE_HTTP_PROXY/NO_PROXY/AGENT_CA_CERT/TIMEOUT`、`ZCODE_LOG_FORMAT`、`ZCODE_MAX_TOOL_CONCURRENCY`。

### Q2 无头单发
`node zcode.cjs --prompt "Reply with exactly: Z1_OK" --cwd <tmp>` → **exit 1，0.92s，stdout 空**，stderr 单行：`Model config is missing. Create C:\Users\sakuya\.zcode\cli\config.json with an explicit model provider before running ZCode.`

- 失败发生在配置加载期，**未触模型、零 token 消耗**。推理配额实耗 1/2。
- 诚实记录：桌面已装已登录的机器上，独立 CLI 无头面**不可直接用**；`--settings <path>` 在帮助文本中宣称但 strict parseArgs 直接拒绝（v0.16.5 文档/实现不一致，实测 `Unknown option '--settings'`）。
- 按红线"失败如实不硬试"，第二次推理尝试未发起：解法需写用户全局 config.json 的 model 段（越出只读侦察边界）或 env 注入真 key（不读取凭据文件，令牌红线）。env 引导的可行性已在协议层以 dummy 值验证（run3）。

### Q3 会话落盘与转录面可见性
- CLI 会话写 `~/.zcode/cli/db/db.sqlite`（WAL，含 -shm/-wal），与桌面**同库**：活体交叉证明（run1 的 `session/list` 读到了桌面创建的会话）；per-session 侧车：`cli/rollout/model-io-sess_*.jsonl`、`cli/exec/sess_*/`、`cli/artifacts/sess_*/`、`cli/log/zcode-YYYY-MM-DD.jsonl`。
- `~/.zcode/v2` 在全部 CLI 探测前后**零结构变化**（仅既有状态文件 mtime 漂移，其中部分来自并行运行的桌面应用本身；无增删文件，凭据文件未触碰）。
- **可见性判定：可读**。现有 zcodeProvider 读的正是 `~/.zcode/cli/db/db.sqlite`（src/main/services/agentControl/providers/zcodeProvider.ts L358，`options.zcodeDbPath` 可覆盖）→ CLI 托管会话对现有九方法转录面天然可见。如需隔离，可用 `ZCODE_SESSION_DB_PATH` + provider 的 zcodeDbPath 注入成对重定向（已具备配置钩子）。

### Q4 发现面与运行面
- 发现：`%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`（12,615,227 字节，**固定文件名**，更新原位替换 → 路径稳定）。注册表 `HKCU\...\Uninstall\{268ce9e6-a30b-5890-ad18-d4b3ebba5377}`：DisplayName "ZCode 3.11.2"、UninstallString（无 InstallLocation 值；可解析 UninstallString 或用默认路径）。**注意桌面 3.x 与 CLI 0.x 版本线不相关**，CLI 版本仅能 `node zcode.cjs -v` 探得。
- 无 PATH shim，需显式 `node` 调起。node 下限 ≥22.5（bundle 用 `node:sqlite`；parseArgs 需 18.3+）；本机 v24.15.0 实测通过。bundle 自包含（meta: source `apps/zcode-cli/packages/cli/dist/zcode.cjs`，runtime electron-node，platform win32-x64 单平台）。
- `doctor`：exit 0，输出 `version/node/platform/default artifact`（verbose 加 execPath/cwd），约 0.5s —— **可当 probeHealth**（轻探针）。更深的探针可用 app-server `session/list` 往返（≈2s 就绪）验证协议面。

## T2 可行性判定：**GO（有条件）**

协议、传输、生命周期、env 配置引导、转录可见性五要素全部经活体/静态证实，codex 托管模式可复刻。条件=T2 必须处理下列与 codexProvider（src/main/services/agentControl/providers/codexProvider.ts L515-700 spawnRpcConnection/withAppServer 模式）的差异点：

| # | codex 现状 | zcode 差异 | T2 处置 |
|---|---|---|---|
| 1 | 帧带 `"jsonrpc":"2.0"` | 帧无 jsonrpc；id 为 string\|int；错误响应 id 可为 "parse-error" 等字符串 | spawnRpcConnection 去掉 jsonrpc 字段；pending 表键放宽为 string\|number |
| 2 | initialize 握手（二次握手回 -32600） | **无握手** | 探针改为 `session/list` 轻往返或 doctor；无 "Already initialized" 顾虑 |
| 3 | 无服务端→客户端请求 | **必须应答** `session/requestRuntimePreferences` 等（不答则 create 挂起 15s） | 加 server-request 分发器：runtimePreferences 回默认四字段；interaction/requestPermission、requestUserInput 路由到 UI 或显式决策；未实现的 interaction/* 回 -32601（服务端有兼容回退） |
| 4 | 靠读 rollout jsonl 投影 | `session/subscribe`（deliveryKind 必填，建议 `desktop-continuous`）+ `session/event`（带 seq，支持 afterSeq 补拉） | 流式投影走事件；现有 db.sqlite 转录面继续保留 |
| 5 | 复用自身 auth | spawn 需注入 `ZCODE_MODEL`/`ZCODE_BASE_URL`/`ZCODE_API_KEY`（活体验证） | 从 DevHub 自身配置注入 env；绝不读 ~/.zcode/v2/credentials.json |
| 6 | idle/lifetime 由 spawnManaged 管 | stdin EOF → 干净 exit 0（活体验证） | 与 codex 相同的"关 stdin 即杀"映射，零改动 |
| 7 | 中断=即杀+惰性重生 | `session/stop` 旁路队列可软中断 | 可先发 stop，超时再杀进程 |

建议实现路径（T2）：
1. clone spawnRpcConnection（差异 1/3）；`['app-server', `--cwd=${dir}`]` + env 注入（差异 5）。
2. probe：doctor 快探（<1s）+ 可选 session/list 深探；caps.mode='managed' 门保持数据驱动。
3. 托管 turn：`session/create(persistence:'immediate')` → `session/subscribe` → `session/send({inputId})` → 消费 `session/event` 至 `turn.completed(resultType)` → `session/close`。
4. 中断：`session/stop`（旁路队列）→ 兜底 killTree。
5. 转录：零额外工作（同库）；如选隔离则成对配 `ZCODE_SESSION_DB_PATH` 与 provider `zcodeDbPath`。

风险与限制：
- CLI 0.x 迭代快，方法/params 为 zod strict，schema 漂移会静默破（建议 probe 覆盖核心方法存在性）。
- 协议事实源于反混淆静态分析+3 次最小活体；`interaction/requestPermission` 的 UX 决策（自动拒绝 vs 弹 UI）未验证，T2 需拍板。
- 本机无头 -p 因 model_config_missing 不可用属预期（env 注入后不受影响，但未做端到端推理验证——受配额与凭据红线约束，留给 T2 首个验收项）。

## 证据清单（本目录）
- `probe/appserver-live-probe.mjs` + `appserver-live-probe-run1.log`：零握手 session/list + workspace/readState + 未知方法错误 + 服务端反向请求首证
- `probe/appserver-lifecycle-probe.mjs` + `run2.log`：应答 runtimePreferences；create 撞 model_config_missing
- `run3-envconfig.log`：ZCODE_MODEL/ZCODE_BASE_URL/ZCODE_API_KEY（dummy）引导下 create 全量成功响应（含 protocol v1 回显）
- `probe/headless-z1ok-stdout.txt`（空）+ `headless-z1ok-stderr.txt`：Q2 失败原文
- `probe/doctor-output.txt`、`probe/help-output.txt`：Q4 探针与帮助文本（--settings 宣称证据）
- `zcode-{v2,cli}-{before,after}.txt` + `zcode-{v2,cli}-diff.txt`：Q3 落盘 diff（仅名称/大小/mtime，未复制任何文件内容）
