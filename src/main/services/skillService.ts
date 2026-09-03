/**
 * skillService.ts — Skills 管理核心编排（S2 批次，docs/09 §1-§5/§9）。
 *
 * 职责与立场（docs/09 §1）：
 *  - 元数据读库（SQLite skill_agents/skills/skill_links），物理状态读盘；
 *    skill_links 只是缓存，任何 toggle/repair/doctor 都以真实文件系统探测为准并回写缓存；
 *  - vault 物理层只读引用 + 按操作语义写入（scan 镜像 upsert、import 新增、显式
 *    toggle/repair 建删链接），绝不移动/重命名 vault 本身；registry.json 不再读写；
 *  - 外部命令（git / wsl.exe / node 构建脚本）一律经 core/exec.ts（约束 #7-#10）；
 *    node:fs 链接操作在本 Service 层直用（docs/09 §11.2）；
 *  - expected unavailability（vault 缺失 / WSL 无 / git 缺失 / companion 不可达）
 *    一律结构化降级返回，绝不向 Renderer 抛裸异常（约束 #14/#24-#26）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { run } from '../core/exec.ts'
import { getDataDir, getProjectRoot } from '../core/paths.ts'
import { getDatabase } from '../db/index.ts'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CompanionDeployResult,
  CompanionStatusResult,
  LinkState,
  LinkStatesResult,
  SkillAgentInfo,
  SkillAgentScanView,
  SkillImportPlan,
  SkillMeta,
  SkillsAgentsResult,
  SkillsDoctorResult,
  SkillsImportResult,
  SkillsListResult,
  SkillsRepairResult,
  SkillsScanResult,
  SkillsScanWslResult,
  SkillsSyncResult,
  SkillsToggleResult,
  SkillDoctorItem,
} from '../../shared/types.ts'
import { ServiceError, nowSec } from './internal.ts'
import { getSetting, setSetting } from './settingsService.ts'
import { listDistros } from '../adapters/wsl.ts'
import {
  listVaultSkills,
  pathExists,
  readSkillDescription,
  removeAgentsDirHardlinks,
  repairAgentsDirHardlinks,
  scanWindowsAgent,
  vaultAgentsDir,
  vaultSkillDir,
} from './skills/winLinks.ts'
import { agentIncludes, projectAgentRow, validateAgentInput } from './skills/registryLogic.ts'
import { executeImport, planImport } from './skills/importer.ts'
import { applyFix, runDoctor } from './skills/doctor.ts'
import { syncAll } from './skills/sync.ts'
import { WSL_CACHE_STALE_MS, readWslScanCache, runWslScan } from './skills/wslScan.ts'
import { WSL_VAULT, winPathToWslPath } from './skills/wslVault.ts'
import { isSafeWslPath, runCompanion, wslBash, wslEnvPassthrough } from './skills/wslBridge.ts'
import { gitAvailable } from './skills/execGit.ts'

/** settings.vault_path 的种子缺省（与 migration 003 一致）。 */
const VAULT_PATH_DEFAULT = 'C:\\Users\\sakuya\\SkillVault'
/** 裸仓缺省（双侧同步 origin；老实现 DEFAULT_SETTINGS.barePath 同值）。 */
const BARE_REPO_DEFAULT = 'C:\\Users\\sakuya\\SkillVault.git'
/** settings 记录上次同步时间的 key。 */
const LAST_SYNC_KEY = 'skills_last_sync_at'
/** companion bundle 产物（scripts/build-skm.mjs 的 outfile）。 */
const BUNDLE_PATH = path.join(getProjectRoot(), 'artifacts', 'skm.mjs')
const BUILD_SCRIPT = path.join(getProjectRoot(), 'scripts', 'build-skm.mjs')

// ---------------------------------------------------------------------------
// vault / agent 基础读取
// ---------------------------------------------------------------------------

export function getVaultPath(): string {
  const v = getSetting('vault_path')
  return v !== undefined && v.trim().length > 0 ? v : VAULT_PATH_DEFAULT
}

function getWslCachePath(): string {
  return path.join(getDataDir(), 'skills', 'wsl-scan-cache.json')
}

/** vault 健康（skills/、agents/、.git 存在性）；vault 目录缺失时 issues 至少一条。 */
function vaultHealth(vaultPath: string): string[] {
  const issues: string[] = []
  if (!fs.existsSync(vaultPath)) {
    issues.push(`vault 路径不存在: ${vaultPath}`)
    return issues
  }
  if (!fs.existsSync(path.join(vaultPath, 'skills'))) issues.push('vault 缺少 skills/ 目录')
  if (!fs.existsSync(path.join(vaultPath, 'agents'))) issues.push('vault 缺少 agents/ 目录')
  if (!fs.existsSync(path.join(vaultPath, '.git'))) issues.push('vault 不是 git 仓库（缺 .git）')
  return issues
}

