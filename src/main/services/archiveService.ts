/**
 * archiveService.ts — 归档编排（S5 批次，docs/10 全文权威；唯一写库层）。
 *
 * 生命周期（docs/10 §1）：预检 → 引用预览 → 确认 → 执行 → 复核 → 回滚（按需）。
 * 两段式衔接：preview 在服务端签发 previewId 并把完整上下文挂入内存注册表
 * （10 分钟超时失效）；run 必须携带该 previewId 且 confirmed 才执行——
 * 强制 dry-run（安全规则 1），杜绝跳过预览直跑。
 *
 * 写库范围：archive_runs（含 100 上限裁剪）/ archives / projects.win_path 联动。
 * 无 electron import；外部命令只经 archive/procGuard → core/exec。
 *
 * 铁律落点（docs/10 §10 安全规则，smoke 76/77/78 逐条覆盖）：
 * 1 强制 dry-run：无 previewId / 伪造 / 过期一律 NOT_FOUND 拒绝；
 * 2 二次确认：run 不带 confirmed 只回 confirmRequired + impacts（再次展示）；
 * 3 绝不删数据：只有 rename/copy/修复改写三种写行为；跨卷失败保源清半成品；
 *   剥离仅限 depDirs 规则判定的可再生日录；删除失败降级为残留报告；
 * 4 回滚可用：undo 清单逐条 copyFile 覆写，幂等可重复执行；
 * 5 非法路径拒绝：old_path 恒取 projects.win_path（run 前复核未被并发改动）；
 *   dest_root 在 old_path 内部 → 拒绝（防自吞）；UNC 目标 → 拒绝（只允许本地卷）。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '../db/index.ts'
import { wslPathForWinPath } from '../adapters/wsl.ts'
import type {
  ArchiveFileFix,
  ArchiveHistoryResult,
  ArchiveOccupier,
  ArchivePhase,
  ArchivePreviewImpacts,
  ArchivePreviewResult,
  ArchiveRollbackResult,
  ArchiveRollbackStart,
  ArchiveRunResult,
  ArchiveRunStart,
  ArchiveStatusResult,
} from '../../shared/types.ts'
import { errorMessage, normalizePathKey, nowSec, ServiceError } from './internal.ts'
import { getSetting } from './settingsService.ts'
import { detectDepSkipDirs, dirSizeBytes, exists, moveDirectory, uniqueDestPath } from './archive/mover.ts'
import type { MoveResult } from './archive/mover.ts'
import { createCancelToken, findRefs, uniqueHitFiles } from './archive/walker.ts'
import type { CancelToken, RefScanResult } from './archive/walker.ts'
import {
  applyFixes,
  readUndoManifest,
  remapMovedPath,
  restoreBackups,
  saveUndoManifest,
  undoDirOf,
  undoManifestPath,
} from './archive/pathFixer.ts'
import type { FixOutcome } from './archive/pathFixer.ts'
import { findOccupiersForPath, killOccupierPids, probeDirMovable } from './archive/procGuard.ts'

// ---------------------------------------------------------------------------
// 常量与内存状态
// ---------------------------------------------------------------------------

/** 预览凭证有效期：10 分钟（超时失效，须重新 preview） */
const PREVIEW_TTL_MS = 10 * 60_000
/** 发给渲染层的命中条目上限：真实项目（含日志/备份目录）可命中数十万条，
 * 全量直传会撑爆渲染进程；修复在主进程按文件进行，不受截断影响（老实现同款） */
const MAX_HITS_TO_RENDERER = 2000
/** archive_runs 历史上限（docs/10 §8；insert 后裁剪，undo 目录不随裁剪删除） */
export const ARCHIVE_HISTORY_LIMIT = 100

