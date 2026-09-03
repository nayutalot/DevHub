/**
 * versionService.ts — 版本中心编排（S3 批次，docs/09 §7/§9）。
 *
 * - checkAll / checkOne：并行检查（每条独立超时 90s、独立失败互不影响），结果
 *   全量 upsert version_targets 快照表（docs/09 §3.5）；
 * - runUpdate（CONFIRM_REQUIRED 两段式）：winget 条目先 tasklist 预检目标进程
 *   （zcode/claude-desktop/codex），运行中 → { blocked:true, processName }；github 条目
 *   （DeepSeek Harness）首次点击一律先确认（源码重建耗时数分钟）；确认后以 job 形式执行，
 *   done 后自动重查一次并回写快照；
 * - job 状态机 running → done/failed（内存注册表 + versions:job 轮询；同一时刻每目标
 *   至多 1 个 running job）；更新类超时 20min、GitHub 重建 30min（经 core/exec 强制）；
 * - 绝不自动启动更新、绝不在应用启动时跑 update。
 * 测试 seam：updateCommandOverride（夹具假命令 node -e 注入，smoke 用例 59 状态机验证用）。
 */
import { run } from '../../core/exec.ts'
import { getDatabase } from '../../db/index.ts'
import type { CatalogEntry } from './catalog.ts'
import { VERSION_CATALOG, findCatalogEntry } from './catalog.ts'
import type {
  VersionJobSnapshot,
  VersionStatus,
  VersionTargetKind,
  VersionsCheckResult,
  VersionsUpdateResult,
} from '../../../shared/types.ts'
import { ServiceError, nowSec } from '../internal.ts'
import { getSetting } from '../settingsService.ts'
import { compareSemver, compareVersions } from './versionCompare.ts'
import { npmInstalled, npmLatest, npmUpgradeArgs } from './npm.ts'
import { wingetCheckInstalled, wingetListUpgrades, wingetUpgradeArgs } from './winget.ts'
import { nativeInstalledVersion, nativeUpdateCommand, resolveNativeBin, NATIVE_UPDATE_TIMEOUT_MS } from './native.ts'
import { arpInstalledVersion } from './arp.ts'
import {
  DEEPSEEK_ARP_DISPLAY_NAME,
  DEEPSEEK_DEFAULT_ROOT,
  GITHUB_UPDATE_COMMAND_TEXT,
  fetchLatestRelease,
  readLocalPackageVersion,
  runGithubUpdate,
} from './github.ts'

/** 检测类超时（docs/09 §7） */
export const CHECK_TIMEOUT_MS = 90_000
/** 更新类超时：npm/winget 拉包（docs/09 §7） */
export const UPDATE_TIMEOUT_MS = 20 * 60_000
/** 进程预检超时（tasklist 快命令） */
const PROCESS_PROBE_TIMEOUT_MS = 15_000

/** service 可注入依赖（smoke 夹具隔离 / 状态机 seam）。 */
export interface VcDeps {
  /** DeepSeek Harness 本体安装目录（github 通道；缺省读 settings.deepseekHarnessRoot） */
  deepseekRoot?: string
  /** native bin 的 home 覆盖（~ 展开用；测试注入） */
  homeDir?: string
  /** 更新命令注入 seam（测试用假命令，如 node -e；不注入则按 catalog 真实通道执行） */
  updateCommandOverride?: { command: string; args: string[] }
}

// ---------------------------------------------------------------------------
// version_targets 快照 upsert
// ---------------------------------------------------------------------------

