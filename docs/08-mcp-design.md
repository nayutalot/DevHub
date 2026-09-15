# DevHub MCP Server 设计（Phase 2 / M 批次）

> 本文档是 MCP 集成 M2（实现）/ M3（stdio 验收与接入文档）批次的**权威实现依据**。
> M1 批次交付设计本身、SDK 依赖与跨进程 DB 路径对齐（docs/02 §1.1）。
> 开工前必读 docs/00-execution-constraints.md（28 条合同）；本文档与其冲突时以合同为准并上报。

## 0. 目标与范围

外部 AI（ZCode / Claude Code / Codex 等 MCP Client）通过 MCP 协议读取 DevHub 对开发环境的
真实认知。**本期（M1–M3）只读**：12 个 tools 全部 READ_ONLY，不做任何修改系统状态的能力。

- 本期交付：MCP Server（stdio transport，独立 Node 进程）、12 tools、6 resources、4 prompts、
  权限模型框架、测试计划落地。
- 本期不做：SAFE / CONFIRM_REQUIRED 级 tools（Phase B）、HTTP transport、写库类操作类 tools、
  任何万能命令执行接口（见 §9.4 设计红线）。

---

## 1. 总体架构

```
MCP Client（ZCode / Claude Code / Codex，宿主 AI）
      │  stdio（JSON-RPC 2.0，stdout=协议通道 / stderr=日志）
      ▼
DevHub MCP Server（独立 Node 进程：node scripts/run-mcp.mjs）
  src/mcp/
   ├─ server.ts        McpServer 组装：注册 12 tools / 6 resources / 4 prompts
   ├─ permissions.ts   权限分类表 + dispatch 前统一校验（§9）
   ├─ transport.ts     DevhubTransport 抽象 + StdioTransport（§11）
   ├─ projection.ts    输出红线（截断 / 路径归一化 / project:'unknown' 规整）（§10）
   ├─ resources.ts     6 个 resource 的 Markdown 渲染（§7）
   └─ prompts.ts       4 个 prompt 指令文本（§8）
      │  直接 import（同仓库同进程内函数调用，非 IPC）
      ▼
Service Layer（src/main/services/* —— 与 Electron 主进程复用同一层，约束 #16/#20）
      │
      ├─ adapters/*（windows / wsl / git / docker / fs —— 只读探测，约束 #19）
      └─ db/index.ts → getDatabase() → <同一下 SQLite 文件>（WAL + busy_timeout=5000）
                                          ▲
Electron 主进程（App 未运行不影响 MCP）────┘  共享同一 DB 文件（§2）
```

**调用铁律（不可违反）**：

1. MCP → Service Layer → Adapter / DB，单向分层，与 docs/02 §1 的主进程分层完全一致。
2. **MCP 进程禁止直接 spawn**：任何系统命令必须经 `src/main/core/exec.ts`（约束 #7），
   即只允许 Service → Adapter → exec 路径。
3. **MCP 进程禁止直接 SQLite**：必须经 `src/main/db/index.ts` 的 `getDatabase()` 单例；
   禁止在 MCP 模块里另行 `new DatabaseSync(...)` 绕过 paths / migration。
4. **MCP 禁止直接调 Adapter**：探测编排（归因、doctor、降级汇总）只在 Service 层。
5. MCP 不与 Renderer 交互、不嵌入 Electron、不依赖 Electron 运行（App 未启动时 MCP 照常工作）。
6. MCP 不经 IPC gateway（`devhub:invoke` 是 Renderer 专用通道，MCP 是另一类客户端，
   走进程内 Service 直调，白名单等价物是 §6 的 tool 注册表）。

### 1.1 与 21 条 IPC channel 的关系

MCP tools 是 Service 层能力的**只读子集**投影，不是 IPC channel 的镜像。本期不暴露：
`scan:start / scan:status / scan:cancel`（写库型扫描编排）、`projects:add / update / remove / rescan`、
`projects:open*`（Phase B SAFE 候选）、`settings:get / set`、`services:refresh`（写库；
其能力经由 detect / dashboard 的既有 service 路径间接覆盖环境与端口数据的新鲜度）。

---

## 2. 共享 SQLite：多进程并发模型

- MCP 进程与 Electron 主进程打开**同一个** `devhub.db`（paths 四级回落对齐，docs/02 §1.1：
  纯 Node 进程第 3 级回落指向 Electron userData 同目录）。
- 连接参数沿用 `src/main/db/connection.ts`：`PRAGMA journal_mode = WAL` +
  `PRAGMA foreign_keys = ON` + `PRAGMA busy_timeout = 5000`。
- WAL 语义：**多进程并发读 + 单写者**。读不阻塞写、写不阻塞读；两个进程同时写时，
  后到者在 `busy_timeout=5000` 内排队等待，超时返回 `SQLITE_BUSY`（折叠为 `DB_ERROR`）。
- 本期 MCP 侧唯一的写路径是 `devhub.environment.detect`（upsert environments /
  environment_tools，短事务），与 Electron 侧写扫描并发冲突概率低，busy_timeout 足以吸收；
  M2 不引入新的写事务形态。
