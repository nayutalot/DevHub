/**
 * deepseekManagedConfig.ts — DeepSeek Harness 真机 managed 面授权门 + cordis.yml
 * 渲染（DM 批 docs/briefs/dm-dsh-managed.md §1.2；对齐 kimiManagedConfig 先例：
 * settings 键默认停用、每调用读取（运行期翻转即时生效）、结构化 reason 零凭据、
 * 键≠'1' 时 provider 行为与未接线逐字节一致）。
 *
 * 授权门（对齐 docs/27 §4.1）：settings 键 `deepseek_managed_enabled` 值恰为 '1'
 * 才授权真机 managed（'true'/'yes' 一律停用，绝不宽松解析）；缺行/非 '1' =
 * observed-only，provider 行为与现状逐字节一致。真实语义（本键存在的理由）：
 * 真实推理消耗 + `~/.dsh` 会话写入必然发生——默认停用、显式授权、键回 0 即撤销。
 *
 * spawn 载体（docs/27 §1.3/§4.2）：Electron 主进程内置 node（process.execPath）+
 * `<deepseekHarnessRoot>/packages/examples/jsonrpc-demo/lib/bin.js`（同机 checkout
 * 已构建 bin 实证）；配置经 `DSH_CORDIS_CONFIG` env 指向 DevHub 渲染的 cordis.yml
 * （runner.ts:24-29 env 优先于 argv）。安装根解析：deps 显式 > settings
 * `deepseekHarnessRoot` > 默认 D:/Apps/deepseek-harness（deepseekProvider 同源）。
 * home 边界复用 apihub/adapters.resolveHomeDir 既有阶梯（explicit → APIHUB_HOME →
 * homedir——Mimosa 纪律：边界函数归位既有模块，绝不另写一份）。
 *
 * 工作区旋钮（DSW 批 docs/briefs/dsw-workspace.md §1；run3 阻断修复：旧默认
 * workspacePath=resolveHomeDir()=用户 home 根 → dsh 沙箱 temp-root 撞 Windows ACL
 * → initialize 30s 超时 → COMMAND_NOT_EXECUTABLE）：settings 键
 * `deepseek_managed_workspace` 三级阶梯——deps 显式注入缝（smoke 夹具，向后兼容
 * 不做存在性强制）> settings 显式键（必须指向**已存在**目录：不存在 = 结构化
 * 拒绝 + 人话文案，绝不静默创建在奇怪位置；`~` 前缀经 resolveHomeDir 既有
 * env→path 边界展开——Mimosa 纪律勿新内联）> 默认安全目录
 * `<data>/dsh-workspace`（paths 既有边界解析，DEVHUB_HOME 策略感知；目录由
 * provider 在 spawn 前按需创建——门读取保持零写盘）。**绝不默认 home 根**。
 *
 * cordis.yml 渲染（docs/27 §4.2 骨架 + 本机 examples/jsonrpc-agent/cordis.yml 与
 * bundle/base/cordis.patch.yml 逐条对源）：sdk-jsonrpc-server + agent-spine +
 * llm-deepseek + sessions（persistence root=dshHomePath('sessions')——DSH_HOME
 * env 或 ~/.dsh，与 observed 投影同根）+ session-checkpoints + settings/credentials
 * （harness 自取 ~/.dsh 凭据与模型选择——DevHub 零读取零注入）+ sandbox
 * workspace-write + bash-sandbox + approval policy 'never'（永不挂起询问）+
 * token-meter/compaction-basic；**无 stdout logger**（stdout 是协议线，
 * sdk/server/src/index.ts:4 红线）。
 *
 * 版本哨兵（docs/27 §5 #10）：两层——(1) bin.js 存在性（门读取时文件在位检查，
 * 绝不 spawn 探测——kimi doctor 先例）；(2) initialize 握手 serverInfo.name 恒
 * 'deepseek-harness-sdk-runtime' + version 字段核对（失配 → 结构化拒绝，
 * provider 侧消费）。
 *
 * 红线：凭据三零——本模块零读取 `~/.dsh/.credentials.yaml`、渲染物零凭据字段、
 * spawn env 零 key 注入（DSH_CORDIS_CONFIG 是配置路径非凭据）；零日志零 console；
 * reason 只含静态字面量+键名+路径。electron-free；纯 Node 可加载。
 */