function upsertStatusRow(status: VersionStatus): void {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO version_targets (key, display_name, kind, installed_version, target_version, state, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       display_name = excluded.display_name,
       kind = excluded.kind,
       installed_version = excluded.installed_version,
       target_version = excluded.target_version,
       state = excluded.state,
       last_checked_at = excluded.last_checked_at`,
  ).run(status.id, status.name, status.channelKind, status.installed, status.latest, status.state, nowSec())
}

/** versions:list：目录 8 条 + 库内快照合并（未检测过 = unknown + lastCheckedAt null）。 */
export function listTargets(): { targets: VersionStatus[] } {
  interface TargetRow {
    key: string
    installed_version: string | null
    target_version: string | null
    state: string
    last_checked_at: number | null
  }
  const rows = getDatabase()
    .prepare('SELECT key, installed_version, target_version, state, last_checked_at FROM version_targets')
    .all() as unknown as TargetRow[]
  const byKey = new Map<string, TargetRow>(rows.map((r) => [r.key, r]))
  const targets: VersionStatus[] = VERSION_CATALOG.map((e) => {
    const snap = byKey.get(e.id)
    return {
      id: e.id,
      name: e.name,
      channel: e.channel,
      channelKind: e.kind as VersionTargetKind,
      installed: snap?.installed_version ?? null,
      latest: snap?.target_version ?? null,
      state: (snap?.state as VersionStatus['state']) ?? 'unknown',
      hint: e.uiNote,
      lastCheckedAt: snap?.last_checked_at ?? null,
    }
  })
  return { targets }
}

// ---------------------------------------------------------------------------
// 单条检查
// ---------------------------------------------------------------------------

function deepseekRoot(deps: VcDeps | undefined): string {
  if (deps?.deepseekRoot !== undefined && deps.deepseekRoot.trim().length > 0) return deps.deepseekRoot
  try {
    const v = getSetting('deepseekHarnessRoot')
    if (v !== undefined && v.trim().length > 0) return v
  } catch {
    /* settings 白名单未含该 key 时按默认目录 */
  }
  return DEEPSEEK_DEFAULT_ROOT
}

async function checkOne(e: CatalogEntry, deps?: VcDeps): Promise<VersionStatus> {
  const base = {
    id: e.id,
    name: e.name,
    channel: e.channel,
    channelKind: e.kind as VersionTargetKind,
    hint: e.uiNote,
    lastCheckedAt: nowSec(),
  }
  switch (e.kind) {
    case 'native': {
      const r = await nativeInstalledVersion(e.native.binPath, { homeDir: deps?.homeDir })
      if (r.error !== undefined) return { ...base, installed: null, latest: null, state: 'check-failed', note: r.error }
      return { ...base, installed: r.version ?? null, latest: null, state: 'unknown', note: '最新版本由其自带更新器探测，可点击更新' }
    }
    case 'github': {
      // DeepSeek Harness：本地 = <installRoot>/package.json 的 version；最新 = GitHub Releases（含 prerelease，compareSemver 选最高）
      const root = deepseekRoot(deps)
      const local = readLocalPackageVersion(root)
      const latest = await fetchLatestRelease()
      if ('missing' in local) {
        // 安装目录缺失：installed 回退展示 ARP 注册表版本（仅展示，绝不据此判定 upgradable）
        const arp = await arpInstalledVersion(DEEPSEEK_ARP_DISPLAY_NAME)
        const fallback = arp.version ?? null
        if (!latest.ok) {
          return { ...base, installed: fallback, latest: null, state: 'check-failed', note: latest.error + '；本地目录也未找到（' + root + '）' }
        }
        return {
          ...base,
          installed: fallback,
          latest: latest.version,
          state: 'unknown',
          note:
            '未找到本地安装（可在设置中指定 deepseekHarnessRoot）' +
            (fallback !== null ? '；注册表 ARP 显示版本 ' + fallback + '（仅回退展示）' : ''),
        }
      }
      if ('error' in local) return { ...base, installed: null, latest: null, state: 'check-failed', note: local.error }
      if (!latest.ok) return { ...base, installed: local.version, latest: null, state: 'unknown', note: latest.error }
      const c = compareSemver(local.version, latest.version)
      if (c === null) {
        return { ...base, installed: local.version, latest: latest.version, state: 'unknown', note: '版本号不可比较' }
      }
      return {
        ...base,
        installed: local.version,
        latest: latest.version,
        state: c < 0 ? 'upgradable' : 'up-to-date',
        note: c < 0 ? '最新 ' + latest.tag + '（' + latest.publishedAt.slice(0, 10) + '）' : undefined,
      }
    }
    case 'npm': {
      const inst = await npmInstalled()
      if ('error' in inst) return { ...base, installed: null, latest: null, state: 'check-failed', note: inst.error }
      const installed = inst.map.get(e.npm.pkg) ?? null
      const latest = await npmLatest(e.npm.pkg)
      if (latest.error !== undefined) {
        return installed !== null
          ? { ...base, installed, latest: null, state: 'unknown', note: latest.error }
          : { ...base, installed: null, latest: null, state: 'check-failed', note: latest.error }
      }
      if (installed === null) {
        return { ...base, installed: null, latest: latest.version ?? null, state: 'unknown', note: 'npm -g 未安装该包（可能经其他通道安装）' }
      }
      const c = compareVersions(installed, latest.version ?? '')
      if (c === null) return { ...base, installed, latest: latest.version ?? null, state: 'unknown', note: '版本号不可比较' }
      return { ...base, installed, latest: latest.version ?? null, state: c < 0 ? 'upgradable' : 'up-to-date' }
    }
    case 'winget': {
      const [inst, upgrades] = await Promise.all([
        wingetCheckInstalled(e.winget.packageId, { exact: e.listExact !== false }),
        wingetListUpgrades(),
      ])
      const up = 'map' in upgrades ? upgrades.map.get(e.winget.packageId.toLowerCase()) : undefined
      const failed = 'error' in upgrades ? upgrades.error : undefined
      if (inst.error !== undefined && inst.version === undefined) {
        return { ...base, installed: null, latest: null, state: 'check-failed', note: inst.error }
      }
      if (up !== undefined) {
        return {
          ...base,
          installed: up.installed ?? inst.version ?? null,
          latest: up.available ?? null,
          state: 'upgradable',
          note: e.storeFallback === true ? '商店系应用：若 winget 更新失败，请通过 Microsoft Store 手动更新' : undefined,
        }
      }
      if (inst.version === undefined) {
        return failed !== undefined
          ? { ...base, installed: null, latest: null, state: 'check-failed', note: inst.error ?? 'winget 未检测到已装记录，且升级清单获取失败' }
          : { ...base, installed: null, latest: null, state: 'unknown', note: 'winget 清单中无此应用的已装与升级记录（未安装或商店清单延迟）' }
      }
      return failed !== undefined
        ? {
            ...base,
            installed: inst.version,
            latest: null,
            state: 'unknown',
            note: '已检测到安装，但 winget upgrade 清单获取失败，无法判断是否可升级',
          }
        : { ...base, installed: inst.version, latest: null, state: 'up-to-date' }
    }
  }
}

/** 单条检查兜底：任何异常 → check-failed（不影响他条） */
async function checkOneSafe(e: CatalogEntry, deps?: VcDeps): Promise<VersionStatus> {
  try {
    return await checkOne(e, deps)
  } catch (err) {
    return {
      id: e.id,
      name: e.name,
      channel: e.channel,
      channelKind: e.kind as VersionTargetKind,
      hint: e.uiNote,
      installed: null,
      latest: null,
      state: 'check-failed',
      note: String(err instanceof Error ? err.message : err).slice(0, 300),
      lastCheckedAt: nowSec(),
    }
  }
}

// ---------------------------------------------------------------------------
// checkAll / checkSingle
// ---------------------------------------------------------------------------

/** 全量检查：并行、独立失败；结果全量 upsert version_targets。 */
export async function checkAll(deps?: VcDeps): Promise<VersionsCheckResult> {
  const statuses = await Promise.all(VERSION_CATALOG.map((e) => checkOneSafe(e, deps)))
  for (const s of statuses) upsertStatusRow(s)
  return { ts: Date.now(), statuses, stale: false }
}

/** 单条检查（versions:check { id }）；成功时 upsert 该条快照。 */
export async function checkOneById(id: string, deps?: VcDeps): Promise<VersionsCheckResult> {
  const e = findCatalogEntry(id)
  if (e === undefined) throw new ServiceError('NOT_FOUND', `版本目录中不存在该条目: ${String(id)}`)
  const status = await checkOneSafe(e, deps)
  if (status.state !== 'check-failed') upsertStatusRow(status)
  return { ts: Date.now(), statuses: [status], stale: false }
}

// ---------------------------------------------------------------------------
// 更新 job 状态机（仅用户点击触发；内存注册表，IPC 轮询）
// ---------------------------------------------------------------------------

interface UpdateJob {
  jobId: string
  entryId: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  log: string[]
  error?: string
  after?: VersionStatus
  startedAt: number
  finishedAt?: number
}

const jobs = new Map<string, UpdateJob>()
let jobSeq = 0
/** 已结束 job 的保留上限（防内存日志无限增长） */
const JOB_KEEP = 30

function pruneJobs(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  while (finished.length > JOB_KEEP) {
    const oldest = finished.shift()
    if (oldest !== undefined) jobs.delete(oldest.jobId)
  }
}

function snapshot(j: UpdateJob): VersionJobSnapshot {
  return {
    jobId: j.jobId,
    entryId: j.entryId,
    status: j.status,
    log: j.log.slice(-400),
    error: j.error,
    after: j.after,
  }
}

/** versions:job { jobId }：不存在/已被清理 → NOT_FOUND。 */
export function jobSnapshot(jobId: string): VersionJobSnapshot {
  const j = jobs.get(jobId)
  if (j === undefined) throw new ServiceError('NOT_FOUND', `更新任务不存在或已被清理: ${String(jobId)}`)
  return snapshot(j)
}

/** 按条目通道构造更新命令（npm/winget/native；github 走多步流水线，不产生单条命令）。 */
function resolveUpdateCommand(e: CatalogEntry, deps: VcDeps | undefined): { command: string; args: string[]; timeoutMs: number; text: string } {
  if (deps?.updateCommandOverride !== undefined) {
    return {
      command: deps.updateCommandOverride.command,
      args: deps.updateCommandOverride.args,
      timeoutMs: UPDATE_TIMEOUT_MS,
      text: `${deps.updateCommandOverride.command} ${deps.updateCommandOverride.args.join(' ')}`,
    }
  }
  switch (e.kind) {
    case 'winget': {
      const args = wingetUpgradeArgs(e.winget.packageId)
      return { command: 'winget', args, timeoutMs: UPDATE_TIMEOUT_MS, text: `winget ${args.join(' ')}` }
    }
    case 'npm': {
      const args = npmUpgradeArgs(e.npm.pkg)
      return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', 'chcp', '65001', '>nul', '&&', 'npm', ...args],
        timeoutMs: UPDATE_TIMEOUT_MS,
        text: `npm ${args.slice(0, 3).join(' ')} …（经 cmd.exe 通道）`,
      }
    }
    case 'native': {
      const bin = resolveNativeBin(e.native.binPath, deps?.homeDir)
      if (bin === null) throw new ServiceError('NOT_FOUND', `未找到自带更新器可执行文件: ${e.native.binPath}`)
      const c = nativeUpdateCommand(bin)
      return { command: c.command, args: c.args, timeoutMs: NATIVE_UPDATE_TIMEOUT_MS, text: `${bin} update` }
    }
    case 'github':
      throw new ServiceError('DEGRADED', 'github 条目走多步重建流水线（runGithubUpdate），无单条更新命令')
  }
}

async function runUpdateJobBody(e: CatalogEntry, job: UpdateJob, deps: VcDeps | undefined): Promise<void> {
  if (e.kind === 'github') {
    // DeepSeek Harness 源码重建：多步流水线（每步超时内建于 github.ts），进度进日志
    job.log.push(`$ ${GITHUB_UPDATE_COMMAND_TEXT}`)
    const outcome = await runGithubUpdate(deepseekRoot(deps), {
      onLine: (line) => job.log.push(line),
    })
    if (!outcome.ok) {
      job.status = 'failed'
      job.error = (outcome.error ?? '无输出').slice(-1500)
      job.log.push('✗ 重建流水线失败')
      return
    }
    job.log.push('✓ 重建完成，正在重新检查版本…')
  } else {
    const cmd = resolveUpdateCommand(e, deps)
    job.log.push(`$ ${cmd.text}`)
    const r = await run(cmd.command, [...cmd.args], { timeoutMs: cmd.timeoutMs })
    if (r.timedOut) {
      job.status = 'failed'
      job.error = `更新命令超时（${cmd.timeoutMs}ms），已终止`
      job.log.push(`✗ ${job.error}`)
      return
    }
    if (r.code !== 0) {
      job.status = 'failed'
      job.error = (r.stderr || r.stdout || '无输出').trim().slice(-1500)
      job.log.push(`✗ 更新命令失败（退出码 ${r.code}）`)
      if (e.kind === 'winget' && e.storeFallback === true) {
        job.log.push('ⓘ 商店系应用：可打开 Microsoft Store 手动更新')
      }
      return
    }
    job.log.push('✓ 更新命令执行成功，正在重新检查版本…')
  }

  // done 后自动重查一次（独立一轮检查，快照回写 version_targets）
  const after = await checkOneSafe(e, deps)
  if (after.state !== 'check-failed') upsertStatusRow(after)
  job.after = after
  job.log.push(`✓ 更新完成：当前 ${after.installed ?? '?'}${after.latest !== null ? `（最新 ${after.latest}）` : ''}`)
  job.status = 'done'
}

/**
 * 启动更新 job。同一目标并发更新直接抛错（envelope → { ok:false }）。
 * deps.updateCommandOverride 为测试 seam（smoke 用例 59 的假命令注入）。
 */
export function startUpdateJob(e: CatalogEntry, deps?: VcDeps): VersionJobSnapshot {
  for (const j of jobs.values()) {
    if (j.entryId === e.id && j.status === 'running') {
      throw new ServiceError('DB_ERROR', `该条目已在更新中，请等待完成或先查询 job: ${e.id}`)
    }
  }
  jobSeq += 1
  const job: UpdateJob = { jobId: `vc-${Date.now()}-${jobSeq}`, entryId: e.id, status: 'running', log: [], startedAt: nowSec() }
  jobs.set(job.jobId, job)
  pruneJobs()
  void runUpdateJobBody(e, job, deps)
    .catch((err: unknown) => {
      if (job.status === 'running') {
        job.status = 'failed'
        job.error = String(err instanceof Error ? err.message : err).slice(0, 1500)
      }
      job.finishedAt = nowSec()
    })
    .finally(() => {
      job.finishedAt = job.finishedAt ?? nowSec()
    })
  return snapshot(job)
}

// ---------------------------------------------------------------------------
// 更新预检（tasklist 检测目标进程是否在运行）
// ---------------------------------------------------------------------------

/** 逐个进程名探测：tasklist /FI 字面量参数；命中返回该进程名。 */
async function findRunningProcess(names: readonly string[]): Promise<string | null> {
  for (const n of names) {
    const r = await run('tasklist', ['/FI', `IMAGENAME eq ${n}`, '/FO', 'CSV', '/NH'], { timeoutMs: PROCESS_PROBE_TIMEOUT_MS })
    if (r.stdout.toLowerCase().includes(n.toLowerCase())) return n
  }
  return null
}

/**
 * runUpdate（CONFIRM_REQUIRED 两段式，docs/09 §8.3/§7.2）：
 * - 不带 confirmed：github 条目一律 { confirmRequired, blocked:true }（重建耗时数分钟）；
 *   带 processNames 的 winget 条目先预检 → 运行中 { confirmRequired, blocked:true, running:true, processName }；
 *   其余条目 { confirmRequired: true }；
 * - confirmed：启动 job → { blocked:false, jobId }。
 */
export async function requestUpdate(id: string, confirmed?: boolean, deps?: VcDeps): Promise<VersionsUpdateResult> {
  const e = findCatalogEntry(id)
  if (e === undefined) throw new ServiceError('NOT_FOUND', `版本目录中不存在该条目: ${String(id)}`)
  if (confirmed !== true) {
    if (e.kind === 'github') {
      return { confirmRequired: true, blocked: true, running: false }
    }
    if (e.kind === 'winget' && e.processNames !== undefined && e.processNames.length > 0) {
      const running = await findRunningProcess(e.processNames)
      if (running !== null) return { confirmRequired: true, blocked: true, running: true, processName: running }
    }
    return { confirmRequired: true, blocked: false }
  }
  const job = startUpdateJob(e, deps)
  return { blocked: false, jobId: job.jobId }
}