- `node:sqlite DatabaseSync` 是同步 API：MCP tools handler 内的长探测（exec）本来就是异步的，
  写库瞬间同步完成、事务短小，不会长时间持锁（现有 Service 写路径即如此，无需改造）。
- 两个进程各自的 `getDatabase()` 单例互不可见（不同进程），不存在跨进程句柄共享问题。

---

## 3. 进程入口与启动（scripts/run-mcp.mjs）

- 入口：`node scripts/run-mcp.mjs`（MCP Client 配置里的 command/args 即此）。
- 纯 Node 加载 TS 源码：与 smoke 相同机制 —— 系统 Node ≥ 23.6 原生类型剥离
  （实测开发机 Node v24.15.0）直接 `import '../src/mcp/server.ts'`。不引入 tsx/ts-node。
- 环境变量：
  - `DEVHUB_HOME`：可选覆盖数据目录（便携 / 测试模式），原样透传给 paths.ts 四级回落；
  - `DEVHUB_LOG_LEVEL`：沿用 logger 阈值。
- **stdout 纪律**：stdio transport 下 stdout 是 JSON-RPC 专用通道。`src/main/core/logger.ts`
  目前把 info/debug 镜像到 `console.log`（stdout）——**M2 必办**：MCP 进程入口设置
  `DEVHUB_MCP_STDIO=1` 后 logger 的 console 镜像全部改走 stderr（logger.ts 增加一个开关分支，
  文件日志行为不变）。违反此条会直接损坏协议流，M3 验收 A01 有对应断言。
- 退出：stdin 关闭（Client 断开）→ server 正常收尾 → 进程退出码 0。

## 4. Service Layer 复用方式

- MCP 直接 `import` 现有 Service 函数（environmentService / projectService / servicesService /
  dashboardService 与既有代码零改动复用；dashboardSummary 明令**不得另算一套**）。
- 缺口按最小增量补齐（全部在 Service 层，不改表结构、不改 21 channel IPC contract）：
  1. **新增** `src/main/services/dockerService.ts`：`status()` 包 adapter.dockerInfo；
     `containers()` 包 adapter.listContainers + matchProjectForContainer 归因投影；
  2. **新增** `src/main/services/wslService.ts`：`status()` 包 adapter wslStatus；
     `distributions()` 见 §6.10 数据源分层；
  3. **新增** `src/main/services/gitService.ts`：`status()` 见 §6.11
     （配 adapters/git.ts 增补只读的 `gitStatusDetailed()`：porcelain 行分类出
     modified / untracked 计数）；
  4. **新增** `projectService.listMcpSummaries()`：projects.list 的增强投影（§6.3）。
- 现有 `ProjectSummary` / `ChannelContract` 等 shared types 不因 MCP 改动（避免波及
  Renderer contract）；MCP 专属输出形态定义在 `src/mcp/` 内。

---

## 5. Tool 命名规则与决策树

**优先点分名**（按用户规格）：`devhub.environment.detect`。

决策树（M2 落地时执行）：

1. 注册点分名。**已实测**：`@modelcontextprotocol/sdk@1.30.0` 的 `registerTool` +
   `InMemoryTransport` 往返（client.listTools / client.callTool）接受点分名（M1 验证记录，§14）。
2. 若 M2/M3 中出现任一环节（SDK 版本升级、协议 schema 校验、特定 MCP Client 的
   client 端白名单 `^[a-zA-Z0-9_-]{1,128}$`）拒绝点分名：
   - 整体回退为下划线命名：`devhub_environment_detect` 等 12 个一一对应；
   - 在本文档 §15 决策记录追加偏离条目（何时、被谁拒绝、回退后名称对照表）；
   - 回退必须是全量一致的（不允许点分与下划线混用）。
3. 名称前缀 `devhub.` / `devhub_` 恒定保留，避免与其他 MCP server 撞名。

---

## 6. Tools 注册表（12 个，本期全部 READ_ONLY）

通用约定：

- 每个 tool 的入参用 zod schema 声明（`registerTool` 的 `inputSchema` raw shape，SDK 自动校验），
  全部 `.strict()` 拒绝未知键；
- 输出经 `projection.ts` 过红线（§10）后以 `content: [{ type: 'text', text: <JSON 字符串> }]`
  返回（M3 验收按 JSON 解析；SDK `outputSchema`/`structuredContent` 为可选增强，不作验收项）；
- 「降级行为」= 探测对象不可用时的结构化返回，**不是** tool 调用失败（`isError` 只用于
  真正的领域错误，见 §10.4）。

### 6.1 devhub.environment.detect