import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSetting } from '../../settingsService.ts'
import { resolveHomeDir } from '../../apihub/adapters.ts'
import { getDataDir } from '../../../core/paths.ts'

/**
 * settings 缺省时的默认安装根（AC0 实测；docs/12 §8.5。事实源原在
 * deepseekProvider.ts，DM 批起定义归位本模块、provider 侧 re-export 保持公共面
 * 不变——模块依赖保持无环：provider → config 单向）。
 */
export const DEEPSEEK_HARNESS_ROOT_DEFAULT = 'D:/Apps/deepseek-harness'

/** settings 键名：managed 授权门（DM 批；ALLOWED_KEYS 20→22）。 */
export const DEEPSEEK_MANAGED_ENABLED_SETTING_KEY = 'deepseek_managed_enabled'

/** settings 键名：可选模型路由（形如 `provider/model`；缺行 = runtime 默认路由）。 */
export const DEEPSEEK_MANAGED_MODEL_SETTING_KEY = 'deepseek_managed_model'

/**
 * settings 键名：托管会话工作区生产旋钮（DSW 批；缺行 = 默认安全目录，显式键 =
 * 用户自管已存在目录——不存在结构化拒绝不静默创建）。
 */
export const DEEPSEEK_MANAGED_WORKSPACE_SETTING_KEY = 'deepseek_managed_workspace'

/**
 * 默认工作区目录名（DSW 批；恒挂 DevHub 数据目录内——`<data>/dsh-workspace`，
 * paths 边界解析 DEVHUB_HOME 策略感知。**绝不默认用户 home 根**：run3 实证 dsh
 * 沙箱 temp-root 在 home 根撞 Windows ACL 确定性失败）。
 */
export const DEEPSEEK_MANAGED_WORKSPACE_DEFAULT_DIRNAME = 'dsh-workspace'

/** harness settings 键（安装根；S3 批既有键，本批复用不新增）。 */
export const DEEPSEEK_HARNESS_ROOT_SETTING_KEY = 'deepseekHarnessRoot'

/** initialize 握手的 wire-stable server 身份（sdk/server/src/server.ts:131 逐字）。 */
export const DEEPSEEK_SDK_RUNTIME_NAME = 'deepseek-harness-sdk-runtime'

/**
 * initialize 握手的预期版本（server.ts:132 硬编码 '0.1.0-rc.5' 侧实测形态）。
 * 版本漂移哨兵核对值：失配 → 结构化拒绝（绝不带病对接——docs/27 §5 #10：
 * HROOT 升级需重跑 launch-verify 1-9，哨兵把「静默漂移」变「显式失败」）。
 */
export const DEEPSEEK_SDK_RUNTIME_VERSION_EXPECTED = '0.0.1'

/** initialize 的默认 provider/model（SDK api.ts:40-41 runtime 默认逐字）。 */
export const DEEPSEEK_MANAGED_PROVIDER_DEFAULT = 'deepseek-official'
export const DEEPSEEK_MANAGED_MODEL_DEFAULT = 'deepseek-v4-flash'

/** jsonrpc-demo 已构建 bin 相对路径（docs/27 §1.3 载体表；同机 ls 实证）。 */
export const DEEPSEEK_MANAGED_BIN_RELATIVE = 'packages/examples/jsonrpc-demo/lib/bin.js'

/**
 * managed 运行态超时（覆盖 provider 默认）：idle 180s——回合间隙（用户阅读回复
 * 后再追问）连接静默期宽裕上限，超时树杀 → 后续 sendReply 走 one-shot resume
 * 回退（两态并存设计）；总生命周期 1800s（live 连接天花板；超时树杀→结构化，
 * 不存在无超时状态——spawnManaged 双上限纪律）。
 */
export const DEEPSEEK_MANAGED_IDLE_TIMEOUT_MS = 180_000
export const DEEPSEEK_MANAGED_LIFETIME_TIMEOUT_MS = 1_800_000

/** initialize/单请求等待宽限（握手秒级；宽容忍冷启动）。 */
export const DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS = 30_000

/** shutdown 优雅段超时（应答后 runtime 自杀 exit 0，sdk/server/src/index.ts:76-83）。 */
export const DEEPSEEK_MANAGED_SHUTDOWN_TIMEOUT_MS = 8_000

