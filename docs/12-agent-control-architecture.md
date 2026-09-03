# DevHub Agent Control 架构设计（docs/12）

> Phase 2/3 Agent Control / Mobile 设计，约束基线同 docs/00；migration/历史文档零改动。
> 本文是 AC 域的架构权威：六层架构 / 进程模型 / spawnManaged 契约 / Provider 接口 /
> 事件模型 / 监控管线 / 逐 Provider 对接 / 文件布局 / 托盘生命周期。
> 需求见 docs/11，数据库见 docs/13，API 见 docs/14，安全见 docs/15，计划见 docs/16。

---

## 1. 六层架构图

```
L6  Android 手机（F:\Active_Project\DevHub\android，Kotlin+Compose+Room+OkHttp+Keystore）
    │  REST(13 端点) + WS(/v1/events)                    ▲ 默认不开路由器端口
    ▼                                                    │
L5  NatPierce（用户自备第三方隧道，仅 TCP 透传，不替代鉴权，docs/15 §8）
    │
    ▼
L4  Remote Gateway —— 运行于 Electron Main 进程内（裁决 2）
    src/main/services/agentControl/gateway/（node:http + 轻量 WS；默认 127.0.0.1:8746，
    settings gateway_port 可配；settings gateway_enabled 默认关）
    │  同进程直调（不 HTTP 回环自调）
    ▼
L3  agentControlService（编排层，唯一写库层延伸，约束 #20）
    事件归一化/去重/落库/投递 · 脱敏 · 配对/设备/命令 · 投影给 IPC 与 Gateway
    │
    ▼
L2  providers/（五家接入适配器）+ monitorRegistry（可取消监控任务表）+ eventPipeline
    codexProvider / claudeProvider / kimiProvider / zcodeProvider / deepseekProvider
    │  数据源：app-server stdio / hooks 回调 / session_index.jsonl / rollout jsonl /
    │         ~/.zcode db.sqlite（只读快照）/ deepseekHarnessRoot 探测
    ▼
L1  外部 Agent（独立进程，DevHub 不改造其本体；唯一例外 = Claude Code hooks 合并写入）
    Codex 0.152.1 · Claude Code 2.1.150 · Kimi 0.36.0 · ZCode · DeepSeek Harness（骨架）
```

与现有分层的关系：

- **Service 分层不变**：agentControl 是新的 service 域（`src/main/services/agentControl/`），
  唯一写库层仍是 Service（约束 #20）；providers 层比照 Adapter 只读纪律（约束 #19）——
  对外部 Agent 的数据源只读，唯一的写行为是 Claude Code hooks 合并（经用户显式动作 +
  备份/恢复，docs/11 §4.2）与托管会话的 stdin 注入（spawnManaged 管道，非文件写）。
- **IPC 网关不变**：Renderer 仍只经 `devhub:invoke` 白名单（约束 #17）；AC 新增 13 条
  `agents:` 前缀 channel（55→68，docs/14 Part A），Result envelope / BAD_PAYLOAD /
  CHANNEL_NOT_ALLOWED 语义零改动。
- **db 单例共享**：Gateway 与 agentControlService 同在 Main 进程，直接复用
  `getDatabase()` 单例（node:sqlite DatabaseSync + WAL）；跨进程先例已有
  （MCP 独立进程读同库，mcp-acceptance A13 验证），Gateway 同进程并发面更小，
  **短事务 + 同步 API 可接受**（docs/08 §2 同款论证）。
- **Renderer 不直连 Gateway**：Agents 视图数据一律走 IPC 轮询（`archive:status`
  先例，docs/10 §11）；build 产物 CSP `default-src 'self'`（src/renderer/index.html）
  零修订——规避 connect-src 扩面（AC0 审计锁定）。

## 2. 进程模型

| 形态 | 裁决 | 说明 |
| --- | --- | --- |
| 新进程 | **无**（铁律：不新增进程形态，docs/10 §4 同款） | Gateway / 监控管线 / provider 探测全部在 Main 进程内 |
| Gateway | Electron Main 内嵌 node:http + 轻量 WS | 不起独立 Node 进程、不起 utilityProcess；与 Main 同生命周期（托盘退出时收尾） |
| 托管 Agent | Codex app-server / Kimi 会话是 **DevHub 的子进程**（spawnManaged） | 长驻受控，树杀收尾（§3）；外部自启的 Agent 会话不经 DevHub 进程，只读其落盘数据 |
| MCP | 零改动 | scripts/run-mcp.mjs 既有独立进程形态不变；AC 能力绝不进 MCP（docs/11 N4） |