interface PendingPreview {
  previewId: string
  projectId: number
  projectName: string
  /** 被归档项目旧路径（== projects.win_path @preview 时刻） */
  winPath: string
  destRoot: string
  destPath: string
  crossVolume: boolean
  /** 引用扫描全量结果（session 内保留全量供修复使用；渲染层拿截断副本） */
  scan: RefScanResult
  occupiers: ArchiveOccupier[]
  dirLocked: boolean
  depSkipDirs: string[]
  /** 其他已登记项目（引用扫描与改写的外部目标） */
  refTargets: { label: string; root: string }[]
  createdAt: number
  expiresAt: number
}

const pendingPreviews = new Map<string, PendingPreview>()

/** 执行期进度注册表（archive:status 轮询；docs/10 §11 无广播 channel） */
interface RunProgress {
  phase: ArchivePhase
  percent?: number
  log: string[]
  startedAt: number
}
const runProgress = new Map<string, RunProgress>()

/** preview 阶段的取消 token（单活跃预览，语义同「至多一个 running 扫描」） */
let activePreviewToken: CancelToken | null = null

function pruneExpiredPreviews(): void {
  const now = Date.now()
  for (const [id, p] of pendingPreviews) {
    if (now > p.expiresAt) pendingPreviews.delete(id)
  }
  for (const [id, r] of runProgress) {
    if (now - r.startedAt > 60 * 60_000) runProgress.delete(id)
  }
}

/** 安全规则 1 的服务端校验点：previewId 必须对应一条有效（未过期）的预览记录。 */
function getPendingPreview(previewId: string): PendingPreview {
  pruneExpiredPreviews()
  const pending = pendingPreviews.get(previewId)
  if (pending === undefined) {
    throw new ServiceError('NOT_FOUND', 'preview not found or expired — run archive:preview first (forced dry-run)')
  }
  return pending
}

// ---------------------------------------------------------------------------
// 内部查询
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number
  name: string
  win_path: string | null
  wsl_path: string | null
}

function readProjectRow(db: DatabaseSync, id: number): ProjectRow {
  const row = db.prepare('SELECT id, name, win_path, wsl_path FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `project ${id} not found`)
  }
  return row
}

async function statIsDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** 本地盘符卷校验（安全规则 5：跨设备移动只允许常规本地卷，拒 UNC/相对路径）。 */
function localDriveRoot(p: string): string | null {
  const resolved = path.resolve(p.trim())
  const m = resolved.match(/^([A-Za-z]):\\/)
  return m !== null ? m[1].toUpperCase() : null
}

function pushLog(previewId: string, message: string): void {
  const progress = runProgress.get(previewId)
  if (progress !== undefined && progress.log.length < 500) progress.log.push(message)
}

function setPhase(previewId: string, phase: ArchivePhase): void {
  const progress = runProgress.get(previewId)
  if (progress !== undefined) progress.phase = phase
}

// ---------------------------------------------------------------------------
// previewArchive：强制 dry-run（只读，绝不移动任何东西）
// ---------------------------------------------------------------------------

