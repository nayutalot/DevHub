/**
 * DevHub shared domain & IPC contract types (docs/03-database.md, docs/04-ipc-api.md).
 *
 * This module is imported by Main and Renderer alike; it must stay free of
 * any Node/Electron API dependency. Syntax is restricted to constructs that
 * survive Node native type stripping (no enum / namespace / parameter
 * properties) so smoke tests can import it directly under system Node.
 *
 * Field naming: DB rows are snake_case (docs/03 DDL), IPC payloads/results
 * are camelCase (docs/04) — mapping happens in the Service layer (Step 5/7).
 */

import type { IpcChannel } from './channels.ts'

// ---------------------------------------------------------------------------
// 1. Result envelope & error model (docs/02 §3, docs/04 §1, constraint #14)
// ---------------------------------------------------------------------------

export interface DomainError {
  code: string
  message: string
}

/** Unified IPC envelope: every gateway response is exactly one of these. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: DomainError }

/** Stable error codes (docs/02 §3). BAD_PAYLOAD / INTERNAL are gateway-level
 * codes (payload shape validation / non-domain exception folding) that landed
 * with the Step 6 implementation and were added to docs/02 §3 in Step 7.
 * PROJECT_LOCKED 为 S5 归档批次新增（docs/10 §1：占用 → PROJECT_LOCKED 附
 * occupiers 清单；文档权威原则同 CHANNEL_NOT_ALLOWED）。
 * AC 域 17 值为 AC2 批次新增（docs/14 Part C 逐字，语义见该表）。 */
export type ErrorCode =
  | 'EXEC_TIMEOUT'
  | 'EXEC_FAILED'
  | 'CHANNEL_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'DB_ERROR'
  | 'DEGRADED'
  | 'BAD_PAYLOAD'
  | 'INTERNAL'
  | 'LINK_CONFLICT'
  | 'PROJECT_LOCKED'
  // --- Agent Control（AC2 批次，docs/14 Part C） ---
  | 'AGENT_PROVIDER_UNAVAILABLE'
  | 'AGENT_PROVIDER_DISABLED'
  | 'AGENT_MONITOR_DISABLED'
  | 'AGENT_CAPABILITY_MISSING'
  | 'AGENT_SOURCE_UNREADABLE'
  | 'GATEWAY_DISABLED'
  | 'GATEWAY_PORT_IN_USE'
  | 'GATEWAY_LOCAL_ONLY'
  | 'DEVICE_NOT_PAIRED'
  | 'DEVICE_REVOKED'
  | 'DEVICE_FORBIDDEN'
  | 'AUTH_INVALID_TOKEN'
  | 'AUTH_REPLAYED'
  | 'AUTH_RATE_LIMITED'
  | 'COMMAND_KEY_CONFLICT'
  | 'COMMAND_EXPIRED'
  | 'COMMAND_NOT_EXECUTABLE'
  // --- ECS Relay（M2-R1，docs/18 §8.2 append-only：8 行新码行 = 9 枚举值，
  //     RELAY_DEVICE_UNKNOWN / RELAY_HOST_UNKNOWN 同属注册表未知行） ---
  | 'PAIRING_INVALID_CODE'
  | 'PAIRING_CODE_EXPIRED'
  | 'PAIRING_CODE_VOIDED'
  | 'RELAY_UPSTREAM_OFFLINE'
  | 'RELAY_UPSTREAM_TIMEOUT'
  | 'RELAY_REST_READONLY'
  | 'RELAY_QUEUE_FULL'
  | 'RELAY_DEVICE_UNKNOWN'
  | 'RELAY_HOST_UNKNOWN'

// ---------------------------------------------------------------------------
// 2. Exec kernel result (src/main/core/exec.ts, constraint #10)
// ---------------------------------------------------------------------------

export interface ExecResult {
  /** Process exit code; -1 when spawn failed or the call timed out. */
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  command: string
  args: string[]
  durationMs: number
}

// ---------------------------------------------------------------------------
// 3. Domain records (docs/03-database.md tables, camelCase API projection)
// ---------------------------------------------------------------------------

export type ProjectRuntimeHint = string

/** projects 表（3.1）。winPath / wslPath 至少一个非空（CHECK 约束）。 */
export interface Project {
  id: number
  name: string
  slug: string
  description?: string
  winPath?: string
  wslPath?: string
  runtimeHint?: ProjectRuntimeHint
  lastOpenedAt?: number
  createdAt: number
  updatedAt: number
}

/** projects:list 行（docs/04）。 */
export interface ProjectSummary {
  id: number
  name: string
  slug: string
  winPath?: string
  wslPath?: string
  runtimeHint?: string
  lastOpenedAt?: number
  /** projects.updated_at（unix 秒）。Step 8c F5 补充：dashboard:summary 的
   * recentProjects 在项目从未打开过时以它回退填充 lastOpenedAt 供相对时间显示。 */
  updatedAt?: number
  hasGit: boolean
  dirtyCount: number
}

/** repositories 表（3.2）。 */
export interface Repository {
  id: number
  projectId: number
  remoteUrl?: string
  branch?: string
  headSha?: string
  isDirty: boolean
  ahead: number
  behind: number
  lastStatusAt?: number
  createdAt: number
  updatedAt: number
}

/** environments 表（3.3）。 */
export interface EnvironmentRecord {
  id: number
  name: string
  kind: 'windows' | 'wsl'
  osVersion?: string
  detectedAt: number
  createdAt: number
  updatedAt: number
}

/** environment_tools 表（3.4）行。 */
export interface EnvironmentTool {
  id?: number
  environmentId?: number
  tool: string
  version?: string
  path?: string
  state: 'installed' | 'missing' | 'error'
  rawVersion?: string
}

/** environment:detect 内的工具明细（docs/04）。 */
export type EnvironmentToolInfo = Omit<EnvironmentTool, 'id' | 'environmentId'>

/** environment:detect 返回的环境（含工具链）。 */
export interface EnvironmentWithTools {
  id: number
  name: string
  kind: 'windows' | 'wsl'
  osVersion?: string
  detectedAt: number
  tools: EnvironmentToolInfo[]
}

/** services 表（3.5）。 */
export interface ServiceRecord {
  id: number
  port: number
  protocol: 'tcp' | 'udp'
  pid?: number
  processName?: string
  commandLine?: string
  workingDir?: string
  origin: 'windows' | 'wsl' | 'docker'
  projectId?: number
  firstSeenAt: number
  lastSeenAt: number
}

/** services:list 行（docs/04，含归因到的项目名）。M2 增补 lastSeenAt（MCP
 * devhub.services.inspect 的 snapshotAt 口径需要；renderer 不受影响）。 */
export interface ServiceRow {
  id: number
  port: number
  protocol: 'tcp' | 'udp'
  pid?: number
  processName?: string
  commandLine?: string
  workingDir?: string
  origin: 'windows' | 'wsl' | 'docker'
  projectId?: number
  projectName?: string
  /** services.last_seen_at（unix 秒；最近一次快照时间）。 */
  lastSeenAt?: number
}

/** containers.ports_json 元素（3.6）。 */
export interface ContainerPortMapping {
  host: number
  container: number
  proto: 'tcp' | 'udp'
}