/** 授权门状态（deepseekProvider.options.managedGate 的返回形态；纯数据零凭据）。 */
export interface DeepseekManagedGateState {
  enabled: boolean
  /** 停用/哨兵拒绝原因（零凭据：静态字面量+键名+路径；enabled=true 时缺省）。 */
  reason?: string
  /** 安装根（解析后绝对路径；evidence 路径用，零凭据）。 */
  harnessRoot?: string
  /** jsonrpc-demo bin.js 绝对路径（enabled=true 必有）。 */
  binPath?: string
  /** cordis.yml 渲染物绝对路径（enabled=true 必有；DSH_CORDIS_CONFIG 指向它）。 */
  configPath?: string
  /** 托管会话工作区（initialize cwd + sandbox workspaceRoot + bash/fs cwd）。 */
  workspacePath?: string
  /** initialize 的 provider 路由（enabled=true 必有）。 */
  provider?: string
  /** initialize 的 model 路由（enabled=true 必有）。 */
  model?: string
  /** spawn 命令（Electron 内置 node；enabled=true 必有）。 */
  spawnCommand?: string
  /** spawn argv 模板（[binPath]；DSH_CORDIS_CONFIG 经 env 传递非 argv）。 */
  spawnArgs?: string[]
  /** spawn env 增量（仅 DSH_CORDIS_CONFIG 配置路径；零凭据零 key）。 */
  spawnEnv?: Record<string, string>
  /** live 连接心跳空闲超时（enabled=true 必有）。 */
  managedIdleTimeoutMs?: number
  /** live 连接总生命周期上限（enabled=true 必有）。 */
  managedLifetimeTimeoutMs?: number
  /** harness 数据根（resolveDshHome 阶梯解析；同一性证据面用）。 */
  dshHome?: string
}

/** readDeepseekManagedGate 依赖注入缝（smoke 夹具隔离真实 home/settings/bin）。 */
export interface DeepseekManagedGateDeps {
  /** 安装根显式覆盖（最高优先）。 */
  harnessRoot?: string
  /** bin.js 路径显式覆盖（跳过存在性检查的夹具路径仍做在位检查）。 */
  binPath?: string
  /** cordis.yml 渲染物路径覆盖（默认 getDataDir()/deepseek-managed/cordis.yml）。 */
  configPath?: string
  /** 托管会话工作区覆盖（smoke 注入缝最高优先，向后兼容不做存在性强制；缺省走
   *  settings 键 > 默认安全目录三级阶梯——resolveManagedWorkspace）。 */
  workspacePath?: string
  /** home 解析注入（透传 resolveHomeDir explicit 槽；smoke 隔离 + `~` 前缀展开）。 */
  homeDir?: string
  /** spawn 命令覆盖（默认 process.execPath；smoke 注入系统 node）。 */
  spawnCommand?: string
}

/** settings 门读取（每调用读；trim 后必须恰为 '1'——绝不宽松解析）。 */
function gateEnabledBySettings(): boolean {
  const raw = (getSetting(DEEPSEEK_MANAGED_ENABLED_SETTING_KEY) ?? '').trim()
  return raw === '1'
}

/**
 * 安装根解析：deps 显式 > settings `deepseekHarnessRoot` > 默认根
 * （deepseekProvider harnessRoot() 同源阶梯；settings 不可用时默认根兜底）。
 */
export function resolveDeepseekHarnessRoot(explicit?: string): string {
  if (explicit !== undefined && explicit.trim().length > 0) return explicit
  try {
    const configured = getSetting(DEEPSEEK_HARNESS_ROOT_SETTING_KEY)
    if (configured !== undefined && configured.trim().length > 0) return configured
  } catch {
    // settings 不可用（无库上下文）：默认根兜底
  }
  return DEEPSEEK_HARNESS_ROOT_DEFAULT
}

/**
 * harness 数据根解析（deepseekProvider dshHome() 同款阶梯：$DSH_HOME 非空白 >
 * resolveHomeDir 阶梯下的 `~/.dsh`——home 边界复用既有 resolveHomeDir，Mimosa
 * 纪律；仅作同一性证据面，DevHub 绝不写该根）。
 */