export async function previewArchive(projectId: number, opts: { destRoot?: string } = {}): Promise<ArchivePreviewResult> {
  pruneExpiredPreviews()
  const db = getDatabase()
  const project = readProjectRow(db, projectId)
  if (project.win_path === null || project.win_path.trim().length === 0) {
    throw new ServiceError('DB_ERROR', `project "${project.name}" has no win_path; archive targets Windows projects (projects.win_path)`)
  }
  const winPath = project.win_path.trim()
  if (!(await statIsDir(winPath))) {
    throw new ServiceError('NOT_FOUND', `project folder does not exist or is not a directory: ${winPath}`)
  }

  // 目标根：显式指定优先，否则读 settings.archive_dest_root；空值绝不猜默认盘
  const destRoot = (opts.destRoot ?? getSetting('archive_dest_root') ?? '').trim()
  if (destRoot.length === 0) {
    throw new ServiceError('DB_ERROR', 'archive_dest_root is not set — configure it in Archive settings first (never guessed)')
  }
  if (!(await statIsDir(destRoot))) {
    throw new ServiceError('NOT_FOUND', `archive destination root does not exist or is not a directory: ${destRoot}`)
  }
  if (localDriveRoot(destRoot) === null) {
    throw new ServiceError('DB_ERROR', `archive destination must be a regular local volume (drive letter), got: ${destRoot}`)
  }

  // 安全规则 5（防自吞）：dest_root 不得位于 old_path 内部
  const oldKey = normalizePathKey(winPath)
  const destKey = normalizePathKey(destRoot)
  if (destKey === oldKey || destKey.startsWith(`${oldKey}/`)) {
    throw new ServiceError('DB_ERROR', 'archive_dest_root must not be inside the project directory (self-swallow guard)')
  }
  const srcDrive = localDriveRoot(winPath)
  const crossVolume = srcDrive !== null && srcDrive !== localDriveRoot(destRoot)

  // 目标重名去重：<name>-archived-YYYYMMDD(-N)（老 uniqueDestPath 语义）
  const destPath = await uniqueDestPath(destRoot, project.name)

  // 占用检测：识别引用了项目路径的进程 + 目录锁定探测（终端/资源管理器停留）
  const [occupiers, movable] = await Promise.all([
    findOccupiersForPath(winPath),
    probeDirMovable(winPath)
      .then((ok) => !ok)
      .catch(() => true),
  ])

  // 引用扫描：本项目 + 其他已登记项目（win_path 归一匹配取代老软件手动登记）
  const otherRows = db
    .prepare('SELECT id, name, win_path FROM projects WHERE id != ? AND win_path IS NOT NULL ORDER BY id')
    .all(projectId) as { id: number; name: string; win_path: string | null }[]
  const refTargets: { label: string; root: string }[] = []
  for (const r of otherRows) {
    if (r.win_path !== null && (await statIsDir(r.win_path))) {
      refTargets.push({ label: r.name, root: r.win_path })
    }
  }

  const token = createCancelToken()
  activePreviewToken = token
  let scan: RefScanResult
  try {
    scan = await findRefs([{ label: project.name, root: winPath }, ...refTargets], winPath, { token })
  } catch (err) {
    if (err instanceof Error && err.name === 'WalkerCancelledError') {
      throw new ServiceError('EXEC_FAILED', 'preview cancelled')
    }
    throw err
  } finally {
    activePreviewToken = null
  }

  const depSkipDirs = await detectDepSkipDirs(winPath)

  const previewId = `arc-${randomUUID()}`
  const expiresAt = Date.now() + PREVIEW_TTL_MS
  const pending: PendingPreview = {
    previewId,
    projectId,
    projectName: project.name,
    winPath,
    destRoot,
    destPath,
    crossVolume,
    scan,
    occupiers,
    dirLocked: movable,
    depSkipDirs,
    refTargets,
    createdAt: Date.now(),
    expiresAt,
  }
  pendingPreviews.set(previewId, pending)
  return { previewId, expiresAt, impacts: buildImpacts(pending) }
}

/** 组装渲染层影响面（hits 截断至 MAX_HITS_TO_RENDERER，totalHits 保留真实值）。 */
function buildImpacts(pending: PendingPreview): ArchivePreviewImpacts {
  return {
    projectId: pending.projectId,
    projectName: pending.projectName,
    oldPath: pending.winPath,
    destRoot: pending.destRoot,
    destPath: pending.destPath,
    crossVolume: pending.crossVolume,
    occupiers: pending.occupiers,
    dirLocked: pending.dirLocked,
    depSkipDirs: pending.depSkipDirs,
    report: {
      hits: pending.scan.hits.slice(0, MAX_HITS_TO_RENDERER),
      totalHits: pending.scan.totalHits,
      scannedFiles: pending.scan.scannedFiles,
      skippedBinary: pending.scan.skippedBinary,
      skippedOversize: pending.scan.skippedOversize,
      errorSummary: pending.scan.errorSummary,
    },
    refProjects: pending.refTargets.map((t) => t.label),
  }
}