## 3. exec.ts spawnManaged 契约（专节）

**裁决 1（母智能体已锁定）**：在 `src/main/core/exec.ts` 本体内新增受控长驻/流式进程
API `spawnManaged`；「全项目唯一 child_process import 点 = exec.ts」不变（约束 #7），
**不新增第二个 spawn 模块**；既有 `run()` / `launchViaStartProcess()` 语义零改动。

```ts
// src/main/core/exec.ts 追加导出（草案，实现批次按此契约落地）
export interface ManagedProcessOptions {
  /** 心跳空闲超时：连续 idleTimeoutMs 无任何 stdout/stderr 增量 → 树杀收尾。默认 30_000。 */
  idleTimeoutMs?: number
  /** 总生命周期上限：无论是否活跃，超时即树杀收尾。默认 600_000，必须允许显式放宽。 */
  lifetimeTimeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** 需要 stdin 注入（reply 通道）时开启；默认 false。 */
  stdinWritable?: boolean
  /** 增量回调（按行缓冲解码后回调；沿用 run() 的 BOM 双解码规则）。 */
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
}

export interface ManagedExit {
  code: number | null
  signal: NodeJS.Signals | null
  reason: 'exit' | 'idle-timeout' | 'lifetime-timeout' | 'spawn-error'
  stderrTail: string        // 尾部 8KB，结构化返回（约束 #10）
  durationMs: number
}

export interface ManagedProcess {
  readonly pid: number
  /** stdin 注入（仅 stdinWritable=true 时可用；写入前进程已退出 → 结构化失败，不抛）。 */
  writeStdin(text: string): { ok: boolean; error?: { code: string; message: string } }
  /** 树杀：taskkill /PID <pid> /T 温和 → 2.5s 存活则 /T /F 强制（procGuard 范本，参数数组经本模块）。 */
  killTree(): Promise<void>
  readonly exited: Promise<ManagedExit>
}

export function spawnManaged(command: string, args: string[], options: ManagedProcessOptions): ManagedProcess
```

**约束 #7/#9 的细化语义（本节为权威）**：

1. 参数数组 + `shell:false` + `windowsHide:true` 不变（约束 #8）；spawn 同步异常折叠为
   `exited = spawn-error`，不 throw。
2. **超时语义细化（裁决 1）**：单次命令的「15s 强制 timeout」（约束 #9）在长驻语义下
   细化为**两个独立上限**——心跳空闲超时（idleTimeoutMs，任何 stdout/stderr 增量都重置
   心跳计时）与总生命周期上限（lifetimeTimeoutMs，绝对天花板）。两者都必须有默认值且
   可显式配置；触发任一上限 → `killTree()` 树杀 + `ManagedExit.reason` 标明
   `idle-timeout | lifetime-timeout`——**不存在无超时状态，不允许无限等待**（约束 #9
   的精神在长驻形态下的等价落地）。
3. 超时收尾复用 `services/archive/procGuard.ts` 的 taskkill /T → /T /F 树杀范本
   （taskkill 参数数组经本模块自身的 run()，约束 #7/#8/#12 不受影响）。
4. 增量回调保证顺序（stdout 行序不乱）；行缓冲携带不完整尾行直到换行或退出时冲刷。
5. 取消传播：`monitorRegistry`（§7）取消监控任务时调用 `killTree()`。

## 4. 统一 Provider 接口（9 方法，TS 草案）