export function resolveDshHome(homeDir?: string): string {
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv
  return join(resolveHomeDir(homeDir), '.dsh')
}

/** 模型路由键解析：`provider/model` 形态校验（zcodeCliConfigPlanOf 同判），
 * 缺行/空 = runtime 默认路由（api.ts:40-41）；形态不符 = 结构化拒绝（绝不猜）。 */
export function resolveManagedModelRoute(): { ok: true; provider: string; model: string } | { ok: false; reason: string } {
  const raw = (getSetting(DEEPSEEK_MANAGED_MODEL_SETTING_KEY) ?? '').trim()
  if (raw.length === 0) {
    return { ok: true, provider: DEEPSEEK_MANAGED_PROVIDER_DEFAULT, model: DEEPSEEK_MANAGED_MODEL_DEFAULT }
  }
  const slash = raw.indexOf('/')
  if (!(slash > 0 && slash < raw.length - 1)) {
    return { ok: false, reason: `settings key ${DEEPSEEK_MANAGED_MODEL_SETTING_KEY} must be a "provider/model" ref (got non-conforming value; managed face refused)` }
  }
  return { ok: true, provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

/** DevHub 渲染物默认落位（DevHub 自有数据目录——绝不写 ~/.dsh）。 */
export function defaultDeepseekCordisConfigPath(): string {
  return join(getDataDir(), 'deepseek-managed', 'cordis.yml')
}

// ---------------------------------------------------------------------------
// 托管会话工作区解析（DSW 批旋钮；run3 home×ACL 阻断修复）
// ---------------------------------------------------------------------------

/** 工作区解析结果（ok=false 时 reason 零凭据、带人话文案）。 */
export type DeepseekManagedWorkspaceResolution =
  | { ok: true; path: string; /** 命中来源（诊断面；deps=注入缝 settings=显式键 default=安全目录）。 */ source: 'deps' | 'settings' | 'default' }
  | { ok: false; reason: string }

/** 目录在位判定（存在且是目录；符号链接/junction 解引用语义与 statSync 一致）。 */
function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * settings 显式键的 `~` 前缀展开（Mimosa 纪律：env→path 归位 resolveHomeDir
 * 既有边界函数——explicit/APIHUB_HOME/homedir 阶梯原样复用，勿新内联）。
 */
function expandWorkspaceHome(value: string, homeDir?: string): string {
  if (value === '~') return resolveHomeDir(homeDir)
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(resolveHomeDir(homeDir), value.slice(2))
  return value
}

/**
 * 托管会话工作区三级解析（每调用读取；纯读取零写盘——目录按需创建由 provider
 * 在 spawn 前经 ensureDeepseekManagedWorkspaceDir 执行）：
 * 1. deps.workspacePath 显式注入缝（smoke 夹具；向后兼容：不做存在性强制）；
 * 2. settings 键 `deepseek_managed_workspace` 非空 → `~` 前缀经 resolveHomeDir
 *    展开后**必须已存在且是目录**——否则结构化拒绝（人话文案点名键名与路径；
 *    绝不静默创建在用户没建过的位置）；
 * 3. 缺行 → 默认安全目录 `<data>/dsh-workspace`（paths 既有边界解析，
 *    DEVHUB_HOME 策略感知）。**绝不默认用户 home 根**（run3 教训）。
 */
export function resolveManagedWorkspace(deps: { workspacePath?: string; homeDir?: string } = {}): DeepseekManagedWorkspaceResolution {
  if (deps.workspacePath !== undefined && deps.workspacePath.trim().length > 0) {
    return { ok: true, path: deps.workspacePath, source: 'deps' }
  }
  let configured: string | null = null
  try {
    const raw = getSetting(DEEPSEEK_MANAGED_WORKSPACE_SETTING_KEY)
    if (raw !== undefined && raw.trim().length > 0) configured = raw.trim()
  } catch {
    configured = null // settings 不可用（无库上下文）：默认安全目录兜底
  }
  if (configured !== null) {
    const resolved = expandWorkspaceHome(configured, deps.homeDir)
    if (!isExistingDir(resolved)) {
      return {
        ok: false,
        reason: `settings key ${DEEPSEEK_MANAGED_WORKSPACE_SETTING_KEY} points to a missing directory: ${resolved} (managed face refused; create the directory yourself first, or clear the key to fall back to the safe default under the DevHub data directory — DevHub never auto-creates an explicitly configured workspace)`,
      }
    }
    return { ok: true, path: resolved, source: 'settings' }
  }
  return { ok: true, path: join(getDataDir(), DEEPSEEK_MANAGED_WORKSPACE_DEFAULT_DIRNAME), source: 'default' }
}

/** ensureDeepseekManagedWorkspaceDir 结果（created=false = 已在位幂等跳过）。 */
export type EnsureDeepseekManagedWorkspaceResult =
  | { ok: true; path: string; created: boolean }
  | { ok: false; path: string; reason: string }

/**
 * 工作区目录按需创建（provider spawn 前置；默认安全目录路径唯一写盘点）。
 * 已在位 → 幂等跳过；缺目录 → mkdir recursive（POSIX 叶子 0700 语义——用户数据
 * 目录内不放开组/其他位；Windows ACL 随 %APPDATA% 用户档案继承）。创建失败
 * 结构化拒绝——绝不带病 spawn（cwd 缺位 = runtime ENOENT）。
 */
export function ensureDeepseekManagedWorkspaceDir(path: string): EnsureDeepseekManagedWorkspaceResult {
  if (isExistingDir(path)) return { ok: true, path, created: false }
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  } catch (err) {
    return { ok: false, path, reason: `managed workspace directory create failed at ${path}: ${errMessage(err)}` }
  }
  if (!isExistingDir(path)) {
    return { ok: false, path, reason: `managed workspace directory still missing after create at ${path}` }
  }
  return { ok: true, path, created: true }
}

// ---------------------------------------------------------------------------
// cordis.yml 渲染（纯函数；渲染物零凭据——红线断言对象）
// ---------------------------------------------------------------------------

/** YAML 单引号标量（Windows 反斜杠路径安全：单引号内反斜杠字面，仅 '' 转义）。 */
function yamlSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** 渲染输入（工作区路径即 initialize cwd / sandbox workspaceRoot / bash+fs cwd）。 */
export interface DeepseekCordisRenderInput {
  workspacePath: string
}

/**
 * ensure 输入：渲染输入 + 安装根（junction 目标定位用——见 ensureNodeModulesJunction）。
 */
export interface DeepseekCordisEnsureInput extends DeepseekCordisRenderInput {
  /** 安装根（门态 harnessRoot；junction 目标 = <root>/examples/node_modules）。 */
  harnessRoot?: string
}

/**
 * cordis.yml 渲染（docs/27 §4.2 骨架；插件矩阵逐条对源：examples/jsonrpc-agent/
 * cordis.yml + bundle/base/cordis.patch.yml + examples/acp-agent/cordis.yml 的
 * sandbox/approval 族）。渲染物零凭据（DEEPSEEK_API_KEY 由 harness credential
 * seam 自取——credentials-local 插件自读 ~/.dsh/.credentials.yaml，DevHub 零参与）；
 * 无 stdout logger（协议线独占红线）。
 */
export function renderDeepseekCordisYml(input: DeepseekCordisRenderInput): string {
  const ws = yamlSingleQuoted(input.workspacePath)
  return `# DevHub-rendered cordis config for the DeepSeek Harness SDK runtime
# (deepseek-managed face; DM batch, docs/27 §4.2). Passed via DSH_CORDIS_CONFIG.
# stdout is the JSON-RPC protocol line: NO stdout logger may ever be added here.
# Credentials: DevHub never reads or injects keys. The llm-deepseek adapter
# resolves DEEPSEEK_API_KEY through the harness credential seam
# (settings/credentials plugins below read the user's own ~/.dsh documents).

- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'

# Agent spine; the SDK server creates agents per sessionId.
- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    persona: 'You are a coding agent. Your bash tool runs under a file sandbox - a [sandbox: file access denied] result is policy, not a command bug. Keep answers brief and factual.'
    workspaceContext: false
    skills:
      enabled: false
    toolBash:
      enableRunInBackground: false
    toolJobs: false

# JSONL persistence at the harness home sessions root (dshHomePath resolves
# $DSH_HOME or ~/.dsh) - the SAME root the DevHub observed projection scans,
# which is the live/observed identity guarantee (docs/27 §4.4).
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions')

- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'

# Harness-side user settings + credentials (~/.dsh/settings.yaml and
# ~/.dsh/.credentials.yaml, read by the harness itself; zero DevHub involvement).
- id: settings
  name: '@deepseek-ai/dsh-settings-file'

- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'

# Managed child-process groups for the bash executor.
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

# Workspace-write sandbox (v1 red line: never full-access by default).
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: 'workspace-write'
    workspaceRoot: ${ws}

- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
  config:
    timeoutMs: 60000

# Approval policy pinned to never (SDK protocol has no approval round-trip:
# approval/asked is an event with no answering method). never = do not ask =
# auto-refuse out-of-workspace operations; UI presents approval_required events
# faithfully with no remote-approval promise (docs/27 §4.5, v1).
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: 'never'

# Filesystem tools ride the SAME workspace-write sandbox policy.
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: ${ws}

- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

# Replay-aware request pressure; the routed adapter supplies model capacity.
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'

- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    maxTokens: 8192
    compactionRetries: 1
`
}

// ---------------------------------------------------------------------------
// 渲染物原子写（zcodeManagedConfig defaultWriteCliConfig 同款 tmp+rename）
// ---------------------------------------------------------------------------

/** ensureDeepseekCordisConfig 结果（wrote=false = 内容已满足幂等跳过）。 */
export interface EnsureDeepseekCordisConfigResult {
  ok: boolean
  /** 目标文件路径（零凭据，可入 evidence）。 */
  path?: string
  /** 结构化失败原因（零凭据）。 */
  reason?: string
  /** 本次是否实际写盘（false = 幂等跳过）。 */
  wrote?: boolean
  /** 渲染物全文（校验面：零凭据断言/夹具断言用；调用方用毕即弃）。 */
  rendered?: string
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * spawn 前置：渲染 cordis.yml 并原子写盘（已存在且内容一致 → 幂等跳过）+
 * 确保 config 目录内 node_modules junction（裸说明符解析桥，见
 * ensureNodeModulesJunction 注）。原子性：父目录 mkdir recursive → 同目录 tmp
 * （`.tmp-<pid>-<ts>`）→ rename；任一步失败清理 tmp 后折叠为结构化
 * reason——绝不半写。
 */
export function ensureDeepseekCordisConfig(
  input: DeepseekCordisEnsureInput,
  deps: { configPath?: string } = {},
): EnsureDeepseekCordisConfigResult {
  const filePath = deps.configPath ?? defaultDeepseekCordisConfigPath()
  if (input.harnessRoot !== undefined && input.harnessRoot.trim().length > 0) {
    const linked = ensureNodeModulesJunction(dirname(filePath), input.harnessRoot)
    if (!linked.ok) return { ok: false, path: filePath, reason: linked.reason }
  }
  const rendered = renderDeepseekCordisYml(input)
  let existing: string | null = null
  try {
    existing = readTextOrNull(filePath)
  } catch (err) {
    return { ok: false, path: filePath, reason: `cordis config read failed: ${errMessage(err)}` }
  }
  if (existing === rendered) {
    return { ok: true, path: filePath, wrote: false, rendered }
  }
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(tmp, rendered, 'utf8')
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    return { ok: false, path: filePath, reason: `cordis config write failed: ${errMessage(err)}` }
  }
  return { ok: true, path: filePath, wrote: true, rendered }
}

function readTextOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
}