/** 取消当前进行中的 preview 扫描（walker 每 64 文件检查一次 token）。 */
export function cancelPreview(): { cancelled: boolean } {
  if (activePreviewToken !== null) {
    activePreviewToken.cancelled = true
    return { cancelled: true }
  }
  return { cancelled: false }
}

// ---------------------------------------------------------------------------
// runArchive：校验 pending preview → 移动 → 改写 → 残留复核 → 落库联动
// ---------------------------------------------------------------------------

export async function runArchive(
  previewId: string,
  confirmed?: boolean,
  killPids?: number[],
): Promise<ArchiveRunStart | ArchiveRunResult> {
  const pending = getPendingPreview(previewId)

  // 两段式：不带 confirmed 只回 confirmRequired + impacts（安全规则 2 的服务端半边）
  if (confirmed !== true) {
    return { confirmRequired: true, impacts: buildImpacts(pending) }
  }

  const db = getDatabase()

  // 安全规则 5：old_path 必须 == projects.win_path（preview 后被并发改动则拒绝）
  const project = readProjectRow(db, pending.projectId)
  if (project.win_path === null || normalizePathKey(project.win_path) !== normalizePathKey(pending.winPath)) {
    pendingPreviews.delete(previewId)
    throw new ServiceError('DB_ERROR', 'project win_path changed since preview — preview again before running')
  }

  // killPids 红线：必须出自 preview impacts 的 occupiers 清单（再次确认语义——
  // 只允许终止用户在预览影响面里看到的进程）
  const occupierPids = new Set(pending.occupiers.map((o) => o.pid))
  if (killPids !== undefined) {
    for (const pid of killPids) {
      if (!occupierPids.has(pid)) {
        throw new ServiceError('BAD_PAYLOAD', `killPids contains pid ${pid} which is not in the previewed occupiers list`)
      }
    }
  }

  const startedAt = nowSec()
  const wallStart = Date.now()
  const movedFrom = pending.winPath
  const movedTo = pending.destPath

  // 占用复检以执行时刻为准（预检后又新起的进程也能发现，老实现同款）：
  // 有占用且未勾选终止 → PROJECT_LOCKED；终止后仍有残留占用 → PROJECT_LOCKED
  const occupiersNow = await findOccupiersForPath(movedFrom)
  if (occupiersNow.length > 0) {
    if (killPids === undefined || killPids.length === 0) {
      throw new ServiceError(
        'PROJECT_LOCKED',
        `project is occupied by ${occupiersNow.length} process(es): ${occupiersNow.map((o) => `${o.name}(${o.pid})`).join(', ')} — close them, preview again and pass killPids`,
      )
    }
  }
  if (killPids !== undefined && killPids.length > 0) {
    const { killed, failed } = await killOccupierPids(killPids, () => {})
    const remaining = await findOccupiersForPath(movedFrom)
    if (remaining.length > 0 || failed.length > 0) {
      throw new ServiceError(
        'PROJECT_LOCKED',
        `occupiers persist after kill (killed=[${killed.join(',')}] failed=[${failed.join(',')}] remaining=${remaining.length}) — nothing was moved`,
      )
    }
  }
  // 目录句柄/CWD 锁定探测（rename 探测，执行时刻为准）
  const movable = await probeDirMovable(movedFrom).catch(() => false)
  if (!movable) {
    throw new ServiceError(
      'PROJECT_LOCKED',
      `directory is locked by a handle or working directory (rename probe failed): ${movedFrom} — close the holder first`,
    )
  }

  // 目标复核（preview 之后外力可能建了目录）：非空目标绝不盲目清场
  if (await exists(movedTo)) {
    const entries = await fsp.readdir(movedTo).catch(() => ['?'])
    if (entries.length > 0) {
      throw new ServiceError('DB_ERROR', `archive destination already exists and is not empty: ${movedTo}`)
    }
  }

  // 先插 archive_runs 行取号（status 'running'；undo 目录以该 id 命名——
  // 回滚只依赖本库与 undo 目录，不依赖任何外部状态，安全规则 4）
  const insertRun = db
    .prepare(
      "INSERT INTO archive_runs (project_id, project_name, old_path, new_path, status, fixed_files, external_files, residual_hits, started_at) VALUES (?, ?, ?, ?, 'running', 0, 0, 0, ?)",
    )
    .run(pending.projectId, pending.projectName, movedFrom, movedTo, startedAt)
  const runId = Number(insertRun.lastInsertRowid)

  runProgress.set(previewId, { phase: 'moving', log: [], startedAt: wallStart })

  try {
    // 1) 移动（同卷 rename / 跨卷并发校验复制；skipDepDirs 剥离可再生日录）
    let move: MoveResult
    try {
      move = await moveDirectory(
        movedFrom,
        movedTo,
        {
          onProgress: (done, total) => {
            const progress = runProgress.get(previewId)
            if (progress !== undefined && total > 0) progress.percent = Math.round((done / total) * 100)
          },
          // 移动一旦开始即不可拆分，不再响应取消（保证一致性，老实现同款）
          isCancelled: () => false,
        },
        { skipDepDirs: true },
      )
    } catch (err) {
      throw new ServiceError('EXEC_FAILED', `move failed (source kept intact): ${errorMessage(err)}`)
    }
    pushLog(previewId, `移动完成 mode=${move.mode} -> ${movedTo} skippedDeps=[${move.skippedDeps.join(',')}] links=${move.skippedLinks}`)
    if (move.sourceLeftovers.length > 0) {
      pushLog(previewId, `原位置残留 ${move.sourceLeftovers.length} 项未能自动删除（不影响归档，可手动清理）`)
    }

    // 2) 路径修复：内部文件（remap 到新位置）+ 外部项目引用（仍在原位）
    setPhase(previewId, 'fixing')
    const backupDir = undoDirOf(runId)
    const fromKey = normalizePathKey(movedFrom)
    const isInternal = (f: string): boolean => normalizePathKey(f).startsWith(fromKey)
    const internalFiles = uniqueHitFiles(pending.scan.hits.filter((h) => isInternal(h.file))).map((f) =>
      remapMovedPath(f, movedFrom, movedTo),
    )
    const externalFiles = uniqueHitFiles(pending.scan.hits.filter((h) => !isInternal(h.file)))

    const fixInternal = await applyFixes(internalFiles, movedFrom, movedTo, backupDir)
    const fixExternal = await applyFixes(externalFiles, movedFrom, movedTo, backupDir)
    saveUndoManifest({
      runId,
      entries: [...fixInternal.fixed, ...fixExternal.fixed].map((f) => ({ target: f.file, backup: f.backup })),
    })
    pushLog(
      previewId,
      `改写完成 internal=${fixInternal.fixed.length} external=${fixExternal.fixed.length} replacements=${fixInternal.totalReplacements + fixExternal.totalReplacements} nonUtf8=${fixInternal.skippedNonUtf8.length + fixExternal.skippedNonUtf8.length} missing=${fixInternal.missing.length + fixExternal.missing.length}`,
    )
    for (const f of [...fixInternal.skippedNonUtf8, ...fixExternal.skippedNonUtf8]) {
      pushLog(previewId, `非 UTF-8 编码，已跳过自动改写: ${f}`)
    }

    // 3) 残留复核：对新路径 + 外部项目重扫旧根引用
    setPhase(previewId, 'verifying')
    const residualScan = await findRefs([{ label: pending.projectName, root: movedTo }, ...pending.refTargets], movedFrom)
    const residualHits = residualScan.totalHits
    if (residualHits > 0) {
      pushLog(previewId, `仍有 ${residualHits} 处残留引用（多为非 UTF-8 跳过文件）`)
    }

    // 4) 联动（docs/10 §9）：projects.win_path 更新、archives 插行、archive_runs 完结
    setPhase(previewId, 'done')
    const now = nowSec()
    const newWslPath = project.wsl_path !== null ? wslPathForWinPath(movedTo) : null
    db.prepare('UPDATE projects SET win_path = ?, wsl_path = ?, updated_at = ? WHERE id = ?').run(
      movedTo,
      newWslPath,
      now,
      pending.projectId,
    )

    const sizeBytes = await dirSizeBytes(movedTo)
    db.prepare(
      'INSERT INTO archives (project_id, archive_path, run_id, old_path, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(pending.projectId, movedTo, runId, movedFrom, sizeBytes, now, now)

    db.prepare(
      'UPDATE archive_runs SET status = ?, fixed_files = ?, external_files = ?, residual_hits = ?, stripped_json = ?, finished_at = ? WHERE id = ?',
    ).run('done', fixInternal.fixed.length, fixExternal.fixed.length, residualHits, JSON.stringify(move.skippedDeps), now, runId)
    trimArchiveRuns(db)

    pendingPreviews.delete(previewId)
    pushLog(previewId, '归档完成')

    return {
      confirmRequired: undefined,
      runId,
      movedFrom,
      movedTo,
      mode: move.mode,
      fixed: toFileFixes(fixInternal),
      external: toFileFixes(fixExternal),
      totalReplacements: fixInternal.totalReplacements + fixExternal.totalReplacements,
      residualHits,
      skippedDeps: move.skippedDeps,
      skippedLinks: move.skippedLinks,
      sourceLeftovers: move.sourceLeftovers,
      durationMs: Date.now() - wallStart,
    }
  } catch (err) {
    // fatal 步失败：保源 + 清半成品（mover 内完成）+ run 置 failed（docs/10 §1）
    const progress = runProgress.get(previewId)
    if (progress !== undefined) progress.phase = 'failed'
    try {
      db.prepare("UPDATE archive_runs SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'running'").run(nowSec(), runId)
    } catch {
      /* 落库失败不掩盖原始异常 */
    }
    throw err instanceof ServiceError ? err : new ServiceError('EXEC_FAILED', errorMessage(err))
  }
}

/** FixOutcome → 逐文件结果（fixed / skipped-non-utf8 / missing 三态，UI 失败标红）。 */
function toFileFixes(outcome: FixOutcome): ArchiveFileFix[] {
  const out: ArchiveFileFix[] = []
  for (const f of outcome.fixed) out.push({ file: f.file, count: f.count, kind: 'fixed' })
  for (const f of outcome.skippedNonUtf8) out.push({ file: f, count: 0, kind: 'skipped-non-utf8' })
  for (const f of outcome.missing) out.push({ file: f, count: 0, kind: 'missing' })
  return out
}

/** 历史上限 100：insert 后裁剪（docs/10 §8；undo 目录不随裁剪删除）。 */
export function trimArchiveRuns(db: DatabaseSync): void {
  db.prepare(
    `DELETE FROM archive_runs WHERE id NOT IN (SELECT id FROM archive_runs ORDER BY id DESC LIMIT ${ARCHIVE_HISTORY_LIMIT})`,
  ).run()
}

// ---------------------------------------------------------------------------
// rollbackArchive：两段式 undo 恢复（内容还原 + 目录移回 + projects 还原）
// ---------------------------------------------------------------------------

interface ArchiveRunDbRow {
  id: number
  project_id: number | null
  project_name: string
  old_path: string
  new_path: string
  status: string
  fixed_files: number
}

const RUN_ROW_SQL = 'SELECT id, project_id, project_name, old_path, new_path, status, fixed_files FROM archive_runs WHERE id = ?'

export async function rollbackArchive(runId: number, confirmed?: boolean): Promise<ArchiveRollbackStart | ArchiveRollbackResult> {
  const db = getDatabase()
  const run = db.prepare(RUN_ROW_SQL).get(runId) as ArchiveRunDbRow | undefined
  if (run === undefined) {
    throw new ServiceError('NOT_FOUND', `archive run ${runId} not found`)
  }
  if (run.status === 'rolled-back') {
    throw new ServiceError('DB_ERROR', `archive run ${runId} is already rolled back`)
  }
  if (run.status !== 'done') {
    throw new ServiceError('DB_ERROR', `archive run ${runId} has status "${run.status}"; only completed archives can be rolled back`)
  }

  const manifest = await readUndoManifest(runId)
  const undoEntries = manifest?.entries.length ?? 0

  // 两段式：不带 confirmed 先回影响面（内容还原条数 / 移回路径）
  if (confirmed !== true) {
    return {
      confirmRequired: true,
      impacts: {
        runId,
        projectName: run.project_name,
        oldPath: run.old_path,
        newPath: run.new_path,
        undoEntries,
        fixedFiles: run.fixed_files,
        note: '回滚将把改写过的文件内容还原（undo 备份覆写）、目录移回原位并还原 projects.win_path；只做 copyFile 覆写，幂等可重复执行',
      },
    }
  }

  const notes: string[] = []

  // 1) 内容回滚：逐条 copyFile(backup, target)（只覆写不改写路径，幂等，安全规则 4）
  let restored = 0
  if (manifest !== null) {
    restored = await restoreBackups(manifest)
    notes.push(`已还原 ${restored}/${manifest.entries.length} 个文件的历史内容`)
  } else {
    notes.push('该记录无内容改写备份（老导入数据或无引用命中）')
  }

  // 2) 目录移回原位：新位置仍存在且原位置空闲才执行（老 undoMove 语义并入回滚）
  let movedBack = false
  const destStillExists = await exists(run.new_path)
  const oldFree = !(await exists(run.old_path))
  if (destStillExists && oldFree) {
    const movable = await probeDirMovable(run.new_path).catch(() => false)
    if (movable) {
      try {
        await moveDirectory(run.new_path, run.old_path, { onProgress: () => {}, isCancelled: () => false }, { skipDepDirs: false })
        movedBack = true
        notes.push(`项目已移回 ${run.old_path}`)
      } catch (err) {
        notes.push(`目录移回失败（内容已还原）：${errorMessage(err)}`)
      }
    } else {
      notes.push('归档目录被占用未能移回（内容已还原）')
    }
  } else if (!destStillExists) {
    notes.push('归档目录已不存在（可能已被手动移走）')
  } else {
    notes.push(`原位置已被占用（${run.old_path}）：文件内容已还原，但项目未移回`)
  }

  // 3) projects 联动还原：当前 win_path 仍等于 new_path 时才回写（用户后续改动不覆盖）
  let projectsRestored = false
  if (run.project_id !== null) {
    const row = db.prepare('SELECT id, win_path, wsl_path FROM projects WHERE id = ?').get(run.project_id) as
      | { id: number; win_path: string | null; wsl_path: string | null }
      | undefined
    if (row !== undefined && row.win_path !== null && normalizePathKey(row.win_path) === normalizePathKey(run.new_path)) {
      db.prepare('UPDATE projects SET win_path = ?, wsl_path = ?, updated_at = ? WHERE id = ?').run(
        run.old_path,
        row.wsl_path !== null ? wslPathForWinPath(run.old_path) : null,
        nowSec(),
        run.project_id,
      )
      projectsRestored = true
    }
  }

  // 4) run 置 rolled-back + archives 行删除（该行语义 = 当前处于归档态的项目）
  db.prepare("UPDATE archive_runs SET status = 'rolled-back', finished_at = ? WHERE id = ?").run(nowSec(), runId)
  db.prepare('DELETE FROM archives WHERE run_id = ?').run(runId)

  // 5) undo 清理：仅在完整成功（全部还原 + 移回 + projects 还原且确有备份）时清理
  //    本次 undo 数据（部分失败保留目录供人工恢复——数据安全优先）
  let undoCleaned = false
  if (manifest !== null && restored === manifest.entries.length && movedBack && projectsRestored) {
    try {
      await fsp.rm(undoDirOf(runId), { recursive: true, force: true })
      await fsp.rm(undoManifestPath(runId), { force: true })
      undoCleaned = true
    } catch {
      /* 清理失败保留，不影响回滚结果 */
    }
  }
  if (undoCleaned) notes.push('undo 已清理')

  return {
    confirmRequired: undefined,
    runId,
    restored,
    undoEntries,
    movedBack,
    projectsRestored,
    status: 'rolled-back',
    note: notes.join('；'),
  }
}

// ---------------------------------------------------------------------------
// archiveHistory / archiveStatus
// ---------------------------------------------------------------------------

interface ArchiveRunSelectRow {
  id: number
  project_id: number | null
  project_name: string
  old_path: string
  new_path: string
  status: string
  fixed_files: number
  external_files: number
  residual_hits: number
  stripped_json: string | null
  started_at: number
  finished_at: number | null
}

export function archiveHistory(limit?: number): ArchiveHistoryResult {
  const db = getDatabase()
  const capped = Math.min(limit ?? ARCHIVE_HISTORY_LIMIT, ARCHIVE_HISTORY_LIMIT)
  const rows = db
    .prepare(
      'SELECT id, project_id, project_name, old_path, new_path, status, fixed_files, external_files, residual_hits, stripped_json, started_at, finished_at FROM archive_runs ORDER BY id DESC LIMIT ?',
    )
    .all(capped) as unknown as ArchiveRunSelectRow[]
  return {
    runs: rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      oldPath: r.old_path,
      newPath: r.new_path,
      status: parseRunStatus(r.status),
      fixedFiles: r.fixed_files,
      externalFiles: r.external_files,
      residualHits: r.residual_hits,
      strippedDirs: parseStrippedJson(r.stripped_json),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      undoEntries: readUndoEntryCount(r.id),
    })),
  }
}