interface AgentRow {
  id: number
  name: string
  platform: string
  skills_dir: string
  agents_dir: string | null
  include_json: string
  enabled: number
}

/** DB agent 清单（include 解析；agentId 过滤）。 */
export function listAgents(agentId?: number): SkillAgentInfo[] {
  const db = getDatabase()
  const rows = (
    agentId === undefined
      ? db.prepare('SELECT * FROM skill_agents ORDER BY id').all()
      : db.prepare('SELECT * FROM skill_agents WHERE id = ?').all(agentId)
  ) as unknown as AgentRow[]
  return rows.map(projectAgentRow)
}

function requireAgent(agentId: number): SkillAgentInfo {
  const agent = listAgents(agentId)[0]
  if (agent === undefined) throw new ServiceError('NOT_FOUND', `agent ${agentId} not found`)
  return agent
}

/** vault 镜像 skill 行（id/名），仅 vault_rel_path 非空的行参与链接态计算。 */
function vaultSkillIds(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare('SELECT id, name FROM skills WHERE vault_rel_path IS NOT NULL').all() as { id: number; name: string }[]
  return new Map(rows.map((r) => [r.name, Number(r.id)]))
}

function upsertSkillRow(db: DatabaseSync, meta: SkillMeta): void {
  const now = nowSec()
  const fm = JSON.stringify({ name: meta.name, ...(meta.description.length > 0 ? { description: meta.description } : {}) })
  db.prepare(
    `INSERT INTO skills (name, source_path, vault_rel_path, frontmatter_json, description, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       vault_rel_path = excluded.vault_rel_path,
       frontmatter_json = excluded.frontmatter_json,
       description = excluded.description,
       updated_at = excluded.updated_at`,
  ).run(meta.name, `skills/${meta.name}`, fm, meta.description, now, now)
}

// ---------------------------------------------------------------------------
// scanVault / list / agents CRUD
// ---------------------------------------------------------------------------

/** 扫描 vault：skills/<name>/SKILL.md + agents 目录的 .md → frontmatter 解析 → skills 表 upsert（幂等）。 */
export function scanVault(): SkillsScanResult {
  const vaultPath = getVaultPath()
  const issues = vaultHealth(vaultPath)
  const metas = fs.existsSync(path.join(vaultPath, 'skills')) ? listVaultSkills(vaultPath) : []
  const db = getDatabase()
  for (const meta of metas) upsertSkillRow(db, meta)
  return { vaultPath, vaultOk: issues.length === 0, issues, skills: metas, agents: listAgents() }
}

/** 库内 skills 清单（含 frontmatter description 投影）。 */
export function listSkills(): SkillsListResult {
  const rows = getDatabase()
    .prepare('SELECT id, name, source_path, vault_rel_path, description, updated_at FROM skills ORDER BY name')
    .all() as { id: number; name: string; source_path: string | null; vault_rel_path: string | null; description: string | null; updated_at: number }[]
  return {
    skills: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      description: r.description ?? '',
      ...(r.vault_rel_path !== null ? { vaultRelPath: r.vault_rel_path } : {}),
      ...(r.source_path !== null ? { sourcePath: r.source_path } : {}),
      updatedAt: Number(r.updated_at),
    })),
  }
}