| 项 | 内容 |
| --- | --- |
| 映射 | `environmentService.detectEnvironment()` |
| 入参 | `{}` |
| 出参 | `{ environments: [{ id, name, kind: 'windows'\|'wsl', osVersion?, detectedAt, tools: [{ tool, version?, path?, state: 'installed'\|'missing'\|'error', rawVersion? }] }] }` |
| 降级 | 单项工具探测失败 → 该工具行 `state:'missing'/'error'`；WSL 不可用 → 仅返回 windows 环境；daemon 不可达 → `tools` 中 docker 行如实反映。不抛错 |
| 说明 | **写库立场声明**：detect 会同步 `environments` / `environment_tools`（upsert 全部本轮条目，并删除本轮快照中未出现的旧行 —— 快照语义，M3 修复：纯 upsert 会残留降级轮次的 NULL-path missing 幽灵行；并登记 resources 节点）——这是 DevHub **自身状态持久化**（写自己的业务库），不属于"修改系统环境"；底层探测（where.exe / wsl.exe / docker version 等）对操作系统零修改。因此本 tool 定级 READ_ONLY 是成立的，与 docs/00 约束 #19/#20 不冲突 |

### 6.2 devhub.environment.doctor

| 项 | 内容 |
| --- | --- |
| 映射 | `environmentService.runDoctor()` |
| 入参 | `{}` |
| 出参 | `{ checks: [{ id, severity: 'info'\|'warning'\|'error', title, detail?, suggestion? }] }` |
| 降级 | 全部规则基于实时快照真实数据；Docker daemon 不可达 / WSL 缺失本身输出为 warning/info 检查项而非错误；不写库 |

### 6.3 devhub.projects.list

| 项 | 内容 |
| --- | --- |
| 映射 | M2 新增 `projectService.listMcpSummaries()`（增强投影，不改表、不改 `ProjectSummary`/IPC contract） |
| 入参 | `{}` |
| 出参 | `McpProjectSummary[]`：`{ id, name, slug, winPath?, wslPath?, runtimeHint?, environment: { id, name } \| null, git: { hasGit, branch?, ahead?, behind?, dirtyCount, lastScanAt? }, docker: { containersTotal, containersRunning }, lastOpenedAt?, updatedAt }` |
| 投影来源 | 基线 = `listProjects()`；`git` = repositories 联查（branch/ahead/behind/is_dirty，`lastScanAt` = `repositories.last_status_at`，无仓库时缺省）；`docker` = containers 按 `project_id` 联查计数（running/total）；`environment` = docs/05 `project located_in environment` 边反查 |
| 降级 | 单项目任一增强字段缺失（无仓库/无容器/无边）→ 字段取空值或缺省，不阻塞整表返回 |

### 6.4 devhub.projects.get

| 项 | 内容 |
| --- | --- |
| 映射 | `projectService.getProject(projectId)` |
| 入参 | `{ projectId: number }`（正整数） |
| 出参 | `ProjectDetail` 全量（win/wsl path、repositories、containers、services、environments）+ 三个显式占位字段：`skills: { notAvailable: true, reason: 'TABLE_EXISTS_NO_SERVICE' }`、`mcpServers: { notAvailable: true, reason: 'TABLE_EXISTS_NO_SERVICE' }`、`archives: { notAvailable: true, reason: 'TABLE_EXISTS_NO_SERVICE' }` —— 三张表 001 已建但无 service 实现（docs/03 §2），**不猜测、不返回空数组冒充实现** |
| 降级 | projectId 不存在 → ServiceError `NOT_FOUND` → `isError:true` + 结构化 `{ code:'NOT_FOUND' }`，server 不崩 |

### 6.5 devhub.services.list

| 项 | 内容 |
| --- | --- |
| 映射 | `servicesService.listServices(filter)` |
| 入参 | `{ port?: number, projectId?: number }`（可选过滤；与 service 层既有 filter 对齐） |
| 出参 | `ServiceRow[]`：`{ id, port, protocol, pid?, processName?, commandLine?, workingDir?, origin: 'windows'\|'wsl'\|'docker', projectId?, projectName? }` |
| 降级 | 返回 DB 最近快照（按 last_seen 倒序）；无记录 → 空数组。数据新鲜度语义见 6.6 |

### 6.6 devhub.services.inspect

| 项 | 内容 |
| --- | --- |
| 映射 | `servicesService.findByPort(port)` |
| 入参 | `{ port: number }`（1–65535） |
| 出参 | `{ port, attributionChain: 'port→pid→process→origin→project', entries: [{ port, pid?, processName?, commandLine?, origin, projectId?, projectName?, wslDistro? }], resolvedProject: string, snapshotAt: number \| null, note? }` |
| 归因铁律 | **归因不到必须显式 `"project": "unknown"`（`resolvedProject` 同理），禁止猜测。** Service 层 `projectId` 缺省即归因失败；MCP 投影层把 `undefined → 'unknown'`（`projection.ts` 统一规整），绝不就近挑一个项目填充 |
| 数据时效 | 查询的是**最近一次 services 快照**（`snapshotAt` = 命中行的 max(lastSeenAt)）；空结果附 `note: 'no record in last services snapshot'` 提示时效。`refresh`（触发实时探测+落库）参数列为 Phase B 候选，本期不实现（backlog） |

### 6.7 devhub.docker.status