// ---------------------------------------------------------------------------
// node_modules junction（launch-verify #1 实测结论的桥接）
//
// DSH loader 从 **config 文件所在目录**向上解析裸说明符（实测：config 在
// DevHub 数据目录时 `@deepseek-ai/dsh-*` 全部 ERR_MODULE_NOT_FOUND）。harness
// 侧权威解析根 = `<harnessRoot>/examples/node_modules`（官方 examples/*
// cordis.yml 同款；实含全部 18 个待组合插件）。DevHub 在**自有**渲染目录内
// 建 `node_modules` junction 指向它——零写 HROOT、零拷贝、HROOT 升级自动跟随。
// ---------------------------------------------------------------------------

/** junction 目标相对路径（官方 examples 配置解析根；实装复核 18/18 插件在位）。 */
export const DEEPSEEK_EXAMPLES_NODE_MODULES_RELATIVE = 'examples/node_modules'

function normalizeLinkTarget(value: string): string {
  return value.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase()
}

/**
 * 确保 `<configDir>/node_modules` junction → `<harnessRoot>/examples/node_modules`。
 * 幂等：链接已在且指向同目标 → 跳过；指向异目标 → 删链重建（rmSync 只摘链不
 * 追目标）；不存在 → 创建（win32 junction 无需特权；POSIX dir symlink）。
 * 目标目录不在位 → 结构化拒绝（安装根形态漂移——版本哨兵精神）。
 */