/** upsertAgent：id 有值按 id 更新（必须存在）；否则按 name upsert（created_at 保留首次值）。 */
export function upsertAgent(input: {
  id?: number
  name: string
  platform: 'windows' | 'linux'
  skillsDir: string
  agentsDir?: string
  include: string[]
  enabled?: boolean
}): SkillAgentInfo {
  const validation = validateAgentInput(input)
  if (!validation.ok) throw new ServiceError('BAD_PAYLOAD', validation.error)
  const db = getDatabase()
  const now = nowSec()
  const includeJson = JSON.stringify(input.include)
  const enabled = input.enabled === false ? 0 : 1
  const agentsDir = input.agentsDir !== undefined ? input.agentsDir : null

  if (input.id !== undefined) {
    const existing = db.prepare('SELECT id FROM skill_agents WHERE id = ?').get(input.id)
    if (existing === undefined) throw new ServiceError('NOT_FOUND', `agent ${input.id} not found`)
    db.prepare(
      'UPDATE skill_agents SET name = ?, platform = ?, skills_dir = ?, agents_dir = ?, include_json = ?, enabled = ?, updated_at = ? WHERE id = ?',
    ).run(input.name, input.platform, input.skillsDir, agentsDir, includeJson, enabled, now, input.id)
    return requireAgent(input.id)
  }

  db.prepare(
    `INSERT INTO skill_agents (name, platform, skills_dir, agents_dir, include_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       platform = excluded.platform, skills_dir = excluded.skills_dir, agents_dir = excluded.agents_dir,
       include_json = excluded.include_json, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(input.name, input.platform, input.skillsDir, agentsDir, includeJson, enabled, now, now)
  const row = db.prepare('SELECT id FROM skill_agents WHERE name = ?').get(input.name) as { id: number }
  return requireAgent(Number(row.id))
}

/** removeAgent：skill_links 经 FK 级联清理。 */
export function removeAgent(agentId: number): { removed: boolean } {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM skill_agents WHERE id = ?').run(agentId)
  return { removed: Number(result.changes) > 0 }
}

// ---------------------------------------------------------------------------
// 链接态：实时计算（Windows fs 直测 / WSL companion 缓存）+ skill_links 回写
// ---------------------------------------------------------------------------

function emptyCounts(): SkillAgentScanView['counts'] {
  return { linked: 0, missing: 0, wrongTarget: 0, realDir: 0, vaultMissing: 0 }
}

function countLinks(links: Record<string, LinkState>): SkillAgentScanView['counts'] {
  const counts = emptyCounts()
  for (const state of Object.values(links)) {
    if (state === 'linked') counts.linked += 1
    else if (state === 'missing') counts.missing += 1
    else if (state === 'wrong-target') counts.wrongTarget += 1
    else if (state === 'real-dir') counts.realDir += 1
    else counts.vaultMissing += 1
  }
  return counts
}

interface CacheWrite {
  agentId: number
  links: Record<string, LinkState>
}

/** skill_links 缓存整表按 agent 重写（DELETE + 批量 INSERT，单事务；docs/09 §3.3）。 */
function writeLinkCaches(db: DatabaseSync, writes: CacheWrite[]): void {
  if (writes.length === 0) return
  const skillIds = vaultSkillIds(db)
  const checkedAt = nowSec()
  db.exec('BEGIN')
  try {
    const del = db.prepare('DELETE FROM skill_links WHERE agent_id = ?')
    const ins = db.prepare('INSERT INTO skill_links (agent_id, skill_id, state, checked_at) VALUES (?, ?, ?, ?)')
    for (const w of writes) {
      del.run(w.agentId)
      for (const [name, state] of Object.entries(w.links)) {
        const skillId = skillIds.get(name)
        if (skillId !== undefined) ins.run(w.agentId, skillId, state, checkedAt)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * 实时五态计算（skills:agents / skills:linkStates 共用核心）：
 * - Windows agent：fs 直测（junction readlink + agentsDir 硬链接 dev+ino）；
 * - WSL agent：最近一次 companion 扫描缓存（stale 标注，绝不猜测实时态）；
 * - 结果回写 skill_links 缓存。
 */
export async function computeAgentScans(agentId?: number): Promise<SkillsAgentsResult> {
  const vaultPath = getVaultPath()
  const db = getDatabase()
  const skillIds = vaultSkillIds(db)
  const skillNames = [...skillIds.keys()].sort((a, b) => a.localeCompare(b))
  const cacheWrites: CacheWrite[] = []
  const agents: SkillAgentScanView[] = []

  for (const agent of listAgents(agentId)) {
    if (agent.platform === 'windows') {
      if (!agent.enabled) {
        agents.push({
          ...agent,
          probe: 'none',
          available: false,
          reason: 'agent 已停用（doctor/toggle 跳过）',
          links: {},
          counts: emptyCounts(),
        })
        continue
      }
      const scanned = scanWindowsAgent(vaultPath, {
        name: agent.name,
        skillsDir: agent.skillsDir,
        ...(agent.agentsDir !== undefined ? { agentsDir: agent.agentsDir } : {}),
        include: agent.include,
      })
      const links: Record<string, LinkState> = {}
      for (const name of skillNames) {
        if (agentIncludes(agent.include, name) && scanned.links[name] !== undefined) links[name] = scanned.links[name]
      }
      agents.push({
        ...agent,
        probe: 'windows',
        available: true,
        links,
        ...(scanned.agentsDirState !== undefined ? { agentsDirState: scanned.agentsDirState } : {}),
        ...(scanned.agentsDirNote !== undefined ? { agentsDirNote: scanned.agentsDirNote } : {}),
        agentFiles: scanned.agentFiles,
        counts: countLinks(links),
      })
      cacheWrites.push({ agentId: agent.id, links })
      continue
    }

    // ---- WSL agent：companion 缓存投影 ----
    const cached = readWslScanCache(getWslCachePath())
    const companionAgent = cached?.agents.find((a) => a.name === agent.name)
    if (cached !== null && companionAgent !== undefined) {
      const stale = Date.now() - cached.ts > WSL_CACHE_STALE_MS
      const links: Record<string, LinkState> = {}
      for (const name of skillNames) {
        if (agentIncludes(agent.include, name) && companionAgent.links[name] !== undefined) links[name] = companionAgent.links[name]
      }
      agents.push({
        ...agent,
        probe: 'companion-cache',
        available: true,
        ...(stale ? { stale: true } : {}),
        links,
        ...(companionAgent.agentsDir !== undefined ? { agentsDirState: companionAgent.agentsDirState } : {}),
        ...(companionAgent.agentsDir !== undefined && companionAgent.agentFiles !== undefined
          ? { agentFiles: companionAgent.agentFiles }
          : {}),
        counts: countLinks(links),
      })
      cacheWrites.push({ agentId: agent.id, links })
    } else {
      agents.push({
        ...agent,
        probe: 'none',
        available: false,
        reason: 'WSL companion 扫描不可用（可在 Skills 页执行 Scan WSL 或部署 companion）',
        links: {},
        counts: emptyCounts(),
      })
    }
  }

  writeLinkCaches(db, cacheWrites)
  return { agents }
}

/** skills:linkStates 入口（agentId 过滤可选）。 */
export async function linkStates(agentId?: number): Promise<LinkStatesResult> {
  return computeAgentScans(agentId)
}

/** skills:agents 入口（全量）。 */
export async function agentScans(): Promise<SkillsAgentsResult> {
  return computeAgentScans(undefined)
}

// ---------------------------------------------------------------------------
// WSL companion：scanWsl / status / deploy
// ---------------------------------------------------------------------------

/** 可用发行版解析：优先 Ubuntu，回退首个非 docker-desktop 的发行版；均无 → undefined。 */
async function resolveDistro(): Promise<string | undefined> {
  let distros
  try {
    distros = await listDistros()
  } catch {
    return undefined
  }
  if (distros.length === 0) return undefined
  const preferred = distros.find((d) => d.name === 'Ubuntu') ?? distros.find((d) => !d.name.startsWith('docker-desktop'))
  return preferred?.name
}

/** skills:scanWsl：companion 实时扫描（20s 超时）→ 缓存回落；结果同样回写 skill_links。 */
export async function scanWsl(): Promise<SkillsScanWslResult> {
  const distro = await resolveDistro()
  const cacheFile = getWslCachePath()
  if (distro === undefined) {
    const cached = readWslScanCache(cacheFile)
    return cached !== null
      ? { report: cached, stale: true, reason: '没有可用的 WSL 发行版，以下为缓存' }
      : { report: null, stale: false, reason: '没有可用的 WSL 发行版（wsl.exe -l -v 为空或失败）' }
  }
  const result = await runWslScan(distro, cacheFile)
  if (result.report !== null && result.stale === false) {
    // companion 实时结果回写 linux agent 缓存
    const db = getDatabase()
    const writes: CacheWrite[] = []
    for (const agent of listAgents()) {
      if (agent.platform !== 'linux') continue
      const companionAgent = result.report.agents.find((a) => a.name === agent.name)
      if (companionAgent === undefined) continue
      const links: Record<string, LinkState> = {}
      for (const [name, state] of Object.entries(companionAgent.links)) {
        if (agentIncludes(agent.include, name)) links[name] = state
      }
      writes.push({ agentId: agent.id, links })
    }
    writeLinkCaches(db, writes)
  }
  return result
}

/** companion 状态探测（只读；WSL 不可达时存在性为 null = 未知，绝不猜测）。 */
export async function companionStatus(): Promise<CompanionStatusResult> {
  const vaultPath = getVaultPath()
  const bundleBuilt = fs.existsSync(BUNDLE_PATH)
  const distro = await resolveDistro()
  if (distro === undefined) {
    return {
      wslAvailable: false,
      wslReason: '没有可用的 WSL 发行版（wsl.exe -l -v 为空或失败）',
      vaultDirExists: null,
      companionFileExists: null,
      bundleBuilt,
      bundlePath: BUNDLE_PATH,
      vaultPath,
    }
  }
  // 静态字面量脚本：常量路径直接写入正文，无动态值
  const script = `test -d ${WSL_VAULT} && echo V1 || echo V0; test -f ${WSL_VAULT}/bin/skm.mjs && echo C1 || echo C0`
  const r = await wslBash(distro, script, 30_000)
  const out = r.stdout
  return {
    wslAvailable: true,
    distro,
    vaultDirExists: out.includes('V1') ? true : out.includes('V0') ? false : null,
    companionFileExists: out.includes('C1') ? true : out.includes('C0') ? false : null,
    bundleBuilt,
    bundlePath: BUNDLE_PATH,
    vaultPath,
  }
}

/** 确保 companion bundle 存在（缺失时经 exec 跑 scripts/build-skm.mjs，依赖树内 esbuild）。 */
async function ensureBundle(steps: string[]): Promise<boolean> {
  if (fs.existsSync(BUNDLE_PATH)) {
    steps.push(`bundle 已存在: ${BUNDLE_PATH}`)
    return true
  }
  const build = await run('node', [BUILD_SCRIPT], {
    cwd: getProjectRoot(),
    timeoutMs: 120_000,
  })
  steps.push(`构建 bundle: node scripts/build-skm.mjs → ${build.code === 0 ? 'ok' : `failed: ${(build.stderr || build.stdout).slice(-300)}`}`)
  return build.code === 0 && fs.existsSync(BUNDLE_PATH)
}

/**
 * 部署 companion 到 WSL：bundle 就绪 → 确保 /root/skill-vault（缺失时从本地裸仓 clone）
 * → 拷贝到 <WSL_VAULT>/bin/skm.mjs → companion selfcheck 验证。
 * 动态路径一律经 WSLENV 环境变量传入静态脚本（约束 #8/#12 模式）。
 */
export async function deployCompanion(confirmed?: boolean): Promise<CompanionDeployResult> {
  if (confirmed !== true) {
    return { confirmRequired: true, deployed: false, steps: [] }
  }
  const steps: string[] = []
  const distro = await resolveDistro()
  if (distro === undefined) {
    return { deployed: false, steps, reason: '没有可用的 WSL 发行版，无法部署 companion' }
  }
  steps.push(`目标发行版: ${distro}`)

  if (!(await ensureBundle(steps))) {
    return { deployed: false, steps, reason: 'companion bundle 构建失败（scripts/build-skm.mjs）' }
  }

  // 1) 确保 WSL vault clone 存在（缺失时从本地裸仓 clone；裸仓缺失/clone 失败 → 结构化降级）
  const hasVault = await wslBash(distro, `test -d ${WSL_VAULT} && echo yes || echo no`, 30_000)
  if (!hasVault.ok) {
    return { deployed: false, steps, reason: `WSL 探测失败: ${(hasVault.stderr || '无输出').slice(-200)}` }
  }
  if (hasVault.stdout.trim() !== 'yes') {
    const bareWsl = winPathToWslPath(BARE_REPO_DEFAULT)
    if (!isSafeWslPath(bareWsl)) {
      return { deployed: false, steps, reason: `裸仓路径不合法: ${BARE_REPO_DEFAULT}` }
    }
    steps.push(`/root/skill-vault 缺失，尝试从裸仓 clone: ${bareWsl}`)
    const clone = await wslBash(distro, 'git clone "$DH_SRC" "$DH_DST"', 120_000, wslEnvPassthrough({ DH_SRC: bareWsl, DH_DST: WSL_VAULT }))
    if (!clone.ok) {
      return { deployed: false, steps, reason: `clone 失败（可先在 WSL 内手动 clone 裸仓）: ${(clone.stderr || '无输出').slice(-300)}` }
    }
    steps.push('clone 完成')
  } else {
    steps.push(`${WSL_VAULT} 已存在`)
  }

  // 2) 拷贝 bundle → <WSL_VAULT>/bin/skm.mjs
  const bundleWsl = winPathToWslPath(BUNDLE_PATH)
  if (!isSafeWslPath(bundleWsl)) {
    return { deployed: false, steps, reason: `bundle 路径不合法: ${BUNDLE_PATH}` }
  }
  const copy = await wslBash(
    distro,
    'mkdir -p "$DH_DST_DIR" && cp "$DH_SRC" "$DH_DST"',
    60_000,
    wslEnvPassthrough({ DH_SRC: bundleWsl, DH_DST: `${WSL_VAULT}/bin/skm.mjs`, DH_DST_DIR: `${WSL_VAULT}/bin` }),
  )
  if (!copy.ok) {
    return { deployed: false, steps, reason: `拷贝失败: ${(copy.stderr || '无输出').slice(-300)}` }
  }
  steps.push(`已部署: ${WSL_VAULT}/bin/skm.mjs`)

  // 3) 验证（companion 可达性；失败仅注记，部署本身已完成）
  const check = await runCompanion(distro, ['selfcheck'], 60_000)
  steps.push(
    check.ok && check.parsed !== null && check.parsed !== undefined
      ? 'companion selfcheck 通过'
      : `companion selfcheck 未通过（部署文件已就位，可重试）: ${(check.parseError || check.stderr || '').slice(-200)}`,
  )
  return { deployed: true, steps }
}

// ---------------------------------------------------------------------------
// toggleLink / agentsDir 链接
// ---------------------------------------------------------------------------

/** include 白名单补齐：import 建链后把 skill 名追加进 agent.include（["*"] 跳过）。 */
function ensureInclude(agent: SkillAgentInfo, skillName: string): boolean {
  if (agentIncludes(agent.include, skillName)) return false
  const next = [...agent.include.filter((x) => x !== '*'), skillName]
  upsertAgent({ ...agent, include: next })
  return true
}

/**
 * toggleLink（CONFIRM_REQUIRED 语义由调用方传 confirmed）：
 * enable → 建 junction（real-dir/普通文件拒绝，LINK_CONFLICT 结构化错误）；
 * disable → 仅删链接本体；WSL agent 走 companion link/unlink（不可达 → DEGRADED）。
 */
export async function toggleLink(agentId: number, skillName: string, enable: boolean, confirmed?: boolean): Promise<SkillsToggleResult> {
  const agent = requireAgent(agentId)
  const vaultPath = getVaultPath()
  const target = vaultSkillDir(vaultPath, skillName)

  // 当前态探测：Windows fs 直测；WSL agent 用 companion 缓存投影（绝不猜测实时态）
  let currentState: LinkState = 'missing'
  if (agent.platform === 'windows') {
    if (pathExists(target)) {
      currentState = scanWindowsAgent(vaultPath, { name: agent.name, skillsDir: agent.skillsDir, include: [skillName] }).links[skillName] ?? 'missing'
    }
  } else {
    const cached = readWslScanCache(getWslCachePath())
    const companionAgent = cached?.agents.find((a) => a.name === agent.name)
    currentState = companionAgent?.links[skillName] ?? 'missing'
  }

  if (confirmed !== true) {
    return { confirmRequired: true, changed: false, state: currentState, agentId, skill: skillName, steps: [] }
  }

  const steps: string[] = []
  let changed = false
  let finalState = currentState

  if (agent.platform === 'linux') {
    const distro = await resolveDistro()
    if (distro === undefined) throw new ServiceError('DEGRADED', '没有可用的 WSL 发行版，无法操作 WSL 侧链接')
    if (!agent.enabled) throw new ServiceError('LINK_CONFLICT', `agent ${agent.name} 已停用，toggle 跳过`)
    const r = await runCompanion(distro, [enable ? 'link' : 'unlink', skillName, '--agent', agent.name], 60_000)
    const parsed = r.parsed as { ok?: boolean; results?: string[] } | undefined
    if (!r.ok || parsed === undefined || parsed === null) {
      throw new ServiceError('DEGRADED', `WSL companion 不可达: ${(r.parseError || r.stderr || '无输出').slice(-200)}`)
    }
    steps.push(...(parsed.results ?? ['companion 已执行']))
    changed = true
    // companion 动作已生效；实时态以下次 skills:scanWsl 刷新（此处按动作语义回报）
    finalState = enable ? 'linked' : 'missing'
    return { changed, state: finalState, agentId, skill: skillName, steps }
  }

  if (!agent.enabled) throw new ServiceError('LINK_CONFLICT', `agent ${agent.name} 已停用，toggle 跳过`)
  if (!pathExists(target)) {
    throw new ServiceError('NOT_FOUND', `vault 中不存在 skill 目录: ${target}（可先 Scan）`)
  }

  const linkPath = path.join(agent.skillsDir, skillName)
  if (enable) {
    if (currentState === 'linked') {
      steps.push('已链接，跳过')
    } else if (currentState === 'real-dir') {
      throw new ServiceError('LINK_CONFLICT', `${linkPath} 是真实目录而非链接，拒绝覆盖（可能含独有内容，请人工处理或走导入流水线）`)
    } else if (currentState === 'wrong-target') {
      const st = fs.lstatSync(linkPath)
      if (!st.isSymbolicLink()) {
        throw new ServiceError('LINK_CONFLICT', `${linkPath} 是普通文件而非链接，拒绝自动删除（请人工处理）`)
      }
      fs.rmSync(linkPath, { force: true })
      fs.symlinkSync(path.resolve(target), linkPath, 'junction')
      steps.push(`旧链接已移除并重建 junction: ${linkPath} → ${target}`)
      changed = true
      finalState = 'linked'
    } else {
      fs.mkdirSync(path.dirname(linkPath), { recursive: true })
      fs.symlinkSync(path.resolve(target), linkPath, 'junction')
      steps.push(`已创建 junction: ${linkPath} → ${target}`)
      changed = true
      finalState = 'linked'
    }
  } else {
    if (currentState === 'missing') {
      steps.push('链接不存在，无需解除')
    } else if (currentState === 'real-dir') {
      throw new ServiceError('LINK_CONFLICT', `${linkPath} 是真实目录，拒绝删除（永不自动处理）`)
    } else if (currentState === 'wrong-target') {
      const st = fs.lstatSync(linkPath)
      if (!st.isSymbolicLink()) {
        throw new ServiceError('LINK_CONFLICT', `${linkPath} 是普通文件，拒绝删除（请人工处理）`)
      }
      fs.rmSync(linkPath, { force: true })
      steps.push(`已移除链接: ${linkPath}`)
      changed = true
      finalState = 'missing'
    } else {
      // linked / vault-missing（悬空链接本体可删）
      fs.rmSync(linkPath, { force: true })
      steps.push(`已移除链接: ${linkPath}`)
      changed = true
      finalState = 'missing'
    }
  }

  // 回写该 agent 缓存
  if (changed) await computeAgentScans(agentId)
  return { changed, state: finalState, agentId, skill: skillName, steps }
}

/**
 * agentsDir 整目录链接开关（service 层；repair fixId='agents-dir' 走 enable 分支）：
 * enable = 重建 vault agents/ 硬链接共享目录；disable = 仅清理与 vault 同 inode 的硬链接文件。
 */
export async function setAgentsDirLink(
  agentId: number,
  enable: boolean,
  opts?: { trashRoot?: string },
): Promise<{ steps: string[]; state: LinkState; note?: string }> {
  const agent = requireAgent(agentId)
  if (agent.agentsDir === undefined) throw new ServiceError('NOT_FOUND', `agent ${agent.name} 未配置 agents_dir`)
  const vaultPath = getVaultPath()
  if (enable && !pathExists(vaultAgentsDir(vaultPath))) {
    throw new ServiceError('NOT_FOUND', `vault 中不存在 agents 目录，无源可链接: ${vaultAgentsDir(vaultPath)}`)
  }
  const result = enable ? repairAgentsDirHardlinks(vaultPath, agent.agentsDir, opts) : removeAgentsDirHardlinks(vaultPath, agent.agentsDir)
  await computeAgentScans(agentId) // 回写缓存
  return result
}

// ---------------------------------------------------------------------------
// import / doctor / repair / sync
// ---------------------------------------------------------------------------

/**
 * Skill 导入（CONFIRM_REQUIRED：先 plan 后执行）。
 * agentIds：导入完成后为其建立链接（Windows junction / WSL companion link），
 * 并把 skill 名补进 agent.include 白名单。单个 agent 建链失败不回滚导入本身。
 */
export async function importSkill(sourceDir: string, agentIds: number[] | undefined, confirmed?: boolean): Promise<SkillsImportResult> {
  const vaultPath = getVaultPath()
  const plan: SkillImportPlan = planImport(sourceDir, vaultPath)
  if (confirmed !== true) {
    return { confirmRequired: true, plan, steps: [] }
  }
  if (!plan.ok) throw new ServiceError('BAD_PAYLOAD', plan.error ?? '导入计划失败')

  const executed = await executeImport(sourceDir, vaultPath, { commit: true })

  // skills 表镜像 upsert（新 skill 立即可见）
  const db = getDatabase()
  upsertSkillRow(db, {
    name: plan.skillName,
    hasSkillMd: true,
    description: plan.frontmatter?.description ?? readSkillDescription(plan.targetDir),
  })

  // 逐 agent 建链（include 补齐 + junction/companion link）
  const steps = [...executed.steps]
  const links: Record<string, LinkState> = {}
  for (const agentId of agentIds ?? []) {
    let agent: SkillAgentInfo
    try {
      agent = requireAgent(agentId)
    } catch {
      steps.push(`agent ${agentId} 不存在，跳过建链`)
      continue
    }
    if (agent.platform === 'windows') {
      ensureInclude(agent, plan.skillName)
      const linkPath = path.join(agent.skillsDir, plan.skillName)
      const st = fs.lstatSync(linkPath, { throwIfNoEntry: false })
      if (st !== undefined && st.isDirectory() && !st.isSymbolicLink()) {
        steps.push(`${agent.name}: ${linkPath} 是真实目录，拒绝覆盖（保持原样）`)
        links[agent.name] = 'real-dir'
        continue
      }
      if (st !== undefined && !st.isSymbolicLink()) {
        steps.push(`${agent.name}: ${linkPath} 是普通文件，拒绝覆盖（保持原样）`)
        links[agent.name] = 'wrong-target'
        continue
      }
      if (st !== undefined) fs.rmSync(linkPath, { force: true })
      fs.mkdirSync(path.dirname(linkPath), { recursive: true })
      fs.symlinkSync(path.resolve(plan.targetDir), linkPath, 'junction')
      steps.push(`${agent.name}: 已创建 junction ${linkPath} → ${plan.targetDir}`)
      links[agent.name] = 'linked'
    } else {
      const distro = await resolveDistro()
      if (distro === undefined) {
        steps.push(`${agent.name}: WSL 不可用，跳过 WSL 建链`)
        links[agent.name] = 'missing'
        continue
      }
      ensureInclude(agent, plan.skillName)
      const r = await runCompanion(distro, ['link', plan.skillName, '--agent', agent.name], 60_000)
      const parsed = r.parsed as { ok?: boolean; results?: string[] } | undefined
      if (r.ok && parsed !== null && parsed !== undefined) {
        steps.push(`${agent.name}: ${(parsed.results ?? ['companion link 完成']).join('; ')}`)
        links[agent.name] = 'linked'
      } else {
        steps.push(`${agent.name}: companion link 失败: ${(r.parseError || r.stderr || '无输出').slice(-200)}`)
        links[agent.name] = 'missing'
      }
    }
  }

  // 受影响 agent 缓存回写
  if ((agentIds ?? []).length > 0) await computeAgentScans()
  return { plan, steps, links }
}

/** doctor：全量体检（agentId 可选过滤 agent 段；期望性不可用折叠为结构化项）。 */
export async function doctor(agentId?: number): Promise<SkillsDoctorResult> {
  const vaultPath = getVaultPath()
  const distro = await resolveDistro()
  const items: SkillDoctorItem[] = await runDoctor({ vaultPath, ...(distro !== undefined ? { distro } : {}) }, listAgents(), agentId)
  return { items }
}

/**
 * repair（CONFIRM_REQUIRED）：按 fixId 修复。
 * real-dir 永不自动处理 —— payload.linkPath 指向真实目录/文件时返回 manualRequired；
 * 修复后受影响 agent 的链接缓存回写。
 */
export async function repair(fixId: string, payload: Record<string, unknown> | undefined, confirmed?: boolean): Promise<SkillsRepairResult> {
  if (confirmed !== true) {
    return { confirmRequired: true, steps: [], message: `确认执行修复: ${fixId}` }
  }
  const vaultPath = getVaultPath()
  const p: Record<string, unknown> = { ...(payload ?? {}) }

  // real-dir 红线：relink 目标是真实目录/普通文件时拒绝自动处理，返回需人工
  if (fixId === 'relink' && typeof p.linkPath === 'string') {
    const st = fs.lstatSync(p.linkPath, { throwIfNoEntry: false })
    if (st !== undefined && !st.isSymbolicLink()) {
      return {
        steps: [],
        manualRequired: true,
        message: `${p.linkPath} 是真实${st.isDirectory() ? '目录' : '文件'}，永不自动处理（请人工处理或走导入流水线）`,
      }
    }
  }

  // agents-dir 修复：从 DB 解析 agentsDir（payload 只需 agentId）
  if (fixId === 'agents-dir') {
    const agentId = Number(p.agentId)
    if (!Number.isSafeInteger(agentId) || agentId < 1) throw new ServiceError('BAD_PAYLOAD', 'agents-dir fix requires payload.agentId')
    const agent = requireAgent(agentId)
    if (agent.agentsDir === undefined) throw new ServiceError('NOT_FOUND', `agent ${agent.name} 未配置 agents_dir`)
    p.agentsDir = agent.agentsDir
  }

  const distro = await resolveDistro()
  const outcome = await applyFix({ vaultPath, ...(distro !== undefined ? { distro } : {}) }, fixId, p as Record<string, string>)

  // 受影响 agent 缓存回写（relink/agents-dir/mkdir-agent 都改变链接形态）
  if (fixId === 'relink' || fixId === 'agents-dir' || fixId === 'mkdir-agent') {
    const agentId = Number(p.agentId)
    await computeAgentScans(Number.isSafeInteger(agentId) && agentId >= 1 ? agentId : undefined)
  }
  return {
    steps: outcome.steps ?? [outcome.message],
    ...(outcome.state !== undefined ? { state: outcome.state } : {}),
    ...(outcome.note !== undefined ? { note: outcome.note } : {}),
    message: outcome.message,
  }
}

/**
 * 双侧同步（CONFIRM_REQUIRED）：Windows add/commit/push → WSL companion sync →
 * Windows pull；冲突只收集不 force；vault 缺失/非 git 仓/git 不可用 → 结构化降级。
 */
export async function syncVault(confirmed?: boolean): Promise<SkillsSyncResult> {
  if (confirmed !== true) {
    return { confirmRequired: true, steps: [], conflicts: [] }
  }
  const vaultPath = getVaultPath()
  if (!fs.existsSync(vaultPath)) {
    return { steps: [], conflicts: [], degraded: true, reason: `vault 路径不存在: ${vaultPath}` }
  }
  if (!fs.existsSync(path.join(vaultPath, '.git'))) {
    return { steps: [], conflicts: [], degraded: true, reason: `vault 不是 git 仓库（缺 .git）: ${vaultPath}` }
  }
  if (!(await gitAvailable())) {
    return { steps: [], conflicts: [], degraded: true, reason: 'git 命令不可用（未安装或不在 PATH）' }
  }
  const distro = (await resolveDistro()) ?? 'Ubuntu'
  const { steps, conflicts } = await syncAll(vaultPath, distro)
  const lastSyncAt = nowSec()
  setSetting(LAST_SYNC_KEY, String(lastSyncAt))
  return { steps, conflicts, lastSyncAt }
}

/** 上次同步时间（settings；未同步过为 undefined）。 */
export function lastSyncAt(): number | undefined {
  const raw = getSetting(LAST_SYNC_KEY)
  if (raw === undefined || raw.trim().length === 0) return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}