| 项 | 内容 |
| --- | --- |
| 映射 | M2 新增 `dockerService.status()`（包 `adapter.dockerInfo()`） |
| 入参 | `{}` |
| 出参 | `{ available: boolean, cliAvailable: boolean, daemonAvailable: boolean, clientVersion?, serverVersion?, reason?, containers: [] }`；`available = cliAvailable && daemonAvailable` |
| 降级 | **daemon 不可用是常态而非异常（docs/02 §4）**：返回 `{ available:false, reason, containers: [] }` 结构化降级，HTTP 语义上仍是成功响应，**不得让 MCP request 失败**（不置 isError） |

### 6.8 devhub.docker.containers

| 项 | 内容 |
| --- | --- |
| 映射 | M2 新增 `dockerService.containers()`（`adapter.listContainers()` + `matchProjectForContainer` 归因投影） |
| 入参 | `{}` |
| 出参 | `{ available: boolean, reason?, containers: [{ dockerId, name, image?, state?, ports: [{ host, container, proto }], project: string }] }`；`project` 为归因到的项目名，归因不到 → `'unknown'` |
| 降级 | daemon 不可用 → `{ available:false, reason, containers: [] }`，与 6.7 同款结构化降级 |

### 6.9 devhub.wsl.status

| 项 | 内容 |
| --- | --- |
| 映射 | M2 新增 `wslService.status()`（包 adapter `wslStatus`） |
| 入参 | `{}` |
| 出参 | `{ available: boolean, distros: string[], detail? }` |
| 降级 | 未安装/不可用 → `{ available:false, detail }`，结构化返回不失败 |

### 6.10 devhub.wsl.distributions

| 项 | 内容 |
| --- | --- |
| 映射 | M2 新增 `wslService.distributions()` |
| 入参 | `{}` |
| 出参 | `{ available: boolean, reason?, distributions: [{ name, version: '1'\|'2', state, isDefault?, tools: [{ tool, version?, path?, state }], snapshotAt? }], toolSnapshot: 'available'\|'missing', hint? }` |
| 数据源分层 | 发行版 `name/version/state/isDefault` 是易变运行时状态，DB 未落库（docs/03 environments 表无此列）→ **实时** `adapter.listDistros()`；`tools` 工具摘要与 `snapshotAt` 来自 **DB 最近 detect 快照**（`environments` kind='wsl' 行 + `environment_tools` 联查，按任务规格）。两者按 `wsl:<name>` 命名对齐 |
| 降级 | WSL 不可用 → `{ available:false, reason, distributions: [] }`；从未 detect 过 → `toolSnapshot:'missing'` + `hint: 'run devhub.environment.detect to build the tool snapshot'`（运行时状态仍如实给出） |

### 6.11 devhub.git.status

| 项 | 内容 |
| --- | --- |
| 映射 | M2 新增 `gitService.status(payload)`；adapters/git.ts 增补只读 `gitStatusDetailed()`（`git status --porcelain=v1 --branch` 逐行分类：`??` 行 → untracked，其余 → modified；分支行解析复用现有 parseBranchLine 语义）；remote/head 沿用 `gitRemote`/`gitHead` best-effort。全部命令经 exec 内核参数数组（约束 #7/#8） |
| 入参 | `{ projectId: number, path?: string }` |
| 出参 | `{ projectId, project: string, path: string, repository?: { branch, upstream?, ahead, behind, headSha?, remoteUrl? }, workingTree: { clean: boolean, modifiedCount: number, untrackedCount: number }, notAGitRepository?: true, checkedAt: number }` |
| 白名单 | **path 可选且必须命中已知项目 winPath 白名单**：`path` 经路径规范化（§10.3）后必须与 `projects` 表任一 `win_path` 完全相等，否则 `BAD_PAYLOAD` 拒绝；**禁止任意路径探测**。缺省 path → 该项目 winPath。projectId 必须存在（NOT_FOUND） |
| 降级 | 非 git 仓库（adapter 返回 null）→ 显式 `{ notAGitRepository: true, ... }`，不是错误；git 缺失/超时 → 结构化 `EXEC_FAILED`/`EXEC_TIMEOUT` isError |

### 6.12 devhub.dashboard.summary

| 项 | 内容 |
| --- | --- |
| 映射 | `dashboardService.dashboardSummary()` **直接复用，不得另算一套**（数字口径与 UI Dashboard 强一致） |
| 入参 | `{}` |
| 出参 | `DashboardSummary` 原样：`{ projectCount, dirtyRepoCount, dockerRunning, dockerTotal, wslStatus, serviceCount, recentProjects, warnings }` |
| 降级 | daemon 不可用 → 0/0 + warnings 中的结构化条目（既有语义） |

---

## 7. Resources（6 个）

所有 resource 返回**面向 LLM 的 Markdown 摘要**：结构化数据 + 可读渲染，由 service 数据渲染，
不落盘、不缓存跨请求状态。URI 恒定：