```ts
export type ProviderId = 'codex' | 'claude-code' | 'kimi' | 'zcode' | 'deepseek'
export type SessionMode = 'managed' | 'attached' | 'observed'
export type AgentCapability = 'reply' | 'pause' | 'resume'
export type SessionStatus =
  // —— 用户锁定 7 态（对外展示全集）——
  | 'running' | 'completed' | 'failed'
  | 'waiting_input'      // 等待用户文本输入
  | 'approval_required'  // 等待工具执行批准（与 waiting_input 独立，判定源见 §5）
  | 'paused'
  | 'connection_lost'    // 监控源失联（判定源见 §7）
  // —— 辅助态（9 值全集，UI 透明展示）——
  | 'stopped'            // 有终态记录的正常停止（区别于 connection_lost 的监控源失联）
  | 'unknown'            // 判定未定（skills 先例：绝不猜实时态）

export interface SessionRef { providerId: ProviderId; nativeId: string }

export interface AgentProvider {
  readonly id: ProviderId
  /** 探测安装/版本/数据源可用性 → agent_providers 健康投影（不写库，写库归 L3）。 */
  probeHealth(): Promise<ProviderHealth>
  /** 全量会话快照（upsert 语义；native_id 幂等）。 */
  listSessions(): Promise<SessionSnapshot[]>
  /** 增量消息（游标 = 已见最大 seq_in_session / 文件 offset）。 */
  readMessages(ref: SessionRef, after?: string): Promise<MessagePage>
  /** 能力真实验证：只返回「此刻验证存在」的能力，绝不因「理论上支持」放行（§5）。 */
  getCapabilities(ref: SessionRef): Promise<CapabilitySet>
  /** 注入回复（仅 managed/attached 且 reply 已验证；实现内部走 stdin/hooks/app-server）。 */
  sendReply(ref: SessionRef, text: string): Promise<CommandOutcome>
  pause(ref: SessionRef): Promise<CommandOutcome>
  resume(ref: SessionRef): Promise<CommandOutcome>
  /** 注册监控管线（fs.watch / 快照轮询），返回句柄；并发可取消（§7）。 */
  startMonitor(sink: EventSink): MonitorHandle
  /** 停止监控、关闭管道、释放资源（托盘退出/开关关闭时调用）。 */
  dispose(): Promise<void>
}
```

## 5. session_mode 三态语义 + 能力验证门

| mode | 判定 | reply | pause/resume | 典型来源 |
| --- | --- | --- | --- | --- |
| managed | DevHub 经 spawnManaged 托管启动该会话（app-server 握手成功 / kimi stdin 管道附加） | ✔（已验证） | ✔（已验证） | Codex app-server、Kimi 托管 |
| attached | 会话外部启动，但存在受支持的输入通道（Claude Code 官方 hooks 已注册并打通） | ✔（已验证） | ✘ | Claude Code hooks |
| observed | 纯观察（文件/db 解析），无任何输入通道 | ✘ | ✘ | Codex rollout 降级、ZCode 全部、Claude 无 hooks、Kimi 外部会话、DeepSeek |

**能力验证门（强制）**：`getCapabilities` 返回的 `granted[]` 只能包含**此刻真实验证
存在**的能力（验证依据随能力集返回），过期（verifiedAt 超过 5 分钟）或验证失败一律
收缩为空集；L3 在执行任何 command 前二次校验能力门与 session_mode（授权矩阵见
docs/15 §5）——UI 不显示按钮只是第一道门，服务端拒绝才是合同。

**状态 9 值判定规则（用户锁定 7 态 + stopped/unknown 辅助态）**：

| 状态 | 语义 | 判定源 |
| --- | --- | --- |
| `waiting_input` | 等待用户**文本输入** | 会话源中的提问/输入请求片段 |
| `approval_required` | 等待**工具执行批准**（与 waiting_input 独立，两者不同时为真） | ZCode `tool_usage.approval_status`；Codex rollout 审批片段；Claude hooks 审批事件（§8）。无审批判定源的 provider（Kimi/DeepSeek）不产生 approval_required，判定不了 → waiting_input/unknown，绝不猜测 |
| `connection_lost` | 监控源失联（非会话终态） | §7：monitorRegistry 连续 5 次读失败降级；或托管进程意外消失且源中无终态记录。恢复（源重新可读/监控恢复）后重探刷新 |
| 其余 6 值 | running / completed / failed / paused / stopped / unknown | 各 provider 状态判定器（§8）；判定不了一律 unknown |

```ts
export interface CapabilitySet {
  mode: SessionMode
  granted: AgentCapability[]     // 空数组 = 无控制能力（observed 或验证失败）
  verifiedAt: number             // unix 秒；>300s 视为过期，重新验证
  evidence: string               // 验证依据：'app-server handshake ok' / 'hooks registered'
                                 // / 'stdin pipe attached' / 'read-only source'
}
```

## 6. 事件模型（7 类型）

