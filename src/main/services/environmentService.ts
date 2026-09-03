/**
 * environmentService.ts — 环境探测 / 落库 / Environment Doctor（docs/04 environment channels）。
 *
 * - detectEnvironment：windows 工具链 + WSL 发行版（跳过 docker-desktop）逐个工具链 →
 *   upsert environments + environment_tools（002 迁移后同名工具按 path 并存，如 python 3.9/3.13）→
 *   registerResource(environment) → 返回 EnvironmentWithTools[]（docs/04 contract）。
 *   docs/05 规则 5：环境只登记，不建关系（环境是锚点不是从属）。
 * - runDoctor：全部规则基于刚探测的快照真实数据（禁止硬编码期望值），
 *   输出 DoctorCheck[]（severity 统一 info / warning / error）。
 */

import { release as osRelease } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { detectWindowsTools } from '../adapters/windows.ts'
import { detectWslTools, listDistros, wslStatus as probeWslStatus } from '../adapters/wsl.ts'
import type { WslDistro } from '../../shared/types.ts'
import { dockerInfo } from '../adapters/docker.ts'
import { getDatabase } from '../db/index.ts'
import type {
  DockerStatus,
  DoctorCheck,
  EnvironmentDetectResult,
  EnvironmentToolInfo,
  EnvironmentWithTools,
  WslStatus,
} from '../../shared/types.ts'
import { dbVal, nowSec } from './internal.ts'
import { registerResource } from './resourceGraph.ts'

/** 跳过的 WSL 发行版前缀（docker-desktop 是 docker 引擎载体，不是开发环境）。 */
const SKIPPED_DISTRO_PREFIX = 'docker-desktop'
/** WSL 侧 python 命令名到 windows 侧的别名（版本一致性对比用）。 */
const CRITICAL_WINDOWS_TOOLS: readonly string[] = ['git', 'python']
const OPTIONAL_WINDOWS_TOOLS: readonly string[] = ['pnpm', 'gcc', 'clang', 'cmake']

// ---------------------------------------------------------------------------
// 探测快照
// ---------------------------------------------------------------------------

/** 一次探测得到的原始快照（detect 落库与 doctor 评估共用）。 */
export interface EnvironmentSnapshot {
  windowsTools: EnvironmentToolInfo[]
  wsl: WslStatus
  /** 真实发行版（已跳过 docker-desktop）。 */
  distros: WslDistro[]
  /** 每个真实发行版的工具链。 */
  distroTools: Map<string, EnvironmentToolInfo[]>
  docker: DockerStatus
}

/** 全量探测：单项失败按 adapter 语义降级为空/结构化状态，不拖垮整体（约束 #25）。 */
export async function probeEnvironmentSnapshot(): Promise<EnvironmentSnapshot> {
  const windowsTools = await detectWindowsTools()

  const allDistros = await listDistros()
  const distros = allDistros.filter((d) => !d.name.toLowerCase().startsWith(SKIPPED_DISTRO_PREFIX))
  const wsl = await probeWslStatus()

  const distroTools = new Map<string, EnvironmentToolInfo[]>()
  for (const distro of distros) {
    let tools: EnvironmentToolInfo[] = []
    try {
      tools = await detectWslTools(distro.name)
    } catch {
      tools = [] // adapter 约定不抛异常；双保险降级
    }
    distroTools.set(distro.name, tools)
  }

  const docker = await dockerInfo()
  return { windowsTools, wsl, distros, distroTools, docker }
}

// ---------------------------------------------------------------------------
// environments / environment_tools 落库
// ---------------------------------------------------------------------------

interface IdRow {
  id: number
}