| URI | 数据来源 | Markdown 必含内容 |
| --- | --- | --- |
| `devhub://dashboard` | `dashboardSummary()` | 四组计数（projects/dirty/docker/.services）、Recent projects 列表、warnings 列表（severity 前缀） |
| `devhub://environment` | DB detect 快照（`environments`+`environment_tools`）+ `runDoctor()` | Windows 与各 WSL 发行版工具版本表（tool/version/path）；**PATH 首位 Python 提示**（多版本并存时标注 PATH 选中项）；Docker daemon 状态行；Doctor 诊断行 `[WARNING] <title> — <detail>` / `[ERROR]` / `[INFO]`；快照缺失时提示先运行 `devhub.environment.detect` |
| `devhub://projects` | `listMcpSummaries()`（§6.3 投影） | 项目表：name / path / runtime / git 分支+dirty / 容器 running/total / 最近打开 |
| `devhub://services` | `listServices()` | 端口表：port / process / origin / project（归因不到显式 unknown）/ lastSeen 相对时间；数据时效声明 |
| `devhub://docker` | `dockerService.status()+containers()` | daemon 状态行（不可用→`Docker: daemon unreachable (<reason截断>)`）；容器表：name/image/state/ports/project |
| `devhub://wsl` | `wslService.status()+distributions()` | WSL 可用性；发行版表：name/version/state/default/工具摘要（快照标注） |

渲染规则：纯文本 Markdown，无 HTML；每节带来源标注（`snapshot at <unix秒>` 或 `live probe`）；
文本字段同样过 §10.5 输出红线。

---

## 8. Prompts（4 个）

Prompt = 指导 AI 的指令文本 + 参数模板。**MCP 自身不做 AI 推理**：prompt 只说明应调用哪些
tools、如何区分证据等级、如何组织回答。以下为每个 prompt 的完整指令文本（`prompts.ts`
内逐字实现；`{{...}}` 为参数模板槽位）。

### 8.1 devhub.diagnose_environment（无参）

```text
You are diagnosing the local development environment using the DevHub MCP server. Follow this procedure:

1. Call tools: devhub.environment.doctor, devhub.docker.status, devhub.wsl.status.
   If the doctor output references tool versions that look stale, optionally call
   devhub.environment.detect first to refresh the snapshot, then re-run doctor.
2. Classify every finding into exactly one evidence level:
   - confirmed: directly backed by a tool result field (quote the tool and field);
   - suspected: a doctor warning/info whose root cause you infer (state the inference);
   - unknown: data you could not obtain (e.g. daemon unreachable) — say what is missing and why.
3. Output format:
   - A table of findings sorted by severity (error > warning > info), one row per finding:
     severity | finding | evidence (tool + field) | level;
   - For each warning/error, one concrete suggested fix. Only suggest actions; never execute
     or promise to execute anything yourself.
4. Never guess a fact that no tool reported. If Docker daemon is unreachable, report it as an
   environmental condition ("docker daemon unavailable"), not as a failure of the diagnosis.
```

### 8.2 devhub.inspect_project（参数：project）

```text
You are inspecting one project tracked by DevHub. The argument "project" is a project name,
slug, or numeric id.

1. Resolve the project: call devhub.projects.list and match by id, slug, or exact name.
   If no unique match, list the closest candidates and stop — do not guess.
2. Call devhub.projects.get with { projectId }. Then call devhub.git.status with { projectId }.
3. Call devhub.services.list with { projectId } to see which of its ports are listening,
   and devhub.docker.containers to find containers attributed to this project.
4. Evidence levels: confirmed (tool field quoted) / suspected (your inference, stated) /
   unknown (missing data, with the reason).
5. Output:
   - Overview: path (win/wsl), runtime hint, environment(s) it is located in;
   - Repository: branch, clean/dirty (modified vs untracked counts), ahead/behind, remote;
   - Running services: port table (mark entries whose project is "unknown" as NOT attributed
     to this project rather than assuming they belong to it);
   - Containers: name/image/state/ports;
   - Observations and suggested next actions (no execution).
If skills/mcpServers/archives come back with notAvailable placeholders, state that DevHub
does not track them yet; do not fabricate content for them.
```

### 8.3 devhub.find_port_owner（参数：port）

```text
You are answering "who is listening on port {{port}}" using DevHub.

1. Call devhub.services.inspect with { "port": {{port}} }.
2. Present the attribution chain explicitly for every entry:
   port → pid → process (name, command line truncated) → origin (windows | wsl | docker) → project.
3. Attribution discipline:
   - If the tool returns resolvedProject "unknown" (or entries without projectId/projectName),
     the answer is "DevHub could not attribute this port to a project". Never guess a project
     from the process name alone; you may note a suspicion and label it "suspected".
   - If entries is empty, say the port has no record in the most recent DevHub services
     snapshot (snapshotAt) and suggest re-running a services refresh from the DevHub UI,
     then retrying.
4. If multiple entries share the port, list all of them with their origins.
5. Output: a short verdict line first ("Port {{port}} is held by X (confirmed)"), then the
   chain table, then caveats.
```

### 8.4 devhub.review_development_environment（无参）