| event_type | 触发来源 | payload（脱敏后 JSON）要点 |
| --- | --- | --- |
| `session.started` | 监控管线发现新 (provider, native_id) 或托管会话就绪 | sessionId, providerId, workdir, projectId? |
| `session.status_changed` | 状态判定器输出新状态（≠ 旧状态才发；to ∈ 9 值全集） | sessionId, from, to, detail? |
| `session.waiting_input` | **输入等待类事件**（event_type 名不变）：状态判定为 waiting_input（等待用户文本输入）或 approval_required（等待工具执行批准）——**远程通知的核心触发源**（两种 status 均通知） | sessionId, status: 'waiting_input'\|'approval_required', summary（≤120 字符脱敏摘要） |
| `session.finished` | completed / failed / stopped 终态 | sessionId, finalStatus, exitHint? |
| `message.appended` | 增量消息解析出新行（可折叠：同一轮多条合并为一条） | sessionId, role, preview（脱敏截断） |
| `provider.health_changed` | probeHealth 结果变化 | providerId, from, to, detail? |
| `command.result` | command 终态（executed / rejected / failed / expired） | commandId, sessionId, action, status, errorCode? |

**语义（裁决 5，强制）**：

1. **先写 SQLite 再 WS 投递**：eventPipeline 单事务内 `INSERT agent_events` +
   `INSERT event_deliveries(pending) × 活跃设备`，COMMIT 后才向 WS 通道投递；
   投递失败不回滚 DB（重连补发兜底）。
2. **sequence 单调递增**：`agent_events.id INTEGER PRIMARY KEY AUTOINCREMENT`
   （AUTOINCREMENT 防删后 rowid 回绕——事件表存在清理可能，普通 rowid 语义不够；
   这是 004 中唯一偏离「INTEGER PRIMARY KEY」默认风格之处，理由记录在案，docs/13 §4）。
3. **去重**：`event_id` 唯一（`<provider>:<native_id>:<type>:<内容指纹>` 派生），
   `INSERT OR IGNORE`；重放同一文件段不产生重复事件。
4. **未确认事件不删**：`delivery_state`（pending / delivered / acked）只前进不回退；
   清理规则 = 仅 `acked` 且超过保留期的事件可由后续批次清理，v1 不清理任何事件。
5. WS 投递带 seq；设备 ack 按 seq 确认；`GET /v1/events/{id}/ack` 补充 REST 确认
   （docs/14 Part B）。
6. **远程通知触发（Android 系统通知）** = `session.waiting_input`（waiting_input /
   approval_required 两种 status 均通知）或 `session.status_changed` 且
   `to ∈ {completed, failed}`；通知内容仅脱敏摘要（docs/15 §6）。

## 7. 监控管线设计

```
provider.startMonitor(sink)
  └─ MonitorTask（monitorRegistry Map：providerId → task）
       ├─ watcher：fs.watch(目录) 优先；不可靠/失败 → 2s stat 轮询（mtime/size）回落
       ├─ reader：增量读（byte offset 记忆）→ 行缓冲 → 逐行 try-parse → 状态判定 → sink
       ├─ cancel token：{ cancelled: boolean }（archive/walker.ts 同款共享 token，
       │   每行/每轮循环检查）；取消 = watcher.close + timer.clear + 管道收尾
       └─ 错误降级：单次读失败计数，连续 5 次 → task 降级为慢轮询并上抛 health_changed
```

- **connection_lost 判定源**：上述连续 5 次读失败降级时，受影响 provider 的活跃会话
  状态置 `connection_lost`（监控源失联，非终态）；托管子进程（spawnManaged）意外
  消失且源中无终态记录 → 该会话同样置 `connection_lost`。恢复（源重新可读/监控
  恢复）后重探刷新为真实状态；无终态记录的停止**绝不推断为 completed/failed**
  （有终态记录的正常停止才是 `stopped`）。

- **文件轮转/截断**：`offset > currentSize` → 视为轮转或截断：重置 offset=0 全量重读，
  依赖 event_id 唯一约束去重（幂等，不产生重复事件）。
- **不完整 JSON 行**：末行无换行符 → 留在行缓冲，下次增量拼接后再解析。
- **重复事件**：见 §6 语义 3。
- **并发可取消任务注册表（Map 化）**：`monitorRegistry.ts` 以 `Map<ProviderId,
  MonitorTask>` 管理，每 provider 同时至多 1 个活跃 task（重复 start 先 cancel 旧 task）；
  开关关闭 / 托盘退出 / provider 停用 → `cancelAll()`。cancel token 模式引用
  `src/main/services/archive/walker.ts` 先例（`{ cancelled }` + 循环检查点）。
- **主线程让步**：大批量解析按 N 行分片 `await setTimeout(0)`（walker 同款），不卡 UI。

## 8. 逐 Provider 对接设计

数据源与实测事实引用 docs/11 §4（AC0 盘点）；本节定义状态判定与防御细节。

### 8.1 Codex（codexProvider.ts）

