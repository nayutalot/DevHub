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
  // --- ECS Relay（M3-E1 设备自管理，docs/18 §8.2 append-only：WS 专属码，REST 面为「—」） ---
  | 'SPAWN_REJECTED'

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
  /** TLS 信任物料状态（M3-C1b，docs/19 §10；只读展示，零凭据）。 */
  tls?: RelayTlsTrustStatus
}

/**
 * relay TLS 信任物料状态（M3-C1b）：指纹状态行（枚数+来源文件名，只读）+
 * !ok 结构化建议。指纹是公开物料（docs/19 §10.1），路径/建议可入投影。
 */
export interface RelayTlsTrustStatus {
  /** 指纹+CA 均就绪（wss 连接将以 tls{ca,checkServerIdentity} 构造）。 */
  ok: boolean
  /** 归一化后 SPKI 指纹枚数（双指纹窗口 = 2）。 */
  pins: number
  /** 指纹来源文件名（如 `fingerprints`）。 */
  source: string
  /** !ok 结构化原因与补放建议（含路径；零凭据）。 */
  error?: string
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
// 6g. ContestPin（CP1 批次，docs/22 §2/§3 + docs/04「ContestPin 追加」节逐字契约）。
// 时间语义权威 = docs/22 §2.2：precision 'date'/'month'/'tbd' 不得提升为 'exact'
// （除非 payload 显式携带原文 raw_text 依据）；'tbd' → start/end 恒 NULL；
// 提醒策略与 precision 分开保存。delete/nodeDelete 为 CONFIRM_REQUIRED 两段式
// （缺省回 { confirmRequired: true, impacts }，docker:action / archive:run 先例）。
// ---------------------------------------------------------------------------

export type ContestStatus = 'watching' | 'registered' | 'submitted' | 'completed' | 'given_up'

export type ContestNodeKind =
  | 'signup_start'
  | 'signup_deadline'
  | 'payment_deadline'
  | 'contest_start'
  | 'contest_end'
  | 'submit_deadline'
  | 'custom'

export type ContestNodePrecision = 'exact' | 'date' | 'month' | 'tbd'

export type ContestNodeSource = 'manual' | 'imported' | 'agent'

export type ContestReminderOffsetKind = 'before_days' | 'before_hours' | 'at_time'

export type ContestReminderChannel = 'windows' | 'in_app'

/** contestpin:list 的行投影（名称/年份/状态/归档 + 节点计数，轻于 ContestView）。
 * CP2 起携带三链接 URL（悬浮窗入口按钮直用，省逐条 get）与 dueNode/nextNode 投影。 */
export interface ContestListItem {
  id: number
  name: string
  /** 可空：缺少年份不编造（docs/22 §2.2）。 */
  year: number | null
  edition?: string
  organizer?: string
  status: ContestStatus
  archived: boolean
  officialSite?: string
  signupUrl?: string
  submitUrl?: string
  nodeCount: number
  /** 当前节点投影（CP2 due-node 计算，docs/22 §4 悬浮窗展示）；无候选节点时 null。 */
  dueNode?: ContestDueNode | null
  /** dueNode 之后的下一未完成节点；无 → null。 */
  nextNode?: ContestDueNode | null
  createdAt: number
  updatedAt: number
}

/** contestpin:create/update/archive 的返回投影（比赛行全量 + nodeCount）。 */
export interface ContestView {
  id: number
  name: string
  year: number | null
  edition?: string
  organizer?: string
  note?: string
  status: ContestStatus
  archived: boolean
  officialSite?: string
  signupUrl?: string
  submitUrl?: string
  nodeCount: number
  dueNode?: ContestDueNode | null
  nextNode?: ContestDueNode | null
  createdAt: number
  updatedAt: number
}

/**
 * due-node 投影（CP2，docs/22 §4 + 任务书 §2.1 #6）：悬浮窗/详情的"当前节点"。
 * 临近优先（未 done 且 start_at 最近未来）；全过期 → dueNode 带 overdue:true；
 * done 后自然推进下一节点；tbd（无 start_at）排最后；precision 传递给展示层
 * （'date' 展示"日期 · 未注明具体时刻"，'tbd' 展示"时间待定"，docs/22 §2.2）。
 */
export interface ContestDueNode {
  nodeId: number
  contestId: number
  kind: ContestNodeKind
  label: string
  /** tbd 节点为 null（排最后，仅无时刻候选时才被选为 dueNode）。 */
  startAt: number | null
  precision: ContestNodePrecision
  done: boolean
  /** dueNode 来自"最近的过去未完成节点"（全部候选已过期）时 true。 */
  overdue: boolean
}

/** 单个时间节点视图（precision/raw_text 为时间语义与原文依据，docs/22 §2.2）。 */
export interface ContestNodeView {
  id: number
  contestId: number
  kind: ContestNodeKind
  label: string
  startAt: number | null
  endAt: number | null
  /** IANA 名或 'local'（自由文本，不强校验）。 */
  tz: string
  precision: ContestNodePrecision
  /** 原文依据（低精度→exact 提升的显式证据）。 */
  rawText?: string
  done: boolean
  doneAt?: number | null
  source: ContestNodeSource
  createdAt: number
  updatedAt: number
}

/** 提醒策略视图（CP4 引擎落地；CP1 随 detail 只读带出）。 */
export interface ContestReminderView {
  id: number
  nodeId: number
  offsetKind: ContestReminderOffsetKind
  offsetValue: number
  channel: ContestReminderChannel
  enabled: boolean
  lastFiredAt?: number | null
  createdAt: number
  updatedAt: number
}

/** 材料视图（sha256 文件级去重；CP1 无导入通道，detail 恒为真实空集）。 */
export interface ContestMaterialView {
  id: number
  sha256: string
  originalName: string
  storedPath: string
  sizeBytes?: number | null
  pages?: number | null
  kind: 'pdf' | 'image' | 'other'
  importedAt: number
}

/** 关联项目（经 resources/relationships `uses` 边反查，docs/22 §2.3）。 */
export interface ContestLinkedProject {
  id: number
  name: string
}

/** contestpin:get 返回：比赛全量 + nodes/materials/reminders/关联 project。 */
export interface ContestDetailView extends ContestView {
  nodes: ContestNodeView[]
  materials: ContestMaterialView[]
  reminders: ContestReminderView[]
  project: ContestLinkedProject | null
}

// --- contestpin:list ---

export interface ContestListPayload {
  /** 名称/年份模糊搜索（LIKE 包含匹配）。 */
  query?: string
  status?: ContestStatus
  /** 缺省排除已归档；true = 含已归档一并返回。 */
  archived?: boolean
  limit?: number
  offset?: number
}

export interface ContestListResult {
  items: ContestListItem[]
  total: number
}

// --- contestpin:get ---

export interface ContestGetPayload {
  id: number
}

// --- contestpin:create ---

export interface ContestCreatePayload {
  name: string
  /** 可空；给定时 1990..2100 整数（运行期校验）。 */
  year?: number | null
  edition?: string
  organizer?: string
  note?: string
  /** 缺省 'watching'。 */
  status?: ContestStatus
  officialSite?: string
  signupUrl?: string
  submitUrl?: string
}

// --- contestpin:update ---

export interface ContestPatch {
  name?: string
  year?: number | null
  edition?: string
  organizer?: string
  note?: string
  status?: ContestStatus
  officialSite?: string
  signupUrl?: string
  submitUrl?: string
}

export interface ContestUpdatePayload {
  id: number
  patch: ContestPatch
}

// --- contestpin:delete（CONFIRM_REQUIRED 两段式） ---

export interface ContestDeleteImpacts {
  nodes: number
  materials: number
  reminders: number
}

export interface ContestDeleteStart {
  confirmRequired: true
  impacts: ContestDeleteImpacts
}

export interface ContestDeletePayload {
  id: number
  confirmed?: boolean
}

export interface ContestDeleteResult {
  /** 判别字段：结果分支恒为 undefined（Start 分支为 true，docker:action 同款）。 */
  confirmRequired?: undefined
  removed: true
}

// --- contestpin:archive ---

export interface ContestArchivePayload {
  id: number
  archived: boolean
}

// --- contestpin:nodeUpsert ---

export interface ContestNodeInput {
  /** 带 id = 更新既有节点；缺省 = 新建。 */
  id?: number
  /** 缺省 'custom'。 */
  kind?: ContestNodeKind
  /** kind='custom' 必填非空；其余 kind 缺省以 kind 值兜底展示。 */
  label?: string
  startAt?: number | null
  endAt?: number | null
  /** 缺省 'local'（自由文本，IANA 名不强校验）。 */
  tz?: string
  /** 缺省 'exact'；已有低精度→'exact' 必须显式携带 rawText 依据。 */
  precision?: ContestNodePrecision
  rawText?: string
  done?: boolean
}

export interface ContestNodeUpsertPayload {
  contestId: number
  node: ContestNodeInput
}

// --- contestpin:nodeDelete（CONFIRM_REQUIRED 两段式） ---

export interface ContestNodeDeleteImpacts {
  reminders: number
}

export interface ContestNodeDeleteStart {
  confirmRequired: true
  impacts: ContestNodeDeleteImpacts
}

export interface ContestNodeDeletePayload {
  id: number
  confirmed?: boolean
}

export interface ContestNodeDeleteResult {
  confirmRequired?: undefined
  removed: true
}

// --- contestpin:linkProject ---

export interface ContestLinkProjectPayload {
  contestId: number
  /** null = 解除关联（删 contest→project `uses` 边）。 */
  projectId: number | null
}

export interface ContestLinkProjectResult {
  linked: boolean
}

// --- contestpin:overlayState（CP2，docs/22 §4；READ_ONLY） ---

/** 悬浮窗 bounds（Electron DIP 坐标，docs/22 §4.3——不自行换算 DPI scale）。 */
export interface ContestOverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ContestOverlayStateResult {
  enabled: boolean
  /** null = 未持久化过位置（wire 层居中主显示器 workArea）。 */
  bounds: ContestOverlayBounds | null
  collapsed: boolean
}

// --- contestpin:overlaySetEnabled / contestpin:overlaySetCollapsed ---

export interface ContestOverlaySetEnabledPayload {
  enabled: boolean
}

export interface ContestOverlaySetEnabledResult {
  enabled: boolean
}

export interface ContestOverlaySetCollapsedPayload {
  collapsed: boolean
}

export interface ContestOverlaySetCollapsedResult {
  collapsed: boolean
}

// --- contestpin:openInMain / contestpin:openLink ---

export interface ContestOpenInMainPayload {
  contestId: number
}

export interface ContestOpenInMainResult {
  /** 悬浮窗/纯 Node 语境未注入 applier 时 false（结构化 no-op，非错误）。 */
  opened: boolean
}

export interface ContestOpenLinkPayload {
  url: string
}

export interface ContestOpenLinkResult {
  /** 同上：applier 未注入时 false；URL 非法为 BAD_PAYLOAD 错误分支。 */
  opened: boolean
}

// --- contestpin 识别配置（CP3a，docs/22 §6；configList/configSave/configDelete/
//     configTest 四条。掩码视图绝不含明文 key 或 sealed envelope —— docs/22 §6 密钥红线） ---

/** 识别配置角色（008 contestpin_configs.role CHECK 同款枚举）。 */
export type RecognitionConfigRole = 'vision' | 'text' | 'multimodal'

/** contestpin:configList 行投影：掩码视图（尾 4 位 + 长度 + 是否已设置布尔）。 */
export interface RecognitionConfigView {
  id: number
  name: string
  role: RecognitionConfigRole
  baseUrl: string
  model: string
  /** 掩码尾 4 位（maskKey 唯一脱敏出口）；无 key / 不可解密 → null。 */
  apiKeyTail: string | null
  apiKeyLen: number | null
  /** true = 已设置 key（含不可解密形态）；false = 无鉴权端点（key_sealed NULL）。 */
  apiKeySet: boolean
  /** 可空 = 用客户端默认超时（60000ms）。 */
  timeoutMs: number | null
  /** 最近连接测试 unix 秒；null = 未测过。 */
  lastTestAt: number | null
  /** null = 未测过；true/false = 最近一次测试结果。 */
  lastTestOk: boolean | null
  /** 实测 usage（仅服务真实返回才落）；null = 无实测。 */
  lastTestUsage: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

export interface RecognitionConfigListPayload {
  // 预留：role 过滤等（当前面板按角色分组在前端分组，不加服务端参数）
}

export interface RecognitionConfigListResult {
  configs: RecognitionConfigView[]
}

export interface RecognitionConfigSavePayload {
  /** 缺省 = 新建；带 id = 编辑。 */
  id?: number
  name: string
  role: RecognitionConfigRole
  /** 仅 http/https 绝对 URL（service 校验，validateExternalUrl 风格本地实现）。 */
  baseUrl: string
  model: string
  /** 密码框约定：空串/undefined = 保持既有（编辑）或不设 key（新建=无鉴权端点）。 */
  apiKey?: string
  /** 正整数毫秒；null = 清空（回客户端默认）。 */
  timeoutMs?: number | null
}

export interface RecognitionConfigDeletePayload {
  id: number
  confirmed?: boolean
}

export interface RecognitionConfigDeleteImpacts {
  /** 引用该配置的 contest_import_jobs 计数（vision_config_id / text_config_id）。 */
  importJobs: number
}

export interface RecognitionConfigDeleteStart {
  confirmRequired: true
  impacts: RecognitionConfigDeleteImpacts
}

export interface RecognitionConfigDeleteResult {
  /** 判别字段：结果分支恒为 undefined（Start 分支为 true，contest:delete 同款）。 */
  confirmRequired?: undefined
  removed: true
}

export interface RecognitionConfigTestPayload {
  id: number
}

/** 连接测试错误分类：客户端六分类 + 服务端错误摘要可判时的 IMAGE_UNSUPPORTED 派生。 */
export type RecognitionTestErrorKind =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'BAD_RESPONSE'
  | 'HTTP_ERROR'
  | 'IMAGE_UNSUPPORTED'

export interface RecognitionTestResult {
  ok: boolean
  latencyMs: number
  /** 实测 usage 原样透传；'unknown' = 服务端未返回（非实测，绝不伪造）。 */
  usage: Record<string, unknown> | 'unknown'
  /** ok=false 时携带：分类 kind + 分类文案（鉴权失败/限流/超时/网络错误/格式错误/图片不支持/HTTP 状态）。 */
  error?: { kind: RecognitionTestErrorKind; message: string }
}

// --- contestpin 材料导入与识别管线（CP3b 批次，docs/22 §5 + 任务书 §2.1-§2.3） ---

export interface ContestMaterialListPayload {
  // 预留：kind 过滤等（当前无服务端参数）
}

export interface ContestMaterialListResult {
  materials: ContestMaterialView[]
}

/**
 * contestpin:importMaterials 载荷：paths（renderer 文件对话框/拖入经 webUtils
 * 落路径）或 pasteClipboard（main 读系统剪贴板截图）二选一；都缺省 → BAD_PAYLOAD。
 */
export interface ContestImportMaterialsPayload {
  paths?: string[]
  pasteClipboard?: boolean
  /** 限制覆盖（单文件字节/单批份数；越硬上限截断，service 侧 clamp）。 */
  limits?: { maxFileBytes?: number; maxBatch?: number }
}

export interface ContestImportMaterialsResult {
  materials: ContestMaterialView[]
  /** true = 剪贴板不可用/无图/未注入 reader（结构化 no-op，openInMain 先例）。 */
  clipboardUnavailable?: boolean
}

/**
 * 识别导入模式（docs/22 §2.1 mode 四值全集）：CP3b 落地 two_stage/multimodal；
 * CP5 落地 agent（codex managed 自动路径）/manual_pack（任务包手动导出导入）。
 */
export type ContestImportMode = 'two_stage' | 'multimodal' | 'agent' | 'manual_pack'

/** 008 contest_import_jobs.stage 九值全集（docs/22 §2.1）。 */
export type ContestImportStage =
  | 'imported'
  | 'preprocessed'
  | 'vision_done'
  | 'text_done'
  | 'validated'
  | 'draft'
  | 'confirmed'
  | 'failed'
  | 'cancelled'

/** finding 级来源映射（docs/22 §5：{field, materialId, page, excerpt} 全程保留）。 */
export interface ImportProvenance {
  materialId: number
  page: number
  excerpt: string
}

/** 链接字段：仅当来源=原文或 PDF 超链接才携带（provenance 缺失在校验期剔除+flag）。 */
export interface ImportLinkDraft {
  url: string
  provenance?: ImportProvenance
}

/** 节点草稿：时刻为原文文本（startAtText），unix 秒解析归校验阶段；精度语义 docs/22 §2.2。 */
export interface ImportNodeDraft {
  kind: ContestNodeKind
  label: string
  precision: ContestNodePrecision
  /** 原文时刻串（ISO 风格 'YYYY-MM-DD HH:mm' / 'YYYY-MM-DD' / 'YYYY-MM' / '待定'）。 */
  startAtText?: string
  endAtText?: string
  rawText?: string
  provenance?: ImportProvenance
  /** 校验阶段按文本解析回填的 unix 秒（'date'=当日 00:00、'month'=当月 1 日 00:00，本地时区）；tbd/未解析 → null。 */
  startAt?: number | null
  endAt?: number | null
}

/** 比赛草稿（识别 JSON 契约的规范化形态；year 可空=缺少年份不编造）。 */
export interface ImportContestDraft {
  name: string
  year: number | null
  edition?: string
  organizer?: string
  officialSite?: ImportLinkDraft
  signupUrl?: ImportLinkDraft
  submitUrl?: ImportLinkDraft
  nodes: ImportNodeDraft[]
}

/** 模糊/冲突标记（{field,reason,excerpt}；展示待核对，绝不自动丢弃）。 */
export interface ImportFlag {
  field: string
  reason: string
  excerpt?: string
}

/** 结构化草稿（识别 JSON 契约 LLM 输出经解析+程序化校验后的落库形态）。 */
export interface ImportDraftView {
  contests: ImportContestDraft[]
  flags: ImportFlag[]
}

/** error_json 形状：chat 六分类复用 + 管线自有类（LIMIT/PAGE_RENDER_UNAVAILABLE/CONFIG_MISSING/INTERNAL/BAD_RESPONSE）。 */
export interface ImportJobError {
  kind: string
  message: string
}

/** 视觉阶段逐页结果（source：页转图 render / 整图 image / 文字 PDF 本地提取 local_text）。 */
export interface ImportVisionPage {
  materialId: number
  page: number
  text: string
  source: 'render' | 'image' | 'local_text'
}

/** result_json 的解析投影。 */
export interface ImportJobResultView {
  /** 预处理（PDF 页数/截断/降级可用性/本地链接/逐页本地文本，单页文本截断 20000 字符）。 */
  preprocessing?: {
    pageCount: number | null
    truncatedByLimit: boolean
    renderAvailable: boolean
    links: { uri: string; page: number }[]
    pages: { page: number; text: string }[]
  }
  /** 视觉阶段逐页输出（two_stage 中间结果；缓存命中带 reusedFromJobId）。 */
  vision?: {
    pages: ImportVisionPage[]
    reusedFromJobId?: number
  }
  /** 校验+核对用结构化草稿（validated/draft 阶段落位）。 */
  draft?: ImportDraftView
  /** CP5 agent 任务托管会话联动（submit 成功后落位；params.materialIds 为任务材料集）。 */
  agent?: {
    provider: string
    commandId: string
    nativeId: string
    sessionId: number | null
    submittedAt: number
  }
}

/** contest_import_jobs 行投影（importStatus/draftList/importCreate 返回）。 */
export interface ContestImportJobView {
  id: number
  contestId: number | null
  material: ContestMaterialView | null
  mode: ContestImportMode
  stage: ContestImportStage
  visionConfigId: number | null
  textConfigId: number | null
  visionFingerprint: string | null
  params: Record<string, unknown> | null
  result: ImportJobResultView | null
  error: ImportJobError | null
  /** 0-100（null = 未开始/不适用）。 */
  progress: number | null
  createdAt: number
  updatedAt: number
}

// --- contestpin:importCreate ---

export interface ContestImportCreateParams {
  /** 页范围（1 基，闭区间；缺省全页，受 PDF 页上限截断）。 */
  pageFrom?: number
  pageTo?: number
  /** 用户显式选择跳过有本地文字的页（不静默改变两阶段流程，docs/22 §5）。 */
  skipTextPages?: boolean
  /** 缺省 = 无配置（阶段期 CONFIG_MISSING 失败）；正整数且必须存在。 */
  visionConfigId?: number
  textConfigId?: number
  /** 限制覆盖（材料侧/页上限，硬上限封顶）。 */
  limits?: { maxFileBytes?: number; maxBatch?: number; maxPdfPages?: number }
}

export interface ContestImportCreatePayload {
  materialIds: number[]
  /** 缺省读 settings contestpin_default_mode（仅 two_stage|multimodal；agent 走 agentSubmit，manual_pack 走 importPack）。 */
  mode?: 'two_stage' | 'multimodal'
  params?: ContestImportCreateParams
}

export interface ContestImportCreateResult {
  jobs: ContestImportJobView[]
}

// --- contestpin:importStatus（READ_ONLY 轮询；jobId 缺省 = 全量最新 50） ---

export interface ContestImportStatusPayload {
  jobId?: number
}

export interface ContestImportStatusResult {
  jobs: ContestImportJobView[]
}

// --- contestpin:importCancel ---

export interface ContestImportCancelPayload {
  jobId: number
}

export interface ContestImportCancelResult {
  cancelled: boolean
  stage: ContestImportStage
}

// --- contestpin:importRetry（fromStage：重跑该阶段及以后） ---

export type ContestImportRetryFromStage = 'vision' | 'text' | 'validate'

export interface ContestImportRetryPayload {
  jobId: number
  fromStage: ContestImportRetryFromStage
}

export interface ContestImportRetryResult {
  job: ContestImportJobView
}

// --- contestpin:draftList（READ_ONLY：stage='draft' 的任务） ---

export interface ContestImportDraftListPayload {
  // 预留：分页（草稿量级小，当前全量）
}

export interface ContestImportDraftListResult {
  jobs: ContestImportJobView[]
}

// --- contestpin:draftConfirm（两段式：先回相似比赛 diff 面 + 草稿；confirmed 落库） ---

export interface ContestImportDraftConfirmPayload {
  jobId: number
  /** 缺省 = 返回确认面（相似比赛检测）；true = 确认执行。 */
  confirmed?: boolean
  /** 用户选择合并进既有比赛（追加节点，绝不静默覆盖既有字段/节点）。 */
  mergeIntoContestId?: number
  /** 核对界面逐字段编辑后的草稿覆盖（缺省用落库草稿；覆盖同样过程序化校验）。 */
  draft?: ImportDraftView
}

/** 相似比赛（同 name 或 name+year 近似；renderer 呈现新旧 diff，用户选择合并或另建）。 */
export interface ContestSimilarItem {
  id: number
  name: string
  year: number | null
  nodeCount: number
  status: ContestStatus
}

export interface ContestImportDraftConfirmStart {
  confirmRequired: true
  draft: ImportDraftView
  similar: ContestSimilarItem[]
}

export interface ContestImportDraftConfirmResult {
  confirmRequired?: undefined
  merged: boolean
  contestId: number
  contest: ContestView
}

// --- contestpin:draftDiscard（两段式；仅 stage='draft' 可弃） ---

export interface ContestImportDraftDiscardPayload {
  jobId: number
  confirmed?: boolean
}

export interface ContestImportDraftDiscardStart {
  confirmRequired: true
  jobId: number
  materialName: string | null
}

export interface ContestImportDraftDiscardResult {
  confirmRequired?: undefined
  removed: true
}

// --- contestpin Agent 模式（CP5 批次，docs/22 §8：自动=codex managed 经 L3
//     startProviderManagedSession 只消费不绕过；手动=任务包 export/import 走同一
//     draft 核对管线；agentStatus 为 READ_ONLY 任务态投影（含托管会话状态联查）。
//     取消不设新通道：复用 contestpin:importCancel（agent 任务挂 L3 pause 中断本
//     任务托管会话，monitorRegistry 同款取消令牌作用域=本任务及其托管会话）） ---

/** Agent 任务行投影 = 导入任务行 + 托管会话联查态（仅 mode='agent' 携带 agent）。 */
export type ContestAgentJobView = ContestImportJobView & {
  agent?: ContestAgentLinkView
}

/** 托管会话联查投影（会话行已不存在 → sessionStatus='unknown'，绝不猜）。 */
export interface ContestAgentLinkView {
  provider: string
  sessionId: number | null
  nativeId: string | null
  /** agent_sessions.status 投影（docs/12 §4 九值；'unknown'=行缺失/不可判定）。 */
  sessionStatus: string
}

/** contestpin:agentSubmit 载荷：多份材料合成一个托管任务（一行 agent 任务）。 */
export interface ContestAgentSubmitPayload {
  materialIds: number[]
  /** provider 业务键或数字 id（L3 startProviderManagedSession 同款双形态）。 */
  provider: string
  /** 用户附加结构化指令（可选；任务文本=材料本地文字提取+结构化指令，零文件内容外发超出材料文字本身）。 */
  instruction?: string
}

export interface ContestAgentSubmitResult {
  job: ContestAgentJobView
}

// --- contestpin:agentStatus（READ_ONLY 轮询；jobId 缺省 = agent/manual_pack 全量最新 50） ---

export interface ContestAgentStatusPayload {
  jobId?: number
}

export interface ContestAgentStatusResult {
  jobs: ContestAgentJobView[]
}

// --- contestpin:exportPack（READ_ONLY 材料面：生成任务包 JSON 落用户选择目录；
//     零凭据零 key——manifest 同款红线） ---

export interface ContestPackExportPayload {
  materialIds: number[]
  /** 用户选择的目标目录（绝对路径；必须已存在）。 */
  destDir: string
  /** 用户附加任务说明（可选）。 */
  instruction?: string
}

export interface ContestPackExportResult {
  /** 任务包 JSON 绝对路径（`contestpin-task-pack-<ts>.json`）。 */
  exportPath: string
  bytes: number
  materialCount: number
  /** 材料文字总字符数（审计用，零凭据）。 */
  textChars: number
}

// --- contestpin:importPack（变更：任务包结果导入 → 同一 draft 核对管线，绝不直写生产行） ---

export interface ContestPackImportPayload {
  /** 结果来源材料（材料存在性校验 + provenance 越界 flag）。 */
  materialIds: number[]
  /** 结果 JSON 文件路径（renderer 文件对话框+preload 先例）与内联文本二选一。 */
  resultPath?: string
  resultText?: string
}

export interface ContestPackImportResult {
  job: ContestAgentJobView
}

// --- contestpin:backupExport / backupImport（CP6 收官批，docs/22 §9 备份恢复；
//     导出 READ_ONLY 库面（产物落用户选择目录，exportPack 同款先例）：目标目录
//     manifest.json 结构性零凭据（不含 contestpin_configs.key_sealed 与任何 key）
//     + materials/ 附件夹 sha256 命名复制（同 sha 跳过幂等）；已存在 manifest →
//     BACKUP_EXISTS 拒绝不覆盖。导入变更面：形状校验/材料 sha256 对账（缺文件
//     如实 flag 降级不带病导入）→ 全部赛事一份 manual_pack 草稿走既有核对界面
//     （name+year 相似检测既有逻辑），绝不直写生产行绝不静默覆盖） ---

export interface ContestBackupExportPayload {
  /** 用户选择的目标目录（绝对路径；必须已存在）。 */
  destDir: string
}

export interface ContestBackupExportResult {
  /** manifest.json 绝对路径（`<destDir>/manifest.json`）。 */
  manifestPath: string
  bytes: number
  contestCount: number
  nodeCount: number
  reminderCount: number
  materialCount: number
}

export interface ContestBackupImportPayload {
  /** 用户选择的备份 manifest.json 绝对路径（materials/ 夹取其同级目录）。 */
  manifestPath: string
}

export interface ContestBackupImportResult {
  /** 草稿任务（mode='manual_pack'，与任务包导入同视图）→ 既有核对界面确认。 */
  job: ContestAgentJobView
}

// --- contestpin 提醒系统（CP4 批次，docs/22 §7 + docs/briefs/contestpin-m4 §1；
//     reminderUpsert / reminderDelete / reminderLogList 三条。reminderDelete 为
//     CONFIRM_REQUIRED 两段式；去重根 = contest_reminder_log UNIQUE(reminder_id, fire_key)） ---

/** reminderUpsert 的规则输入（UNIQUE(node_id, offset_kind, offset_value, channel) 冲突 = 更新）。 */
export interface ContestReminderRuleInput {
  offsetKind: ContestReminderOffsetKind
  /** before_days/before_hours 的 N（非负整数）；at_time 恒 0（非零 → BAD_PAYLOAD）。 */
  offsetValue?: number
  channel: ContestReminderChannel
  /** 缺省 true。 */
  enabled?: boolean
}

export interface ContestReminderUpsertPayload {
  nodeId: number
  rule?: ContestReminderRuleInput
}

export interface ContestReminderDeletePayload {
  id: number
  confirmed?: boolean
}

export interface ContestReminderDeleteStart {
  confirmRequired: true
  /** 影响面 = 该提醒的触发账本行数（confirmed 后随 FK CASCADE 一并删除）。 */
  impacts: { logRows: number }
}

export interface ContestReminderDeleteResult {
  confirmRequired?: undefined
  removed: true
}

/** contestpin:reminderLogList 行投影（触发账本；联 contest/node 展示字段）。 */
export interface ContestReminderLogEntry {
  id: number
  reminderId: number
  nodeId: number
  contestId: number
  contestName: string
  nodeLabel: string
  offsetKind: ContestReminderOffsetKind
  offsetValue: number
  channel: ContestReminderChannel
  /** 计划触发时刻 unix 秒。 */
  fireAt: number
  /** 去重键 `r<reminderId>@d<YYYY-MM-DD>|s<fireAt>`（自然日桶或秒桶）。 */
  fireKey: string
  /** 落账时刻 unix 秒（真实触发时间）。 */
  createdAt: number
}

export interface ContestReminderLogListPayload {
  /** 缺省 100、上限 200（contestpin:list 同款边界）。 */
  limit?: number
}

/** 顶栏小铃铛聚合数（近 24h 已触发 / 未来 24h 待触发；轮询本通道取得，无推送面）。 */
export interface ContestReminderLogSummary {
  firedLast24h: number
  upcoming24h: number
}

export interface ContestReminderLogListResult {
  entries: ContestReminderLogEntry[]
  summary: ContestReminderLogSummary
}

// ---------------------------------------------------------------------------
// 6i. LLM 复核层（LR1 批次，advisory-only；docs/briefs/lr1-llm-review.md §3/§4/§8）。
// 四态 envelope：ok（端点可达且回复合法 JSON 过结构校验）/ skipped（端点未配置、
// 不可达、超时——全流程行为等价现状）/ failed（端点非 2xx、网络错误）/
// unparseable（模型回非法 JSON——不崩）。advisory-only：永不阻塞归档主流程。
// ---------------------------------------------------------------------------

/** 复核结果四态（任务书 §3 权威枚举）。 */
export type ReviewStatus = 'ok' | 'skipped' | 'failed' | 'unparseable'

/** 复核风险三档（ok 态专用；模型输出白名单校验，越值降 unparseable）。 */
export type ReviewRisk = 'low' | 'medium' | 'high'

/** 归档前复核 payload：preview 既有 plan 摘要（零额外扫描，仅路径/名称/描述/计数）。
 * 渲染层从 preview.impacts 直投影，主进程零补充扫描（任务书 §4.1）。 */
export interface ArchiveReviewPrePayload {
  plan: {
    projectName: string
    projectDescription?: string
    oldPath: string
    destPath: string
    crossVolume: boolean
    /** 引用命中总数（真实值，非截断展示数） */
    totalHits: number
    /** 待改写唯一文件数 */
    filesToRewrite: number
    /** 可剥离再生日录数 */
    stripDirs: number
    /** 占用进程数 */
    occupiers: number
  }
}

/** 归档前/后复核统一 envelope（archive:reviewPre / archive:reviewPost result）。
 * ok 态含 risk/concerns/rationale；cached = reviewPost 命中 review_post_json 缓存。 */
export interface ReviewEnvelope {
  status: ReviewStatus
  /** ok 态：实际使用的模型名。 */
  model?: string
  /** 端点实际耗时（ok/failed/unparseable 携带；skipped 无端点耗时）。 */
  latencyMs?: number
  risk?: ReviewRisk
  concerns?: string[]
  rationale?: string
  /** reviewPost 缓存命中（true = 未打端点，读自 review_post_json）。 */
  cached?: boolean
  /** 非 ok 态的简短原因（skipped reason / failed / unparseable 摘要，无堆栈无绝对路径细节）。 */
  note?: string
}

export interface ReviewTestEndpointPayload {
  baseUrl: string
  model: string
}

/** 设置卡片端点测试结果（连通性/延迟探测；ok=false 时 error 携带简短原因）。 */
export interface ReviewTestEndpointResult {
  ok: boolean
  latencyMs: number
  error?: string
}

export interface ArchiveReviewPostPayload {
  runId: number
}

/** Skills 元数据体检 flag 三类（docs/09 §13；判定标准在 prompt 常量中锚定）。 */
export type SkillMetaFlagKind = 'short_description' | 'language_mismatch' | 'suspected_duplicate'

export interface SkillMetaFlag {
  skillId: number
  name: string
  kind: SkillMetaFlagKind
  /** 模型给出的简短依据（一句话；展示用，不入库）。 */
  detail: string
}

/** skills:reviewMeta result：批量 flags（只读咨询不落库，doctor 语义不变）。
 * 端点未配置/不可达 → skipped 态，页面行为等价现状（docs/09 §13）。 */
export interface SkillsReviewMetaResult {
  status: ReviewStatus
  latencyMs?: number
  model?: string
  note?: string
  flags?: SkillMetaFlag[]
  /** 参与体检的 skill 总数（= listSkills 行数；ok 态携带）。 */
  checkedCount?: number
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
  // --- contestpin (CP1 batch, docs/22 §3 + docs/04「ContestPin 追加」节；
  //     delete / nodeDelete 为 CONFIRM_REQUIRED 两段式) ---
  'contestpin:list': [ContestListPayload, ContestListResult]
  'contestpin:get': [ContestGetPayload, ContestDetailView]
  'contestpin:create': [ContestCreatePayload, ContestView]
  'contestpin:update': [ContestUpdatePayload, ContestView]
  'contestpin:delete': [ContestDeletePayload, ContestDeleteStart | ContestDeleteResult]
  'contestpin:archive': [ContestArchivePayload, ContestView]
  'contestpin:nodeUpsert': [ContestNodeUpsertPayload, ContestNodeView]
  'contestpin:nodeDelete': [ContestNodeDeletePayload, ContestNodeDeleteStart | ContestNodeDeleteResult]
  'contestpin:linkProject': [ContestLinkProjectPayload, ContestLinkProjectResult]
  // --- contestpin (CP2 batch, docs/22 §4 悬浮窗；overlayState 为 READ_ONLY，
  //     openLink 经 validateExternalUrl 仅 http/https，openInMain 聚焦主窗口导航) ---
  'contestpin:overlayState': [Record<string, never>, ContestOverlayStateResult]
  'contestpin:overlaySetEnabled': [ContestOverlaySetEnabledPayload, ContestOverlaySetEnabledResult]
  'contestpin:overlaySetCollapsed': [ContestOverlaySetCollapsedPayload, ContestOverlaySetCollapsedResult]
  'contestpin:openInMain': [ContestOpenInMainPayload, ContestOpenInMainResult]
  'contestpin:openLink': [ContestOpenLinkPayload, ContestOpenLinkResult]
  // --- contestpin (CP3a batch, docs/22 §6 + docs/04「ContestPin 追加」节；
  //     configList 为 READ_ONLY 掩码视图，configDelete 为 CONFIRM_REQUIRED 两段式) ---
  'contestpin:configList': [RecognitionConfigListPayload, RecognitionConfigListResult]
  'contestpin:configSave': [RecognitionConfigSavePayload, RecognitionConfigView]
  'contestpin:configDelete': [RecognitionConfigDeletePayload, RecognitionConfigDeleteStart | RecognitionConfigDeleteResult]
  'contestpin:configTest': [RecognitionConfigTestPayload, RecognitionTestResult]
  // --- contestpin (CP3b batch, docs/22 §5 + docs/04「ContestPin 追加」节；
  //     materialsList/importStatus/draftList 为 READ_ONLY，draftConfirm/draftDiscard
  //     为 CONFIRM_REQUIRED 两段式) ---
  'contestpin:materialsList': [ContestMaterialListPayload, ContestMaterialListResult]
  'contestpin:importMaterials': [ContestImportMaterialsPayload, ContestImportMaterialsResult]
  'contestpin:importCreate': [ContestImportCreatePayload, ContestImportCreateResult]
  'contestpin:importStatus': [ContestImportStatusPayload, ContestImportStatusResult]
  'contestpin:importCancel': [ContestImportCancelPayload, ContestImportCancelResult]
  'contestpin:importRetry': [ContestImportRetryPayload, ContestImportRetryResult]
  'contestpin:draftList': [ContestImportDraftListPayload, ContestImportDraftListResult]
  'contestpin:draftConfirm': [ContestImportDraftConfirmPayload, ContestImportDraftConfirmStart | ContestImportDraftConfirmResult]
  'contestpin:draftDiscard': [ContestImportDraftDiscardPayload, ContestImportDraftDiscardStart | ContestImportDraftDiscardResult]
  // --- contestpin (CP4 batch, docs/22 §7 + docs/04「ContestPin 追加」节；
  //     reminderLogList 为 READ_ONLY 触发账本，reminderDelete 为 CONFIRM_REQUIRED
  //     两段式；去重根 = contest_reminder_log UNIQUE(reminder_id, fire_key)) ---
  'contestpin:reminderUpsert': [ContestReminderUpsertPayload, ContestReminderView]
  'contestpin:reminderDelete': [ContestReminderDeletePayload, ContestReminderDeleteStart | ContestReminderDeleteResult]
  'contestpin:reminderLogList': [ContestReminderLogListPayload, ContestReminderLogListResult]
  // --- review (LR1 batch, LLM 复核层 advisory-only，docs/04「LR1 追加」节 +
  //     docs/briefs/lr1-llm-review.md §8；4 条全 READ_ONLY，四态 envelope 永不
  //     阻塞归档主流程——advisory 纪律见任务书 §1/§3) ---
  'review:testEndpoint': [ReviewTestEndpointPayload, ReviewTestEndpointResult]
  'archive:reviewPre': [ArchiveReviewPrePayload, ReviewEnvelope]
  'archive:reviewPost': [ArchiveReviewPostPayload, ReviewEnvelope]
  'skills:reviewMeta': [Record<string, never>, SkillsReviewMetaResult]
  // --- contestpin (CP5 batch, Agent 模式 docs/22 §8 + docs/04「ContestPin 追加」节；
  //     agentStatus 为 READ_ONLY 任务态投影；agentSubmit/exportPack/importPack 中
  //     自动路径一律经 L3 startProviderManagedSession 能力门（observed/陈旧 → 结构化
  //     拒绝不静默降级），手动路径任务包零凭据；结果全走同一 draft 核对管线) ---
  'contestpin:agentStatus': [ContestAgentStatusPayload, ContestAgentStatusResult]
  'contestpin:agentSubmit': [ContestAgentSubmitPayload, ContestAgentSubmitResult]
  'contestpin:exportPack': [ContestPackExportPayload, ContestPackExportResult]
  'contestpin:importPack': [ContestPackImportPayload, ContestPackImportResult]
  // --- contestpin (CP6 batch, 备份恢复 docs/22 §9 + docs/04「ContestPin 追加」节；
  //     backupExport 为 READ_ONLY 库面（产物落用户选择目录，结构性零凭据）；
  //     backupImport 变更面：校验/材料对账 → 一份 manual_pack 草稿走既有核对
  //     界面，绝不直写生产行绝不静默覆盖) ---
  'contestpin:backupExport': [ContestBackupExportPayload, ContestBackupExportResult]
  'contestpin:backupImport': [ContestBackupImportPayload, ContestBackupImportResult]
}

/** Compile-time assertion that ChannelContract covers exactly the whitelist. */
export type AssertContractCoversWhitelist = Exclude<IpcChannel, keyof ChannelContract> extends never
  ? Exclude<keyof ChannelContract, IpcChannel> extends never
    ? true
    : never
  : never