```text
You are producing a review report of this machine's development environment from DevHub data.

1. Gather: devhub.dashboard.summary, devhub.environment.doctor, devhub.docker.status,
   devhub.wsl.status, devhub.projects.list.
2. Build the report with these sections:
   - Health verdict: one paragraph, weighted by doctor severities and dashboard warnings;
   - Toolchain: versions per side (Windows / each WSL distro) from doctor and environment data;
     call out PATH-first Python issues and Win/WSL version mismatches explicitly;
   - Containers & WSL: daemon availability, running container counts, distro states;
   - Projects at a glance: count, dirty repositories, stale scans (lastScanAt older than 7 days
     flagged as suspected-stale);
   - Recommendations: prioritized, each tagged [confirmed|suspected] with the evidence source,
     and each phrased as a suggestion for the human to approve.
3. Evidence discipline: same three levels as other DevHub prompts. Anything not backed by a
   tool field is "unknown" or "suspected" — label it.
4. Close the report with an appendix listing every tool call you made, in order, with arguments.
```

---

## 9. 权限模型（本期建框架，Phase B 启用）

### 9.1 四级分类

| 级别 | 语义 | dispatch 行为 |
| --- | --- | --- |
| `READ_ONLY` | 只读查询 / 只读探测（含 DevHub 自身状态持久化，如 detect，见 §6.1 立场） | 放行 |
| `SAFE` | 打开窗口/编辑器等用户可感知、无破坏性的操作（如 open VS Code） | 放行（Phase B 起才出现此类 tool） |
| `CONFIRM_REQUIRED` | 影响运行状态的操作（如 stop service / stop container） | 不执行，返回结构化 `requiresConfirmation` 结果，由宿主 AI 向用户确认后重试（Phase B） |
| `BLOCKED` | 明确禁止的能力 | dispatch 前直接拒绝，返回结构化错误 |

### 9.2 permissions.ts 职责（M2 落地）

1. **分类表**：静态 `Record<toolName, PermissionLevel>`，覆盖且仅覆盖 §6 的 12 个 tool
   （本期全为 `READ_ONLY`）；表外名称一律拒绝（等价于 BLOCKED，防注册漂移）。
2. **dispatch 前统一校验**：server.ts 用一个 wrapper 包装所有 tool handler
   （`safeHandler(name, fn)`），首个动作即 `permissions.assertAllowed(name)`——校验先于
   zod 之外的一切业务逻辑。
3. **BLOCKED 直接拒**：命中 BLOCKED 或表外名称 → `{ code: 'PERMISSION_DENIED', message }`
   结构化错误，handler 不执行。
4. SAFE / CONFIRM_REQUIRED 分支的完整语义 Phase B 实现；本期框架只保证分类表与校验管线就位。

### 9.3 示例分类表（Phase B 参考基准）

| tool（示例） | 级别 |
| --- | --- |
| 查询类（本期全部 12 个） | READ_ONLY |
| `devhub.projects.openVSCode`（Phase B 候选） | SAFE |
| `devhub.services.stop`（Phase B 候选） | CONFIRM_REQUIRED |
| 任意 shell / 命令执行 | BLOCKED |

> **MEM 批次注记（2026-09-15，Phase B SAFE 首批启用）**：记忆域知识图谱并入
> DevHub MCP（docs/briefs/mem-mcp.md），10 个 `devhub.memory.*` 工具静态入
> permissions.ts 分类表：读三类 `read_graph` / `search_nodes` / `open_nodes` =
> READ_ONLY；写六类 `create_entities` / `create_relations` / `add_observations` /
> `delete_entities` / `delete_observations` / `delete_relations` + `import_jsonl` =
> **SAFE**（本节 §9.1 "Phase B 起才出现此类 tool" 的首批落地）。SAFE 依据：
> 全部为域特定结构化写入——zod strict 入参、具名、最小授权、可枚举，操作对象
> 仅限 DevHub 自有记忆库三表（memory_entities / memory_observations /
> memory_relations），不触碰 §9.4 红线（无 shell、无任意路径写、无万能执行
> 接口）；`import_jsonl` 只读调用方显式给路径的原型 server-memory JSONL 记忆
> 文件（DevHub 零硬编码用户路径），逐条走 create 语义入库，绝不写回源文件。

### 9.4 设计红线

**明令禁止出现 `devhub.execute_command` 类万能接口。** 任何"把 shell 交给外部 AI"的能力
都不设 tool、不设白名单开关、不做配置项。未来任何写入/操作能力必须以具名、最小授权、
可枚举的 tool 形式提案并过权限评审。

---

## 10. 安全规则

1. **schema 校验**：每个 tool 的 zod inputSchema（`.strict()`）是唯一入参入口；SDK 自动校验
   失败 → isError。zod 随 SDK 依赖显式声明（§14）。
2. **输入白名单**：实体引用优先 `projectId`（数字主键）；接受自由路径的只有
   `devhub.git.status` 的可选 `path`，且必须命中已知项目 winPath 白名单（§6.11），
   禁止任意路径探测。
3. **路径规范化**：比对前统一 `toLowerCase()`（Windows 大小写不敏感）+ 反斜杠→正斜杠 +
   去尾分隔符（复用 servicesService `normalizePathKey` 语义；M2 把该函数提升到
   `src/mcp/projection.ts` 或 shared 工具模块供两处复用）。