- 发现：`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 取最新 hash 目录；`--version` 探测。
- managed 通道：spawnManaged 启动 `codex app-server`，stdio JSON-RPC 握手 → CapabilitySet
  （evidence 'app-server handshake ok'）；协议字段未知一律容忍丢弃 + 计数。
- observed 通道：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 增量解析 + 
  `session_index.jsonl` 会话发现；状态判定 = rollout 内部状态标记 + rollout 审批片段
  （approval_required 判定源之一；无法判定 → unknown，
  绝不用窗口标题/进程存活判态）。
- 降级路径：app-server 失败 → observed jsonl；jsonl 不可读 → unavailable。
- schema 防御：逐行 try-parse；解析失败行计数入 health_detail；不中断监控。

### 8.2 Claude Code（claudeProvider.ts）

- 发现：`claude --version`（PATH / npm 全局）。
- attached 通道：官方 hooks 合并写入 `~/.claude/settings.json`（**备份 + 恢复脚本 +
  只合并 hooks 子键，env.*（含 ANTHROPIC_BASE_URL=http://127.0.0.1:15721 的 ApiHub
  写入目标）零改动**，原子写）；hooks 回调由**独立的内部回环 listener** 承载
  （绑定 127.0.0.1 随机端口，随 provider 监控启用而启停——**不随 gateway_enabled
  关闭**，远程面与 hooks 回收面是两个独立监听）；hook 命令内嵌签发时生成的本地
  随机 secret（防其他本机进程伪造回调），回调事件转成 waiting_input 等事件。
- observed 通道：`~/.claude/projects/` 转录目录增量解析（schema 实现批次实机复核，
  解析纪律同 8.1）。
- 状态判定：hooks 事件（含审批事件 → approval_required 判定源之一）> 转录内容推断
  （判定不了 → unknown）。
- 风险：settings.json 是 AC 与 ApiHub 共写点——共写冲突列入 docs/16 风险清单，
  写入前重读整文件再合并（不使用陈旧缓存）。

### 8.3 Kimi（kimiProvider.ts）

- 发现：`C:\Users\sakuya\.kimi-code\bin\kimi.exe` + `--version`。
- 会话发现：`~/.kimi-code/session_index.jsonl` 每行 `{sessionId, sessionDir, workDir}`
  → (native_id, 数据源目录, workdir 归一关联 project)。
- managed 通道：spawnManaged 托管启动 kimi 会话（stdinWritable），reply = stdin 注入；
  **成功判定一律以会话文件终态为准，禁仅凭进程退出判成功**。
- 红线：config.toml 明文 api_key 的任何投影只有尾 4 位 + 长度（redact.ts 统一实现，
  docs/15 §6）；AC 域对 `~/.kimi-code` 零写入。

### 8.4 ZCode（zcodeProvider.ts）

- 数据源：`~/.zcode/cli/db/db.sqlite`（session / message / tool_usage（审批状态，
  `approval_status` 为 approval_required 判定源之一）/ sequence）+ `~/.zcode/v2/tasks-index.sqlite`（tasks(workspace_path/task_id/title/
  task_status/provider)）。
- 只读策略：优先 `readOnly` 打开；失败（锁/node:sqlite 版本）→ 复制 db + -wal + -shm
  快照到 `getDataDir()/tmp/` 后读快照（快照用完即删）。**绝不写第三方库、绝不 checkpoint**。
- 增量：记忆各表 max(rowid)/sequence 值，下轮从游标读取。
- schema 防御：启动时 `PRAGMA table_info` 白名单比对；不匹配 → unavailable +
  health_detail（ZCode 非公开 CLI，schema 可能变——防御优先）。
- 控制边界：**首版全部 observed，无任何控制按钮**（裁决 4）；禁 GUI 自动化、禁逆向。

### 8.5 DeepSeek（deepseekProvider.ts）

- 骨架 + 能力检测：settings `deepseekHarnessRoot`（本机 `D:\Apps\deepseek-harness`）
  目录存在性 / 本地版本文件 / 进程探测 → health + 能力集。
- 无法验证的能力 → 「未接入」显式文案；绝不伪造状态、绝不猜测会话格式（裁决 4）。

## 9. 项目文件布局

```
src/main/services/agentControl/
├─ agentControlService.ts    L3 编排入口：13 条 IPC handler 的业务实现（唯一写库层延伸）
├─ providerRegistry.ts       五家 provider 目录常量与注册（catalog 模式，Grok 预留位）
├─ monitorRegistry.ts        Map 化可取消监控任务表（§7）
├─ eventPipeline.ts          事件归一化 / event_id 派生 / 去重 / 落库 / 投递（§6）
├─ redact.ts                 脱敏统一实现（尾 4 位 + 长度；密钥/Token/Cookie 模式）
├─ gateway/
│  ├─ httpServer.ts          node:http 路由（docs/14 Part B 的 13 端点 + 本地 hooks 回调）
│  ├─ ws.ts                  轻量 WS（upgrade 握手 / 帧编解码 / 心跳）；评估后若引 ws 库
│  │                         需走 npmmirror 并记录依赖裁决，默认自研（零新依赖纪律，docs/09 §11.4）
│  ├─ auth.ts                设备 Token 校验（SHA-256 比对）/ 防重放 / 限流
│  └─ pairing.ts             配对码签发 / 核销 / 限流
└─ providers/
   ├─ codexProvider.ts  claudeProvider.ts  kimiProvider.ts
   ├─ zcodeProvider.ts  deepseekProvider.ts
   └─（Grok 预留位：后续批次新增 grokProvider.ts + 注册行即可，docs/11 §4.6）