function parseRunStatus(status: string): 'running' | 'done' | 'failed' | 'rolled-back' {
  return status === 'running' || status === 'done' || status === 'failed' || status === 'rolled-back' ? status : 'failed'
}

function parseStrippedJson(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : null
  } catch {
    return null
  }
}

/** undo 清单条数（无清单 → null；历史导入行/已清理行不硬造 0）。文件极小，同步读。 */
function readUndoEntryCount(runId: number): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(undoManifestPath(runId), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { entries?: unknown }).entries)) {
      return (parsed as { entries: unknown[] }).entries.length
    }
    return null
  } catch {
    return null
  }
}

/** 执行期进度查询（docs/10 §11 archive:status 轮询）。无对应执行 → NOT_FOUND。 */
export function archiveStatus(previewId: string): ArchiveStatusResult {
  pruneExpiredPreviews()
  const progress = runProgress.get(previewId)
  if (progress === undefined) {
    throw new ServiceError('NOT_FOUND', `no run known for preview ${previewId}`)
  }
  return {
    active: progress.phase !== 'done' && progress.phase !== 'failed',
    phase: progress.phase,
    ...(progress.percent !== undefined ? { percent: progress.percent } : {}),
    logTail: progress.log.slice(-30),
  }
}

// re-export 供 smoke 做测试隔离（内存注册表清空）
export function _testReset(): void {
  pendingPreviews.clear()
  runProgress.clear()
  activePreviewToken = null
}

/** smoke 专用：把全部 pending 预览置为已过期并触发裁剪（TTL 失效路径的可确定性验证）。 */
export function _testExpireAllPreviews(): void {
  for (const p of pendingPreviews.values()) {
    ;(p as { expiresAt: number }).expiresAt = 0
  }
  pruneExpiredPreviews()
}