4. **错误处理**：`safeHandler` 外层 try/catch 兜底——`ServiceError` → `isError:true` +
   `{ code, message }`；未知异常 → 折叠 `{ code: 'INTERNAL' }`（message 无堆栈无路径细节，
   细节仅进 stderr/文件日志，对齐约束 #14）。**单 tool 失败只影响该请求，server 进程不崩**
   （M2/M3 各有断言）。
5. **输出红线**（`projection.ts` 统一执行）：
   - 自由文本字段（commandLine / reason / detail / errorSummary / Markdown resource 内嵌文本）
     截断上限 **500 字符**；
   - 不返回巨大原始 stdout：任何 tool 都不透传 exec 原始输出，只返回 Service 层解析后的
     结构化字段；
   - 不泄露密钥 / token / SSH 私钥 / 敏感环境变量：MCP 不提供读取文件内容与环境变量的任何
     能力；processName/commandLine 中若出现 `password=`/`token=`/`SECRET` 等模式，
     值段以 `***` 打码后再截断输出。

---

## 11. Transport 抽象

`src/mcp/transport.ts`（M2 新增）：

```ts
/** 传输抽象：server 组装（tools/resources/prompts 注册）与传输解耦。 */
export interface DevhubTransport {
  /** 建立通道、把已组装的 server 接上去，resolve 后保持运行直至通道关闭。 */
  start(server: McpServer): Promise<void>
}

/** 本期唯一实现：stdio（包 @modelcontextprotocol/sdk/server/stdio.js 的 StdioServerTransport）。 */
export class StdioTransport implements DevhubTransport { /* ... */ }
```

- 未来 HTTP / Streamable HTTP：只新增 `HttpTransport` 实现类与 `run-mcp` 的 `--http` 分支，
  **不动 server.ts 的注册逻辑**（约束：tools/resources/prompts 注册对传输零感知）。
- transport 层不做任何业务校验（校验归 §9/§10 的 server 侧管线）。

---

## 12. 错误模型与降级总表

| 场景 | 表现 | isError? |
| --- | --- | --- |
| Docker daemon 不可达（status/containers/dashboard） | `available:false` + reason 结构化返回 | 否 |
| WSL 未安装 / 无发行版 | `available:false` / distributions:[] + reason | 否 |
| git 目标非仓库 | `notAGitRepository:true` | 否 |
| 端口归因不到项目 | `project:'unknown'` 显式 | 否 |
| 快照缺失（wsl tools / services 空） | `toolSnapshot:'missing'`+hint / 空数组+note | 否 |
| projectId 不存在 | `{ code:'NOT_FOUND' }` | 是 |
| path 未命中白名单 / 入参非法 | `{ code:'BAD_PAYLOAD' }` | 是 |
| git 缺失 / exec 超时 | `{ code:'EXEC_FAILED'/'EXEC_TIMEOUT' }` | 是 |
| SQLITE_BUSY（写锁 5s 超时） | `{ code:'DB_ERROR' }` | 是 |
| 未预期异常 | `{ code:'INTERNAL' }`（无堆栈） | 是 |
| BLOCKED / 表外 tool 名 | `{ code:'PERMISSION_DENIED' }` | 是 |

---

## 13. 测试计划

smoke 遵守约束 #27（只增不减）。M2 用例追加进 `scripts/smoke.mjs`，经 SDK `InMemoryTransport`
对连 client/server 全链路调用（真实走 SDK 校验与 envelope，不走简化直调）。

### 13.1 M2 — in-memory transport smoke 用例清单（对应任务书 §11）

| # | 用例 |
| --- | --- |
| M2-T01 | server 组装后 `listTools` 恰为 12 个点分名、`listResources` 恰为 6 个 URI、`listPrompts` 恰为 4 个名 |
| M2-T02 | permissions 分类表覆盖且仅覆盖 12 个 tool，值全为 READ_ONLY；表外名 assertAllowed 拒绝（PERMISSION_DENIED） |
| M2-T03 | `devhub.dashboard.summary` 与临时 home 库直接 SQL 计数一致（复用 step5 dashboard 夹具口径），**且与 dashboardService.dashboardSummary() 同源** |
| M2-T04 | `devhub.projects.list` 增强投影字段齐全（git 摘要 / docker 计数 / environment 标识）；`devhub.projects.get` 含三个 notAvailable 占位 |
| M2-T05 | `devhub.projects.get` 未知 id → isError + `NOT_FOUND`，随后再调任意 tool 仍成功（server 不崩） |
| M2-T06 | `devhub.services.inspect` 对 `project_id` 为 NULL 的夹具端口 → 每条 entry `project:'unknown'` 且 `resolvedProject:'unknown'`（禁止猜测断言） |
| M2-T07 | `devhub.git.status`：白名单内 path 通过、白名单外 path → BAD_PAYLOAD；非仓库目录 → `notAGitRepository:true`；modified/untracked 计数与夹具 porcelain 行数一致 |
| M2-T08 | `devhub.docker.status/containers`：daemon 不可用 → `available:false`+reason 且无 isError（daemon 可用机器走可用断言分支，与 step4 同款容错） |
| M2-T09 | `devhub.wsl.distributions`：无 detect 快照的隔离 home → `toolSnapshot:'missing'`+hint；detect 之后 → tools 快照出现 |
| M2-T10 | `devhub.environment.detect` 调用后 `devhub://environment` resource Markdown 含工具版本行与 `[WARNING]` 行 |
| M2-T11 | zod schema 拒绝非法入参（port 70000、projectId 'abc'、未知键）→ isError，server 存活 |
| M2-T12 | 输出红线：构造 >500 字符 reason/commandLine → 输出被截断至 500；敏感模式 `password=...` 值段被打码 |