```

挂接点（既有文件的最小改动）：

| 文件 | 改动 |
| --- | --- |
| `src/shared/channels.ts` | IPC_CHANNELS 追加 13 条 agents: channel（55→68） |
| `src/shared/types.ts` | ChannelContract 增行；ErrorCode 增 AC 域值（docs/14 Part C）；ResourceType/RelationType 联合类型扩值 |
| `src/main/ipc/handlers.ts` | handler 注册表增 13 条（注册表 = 白名单编译期断言自动约束） |
| `src/main/services/resourceGraph.ts` | `ResourceType` 扩 `'agent' \| 'session' \| 'device'`；`RelationType` 扩 `'monitors' \| 'exposes' \| 'controls'`（表结构零改动：resources/relationships 列本就是 TEXT） |
| `src/main/services/settingsService.ts` | ALLOWED_KEYS 6→10（gateway_port / gateway_enabled / agents_monitor_enabled / login_autostart） |
| `src/main/db/migrate.ts` | setUserVersionLiteral switch 补 case 4（docs/13 §3） |
| `src/main/index.ts` | 托盘/生命周期改写（§10） |
| `scripts/smoke.mjs` | step1 / step6 / s4-68 三处计数断言 55→68 就地更新（s4-68 注明模式授权） |

## 10. 托盘与生命周期设计

改写点全部在 `src/main/index.ts`（现状：`window-all-closed → app.quit()`，第 84–86 行）：

| 项 | 设计 |
| --- | --- |
| isQuitting 标志 | `let isQuitting = false`；`before-quit` 置 true；窗口 `close` 事件：`!isQuitting → preventDefault() + win.hide()`（关窗 = 隐藏）；`window-all-closed` 回调改为**不 quit**（托盘常驻） |
| 托盘 | `new Tray(<icon>)`；菜单：显示主窗口 / 监控开关（读写 settings `agents_monitor_enabled`）/ 退出（置 isQuitting → 关闭 Gateway 与 monitorRegistry.cancelAll() → closeDatabase() → app.quit()） |
| 图标资源 | 仓库现无托盘图标 → AC5 批次新增 `resources/tray.png`（含 @2x）并接入 electron-vite 静态资源；加载失败降级为空图标 + 结构化日志（不崩） |
| AppUserModelID | `app.setAppUserModelId(...)` 在 whenReady 首行设置——Windows 通知归属前置条件（AC0 审计：现缺） |
| 自启 | `app.setLoginItemSettings({ openAtLogin })`（Electron 44 Windows 可用）；由 settings `login_autostart` 驱动，启动时应用 + agents:setAutoStart 变更时即时应用（electron 胶水注入，services 层 electron-free 纪律不变，docs/09 §11.3） |
| second-instance | 既有 `focusExistingWindow()` 复用并扩展：窗口隐藏 → `win.show() + win.focus()` |
| 退出收尾顺序 | cancelAll 监控 → 关 WS 连接 → 关 Gateway 监听 → 关托管子进程（killTree）→ closeDatabase（WAL 落盘） |

## 11. Grok 本期不做（注记）

Grok CLI 1.0.5 本机存在但不在用户首批清单（docs/11 §4.6）：providerRegistry 目录与
providers/ 布局已预留扩展位（`~/.grok/bin/grok`、`~/.grok/config.toml`、
`~/.grok/sessions/`（实现批次复核）均可比照 kimi 模式接入），本期零实现、零注册。