/** containers 表（3.6）。 */
export interface ContainerRecord {
  id: number
  dockerId: string
  name: string
  image?: string
  state?: string
  ports: ContainerPortMapping[]
  /** docker ps --format 的 Labels 解析（如 com.docker.compose.project=foo），归因用；无 label 时缺省。 */
  labels?: Record<string, string>
  projectId?: number
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// 3a. Adapter probe models (src/main/adapters/*, Step 4 — read-only layer)
//     只读探测层返回的结构化模型；预期性不可用一律降级为结构化状态而非 throw。
// ---------------------------------------------------------------------------

// --- git.ts ---

/** gitStatus(repoPath) 结果：`git status --porcelain=v1 --branch` 解析。 */
export interface GitRepoStatus {
  /** 当前分支名；detached HEAD 时为 'HEAD'。 */
  branch: string
  /** 上游分支（无跟踪时缺省）。 */
  upstream?: string
  ahead: number
  behind: number
  /** 变更文件数（porcelain 正文行数）。 */
  dirtyCount: number
}

// --- windows.ts ---

/** listWindowsProcesses() 行：tasklist /FO CSV /NH。 */
export interface WinProcess {
  name: string
  pid: number
  /** 物理内存 KB（解析失败时缺省）。 */
  memKb?: number
}

/** listListeningPorts() 行：netstat -ano -p tcp 的 LISTENING 条目。 */
export interface PortEntry {
  port: number
  pid: number
  /** 本地监听地址（如 0.0.0.0 / 127.0.0.1 / [::]）。 */
  address: string
}

/** getProcessDetails() 值：Win32_Process 明细。 */
export interface ProcessDetail {
  pid: number
  name: string
  commandLine?: string
  executablePath?: string
}

// --- wsl.ts ---

/** listDistros() 行：wsl.exe -l -v 解析。 */
export interface WslDistro {
  name: string
  /** 'Running' | 'Stopped' | ...（原样保留 STATE 列）。 */
  state: string
  /** WSL 版本 '1' | '2'。 */
  version: string
  /** 是否默认发行版（wsl -l -v 的 * 标记）。 */
  isDefault?: boolean
}

/** wslListeningSockets() 行：ss/netstat -tlnp 解析；无权限看进程时 pid/processName 为 null。 */
export interface WslPortEntry {
  port: number
  /** 本地监听地址（如 127.0.0.1 / [::] / 0.0.0.0）。 */
  address: string
  pid: number | null
  processName: string | null
}

/** readDistroStats() 结果：发行版内一次 `sh -c` 复合读取（meminfo/loadavg/df/uptime）。
 * 取不到的字段显式 null（部分输出/半途失败都不硬造数值，docs/09 §8.2）。 */
export interface WslDistroStats {
  memTotalKb: number | null
  memFreeKb: number | null
  memAvailKb: number | null
  /** loadavg 第 1 列（1 分钟负载）。 */
  load1: number | null
  diskTotal: string | null
  diskUsed: string | null
  diskAvail: string | null
  diskPct: number | null
  uptimeSec: number | null
}

// --- docker.ts ---

/** dockerInfo() 结果：CLI / daemon 两级可用性结构化表达。 */
export interface DockerStatus {
  cliAvailable: boolean
  /** daemon 不可达是常态而非异常（docs/02 §4），必须结构化降级。 */
  daemonAvailable: boolean
  clientVersion?: string
  serverVersion?: string
  /** 降级原因（CLI 缺失 / daemon unreachable / 超时等）。 */
  reason?: string
}

/** listImages() 行：`docker images --format '{{json .}}'` 逐行 JSON 解析（S4）。 */
export interface DockerImageInfo {
  repository: string
  tag: string
  /** 镜像 ID（sha12 前缀形态，docker 原样输出）。 */
  imageId: string
  /** 人类可读大小（如 `1.2GB`，docker 原样输出）。 */
  size: string
  /** 人类可读创建时间（CreatedSince 优先，CreatedAt 兜底）。 */
  createdAt: string
}

// --- fs.ts ---

/** discoverProjects(rootPath) 行：扫描根一级目录的候选项目。 */
export interface DiscoveredProject {
  /** 目录名。 */
  name: string
  /** Windows 绝对路径。 */
  winPath: string
  /** 等价的 WSL 路径（wslPathForWinPath 映射）。 */
  wslPath: string
  /** 命中的最高优先级标记对应的运行时提示（如 git/node/python/...）。 */
  runtimeHint: string
  /** 该目录命中的全部标记文件名（*.sln/*.csproj 以扩展名形式记录）。 */
  markers: string[]
}

// ---------------------------------------------------------------------------
// 4. Scan lifecycle (docs/03 3.13, docs/04 scan channels)
// ---------------------------------------------------------------------------

export type ScanKind = 'full' | 'projects' | 'services' | 'environment'
export type ScanStatusType = 'running' | 'done' | 'cancelled' | 'failed'

/** scan:status 返回的扫描状态。 */
export interface ScanStatus {
  scanId: number
  kind: ScanKind
  rootPath?: string
  status: ScanStatusType
  startedAt: number
  finishedAt?: number
  foundCount: number
  errorSummary?: string
}

// ---------------------------------------------------------------------------
// 5. Diagnostics (environment:doctor, dashboard warnings)
// ---------------------------------------------------------------------------

/** 通用诊断条目（父任务约定的 severity 枚举）。 */
export interface Diagnostic {
  severity: 'info' | 'warning' | 'error'
  title: string
  detail?: string
  suggestion?: string
}

/** environment:doctor 检查项（docs/04）。severity 统一三态：info / warning / error。 */
export interface DoctorCheck {
  id: string
  severity: 'info' | 'warning' | 'error'
  title: string
  detail?: string
  suggestion?: string
}

/** wslStatus（dashboard:summary）。 */
export interface WslStatus {
  available: boolean
  distros: string[]
  detail?: string
}

/** dashboard:summary warnings 元素。severity 与 DoctorCheck 统一三态（Step 5 裁决修订 #1）。 */
export interface DashboardWarning {
  severity: 'info' | 'warning' | 'error'
  title: string
  detail?: string
}

/**
 * dashboard:summary 结果（docs/04 原文字段）：
 * projectCount / dirtyRepoCount / dockerRunning / dockerTotal / wslStatus /
 * serviceCount / recentProjects / warnings。
 */
export interface DashboardSummary {
  projectCount: number
  dirtyRepoCount: number
  dockerRunning: number
  dockerTotal: number
  wslStatus: WslStatus
  serviceCount: number
  recentProjects: ProjectSummary[]
  warnings: DashboardWarning[]
}

// ---------------------------------------------------------------------------
// 6. Per-channel payloads & results (docs/04 §2, 21 channels)
// ---------------------------------------------------------------------------

export type EmptyPayload = Record<string, never>

/** 通用打开类结果。 */
export interface OpenResult {
  opened: true
}

// --- scan ---
export interface ScanStartPayload {
  kind: ScanKind
}
export interface ScanStartResult {
  scanId: number
}
export interface ScanStatusPayload {
  scanId?: number
}
export interface ScanCancelPayload {
  scanId: number
}
export interface ScanCancelResult {
  cancelled: boolean
}

// --- projects CRUD ---
export interface ProjectsListPayload extends EmptyPayload {}
export type ProjectsListResult = ProjectSummary[]
export interface ProjectsGetPayload {
  id: number
}

/**
 * 三张 001 已建但尚无 service 实现的表（skills / mcp_servers / archives，docs/03 §2）
 * 的显式占位（docs/08 §6.4）：不猜测、不返回空数组冒充实现。
 */
export interface NotAvailablePlaceholder {
  notAvailable: true
  reason: 'TABLE_EXISTS_NO_SERVICE'
}

/** 项目资源关系边投影（resources + relationships 读查询，docs/05）。 */
export interface ProjectRelationshipEdge {
  relation: 'uses' | 'contains' | 'depends_on' | 'located_in'
  /** outgoing = project 为 source；incoming = project 为 target。 */
  direction: 'outgoing' | 'incoming'
  resourceType: string
  refId: number
  displayName: string
}

export interface ProjectDetail extends ProjectSummary {
  description?: string
  repositories: Repository[]
  containers: ContainerRecord[]
  services: ServiceRow[]
  environments: EnvironmentWithTools[]
  /** M2（docs/08 §6.4）：三张已建表无 service 实现的显式占位。 */
  skills: NotAvailablePlaceholder
  mcpServers: NotAvailablePlaceholder
  archives: NotAvailablePlaceholder
  /** M2：项目资源关系边列表（resources/relationships 读查询）。 */
  relationships: ProjectRelationshipEdge[]
}
export type ProjectsGetResult = ProjectDetail
export interface ProjectsAddPayload {
  winPath?: string
  wslPath?: string
  name?: string
  description?: string
  runtimeHint?: string
}
export type ProjectsAddResult = ProjectSummary
export interface ProjectsRemovePayload {
  id: number
}
export interface ProjectsRemoveResult {
  removed: boolean
}
export interface ProjectsRescanPayload {
  id?: number
}
export type ProjectsRescanResult = ScanStartResult
export interface ProjectsUpdatePayload {
  id: number
  name?: string
  description?: string
  winPath?: string
  wslPath?: string
  runtimeHint?: string
}
export type ProjectsUpdateResult = ProjectSummary

// --- projects open ---
export interface OpenFolderPayload {
  id: number
}
export interface OpenVSCodePayload {
  id: number
  wsl?: boolean
}
export interface OpenTerminalPayload {
  id: number
  wsl?: boolean
}
export interface OpenWSLPayload {
  id: number
}

// --- environment ---
export interface EnvironmentDetectPayload extends EmptyPayload {}
export interface EnvironmentDetectResult {
  environments: EnvironmentWithTools[]
}
export interface EnvironmentDoctorPayload extends EmptyPayload {}
export interface EnvironmentDoctorResult {
  checks: DoctorCheck[]
}

// --- services ---
export interface ServicesListPayload {
  port?: number
}
export type ServicesListResult = ServiceRow[]
export interface ServicesRefreshPayload extends EmptyPayload {}
/**
 * Step 5 决议：refresh 返回本轮写入/更新的记录 + 本次 services 扫描行 id
 * （docs/04 services:refresh 的 result 描述已同步）。
 */
export interface ServicesRefreshResult {
  records: ServiceRecord[]
  scanId: number
}

// --- dashboard / settings / app ---
export interface DashboardSummaryPayload extends EmptyPayload {}
export type DashboardSummaryResult = DashboardSummary
export interface SettingsGetPayload {
  key: string
}
export interface SettingsGetResult {
  key: string
  value: string
}
export interface SettingsSetPayload {
  key: string
  value: string
}
export interface SettingsSetResult {
  saved: true
}
export interface AppVersionPayload extends EmptyPayload {}
export interface AppVersionResult {
  appVersion: string
  electronVersion: string
  nodeVersion: string
}

// ---------------------------------------------------------------------------
// 6a. Skills domain (S2 batch, docs/09 §1-§5; LinkState five states ported verbatim)
// ---------------------------------------------------------------------------

/** 链接五态（docs/09 §4.1，原样移植）：判定永远以真实文件系统为准。 */
export type LinkState = 'linked' | 'missing' | 'wrong-target' | 'real-dir' | 'vault-missing'

/** vault skills/<name>/SKILL.md 的扫描投影。 */
export interface SkillMeta {
  name: string
  hasSkillMd: boolean
  description: string
}

/** doctor 检查项（docs/09 §4.3，原样移植）。 */
export interface SkillDoctorItem {
  id: string
  severity: 'error' | 'warn' | 'info'
  message: string
  fixable: boolean
  fixId?: string
  payload?: Record<string, unknown>
}

/** 双侧同步步骤日志（docs/09 §9 skills:sync）。 */
export interface SkillSyncStep {
  side: 'windows' | 'wsl'
  cmd: string
  ok: boolean
  detail: string
}

/** skill_agents 表投影（camelCase，include 已解析）。 */
export interface SkillAgentInfo {
  id: number
  name: string
  platform: 'windows' | 'linux'
  skillsDir: string
  agentsDir?: string
  /** include 白名单：["*"] 全包含，或技能名数组。 */
  include: string[]
  enabled: boolean
}

/** 单 agent 的实时链接态视图（Windows 侧 fs 直测；WSL 侧来自 companion 缓存）。 */
export interface SkillAgentScanView extends SkillAgentInfo {
  /** windows = 实时探测；companion-cache = 最近一次 WSL companion 扫描；none = 不可用。 */
  probe: 'windows' | 'companion-cache' | 'none'
  available: boolean
  reason?: string
  /** companion 缓存命中且已过期（>10 分钟）时为 true，UI 标注。 */
  stale?: boolean
  /** skill 名 → 五态（仅 include 命中的 skill）。 */
  links: Record<string, LinkState>
  agentsDirState?: LinkState
  /** agentsDir 状态附注（如「硬链接共享」）。 */
  agentsDirNote?: string
  /** vault agents/ 的 .md 清单（配置了 agentsDir 时返回）。 */
  agentFiles?: string[]
  /** 五态计数（UI 链接统计徽章）。 */
  counts: { linked: number; missing: number; wrongTarget: number; realDir: number; vaultMissing: number }
}

/** skills 表行投影（skills:list）。 */
export interface SkillRow {
  id: number
  name: string
  description: string
  vaultRelPath?: string
  sourcePath?: string
  updatedAt: number
}

/** 导入计划（docs/09 §5；frontmatter 为 SKILL.md 预览解析）。 */
export interface SkillImportPlan {
  ok: boolean
  error?: string
  sourceDir: string
  sourceRealPath: string
  sourceIsLink: boolean
  skillName: string
  nameOk: boolean
  hasSkillMd: boolean
  targetDir: string
  fileCount: number
  totalBytes: number
  vaultConflict: boolean
  actions: string[]
  frontmatter?: { name?: string; description?: string }
}

/** WSL companion 扫描的单 agent 负载（skm scan 原样输出；缓存与 skills:scanWsl 同构）。 */
export interface CompanionAgentScan {
  name: string
  platform: 'windows' | 'linux'
  skillsDir: string
  links: Record<string, LinkState>
  agentsDir?: string
  agentsDirState?: LinkState
  agentsDirNote?: string
  agentFiles?: string[]
}

/** WSL companion 扫描缓存负载（与 skills:scanWsl 的 report 同构）。 */
export interface WslSkillsScanPayload {
  ts: number
  skills: SkillMeta[]
  agents: CompanionAgentScan[]
}

// ---------------------------------------------------------------------------
// 6b. Skills per-channel payloads & results (docs/09 §9 skills group)
// ---------------------------------------------------------------------------

export interface SkillsScanPayload extends EmptyPayload {}
export interface SkillsScanResult {
  vaultPath: string
  vaultOk: boolean
  /** vault 健康问题（skills/、agents/、.git 缺失等），空数组 = 健康。 */
  issues: string[]
  skills: SkillMeta[]
  agents: SkillAgentInfo[]
}

export interface SkillsScanWslPayload extends EmptyPayload {}
export interface SkillsScanWslResult {
  report: WslSkillsScanPayload | null
  /** stale=true 表示本次 companion 不可达/超时，report 来自缓存。 */
  stale: boolean
  reason?: string
}

export interface SkillsListPayload extends EmptyPayload {}
export interface SkillsListResult {
  skills: SkillRow[]
}

export interface SkillsAgentsPayload extends EmptyPayload {}
export interface SkillsAgentsResult {
  agents: SkillAgentScanView[]
}

export interface LinkStatesPayload {
  agentId?: number
}
export interface LinkStatesResult {
  agents: SkillAgentScanView[]
}

/** toggleLink / import / repair / sync / deploy 共用的待确认返回分支。 */
export interface SkillsConfirmRequired {
  confirmRequired: true
}

export interface SkillsTogglePayload {
  agentId: number
  skill: string
  enable: boolean
  confirmed?: boolean
}
export interface SkillsToggleResult extends Partial<SkillsConfirmRequired> {
  changed: boolean
  state: LinkState
  agentId: number
  skill: string
  steps: string[]
}

export interface SkillsImportPayload {
  sourceDir: string
  /** 导入完成后要建立链接的目标 agent（缺省不建链，仅入 vault）。 */
  agentIds?: number[]
  confirmed?: boolean
}
export interface SkillsImportResult extends Partial<SkillsConfirmRequired> {
  plan: SkillImportPlan
  steps: string[]
  /** 执行成功后各 agent 对该 skill 的链接态（缺省 = 仅返回 plan）。 */
  links?: Record<string, LinkState>
}

export interface SkillsDoctorPayload {
  agentId?: number
}
export interface SkillsDoctorResult {
  items: SkillDoctorItem[]
}

export interface SkillsRepairPayload {
  fixId: string
  payload?: Record<string, unknown>
  confirmed?: boolean
}
export interface SkillsRepairResult extends Partial<SkillsConfirmRequired> {
  steps: string[]
  state?: LinkState
  note?: string
  /** real-dir 等永不自动处理的项：manualRequired=true，message 说明人工动作。 */
  manualRequired?: boolean
  message?: string
}

export interface SkillsSyncPayload {
  confirmed?: boolean
}
export interface SkillsSyncResult extends Partial<SkillsConfirmRequired> {
  steps: SkillSyncStep[]
  conflicts: string[]
  /** 结构化降级（vault 缺失 / 非 git 仓 / git 不可用）：未执行完整同步。 */
  degraded?: boolean
  reason?: string
  lastSyncAt?: number
}

export interface AgentUpsertPayload {
  /** 有值 = 更新既有行；缺省 = 按 name upsert（存在则更新，否则插入）。 */
  id?: number
  name: string
  platform: 'windows' | 'linux'
  skillsDir: string
  agentsDir?: string
  include: string[]
  enabled?: boolean
}
export interface AgentUpsertResult {
  agent: SkillAgentInfo
}

export interface AgentRemovePayload {
  id: number
}
export interface AgentRemoveResult {
  removed: boolean
}

export interface CompanionStatusPayload extends EmptyPayload {}
export interface CompanionStatusResult {
  /** WSL 本身可用（有可用的发行版）。 */
  wslAvailable: boolean
  wslReason?: string
  distro?: string
  /** /root/skill-vault 目录存在性（WSL 不可达时 null = 未知，绝不猜测）。 */
  vaultDirExists: boolean | null
  /** <WSL_VAULT>/bin/skm.mjs 存在性。 */
  companionFileExists: boolean | null
  /** Windows 侧已构建的零依赖 bundle 是否可用。 */
  bundleBuilt: boolean
  bundlePath?: string
  vaultPath: string
}

export interface CompanionDeployPayload {
  confirmed?: boolean
}
export interface CompanionDeployResult extends Partial<SkillsConfirmRequired> {
  deployed: boolean
  steps: string[]
  reason?: string
}

// ---------------------------------------------------------------------------
// 6c. ApiHub（S3 批次，docs/09 §6/§9）—— key 全值红线：一切对外投影只有
// apiKeyTail（尾 4 位）与 apiKeyLen；key 全值只出现在主进程切换/写文件瞬间。
// ---------------------------------------------------------------------------

export type ApiHubAdapterId =
  | 'claude-cli'
  | 'claude-desktop'
  | 'codex'
  | 'grok'
  | 'kimi'
  | 'zcode'
  | 'deepseek'

/** 适配器表单字段定义（UI 动态渲染表单用）。 */
export interface ApiHubFieldDef {
  key: string
  label: string
  placeholder?: string
  kind?: 'text' | 'select'
  options?: string[]
  advanced?: boolean
}

export interface ApiHubAdapterInfo {
  id: ApiHubAdapterId
  label: string
  available: boolean
  naReason?: string
  notes: string[]
  needsKey: boolean
  fieldDefs: ApiHubFieldDef[]
}

/** apihub:adapters 行（catalog + 当前 home 计算出的目标文件与预检进程）。 */
export interface ApiHubAdapterEntry extends ApiHubAdapterInfo {
  targetPaths: string[]
  /** 切换预检的进程名（空数组 = 无预检）。 */
  processNames: string[]
}

/** apihub_profiles 行的脱敏视图（绝无 key 全值）。 */
export interface ApiHubProfileView {
  id: number
  provider: ApiHubAdapterId
  name: string
  fields: Record<string, string>
  apiKeyTail: string | null
  apiKeyLen: number | null
  /** blob 为明文降级形态（base64），UI 强提示。 */
  plainStore: boolean
  /** 密钥待重加密/重录：禁止切换，UI 引导重填 key。 */
  needsRekey: boolean
  createdAt: number
  updatedAt: number
}

export interface ApiHubAdaptersPayload extends EmptyPayload {}
export interface ApiHubAdaptersResult {
  adapters: ApiHubAdapterEntry[]
}

export interface ApiHubCurrentPayload {
  adapterId: ApiHubAdapterId
}
export interface ApiHubCurrentResult {
  adapterId: ApiHubAdapterId
  available: boolean
  naReason?: string
  configPaths: string[]
  baseUrl: string | null
  apiKeyTail: string | null
  apiKeyLen: number | null
  detail: Record<string, string>
  /** 按目标文件当前内容反推命中的档案（激活态不落库，docs/09 §3.4）。 */
  matchedProfileId: number | null
}

export interface ApiHubProfilesPayload {
  adapterId: ApiHubAdapterId
}
export interface ApiHubProfilesResult {
  profiles: ApiHubProfileView[]
  /** readCurrent 反推的当前生效档案（无匹配为 null）。 */
  activeId: number | null
}

export interface ApiHubProfileInput {
  adapterId: ApiHubAdapterId
  /** 有值 = 编辑既有档案；缺省 = 新增。 */
  id?: number
  name: string
  fields: Record<string, string>
}

export interface ApiHubSaveProfilePayload {
  input: ApiHubProfileInput
  /** 明文 key 仅本次 payload 携带；主进程立即 seal。编辑留空 = 不改动 key。 */
  apiKeyPlain?: string
}
export interface ApiHubSaveProfileResult {
  profile: ApiHubProfileView
}

export interface ApiHubDeleteProfilePayload {
  adapterId: ApiHubAdapterId
  id: number
}
export interface ApiHubDeleteProfileResult {
  deleted: boolean
}

/** 切换影响预览：将写入的文件 + 检测到的运行中进程。 */
export interface ApiHubSwitchImpacts {
  files: string[]
  processes: { pid: number; name: string }[]
  warning?: string
}

export interface ApiHubSwitchPayload {
  adapterId: ApiHubAdapterId
  id: number
  confirmed?: boolean
  /** 可选终止运行中进程：必须显式给出 impacts 里列出的 pid（再次确认语义）。 */
  killPids?: number[]
}
export interface ApiHubSwitchStart {
  confirmRequired: true
  impacts: ApiHubSwitchImpacts
}

/** 逐目标文件结果（written/rolledBack 结构化，docs/09 §6.3）。 */
export interface ApiHubFileResult {
  path: string
  written: boolean
  rolledBack: boolean
  error?: string
}

export interface ApiHubSwitchResult {
  /** 判别字段：结果分支恒为 undefined（Start 分支为 true）。 */
  confirmRequired?: undefined
  files: ApiHubFileResult[]
  backupFiles: string[]
  warning?: string
  /** 写入/校验失败且已回滚时为 true（UI 失败文件标红 + 已回滚提示）。 */
  failed?: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// 6d. 版本中心（S3 批次，docs/09 §7/§9）
// ---------------------------------------------------------------------------

export type VersionTargetKind = 'npm' | 'winget' | 'native' | 'github'

/** version_targets.state（checking 仅渲染层占位，不入库）。 */
export type VersionTargetState = 'up-to-date' | 'upgradable' | 'unknown' | 'check-failed' | 'detect-only'

/** 单目标检测快照（versions:list / versions:check / job.after 共用投影）。 */
export interface VersionStatus {
  id: string
  name: string
  channel: string
  channelKind: VersionTargetKind
  installed: string | null
  latest: string | null
  state: VersionTargetState
  note?: string
  /** catalog UI 提示（如「更新会关闭 ZCode」）。 */
  hint?: string
  lastCheckedAt: number | null
}

export interface VersionsListPayload extends EmptyPayload {}
export interface VersionsListResult {
  targets: VersionStatus[]
}

export interface VersionsCheckPayload {
  /** 缺省全查（8 目标）；有值只查该条。 */
  id?: string
}
export interface VersionsCheckResult {
  ts: number
  statuses: VersionStatus[]
  /** 实时检查全部失败回落上次快照时为 true。 */
  stale: boolean
  reason?: string
}

export interface VersionsUpdatePayload {
  id: string
  confirmed?: boolean
}
export interface VersionsUpdateResult {
  confirmRequired?: true
  /** blocked=true：目标进程运行中（processName 携带），UI 确认后带 confirmed 重发。 */
  blocked?: boolean
  running?: boolean
  processName?: string
  jobId?: string
}

export interface VersionsJobPayload {
  jobId: string
}
export interface VersionJobSnapshot {
  jobId: string
  entryId: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  /** 内存环形日志尾部（截断）。 */
  log: string[]
  error?: string
  /** done 后自动重查一次的快照。 */
  after?: VersionStatus
}

/** 夜间#1 批次（docs/09 §7.2 cancelled 分支的主动取消落地）：缺省 jobId = 取消当前
 *  唯一活跃 job；多个活跃 job 时不指定 jobId → BAD_PAYLOAD（消除按 id 取消假象）。 */
export interface VersionsCancelPayload {
  jobId?: string
}
export interface VersionsCancelResult {
  /** true = 本次调用真实把 running job 置为 cancelled（killTree 收尾）。 */
  cancelled: boolean
  jobId?: string
  entryId?: string
  /** 目标 job 调用后状态（cancelled / done / failed / running）；无活跃 job 时缺省。 */
  status?: 'running' | 'done' | 'failed' | 'cancelled'
  /** 结构化说明（no-op 原因等）。 */
  note?: string
}

// ---------------------------------------------------------------------------
// 6e. Docker（S4 批次，docs/09 §8.1/§9）。daemon 不可用是常态而非异常：
// 三个 channel 全部结构化降级（available:false / ok:false + reason），绝不 throw。
// 变更动作 action 为 CONFIRM_REQUIRED 两段式（start/stop/restart；docs/09 §8.3）。
// 夜间#1 批次：action 扩 'remove'（docs/09 §8.3 DOUBLE_CONFIRM 档 —— wire 契约仍为
// confirmed 两段式；额外名称匹配在 UI 确认步落地，docs/09 §8.1「输入容器名匹配」）。
// ---------------------------------------------------------------------------

export type DockerActionName = 'start' | 'stop' | 'restart' | 'remove'

export interface DockerOverviewPayload extends EmptyPayload {}

/** docker:overview 的容器行（归因不到 project → 字面量 'unknown'，docs/08 §6.8 同款）。 */
export interface DockerOverviewContainer {
  dockerId: string
  name: string
  image?: string
  state?: string
  ports: ContainerPortMapping[]
  project: string
}

/** 镜像列表 + 简要统计（镜像不落库，瞬时读；docs/09 §8.1）。 */
export interface DockerImagesInfo {
  available: boolean
  reason?: string
  images: DockerImageInfo[]
  count: number
  /** repository 为 `<none>` 的悬空镜像数。 */
  danglingCount: number
}

export interface DockerOverviewResult {
  status: {
    available: boolean
    cliAvailable: boolean
    daemonAvailable: boolean
    clientVersion?: string
    serverVersion?: string
    reason?: string
  }
  containers: DockerOverviewContainer[]
  images: DockerImagesInfo
}

export interface DockerLogsPayload {
  /** 容器名或 ID 前缀（`[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`，网关校验）。 */
  name: string
  /** 尾部行数（1-500，>500 截到 500，负数/非整数 BAD_PAYLOAD）。 */
  tail?: number
  /** 只读最近 N 秒（缺省全量 tail）。 */
  since?: number
}

export interface DockerLogsResult {
  ok: boolean
  name: string
  /** 实际生效的 tail（>500 已截到 500）。 */
  tail: number
  text: string
  /** 文本超过 64KB 上限被截断时为 true（提示调小 tail）。 */
  truncated?: boolean
  error?: string
}

/** 动作影响面（confirmRequired 段展示）：容器现状 + 发布端口 + 关联项目。
 *  remove 分支 ports 恒为空数组（删除语义无关端口），note 说明数据面影响。 */
export interface DockerActionImpacts {
  name: string
  image?: string
  state?: string
  ports: ContainerPortMapping[]
  project?: string
  note?: string
}

export interface DockerActionStart {
  confirmRequired: true
  impacts: DockerActionImpacts
}

export interface DockerActionPayload {
  name: string
  action: DockerActionName
  confirmed?: boolean
}

export interface DockerActionResult {
  /** 判别字段：结果分支恒为 undefined（Start 分支为 true，apihub:switch 同款）。 */
  confirmRequired?: undefined
  ok: boolean
  name: string
  action: DockerActionName
  /** docker CLI 输出摘要（截断 300）。 */
  detail?: string
  /** ok:false 时给出原因（daemon 不可用 / CLI 失败）。 */
  error?: string
  /** true = 未执行的结构化降级（daemon 不可用），非 CLI 失败。 */
  degraded?: boolean
}

// ---------------------------------------------------------------------------
// 6f. WSL（S4 批次，docs/09 §8.2/§9）。铁律：绝不为了取数而启动已停止的发行版；
// terminate 为 CONFIRM_REQUIRED 两段式（impacts = 该发行版当前监听端口），
// boot 无害直接执行（wsl -d <distro> -e true 幂等唤醒）。
// 夜间#1 批次：action 扩 'shutdownAll'（docs/09 §8.2 CONFIRM_REQUIRED + 二次确认
// 文案；impacts = 将停的全部发行版清单；语义 = 全停，绝不唤醒任何已停发行版）。
// ---------------------------------------------------------------------------

/** 单发行版概要视图：stats 仅对 Running 且非 docker-desktop 系探测；取不到为 null。 */
export interface WslDistroStatView {
  name: string
  state: string
  version: string
  isDefault?: boolean
  /** docker-desktop 系由 Docker Desktop 管理：不取数、只显示状态。 */
  managedByDocker?: boolean
  stats: WslDistroStats | null
  reason?: string
}

export interface WslDistroStatsPayload {
  /** 缺省 = 全部已知发行版概要；有值 = 单发行版（须在已知发行版列表内）。 */
  distro?: string
}

export interface WslDistroStatsResult {
  available: boolean
  reason?: string
  /** 采样时刻（unix 秒）。 */
  sampledAt: number
  distros: WslDistroStatView[]
}

export type WslActionName = 'terminate' | 'boot' | 'shutdownAll'

/** terminate 影响面：该发行版当前监听的 TCP 端口（复用 wslListeningSockets 数据）。 */
export interface WslActionImpacts {
  distro: string
  state: string
  listeningPorts: WslPortEntry[]
  note?: string
}

/** shutdownAll 影响面：`wsl.exe --shutdown` 将停掉的全部发行版清单（语义 = 全停，
 *  含 docker-desktop 系 —— 由 VM 级关停一并带走，note 显式标注，docs/09 §8.2）。 */
export interface WslShutdownAllImpacts {
  distros: Array<{ name: string; state: string }>
  /** 将被一并停掉的 docker-desktop 系发行版名（空数组 = 无）。 */
  dockerDesktopDistros: string[]
  note?: string
}

export interface WslActionStart {
  confirmRequired: true
  /** 判别字段（Start 分支之间互斥：shutdownAll 段见 WslShutdownAllStart）。 */
  action?: 'terminate'
  impacts: WslActionImpacts
}

export interface WslShutdownAllStart {
  confirmRequired: true
  /** 判别字段（UI 依赖它与 terminate 段互斥收窄）。 */
  action: 'shutdownAll'
  impacts: WslShutdownAllImpacts
}

export interface WslActionPayload {
  /** terminate/boot 必填（网关按 action 分支校验）；shutdownAll 不需要（全停语义）。 */
  distro?: string
  action: WslActionName
  confirmed?: boolean
}

export interface WslActionResult {
  /** 判别字段：结果分支恒为 undefined（Start 分支为 true，apihub:switch 同款）。 */
  confirmRequired?: undefined
  ok: boolean
  distro: string
  action: WslActionName
  /** wsl.exe 输出摘要（截断）。 */
  detail?: string
  error?: string
}

export interface WslShutdownAllResult {
  confirmRequired?: undefined
  ok: boolean
  action: 'shutdownAll'
  /** 执行前观测到的 Running 发行版数（0 = 结构化 no-op）。 */
  runningBefore: number
  /** 执行前观测到的发行版总数。 */
  totalBefore: number
  detail?: string
  error?: string
}

// ---------------------------------------------------------------------------
// 6g. Archive（S5 批次，docs/10 全文权威）。安全规则五条（docs/10 §10）：
// 1 强制 dry-run 预览——archive:run 必须携带 preview 签发的 previewId，服务端
//   校验确有已完成的预览记录（内存注册表 + 10 分钟超时失效）；
// 2 UI 二次确认——确认页展示命中/影响文件/剥离目录/old→new 路径后才可 confirmed；
// 3 绝不删数据，只移动 + 备份——修复改写前逐文件备份；删源只在复制校验全通过后；
// 4 回滚必须可用——undo 清单 + copyFile 覆写，幂等可重复执行；
// 5 非法路径拒绝——old_path 必须 == projects.win_path；dest_root 不得位于
//   old_path 内部（防自吞）；跨设备移动只允许常规本地卷（盘符，非 UNC）。
// ---------------------------------------------------------------------------

/** 单处旧路径引用命中（老 PathHit 原样移植；file 为扫描时的旧位置绝对路径）。 */
export interface ArchivePathHit {
  file: string
  line: number
  col: number
  snippet: string
  matched: string
}

/** 引用扫描报告（walker 产出；hits 发给渲染层时截断，totalHits 恒为真实值）。 */
export interface ArchiveScanReport {
  hits: ArchivePathHit[]
  totalHits: number
  scannedFiles: number
  skippedBinary: number
  skippedOversize: number
  /** 单文件失败摘要（降级继续，docs/10 §1） */
  errorSummary: string[]
}

/** 占用项目的进程（可执行路径/命令行引用了项目路径；cmd 截断展示）。 */
export interface ArchiveOccupier {
  pid: number
  name: string
  cmd: string
}

/**
 * archive:preview 的完整影响面（impacts）。安全规则 2：UI 必须把命中文件数、
 * 影响文件清单、剥离目录、old→new 路径、占用进程全部展示后才允许 confirmed。
 */
export interface ArchivePreviewImpacts {
  projectId: number
  projectName: string
  /** 被归档项目当前登记路径（== projects.win_path，安全规则 5） */
  oldPath: string
  destRoot: string
  /** 目标路径（<destRoot>/<name>-archived-YYYYMMDD(-N) 去重后） */
  destPath: string
  crossVolume: boolean
  occupiers: ArchiveOccupier[]
  /** 目录被句柄/CWD 锁定（终端/资源管理器停留），rename 移动探测失败 */
  dirLocked: boolean
  /** 将剥离的可再生依赖/缓存目录（剥离清单入 stripped_json） */
  depSkipDirs: string[]
  /** 引用扫描报告（hits 截断至 2000 条防渲染层 OOM；totalHits 真实值） */
  report: ArchiveScanReport
  /** 参与引用扫描的其他已登记项目名 */
  refProjects: string[]
}

export interface ArchivePreviewPayload {
  projectId: number
  /** 缺省读 settings.archive_dest_root */
  destRoot?: string
}

export interface ArchivePreviewResult {
  /** 服务端签发的预览凭证（'arc-<uuid>'）；archive:run 必须原样携带 */
  previewId: string
  /** 预览失效时刻（epoch ms；10 分钟） */
  expiresAt: number
  impacts: ArchivePreviewImpacts
}

export interface ArchiveRunPayload {
  previewId: string
  confirmed?: boolean
  /** 可选终止占用进程：必须显式给出 preview impacts 里列出的 pid（再次确认语义） */
  killPids?: number[]
}

export interface ArchiveRunStart {
  confirmRequired: true
  impacts: ArchivePreviewImpacts
}

/** 逐文件改写结果（kind: fixed=已改写 / skipped-non-utf8=跳过 / missing=不存在）。 */
export interface ArchiveFileFix {
  file: string
  count: number
  kind: 'fixed' | 'skipped-non-utf8' | 'missing'
}

export interface ArchiveRunResult {
  /** 判别字段：结果分支恒为 undefined（Start 分支为 true，apihub:switch 同款） */
  confirmRequired?: undefined
  /** archive_runs.id */
  runId: number
  movedFrom: string
  movedTo: string
  mode: 'renamed' | 'copied'
  /** 项目内部文件的逐文件结果（fixed / skipped-non-utf8 / missing） */
  fixed: ArchiveFileFix[]
  /** 其他已登记项目内引用文件的逐文件结果 */
  external: ArchiveFileFix[]
  totalReplacements: number
  /** 新路径下残留旧根引用数（非 0 不算失败但 UI 显式警示） */
  residualHits: number
  /** 本次剥离的依赖/缓存目录名 */
  skippedDeps: string[]
  skippedLinks: number
  /** 源目录删除失败的残留（不判定为失败，可手动清理） */
  sourceLeftovers: string[]
  durationMs: number
}

export interface ArchiveHistoryPayload {
  /** 缺省 100，上限 100 */
  limit?: number
}

export interface ArchiveRunRow {
  id: number
  projectId: number | null
  projectName: string
  oldPath: string
  newPath: string
  status: 'running' | 'done' | 'failed' | 'rolled-back'
  fixedFiles: number
  externalFiles: number
  residualHits: number
  /** 剥离目录名（stripped_json 解析；老导入数据为 null） */
  strippedDirs: string[] | null
  startedAt: number
  finishedAt: number | null
  /** undo 清单条数（回滚可用性提示；无清单/已清理为 null） */
  undoEntries: number | null
}

export interface ArchiveHistoryResult {
  runs: ArchiveRunRow[]
}

export interface ArchiveRollbackPayload {
  runId: number
  confirmed?: boolean
}

export interface ArchiveRollbackStart {
  confirmRequired: true
  impacts: {
    runId: number
    projectName: string
    oldPath: string
    newPath: string
    /** undo 清单条数（0 = 无内容回滚，仅目录移回 + projects 还原） */
    undoEntries: number
    fixedFiles: number
    note: string
  }
}

export interface ArchiveRollbackResult {
  confirmRequired?: undefined
  runId: number
  /** 内容回滚恢复的文件数（undo copyFile 覆写成功数） */
  restored: number
  undoEntries: number
  /** 目录是否已移回原位（原位置被占用时 false，内容已还原） */
  movedBack: boolean
  /** projects.win_path 是否已还原为 old_path */
  projectsRestored: boolean
  status: 'rolled-back'
  note: string
}

/** 执行阶段（archive:status 轮询；docs/10 §11 进度复用轮询模式，无广播 channel）。 */
export type ArchivePhase = 'moving' | 'fixing' | 'verifying' | 'done' | 'failed'

export interface ArchiveStatusPayload {
  previewId: string
}

export interface ArchiveStatusResult {
  /** 该 previewId 是否有进行中/刚结束的执行 */
  active: boolean
  phase: ArchivePhase
  /** 跨卷复制进度 0-100（同卷 rename 无此字段） */
  percent?: number
  /** 阶段日志尾部（截断 30 条） */
  logTail: string[]
}

// ---------------------------------------------------------------------------
// 6h. Agent Control（AC2 批次，docs/14 §A.1 13 条 + docs/12 §4 共享枚举）。
// 轮询模式（docs/14 §A.3）：无广播 channel，事件经 agents:events 游标拉取。
// SessionStatus 为 AC1 修正后的 9 值权威（docs/12 §4：用户锁定 7 态 +
// stopped/unknown 辅助态；DB 层该列为注释枚举，docs/13 §4.2）。
// ---------------------------------------------------------------------------

/** provider 业务标识（docs/12 §4 ProviderId；Grok 预留不入联合，docs/12 §11）。 */
export type AgentProviderId = 'codex' | 'claude-code' | 'kimi' | 'zcode' | 'deepseek'

/** 会话三模式（docs/12 §5：managed/attached 有输入通道，observed 纯观察）。 */
export type SessionMode = 'managed' | 'attached' | 'observed'

/** 控制能力全集（docs/12 §4 AgentCapability；手机 v1 与桌面 IPC 同集）。 */
export type AgentCapability = 'reply' | 'pause' | 'resume'

/** 会话状态 9 值全集（docs/12 §4；对外展示用户锁定 7 态，辅助 2 态透明展示）。 */
export type SessionStatus =
  // —— 用户锁定 7 态（对外展示全集）——
  | 'running'
  | 'completed'
  | 'failed'
  | 'waiting_input' // 等待用户文本输入
  | 'approval_required' // 等待工具执行批准（与 waiting_input 独立）
  | 'paused'
  | 'connection_lost' // 监控源失联（非会话终态）
  // —— 辅助态（9 值全集，UI 透明展示）——
  | 'stopped' // 有终态记录的正常停止
  | 'unknown' // 判定未定（skills 先例：绝不猜实时态）

/** provider 健康四态（agent_providers.health，docs/13 §4.1）。 */
export type AgentHealth = 'ok' | 'degraded' | 'unavailable' | 'unknown'

/** 事件投递状态机（pending → delivered → acked，只前进不回退，docs/12 §6）。 */
export type EventDeliveryState = 'pending' | 'delivered' | 'acked'

/** 能力集（docs/12 §5）：granted 只含「此刻真实验证存在」的能力；空数组 = 无控制能力。 */
export interface AgentCapabilitySet {
  mode: SessionMode
  granted: AgentCapability[]
  /** unix 秒；>300s 视为过期，重新验证。 */
  verifiedAt: number
  /** 验证依据（如 'app-server handshake ok' / 'hooks registered' / 'read-only source'）。 */
  evidence: string
}

// --- agents:providers ---

/** agents:providers 行（docs/14 §A.1 #1；capabilities 来自 agent_providers.capabilities_json）。 */
export interface AgentProviderView {
  id: number
  displayName: string
  installed: boolean
  version?: string
  /** 可执行文件路径（仅展示，绝不存凭据）。 */
  exePath?: string
  health: AgentHealth
  /** 结构化降级原因（约束 #26）。 */
  healthDetail?: string
  capabilities: AgentCapabilitySet
  /** 每 provider 监控开关（总开关在 settings.agents_monitor_enabled）。 */
  enabled: boolean
  /** unix 秒；从未探测为 null。 */
  lastProbeAt: number | null
}

export interface AgentProvidersPayload extends EmptyPayload {}
export interface AgentProvidersResult {
  providers: AgentProviderView[]
  /** settings.agents_monitor_enabled 真值。 */
  monitorEnabled: boolean
  /** 本批探测时刻（unix 秒）；无探测数据为 null。 */
  probedAt: number | null
}

/** 夜间#1 批次（UX 验收 backlog：per-provider 单独重探，known-limitations §3.2）。
 *  force 语义：绕过 60s 探测节流，立即 probeHealth + 落库 + 该家会话快照强刷。 */
export interface AgentProbeProviderPayload {
  providerId: number
}
export interface AgentProbeProviderResult {
  /** 重探落库后该家投影（agent_providers 行视图）。 */
  provider: AgentProviderView
  /** 本次重探是否引起 health 变化（true = 落了一条 provider.health_changed 事件）。 */
  healthChanged: boolean
}

// --- agents:sessions ---

/** 会话视图（docs/14 §A.1 #2 SessionView；REST /v1/sessions 同构）。
 *  ux 批 A 起可选附加字段（全部向后兼容，缺省零变化）：providerKey/providerLabel
 *  （R4 识别 Agent）/ archivedAt（R3 归档时间戳）/ childSessions（R2，仅
 *  sessionDetail 投影填充，列表行恒缺省）。 */
export interface AgentSessionView {
  id: number
  providerId: number
  /** provider 原生 session ID。 */
  nativeId: string
  sessionMode: SessionMode
  projectId?: number
  title?: string
  status: SessionStatus
  statusDetail?: string
  startedAt?: number
  lastActivityAt?: number
  endedAt?: number
  /** 数据源过期标注，绝不猜实时态（docs/14 §A.1 #2）。 */
  stale: boolean
  /** provider 业务键（'codex' | 'claude-code' | ...，R4；投影自 agent_providers.provider）。 */
  providerKey?: string
  /** provider 展示名（'Codex' / 'Claude Code' / ...，R4；投影自 agent_providers.display_name）。 */
  providerLabel?: string
  /** 归档时刻（unix 秒；R3；未归档缺省）。 */
  archivedAt?: number
  /** 子会话（R2；含已结束；仅 sessionDetail 响应的 session 视图填充，列表行缺省）。 */
  childSessions?: AgentSessionView[]
}

export interface AgentSessionsPayload {
  providerId?: number
  projectId?: number
  status?: SessionStatus
  /** 正整数 ≤200，缺省 100。 */
  limit?: number
  /** 父会话 id（R2）：给定时返回其子会话（含已结束）；缺省只返回主会话（parent IS NULL）。 */
  parentId?: number
  /** R3：'1' 时归档会话可见；缺省隐藏归档。 */
  includeArchived?: boolean
}
export interface AgentSessionsResult {
  sessions: AgentSessionView[]
}

// --- agents:sessionDetail ---

export interface AgentSessionDetailPayload {
  sessionId: number
}
export interface AgentSessionDetailResult {
  session: AgentSessionView
  capabilities: AgentCapabilitySet
  counts: {
    messages: number
    events: number
  }
}

// --- agents:messages ---

/** 消息分段（R1/R8）：只在转录源有明确结构时产生（无结构 = 整段 text，绝不猜）。
 *  content 为脱敏投影，且 text/thinking 段内 plugin://、skill://、mcp:// 引用已
 *  替换为短标签（原始 URI 只保留在 contentRedacted 兼容字段，绝不出网）。 */
export interface AgentMessageSegment {
  kind: 'text' | 'thinking' | 'toolInvocation'
  /** 结构化标签（如 toolInvocation 的工具名）。 */
  label?: string
  content: string
}

/** agents:messages 行（contentRedacted 为脱敏投影；完整上下文按需加载，docs/15 §6）。 */
export interface AgentMessageView {
  id: number
  role: string
  contentRedacted: string
  occurredAt?: number
  sourceRef?: string
  /** R1 可选分段投影（源无结构 → 缺省，展示按整段 text）。 */
  segments?: AgentMessageSegment[]
}

export interface AgentMessagesPayload {
  sessionId: number
  /** 消息游标 id（返回 id 大于 after 的消息）。与 before/last 互斥。 */
  after?: number
  /** R10 尾部取数：返回 id 小于 before 的最新一页（ASC）。与 after/last 互斥。 */
  before?: number
  /** R10 尾部取数：返回最新 last 条（ASC）。与 after/before 互斥。 */
  last?: number
  /** ≤200。 */
  limit?: number
}
export interface AgentMessagesResult {
  items: AgentMessageView[]
  /** 还有下一页时为最后一条的 id（after 正向分页语义不变）。 */
  nextAfter?: number
  /** R10：仍有更早消息时为「本页最早一条」的 id（向旧翻页：before=prevAfter 续拉）。 */
  prevAfter?: number
}

// --- agents:events ---

/** agents:events 行（payload 为脱敏后 JSON 解析结果；id 即全局 sequence）。 */
export interface AgentEventView {
  id: number
  eventId: string
  eventType: string
  providerId?: number
  sessionId?: number
  summary?: string
  payload: Record<string, unknown>
  deliveryState: EventDeliveryState
  createdAt: number
}

export interface AgentEventsPayload {
  /** sequence 游标（返回 id 大于 after 的事件）。 */
  after?: number
  providerId?: number
  sessionId?: number
  /** ≤200。 */
  limit?: number
}
export interface AgentEventsResult {
  events: AgentEventView[]
  /** 还有下一页时为最后一条的 sequence。 */
  nextAfter?: number
}

// --- agents:sessionAction ---

export interface AgentSessionActionPayload {
  sessionId: number
  action: AgentCapability
  /** reply 必带 text 非空 ≤4000 字符（docs/14 §A.1 #6）。 */
  text?: string
  /** 直执行（用户显式输入不经 CONFIRM_REQUIRED），占位保留契约形状。 */
  confirmed?: boolean
}
export interface AgentSessionActionResult {
  commandId: string
  status: 'accepted' | 'executed' | 'rejected'
  error?: DomainError
}

// --- agents:pairingCreate ---

export interface AgentPairingCreatePayload {
  deviceName?: string
}
export interface AgentPairingCreateResult {
  pairingId: string
  /** 8 位 Crockford Base32，TTL 300s，一次性；明文只在本次返回中出现（docs/15 §2）。 */
  code: string
  /** unix 秒。 */
  expiresAt: number
}

// --- agents:devices ---

/** agents:devices 行（绝无 Token 明文/哈希，docs/14 §A.1 #8）。 */
export interface AgentDeviceView {
  id: number
  deviceName: string
  platform: string
  status: 'active' | 'revoked'
  pairedAt: number
  lastSeenAt?: number
  tokenVersion: number
}

export interface AgentDevicesPayload extends EmptyPayload {}
export interface AgentDevicesResult {
  devices: AgentDeviceView[]
}

// --- agents:deviceRevoke（CONFIRM_REQUIRED 两段式，docs/14 §A.1 #9） ---

export interface AgentDeviceRevokePayload {
  deviceId: number
  confirmed?: boolean
}

export interface AgentDeviceRevokeImpacts {
  deviceId: number
  deviceName: string
  lastSeenAt?: number
  note: string
}

export interface AgentDeviceRevokeStart {
  confirmRequired: true
  impacts: AgentDeviceRevokeImpacts
}

export interface AgentDeviceRevokeResult {
  /** 判别字段：结果分支恒为 undefined（Start 分支为 true，apihub:switch 同款）。 */
  confirmRequired?: undefined
  revoked: true
}

// --- agents:gatewayStatus / agents:gatewayRestart ---

/** NatPierce 隧道状态（用户自备第三方隧道，docs/15 §8；未配置为常态）。 */
export interface GatewayNatPierceStatus {
  configured: boolean
  reachable?: boolean
  hint?: string
}

/** agents:gatewayStatus 视图（docs/14 §A.1 #10；未启用 → enabled:false + running:false，结构化而非错误）。 */
export interface GatewayStatusView {
  enabled: boolean
  running: boolean
  /** settings.gateway_port 配置值。 */
  port: number
  /** 实际监听端口（顺延尝试后可能 ≠ port；未运行为 undefined）。 */
  actualPort?: number
  activeDevices: number
  natpierce: GatewayNatPierceStatus
  lastError?: string
  /** ECS Relay 投影（M2-R1，docs/19 §4.7 可选附加字段；disabled 时缺席 = 零噪声向后兼容）。 */
  relay?: RelayStatusView
}

/**
 * agents:gatewayStatus.relay 可选投影（docs/19 §4.7 D5：不新增 IPC channel，
 * 可选字段向后兼容）。凭据/注册码绝不入本投影（红线 docs/19 §2.2）。
 */
export interface RelayStatusView {
  enabled: boolean
  /** host leg 连接态（hello 已收且恢复序完成或进行中）。 */
  connected: boolean
  /** settings.relay_endpoint 原样（wss://…；未配置为空串）。 */
  endpoint: string
  /** ECS relay_hosts.id（hello 帧回填；未连接缺席）。 */
  hostId?: number
  /** 最近一次连接失败的结构化原因（零凭据）。 */
  lastError?: string
  /** 结构化告警（非错误）：如 relay 启用但本地 Gateway 未启用（docs/19 §4.8）。 */
  warning?: string
}

export interface AgentGatewayStatusPayload extends EmptyPayload {}
export type AgentGatewayStatusResult = GatewayStatusView

export interface AgentGatewayRestartPayload {
  confirmed?: boolean
}

export interface AgentGatewayRestartImpacts {
  activeConnections: number
  note: string
}

export interface AgentGatewayRestartStart {
  confirmRequired: true
  impacts: AgentGatewayRestartImpacts
}

export interface AgentGatewayRestartResult {
  /** 判别字段：结果分支恒为 undefined（Start 分支为 true）。 */
  confirmRequired?: undefined
  running: boolean
  port: number
}

// --- agents:setAutoStart ---

export interface AgentSetAutoStartPayload {
  enabled: boolean
}
export interface AgentSetAutoStartResult {
  enabled: boolean
}

// --- agents:diagnostics ---

/** 单 provider 诊断投影（docs/14 §A.1 #13；与 REST /v1/diagnostics 同投影红线）。 */
export interface AgentProviderDiagnostic {
  id: number
  installed: boolean
  version?: string
  /** 可执行文件探测命中。 */
  exeFound: boolean
  /** 数据源状态（kind 为源形态标注；AC2 未探测时为 'unknown'）。 */
  dataSource: {
    kind: string
    readable: boolean
    detail?: string
  }
  /** 控制通道状态（未验证的通道绝不出现为 true）。 */
  control: {
    hooks?: boolean
    appServer?: boolean
    stdin?: boolean
    note?: string
  }
}

export interface AgentDiagnosticsPayload extends EmptyPayload {}
export interface AgentDiagnosticsResult {
  providers: AgentProviderDiagnostic[]
  gateway: GatewayStatusView
  /** 托盘可用性（托盘随 AC5 落地，AC2 恒 false）。 */
  tray: { available: boolean }
  autostart: { enabled: boolean }
  monitorEnabled: boolean
}

// ---------------------------------------------------------------------------
// 7. Gateway request & channel contract table (constraint #17)
// ---------------------------------------------------------------------------

/** devhub:invoke 请求外层 payload。 */
export interface IpcRequest {
  channel: string
  payload?: unknown
}

/**
 * Channel -> [payload, result] contract. Keyed by IpcChannel so any handler
 * map built from this type is compile-time restricted to the whitelist;
 * adding a channel without a contract row here is a type error.
 */
export interface ChannelContract {
  'scan:start': [ScanStartPayload, ScanStartResult]
  'scan:status': [ScanStatusPayload, ScanStatus]
  'scan:cancel': [ScanCancelPayload, ScanCancelResult]
  'projects:list': [ProjectsListPayload, ProjectsListResult]
  'projects:get': [ProjectsGetPayload, ProjectsGetResult]
  'projects:add': [ProjectsAddPayload, ProjectsAddResult]
  'projects:remove': [ProjectsRemovePayload, ProjectsRemoveResult]
  'projects:rescan': [ProjectsRescanPayload, ProjectsRescanResult]
  'projects:update': [ProjectsUpdatePayload, ProjectsUpdateResult]
  'projects:openFolder': [OpenFolderPayload, OpenResult]
  'projects:openVSCode': [OpenVSCodePayload, OpenResult]
  'projects:openTerminal': [OpenTerminalPayload, OpenResult]
  'projects:openWSL': [OpenWSLPayload, OpenResult]
  'environment:detect': [EnvironmentDetectPayload, EnvironmentDetectResult]
  'environment:doctor': [EnvironmentDoctorPayload, EnvironmentDoctorResult]
  'services:list': [ServicesListPayload, ServicesListResult]
  'services:refresh': [ServicesRefreshPayload, ServicesRefreshResult]
  'dashboard:summary': [DashboardSummaryPayload, DashboardSummaryResult]
  'settings:get': [SettingsGetPayload, SettingsGetResult]
  'settings:set': [SettingsSetPayload, SettingsSetResult]
  'app:version': [AppVersionPayload, AppVersionResult]
  // --- skills (S2 batch, docs/09 §9) ---
  'skills:scan': [SkillsScanPayload, SkillsScanResult]
  'skills:scanWsl': [SkillsScanWslPayload, SkillsScanWslResult]
  'skills:list': [SkillsListPayload, SkillsListResult]
  'skills:agents': [SkillsAgentsPayload, SkillsAgentsResult]
  'skills:linkStates': [LinkStatesPayload, LinkStatesResult]
  'skills:toggleLink': [SkillsTogglePayload, SkillsToggleResult]
  'skills:import': [SkillsImportPayload, SkillsImportResult]
  'skills:doctor': [SkillsDoctorPayload, SkillsDoctorResult]
  'skills:repair': [SkillsRepairPayload, SkillsRepairResult]
  'skills:sync': [SkillsSyncPayload, SkillsSyncResult]
  'skills:agent.upsert': [AgentUpsertPayload, AgentUpsertResult]
  'skills:agent.remove': [AgentRemovePayload, AgentRemoveResult]
  'skills:companion.status': [CompanionStatusPayload, CompanionStatusResult]
  'skills:companion.deploy': [CompanionDeployPayload, CompanionDeployResult]
  // --- apihub (S3 batch, docs/09 §9) ---
  'apihub:adapters': [ApiHubAdaptersPayload, ApiHubAdaptersResult]
  'apihub:current': [ApiHubCurrentPayload, ApiHubCurrentResult]
  'apihub:profiles': [ApiHubProfilesPayload, ApiHubProfilesResult]
  'apihub:saveProfile': [ApiHubSaveProfilePayload, ApiHubSaveProfileResult]
  'apihub:deleteProfile': [ApiHubDeleteProfilePayload, ApiHubDeleteProfileResult]
  'apihub:switch': [ApiHubSwitchPayload, ApiHubSwitchStart | ApiHubSwitchResult]
  // --- versions (S3 batch, docs/09 §9) ---
  'versions:list': [VersionsListPayload, VersionsListResult]
  'versions:check': [VersionsCheckPayload, VersionsCheckResult]
  'versions:update': [VersionsUpdatePayload, VersionsUpdateResult]
  'versions:job': [VersionsJobPayload, VersionJobSnapshot]
  // 夜间#1 批次：docs/09 §7.2 cancelled 分支主动取消（job 快照轮询不变）
  'versions:cancel': [VersionsCancelPayload, VersionsCancelResult]
  // --- docker (S4 batch, docs/09 §9, 按文档命名 overview/logs/action) ---
  'docker:overview': [DockerOverviewPayload, DockerOverviewResult]
  'docker:logs': [DockerLogsPayload, DockerLogsResult]
  'docker:action': [DockerActionPayload, DockerActionStart | DockerActionResult]
  // --- wsl (S4 batch, docs/09 §8.2/§9 授权并入的 2 条) ---
  'wsl:action': [WslActionPayload, WslActionStart | WslActionResult | WslShutdownAllStart | WslShutdownAllResult]
  'wsl:distroStats': [WslDistroStatsPayload, WslDistroStatsResult]
  // --- archive (S5 batch, docs/10 §11；run 为 CONFIRM_REQUIRED 两段式，
  //     且必须携带 preview 签发的 previewId——强制 dry-run，安全规则 1) ---
  'archive:preview': [ArchivePreviewPayload, ArchivePreviewResult]
  'archive:run': [ArchiveRunPayload, ArchiveRunStart | ArchiveRunResult]
  'archive:history': [ArchiveHistoryPayload, ArchiveHistoryResult]
  'archive:rollback': [ArchiveRollbackPayload, ArchiveRollbackStart | ArchiveRollbackResult]
  'archive:status': [ArchiveStatusPayload, ArchiveStatusResult]
  // --- agents (AC2 batch, docs/14 §A.1；全部轮询 channel，docs/14 §A.3。
  //     deviceRevoke / gatewayRestart 为 CONFIRM_REQUIRED 两段式) ---
  'agents:providers': [AgentProvidersPayload, AgentProvidersResult]
  'agents:sessions': [AgentSessionsPayload, AgentSessionsResult]
  'agents:sessionDetail': [AgentSessionDetailPayload, AgentSessionDetailResult]
  'agents:messages': [AgentMessagesPayload, AgentMessagesResult]
  'agents:events': [AgentEventsPayload, AgentEventsResult]
  'agents:sessionAction': [AgentSessionActionPayload, AgentSessionActionResult]
  'agents:pairingCreate': [AgentPairingCreatePayload, AgentPairingCreateResult]
  'agents:devices': [AgentDevicesPayload, AgentDevicesResult]
  'agents:deviceRevoke': [AgentDeviceRevokePayload, AgentDeviceRevokeStart | AgentDeviceRevokeResult]
  'agents:gatewayStatus': [AgentGatewayStatusPayload, AgentGatewayStatusResult]
  'agents:gatewayRestart': [AgentGatewayRestartPayload, AgentGatewayRestartStart | AgentGatewayRestartResult]
  'agents:setAutoStart': [AgentSetAutoStartPayload, AgentSetAutoStartResult]
  'agents:diagnostics': [AgentDiagnosticsPayload, AgentDiagnosticsResult]
  // 夜间#1 批次：per-provider 单独重探（UX 验收 backlog，known-limitations §3.2）
  'agents:probeProvider': [AgentProbeProviderPayload, AgentProbeProviderResult]
}

/** Compile-time assertion that ChannelContract covers exactly the whitelist. */
export type AssertContractCoversWhitelist = Exclude<IpcChannel, keyof ChannelContract> extends never
  ? Exclude<keyof ChannelContract, IpcChannel> extends never
    ? true
    : never
  : never