export function ensureNodeModulesJunction(
  configDir: string,
  harnessRoot: string,
): { ok: true; linkPath: string; created: boolean } | { ok: false; reason: string } {
  const target = join(harnessRoot, ...DEEPSEEK_EXAMPLES_NODE_MODULES_RELATIVE.split('/'))
  try {
    if (!statSyncNoFollowDir(target)) {
      return { ok: false, reason: `version sentinel: harness plugin resolution root not found at ${target} (expected a harness checkout with examples/node_modules)` }
    }
  } catch (err) {
    return { ok: false, reason: `version sentinel: harness plugin resolution root unreadable at ${target}: ${errMessage(err)}` }
  }
  const linkPath = join(configDir, 'node_modules')
  let existing: string | null = null
  let exists = false
  try {
    existing = readlinkSync(linkPath)
    exists = true
  } catch (err) {
    if (isEnoent(err)) {
      exists = false
    } else {
      // 非链接实体（真实目录/文件）：保留不动（非 DevHub 所建，绝不删除用户数据）
      exists = true
      existing = null
    }
  }
  if (exists && existing === null) {
    return { ok: true, linkPath, created: false } // 外来实体：不触碰
  }
  if (exists && existing !== null && normalizeLinkTarget(existing) === normalizeLinkTarget(target)) {
    return { ok: true, linkPath, created: false } // 幂等：已指向同目标
  }
  try {
    mkdirSync(configDir, { recursive: true })
    if (exists) rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (err) {
    return { ok: false, reason: `node_modules junction create failed at ${linkPath} → ${target}: ${errMessage(err)}` }
  }
  return { ok: true, linkPath, created: true }
}

function statSyncNoFollowDir(path: string): boolean {
  // 目录在位检查（不要求可写； junction 目标自身允许是目录）
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// 版本哨兵（initialize 握手核对——provider 在握手后调用）
// ---------------------------------------------------------------------------

/** 版本哨兵判定结果（ok=false 时 reason 零凭据、含实测值供诊断）。 */
export type DeepseekVersionSentinelVerdict =
  | { ok: true; name: string; version: string }
  | { ok: false; reason: string }

/**
 * initialize 握手结果 → 版本哨兵（bin 存在性是第一层，在门读取时已判；
 * 本层核对 wire-stable name + 预期 version，失配 → 结构化拒绝）。绝不容忍
 * name 不符（对接的不是 SDK runtime = 协议面整体不可信）。
 */
export function verifyDeepseekHandshake(result: unknown): DeepseekVersionSentinelVerdict {
  const info = extractServerInfoLoose(result)
  if (info === null) {
    return { ok: false, reason: 'initialize handshake returned no parseable serverInfo (protocol shape drift; version sentinel refused)' }
  }
  if (info.name !== DEEPSEEK_SDK_RUNTIME_NAME) {
    return {
      ok: false,
      reason: `version sentinel: serverInfo.name is "${info.name}", expected "${DEEPSEEK_SDK_RUNTIME_NAME}" (not the SDK runtime; refused)`,
    }
  }
  if (info.version !== DEEPSEEK_SDK_RUNTIME_VERSION_EXPECTED) {
    return {
      ok: false,
      reason: `version sentinel: harness runtime version "${info.version}" != expected "${DEEPSEEK_SDK_RUNTIME_VERSION_EXPECTED}" (harness root upgraded; re-run launch-verify 1-9 before managed use, docs/27 §5 #10)`,
    }
  }
  return { ok: true, name: info.name, version: info.version }
}

function extractServerInfoLoose(result: unknown): { name: string; version: string } | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null
  const info = (result as Record<string, unknown>)['serverInfo']
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return null
  const name = (info as Record<string, unknown>)['name']
  const version = (info as Record<string, unknown>)['version']
  if (typeof name !== 'string' || typeof version !== 'string') return null
  return { name, version }
}

// ---------------------------------------------------------------------------
// 门组装
// ---------------------------------------------------------------------------

/**
 * 读 DeepSeek managed 授权门（每调用读取；kimiManagedConfig.readKimiManagedGate
 * 同构）。停用面（enabled=false 全部结构化 reason，绝不半开）：
 * 1. settings 键 ≠ '1' → 停用（默认态）；
 * 2. 模型路由键形态不符 → 停用；
 * 3. bin.js 不存在 → 版本哨兵第一层拒绝；
 * 4. 工作区显式键指向不存在目录 → 结构化拒绝（绝不静默创建——DSW 批）。
 * 就绪面：spawn 载体 + 渲染物路径 + 路由 + 超时全量携带（渲染物写盘由 provider
 * 在 spawn 前经 ensureDeepseekCordisConfig 执行——本函数零写盘，纯读取+判定；
 * 默认工作区目录的按需创建同理归 provider spawn 前置 ensureDeepseekManagedWorkspaceDir）。
 */
export function readDeepseekManagedGate(deps: DeepseekManagedGateDeps = {}): DeepseekManagedGateState {
  if (!gateEnabledBySettings()) {
    return {
      enabled: false,
      reason: `settings key ${DEEPSEEK_MANAGED_ENABLED_SETTING_KEY} is not '1' (managed face disabled by default; real inference + ~/.dsh writes require explicit authorization)`,
    }
  }
  const route = resolveManagedModelRoute()
  if (!route.ok) {
    return { enabled: false, reason: route.reason }
  }
  const harnessRoot = resolveDeepseekHarnessRoot(deps.harnessRoot)
  const binPath = deps.binPath ?? join(harnessRoot, ...DEEPSEEK_MANAGED_BIN_RELATIVE.split('/'))
  // 版本哨兵第一层：bin 在位检查（文件在位，绝不 spawn 探测——kimi doctor 先例）
  let binPresent = false
  try {
    binPresent = existsSync(binPath)
  } catch {
    binPresent = false
  }
  if (!binPresent) {
    return {
      enabled: false,
      reason: `version sentinel: jsonrpc-demo bin not found at ${binPath} (deepseekHarnessRoot=${harnessRoot}; install or point the setting at a harness checkout with packages/examples/jsonrpc-demo/lib/bin.js built)`,
    }
  }
  const workspace = resolveManagedWorkspace(deps)
  if (!workspace.ok) {
    // 显式键指向不存在目录：结构化拒绝（绝不静默创建在奇怪位置——DSW 批红线）
    return { enabled: false, reason: workspace.reason }
  }
  const workspacePath = workspace.path
  const configPath = deps.configPath ?? defaultDeepseekCordisConfigPath()
  const spawnCommand = deps.spawnCommand ?? process.execPath
  return {
    enabled: true,
    harnessRoot,
    binPath,
    configPath,
    workspacePath,
    provider: route.provider,
    model: route.model,
    spawnCommand,
    spawnArgs: [binPath],
    // env 增量仅配置路径（DSH_CORDIS_CONFIG 优先于 argv——runner.ts:24-29）；
    // 零凭据零 key（凭据三零红线）。ELECTRON_RUN_AS_NODE=1：打包常驻里
    // process.execPath=electron.exe，直接派生会作为第二个 GUI 实例被单实例锁
    // 静默秒退 → initialize 永不应答（RD run4 实证 30s 超时 COMMAND_NOT_
    // EXECUTABLE）；该开关强制其以纯 node 运行 bin.js（plain node 下无副作用）。
    spawnEnv: { DSH_CORDIS_CONFIG: configPath, ELECTRON_RUN_AS_NODE: '1' },
    managedIdleTimeoutMs: DEEPSEEK_MANAGED_IDLE_TIMEOUT_MS,
    managedLifetimeTimeoutMs: DEEPSEEK_MANAGED_LIFETIME_TIMEOUT_MS,
    dshHome: resolveDshHome(deps.homeDir),
  }
}