function upsertEnvironment(db: DatabaseSync, name: string, kind: 'windows' | 'wsl', osVersion: string | undefined, now: number): number {
  const existing = db.prepare('SELECT id FROM environments WHERE name = ?').get(name) as IdRow | undefined
  if (existing !== undefined) {
    db.prepare('UPDATE environments SET kind = ?, os_version = ?, detected_at = ?, updated_at = ? WHERE id = ?').run(
      kind,
      dbVal(osVersion),
      now,
      now,
      existing.id,
    )
    return existing.id
  }
  const result = db
    .prepare('INSERT INTO environments (name, kind, os_version, detected_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, kind, dbVal(osVersion), now, now, now)
  return Number(result.lastInsertRowid)
}

/** 002 迁移前 defensively 去重：同一 (tool, path) 只保留首条（PATH 顺序优先）。 */
function dedupeTools(tools: readonly EnvironmentToolInfo[]): EnvironmentToolInfo[] {
  const seen = new Set<string>()
  const out: EnvironmentToolInfo[] = []
  for (const tool of tools) {
    const key = `${tool.tool}|${tool.path ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tool)
  }
  return out
}

function findToolRow(db: DatabaseSync, environmentId: number, tool: EnvironmentToolInfo): IdRow | undefined {
  if (tool.path === undefined) {
    return db
      .prepare('SELECT id FROM environment_tools WHERE environment_id = ? AND tool = ? AND path IS NULL')
      .get(environmentId, tool.tool) as IdRow | undefined
  }
  return db
    .prepare('SELECT id FROM environment_tools WHERE environment_id = ? AND tool = ? AND path = ?')
    .get(environmentId, tool.tool, tool.path) as IdRow | undefined
}

/** 单工具 upsert：业务键 (environment_id, tool, path)；NULL path（missing 条目）单独匹配。 */
function upsertEnvironmentTool(db: DatabaseSync, environmentId: number, tool: EnvironmentToolInfo, now: number): void {
  const existing = findToolRow(db, environmentId, tool)
  if (existing !== undefined) {
    db.prepare(
      'UPDATE environment_tools SET version = ?, state = ?, raw_version = ?, updated_at = ? WHERE id = ?',
    ).run(dbVal(tool.version), tool.state, dbVal(tool.rawVersion), now, existing.id)
    return
  }
  db.prepare(
    'INSERT INTO environment_tools (environment_id, tool, version, path, state, raw_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(environmentId, tool.tool, dbVal(tool.version), dbVal(tool.path), tool.state, dbVal(tool.rawVersion), now, now)
}

/**
 * 快照同步（M3 修复）：environment_tools 的语义是"最近一次 detect 快照"
 * （docs/08 §6.1、§6.10 均按 detected_at 读取本轮结果）。此前只 upsert 不删除 ——
 * 某轮探测在降级/精简环境下漏探（或工具被卸载、PATH 变化）时，旧行（典型是
 * NULL path 的 missing 行）会永久残留，detect / wsl.distributions 输出出现幽灵条目
 * （M3 验收实测：windows 环境出现第 3 条 'python missing'）。这里删除本轮快照中
 * 不存在的旧行，使表与最新快照严格一致；同业务键 (tool, path) 仍走 upsert。
 */
function syncEnvironmentTools(db: DatabaseSync, environmentId: number, tools: readonly EnvironmentToolInfo[], now: number): void {
  const freshKeys = new Set(dedupeTools(tools).map((tool) => `${tool.tool}|${tool.path ?? ''}`))
  const existing = db.prepare('SELECT id, tool, path FROM environment_tools WHERE environment_id = ?').all(environmentId) as {
    id: number
    tool: string
    path: string | null
  }[]
  for (const row of existing) {
    if (!freshKeys.has(`${row.tool}|${row.path ?? ''}`)) {
      db.prepare('DELETE FROM environment_tools WHERE id = ?').run(row.id)
    }
  }
  for (const tool of dedupeTools(tools)) {
    upsertEnvironmentTool(db, environmentId, tool, now)
  }
}

/** 读取一个环境的全部工具行，映射为 docs/04 的 EnvironmentToolInfo 形态。 */
export function loadEnvironmentWithTools(db: DatabaseSync, environmentId: number): EnvironmentWithTools {

  const env = db.prepare('SELECT id, name, kind, os_version, detected_at FROM environments WHERE id = ?').get(environmentId) as
    | { id: number; name: string; kind: string; os_version: string | null; detected_at: number }
    | undefined
  if (env === undefined) {
    throw new Error(`environment ${environmentId} not found`)
  }
  const toolRows = db
    .prepare('SELECT tool, version, path, state, raw_version FROM environment_tools WHERE environment_id = ? ORDER BY tool, id')
    .all(environmentId) as { tool: string; version: string | null; path: string | null; state: string; raw_version: string | null }[]
  return {
    id: env.id,
    name: env.name,
    kind: env.kind as 'windows' | 'wsl',
    osVersion: env.os_version ?? undefined,
    detectedAt: env.detected_at,
    tools: toolRows.map((row) => ({
      tool: row.tool,
      version: row.version ?? undefined,
      path: row.path ?? undefined,
      state: row.state as EnvironmentToolInfo['state'],
      rawVersion: row.raw_version ?? undefined,
    })),
  }
}

/**
 * DB 全部环境快照（含工具链），按 id 序 —— devhub://environment resource 的数据源
 * （docs/08 §7）。纯读查询，不探测不写库；空结果 = 尚未跑过 detect。
 */
export function listEnvironmentSnapshots(): EnvironmentWithTools[] {
  const db = getDatabase()
  const rows = db.prepare('SELECT id FROM environments ORDER BY id').all() as { id: number }[]
  return rows.map((row) => loadEnvironmentWithTools(db, row.id))
}

// ---------------------------------------------------------------------------
// detectEnvironment（environment:detect）
// ---------------------------------------------------------------------------

export async function detectEnvironment(): Promise<EnvironmentDetectResult> {
  const snapshot = await probeEnvironmentSnapshot()
  const db = getDatabase()
  const now = nowSec()

  const environments: EnvironmentWithTools[] = []

  const windowsId = upsertEnvironment(db, 'windows', 'windows', osRelease(), now)
  syncEnvironmentTools(db, windowsId, snapshot.windowsTools, now)
  registerResource(db, 'environment', windowsId, 'windows')
  environments.push(loadEnvironmentWithTools(db, windowsId))

  for (const distro of snapshot.distros) {
    const envName = `wsl:${distro.name}`
    const envId = upsertEnvironment(db, envName, 'wsl', undefined, now)
    syncEnvironmentTools(db, envId, snapshot.distroTools.get(distro.name) ?? [], now)
    registerResource(db, 'environment', envId, envName)
    environments.push(loadEnvironmentWithTools(db, envId))
  }

  return { environments }
}

// ---------------------------------------------------------------------------
// Environment Doctor（environment:doctor）
// ---------------------------------------------------------------------------

/** WSL 工具名 → windows 工具名（python3 与 python 视为同一工具）。 */
function toolAlias(name: string): string {
  return name === 'python3' ? 'python' : name
}

function firstNumber(version: string): number | null {
  const m = version.match(/\d+/)
  return m !== null ? Number.parseInt(m[0], 10) : null
}

function versionKey(version: string): number[] {
  const m = version.match(/\d+(\.\d+)*/)
  if (m === null) return [0]
  return m[0].split('.').map((part) => Number.parseInt(part, 10))
}

function compareVersions(a: string, b: string): number {
  const ka = versionKey(a)
  const kb = versionKey(b)
  const len = Math.max(ka.length, kb.length)
  for (let i = 0; i < len; i += 1) {
    const x = ka[i] ?? 0
    const y = kb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/** 评估 doctor 规则（全部基于快照真实数据；输出顺序确定）。 */
export function evaluateDoctor(snapshot: EnvironmentSnapshot): DoctorCheck[] {
  const checks: DoctorCheck[] = []

  // 规则 2：Windows PATH 首位 Python 低于已安装的另一版本（如 3.9 vs 3.13）
  const pythons = snapshot.windowsTools.filter(
    (t) => t.tool === 'python' && t.state === 'installed' && t.version !== undefined,
  )
  if (pythons.length >= 2) {
    const first = pythons[0]
    let newest = pythons[1]
    for (let i = 2; i < pythons.length; i += 1) {
      if (compareVersions(pythons[i].version ?? '', newest.version ?? '') > 0) newest = pythons[i]
    }
    if (first.version !== undefined && newest.version !== undefined && compareVersions(first.version, newest.version) < 0) {
      checks.push({
        id: 'windows-python-path-order',
        severity: 'warning',
        title: `Windows PATH picks Python ${first.version} while ${newest.version} is installed`,
        detail: `PATH-first: ${first.version} (${first.path ?? 'unknown path'}); newest found: ${newest.version} (${newest.path ?? 'unknown path'})`,
        suggestion: 'Reorder PATH or use the py launcher so new projects pick the newest interpreter.',
      })
    }
  }

  // 规则 1：Win / WSL 同名工具主版本不一致
  const winByName = new Map<string, EnvironmentToolInfo>()
  for (const tool of snapshot.windowsTools) {
    if (tool.state !== 'installed' || tool.version === undefined) continue
    const name = toolAlias(tool.tool)
    if (!winByName.has(name)) winByName.set(name, tool) // PATH 首条优先
  }
  for (const [distroName, tools] of snapshot.distroTools) {
    for (const tool of tools) {
      if (tool.state !== 'installed' || tool.version === undefined) continue
      const name = toolAlias(tool.tool)
      const winTool = winByName.get(name)
      if (winTool === undefined || winTool.version === undefined) continue
      const winMajor = firstNumber(winTool.version)
      const wslMajor = firstNumber(tool.version)
      if (winMajor === null || wslMajor === null || winMajor === wslMajor) continue
      checks.push({
        id: `version-mismatch:${name}:${distroName}`,
        severity: 'warning',
        title: `${name} major version differs between Windows and WSL (${distroName})`,
        detail: `Windows: ${name} ${winTool.version} (${winTool.path ?? 'unknown path'}) vs WSL ${distroName}: ${name} ${tool.version} (${tool.path ?? 'unknown path'})`,
        suggestion: 'Align the toolchain across sides (nvm/pyenv/apt) to avoid "works on Windows but not in WSL".',
      })
    }
  }

  // 规则 3：docker CLI 在但 daemon 不可达
  if (!snapshot.docker.cliAvailable) {
    checks.push({
      id: 'docker-cli-missing',
      severity: 'info',
      title: 'Docker CLI not found on Windows',
      detail: snapshot.docker.reason ?? 'docker.exe is not on PATH',
      suggestion: 'Install Docker Desktop (or the docker CLI) if container workflows are needed.',
    })
  } else if (!snapshot.docker.daemonAvailable) {
    checks.push({
      id: 'docker-daemon-unreachable',
      severity: 'warning',
      title: 'Docker daemon is unreachable',
      detail: snapshot.docker.reason ?? 'docker version did not report a server section',
      suggestion: 'Start Docker Desktop and wait until the engine is running.',
    })
  }

  // 规则 4：WSL 不存在 / 无发行版 / 全部 Stopped
  if (!snapshot.wsl.available) {
    checks.push({
      id: 'wsl-unavailable',
      severity: 'warning',
      title: 'WSL is not available',
      detail: snapshot.wsl.detail ?? 'wsl.exe could not be probed',
      suggestion: 'Run `wsl --install` (admin) and reboot to enable WSL2.',
    })
  } else if (snapshot.distros.length === 0) {
    checks.push({
      id: 'wsl-no-distros',
      severity: 'info',
      title: 'WSL is reachable but no distribution is installed',
      detail: snapshot.wsl.detail,
      suggestion: 'Install a distribution with `wsl --install -d Ubuntu`.',
    })
  } else if (snapshot.distros.every((d) => d.state !== 'Running')) {
    checks.push({
      id: 'wsl-all-stopped',
      severity: 'info',
      title: 'All WSL distributions are stopped',
      detail: snapshot.distros.map((d) => `${d.name}(${d.state})`).join(', '),
    })
  }

  // 规则 5：关键工具缺失 → error；可选工具缺失 → info
  for (const tool of snapshot.windowsTools) {
    if (tool.state !== 'missing') continue
    if (CRITICAL_WINDOWS_TOOLS.includes(tool.tool)) {
      checks.push({
        id: `missing-critical:${tool.tool}`,
        severity: 'error',
        title: `Critical tool "${tool.tool}" is missing on Windows`,
        detail: `${tool.tool} was not found via where.exe`,
        suggestion: `Install ${tool.tool} and make sure it is on PATH.`,
      })
    } else if (OPTIONAL_WINDOWS_TOOLS.includes(tool.tool)) {
      checks.push({
        id: `missing-optional:${tool.tool}`,
        severity: 'info',
        title: `Optional tool "${tool.tool}" not found`,
        detail: `${tool.tool} was not found via where.exe`,
      })
    }
  }

  return checks
}

/** environment:doctor：探测 → 评估，不写库。 */
export async function runDoctor(): Promise<{ checks: DoctorCheck[] }> {
  const snapshot = await probeEnvironmentSnapshot()
  return { checks: evaluateDoctor(snapshot) }
}