### 13.2 M3 — stdio 真实进程验收清单（对应任务书 §13）

| # | 验收项 |
| --- | --- |
| M3-A01 | spawn `node scripts/run-mcp.mjs`：进程存活；stdout 全部为合法 JSON-RPC 行，stderr 无协议内容（logger 镜像已改道 stderr，§3） |
| M3-A02 | `initialize` 握手成功，serverInfo.name/version 正确 |
| M3-A03 | `tools/list` 返回 12 个点分名（若 §5 决策树触发回退，则为 12 个下划线名并已记录偏离） |
| M3-A04 | `tools/call devhub.dashboard.summary` 返回真实数据，projectCount 与 Electron UI Dashboard 一致 |
| M3-A05 | `tools/call devhub.services.inspect {port:<真实监听端口>}` 返回完整归因链；归因不到时显式 unknown |
| M3-A06 | `resources/read devhub://environment` 返回含 `[WARNING]` 行的 Markdown |
| M3-A07 | `prompts/get devhub.find_port_owner` 返回 §8.3 指令文本（参数槽位已替换） |
| M3-A08 | 发送非法 JSON 行 → 返回协议级错误帧，进程不退出 |
| M3-A09 | 并发 5 个 tools/call：响应无交错损坏（逐行完整 JSON） |
| M3-A10 | 共享库验证：先启动 Electron App 产生数据，MCP 进程（不设 DEVHUB_HOME）读到的 projectCount 与 App 一致（不打开空库） |
| M3-A11 | stdin 关闭 → 进程优雅退出，退出码 0 |
| M3-A12 | DEVHUB_HOME 透传：设置后 MCP 打开隔离库（便携模式路径生效） |

---

## 14. 依赖与版本（M1 实装并验证）

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | ^1.30.0（实装 1.30.0） | 经 npmmirror 安装；入口 `@modelcontextprotocol/sdk/server/mcp.js` |
| `zod` | ^4.5.4（实装 4.5.4） | 显式声明（SDK inputSchema 依赖）；与 SDK 1.30.0 兼容实测通过 |

M1 验证记录（系统 Node v24.15.0，均真实执行）：

- `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'` → `function`；
- `import { z } from 'zod'` → safeParse 通过；
- 点分名 + InMemoryTransport 往返：`registerTool('devhub.environment.detect', { inputSchema: { probe: z.string() } })`
  后 client `listTools` 返回 `["devhub.environment.detect"]`、`callTool` 返回 content 成功
  （§5 决策树第 1 步的证据）。

---

## 15. 决策记录

| # | 决策 | 理由 / 证据 |
| --- | --- | --- |
| D1 | tool 用点分名直接注册；保留 SDK/Client 拒绝时整体回退下划线的决策树 | M1 实测 SDK 1.30.0 接受点分名（§14）；回退分支留作协议/Client 校验的保险 |
| D2 | `devhub.wsl.distributions` 数据源分层：state/version 实时探测 + 工具摘要用 DB detect 快照 | docs/03 environments 表无 WSL version/state 列（不改表）；任务要求"版本+状态+工具摘要"三者齐备，唯一可行且不猜测的来源即此分层 |
| D3 | projects.list 增强投影走新增 `listMcpSummaries()`，不改 `ProjectSummary`/ChannelContract | 避免 MCP 需求波及 21 channel IPC contract 与 Renderer（最小增量原则） |
| D4 | `devhub.services.inspect` 本期只读快照；refresh 能力列为 Phase B 候选 | 任务规格映射为 findByPort 直查；refresh 属写库编排，超本期只读范围 |
| D5 | MCP 侧 stdout 纪律：logger console 镜像在 MCP 进程内改道 stderr | stdio transport 下 stdout 是 JSON-RPC 专用通道；现 logger info/debug 走 console.log 会损坏协议流（M2 必办项） |
| D6 | detect 的写库定为 READ_ONLY | 写的是 DevHub 自身业务库（状态持久化），对操作系统零修改；与约束 #19/#20 一致（§6.1 立场声明） |

## 16. Backlog（本期不做，记录待议）

- `refresh` 参数（services.inspect 实时刷新）、services/dedicated refresh tool；
- SAFE / CONFIRM_REQUIRED 级 tools（open 类、stop 类）与确认回环协议；
- HTTP / Streamable HTTP transport；
- skills / mcp_servers / archives 的 service 实现与对应 tool/resource；
- Resource 订阅（resources/subscribe）与变更推送。
