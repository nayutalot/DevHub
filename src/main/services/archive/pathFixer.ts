// 路径修复器：把文件中写死的旧根路径改写为新位置。
// S5 批次自 ArchiveKeeper `main/services/pathFixer.ts` 移植（docs/10 §6.1/§7）。
// 安全措施：UTF-8 往返校验（非 UTF-8 文件跳过不动）、先备份后原子写入、
// 撤销清单落盘支持一键回滚（安全规则 4：回滚必须可用，只做 copyFile 覆写）。
//
// undo 布局（docs/10 §7）：<DEVHUB_HOME>/undo/<runId>/（备份文件，0001-<basename>
// 序号命名）+ <DEVHUB_HOME>/undo/<runId>.json（清单）。runId 为 archive_runs.id
// （整数，执行开始即插行取号——status 'running' 语义的由来）。

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { getDataDir } from '../../core/paths.ts'
import { replacePathRefs } from './pathRefs.ts'
import { withoutAsar } from './mover.ts'

export interface FixOutcome {
  fixed: { file: string; count: number; backup: string }[]
  skippedNonUtf8: string[]
  missing: string[]
  totalReplacements: number
}

/** 扫描时记录的是旧位置；移动后的项目内部文件需映射到新位置 */
export function remapMovedPath(file: string, movedFrom: string, movedTo: string): string {
  const from = movedFrom.replace(/[\\/]+$/, '')
  if (file.toLowerCase().startsWith(from.toLowerCase())) {
    const rest = file.slice(from.length).replace(/^[\\/]+/, '')
    return path.join(movedTo, rest)
  }
  return file
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
}

export interface FixHooks {
  isCancelled?: () => boolean
  onFileFixed?: (file: string, count: number) => void
}

/**
 * 对一批文件执行旧路径 → 新路径的改写（保留 `\\` 转义与分隔符风格，见 pathRefs）。
 * @param files 参与改写的文件（当前实际位置，已去重）
 * @param oldRoot 被归档项目的旧根路径（匹配目标）
 * @param newRoot 新根路径（替换值）
 * @param backupDir 本轮备份目录（逐文件 copyFile 备份后才原子替换）
 */
export function applyFixes(
  files: string[],
  oldRoot: string,
  newRoot: string,
  backupDir: string,
  hooks: FixHooks = {},
): Promise<FixOutcome> {
  // 目标文件可能自带 .asar（Electron 产物等），读写期间关闭 asar 拦截
  return withoutAsar(() => applyFixesInner(files, oldRoot, newRoot, backupDir, hooks))
}

async function applyFixesInner(
  files: string[],
  oldRoot: string,
  newRoot: string,
  backupDir: string,
  hooks: FixHooks,
): Promise<FixOutcome> {
  const outcome: FixOutcome = {
    fixed: [],
    skippedNonUtf8: [],
    missing: [],
    totalReplacements: 0,
  }
  await fsp.mkdir(backupDir, { recursive: true })
  let idx = 0

  for (const file of files) {
    if (hooks.isCancelled?.() === true) break
    idx++
    if (!(await exists(file))) {
      outcome.missing.push(file)
      continue
    }
    const buf = await fsp.readFile(file)
    const text = buf.toString('utf8')
    // UTF-8 往返校验：非 UTF-8（如 GBK）文件改写会损坏非 ASCII 内容，跳过交人工处理
    if (!buf.equals(Buffer.from(text, 'utf8'))) {
      outcome.skippedNonUtf8.push(file)
      continue
    }
    const { text: next, count } = replacePathRefs(text, oldRoot, newRoot)
    if (count === 0) continue
    const backupPath = path.join(backupDir, `${String(idx).padStart(4, '0')}-${path.basename(file)}`)
    await fsp.copyFile(file, backupPath)
    const tmp = `${file}.pathfix-${randomUUID().slice(0, 8)}.tmp`
    await fsp.writeFile(tmp, next, 'utf8')
    await fsp.rename(tmp, file)
    outcome.fixed.push({ file, count, backup: backupPath })
    outcome.totalReplacements += count
    hooks.onFileFixed?.(file, count)
  }
  return outcome
}

// ---------------------------------------------------------------------------
// undo 清单与回滚（docs/10 §7）
// ---------------------------------------------------------------------------

export interface UndoManifest {
  runId: number
  entries: { target: string; backup: string }[]
}

/** undo 根目录：<DEVHUB_HOME>/undo（与 DB 同根，core/paths.ts）。 */
export function undoRootDir(): string {
  return path.join(getDataDir(), 'undo')
}

/** 单次执行的备份目录：<DEVHUB_HOME>/undo/<runId>/ */
export function undoDirOf(runId: number): string {
  return path.join(undoRootDir(), String(runId))
}

/** 撤销清单路径：<DEVHUB_HOME>/undo/<runId>.json */
export function undoManifestPath(runId: number): string {
  return path.join(undoRootDir(), `${runId}.json`)
}

export function saveUndoManifest(manifest: UndoManifest): void {
  const p = process as NodeJS.Process & { noAsar?: boolean }
  const prev = p.noAsar
  p.noAsar = true
  try {
    // undo 根目录防御性确保存在（正常流由 applyFixes 的 backupDir mkdir 顺带建立；
    // 单独调用/人工恢复场景不得因目录缺失而丢清单——数据安全优先，docs/10 §7）
    mkdirSync(undoRootDir(), { recursive: true })
    // 同步原子语义说明：清单极小，writeFileSync 的撕裂窗口可忽略；若因断电缺失，
    // 备份文件仍在 undo 目录内可人工恢复——数据安全优先（docs/10 §7）
    writeFileSync(undoManifestPath(manifest.runId), JSON.stringify(manifest, null, 2), 'utf8')
  } finally {
    p.noAsar = prev
  }
}

/** 读取撤销清单；缺失/损坏 → null（历史导入行无清单，回滚时按 0 条处理）。 */
export async function readUndoManifest(runId: number): Promise<UndoManifest | null> {
  try {
    const raw = await fsp.readFile(undoManifestPath(runId), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const rec = parsed as { runId?: unknown; entries?: unknown }
    if (!Array.isArray(rec.entries)) return null
    const entries: { target: string; backup: string }[] = []
    for (const e of rec.entries) {
      if (typeof e !== 'object' || e === null) continue
      const r = e as { target?: unknown; backup?: unknown }
      if (typeof r.target === 'string' && typeof r.backup === 'string') {
        entries.push({ target: r.target, backup: r.backup })
      }
    }
    return { runId: typeof rec.runId === 'number' ? rec.runId : runId, entries }
  } catch {
    return null
  }
}

/**
 * 回滚：把备份内容写回各文件（文件位于归档后的新位置）。
 * 只做 copyFile 覆写（不再改写路径），保证幂等可重复执行（安全规则 4）；
 * 单条失败继续，返回 restored 计数。
 */
export function restoreBackups(manifest: UndoManifest): Promise<number> {
  // 归档后的项目可能自带 .asar，回写期间关闭 asar 拦截
  return withoutAsar(async () => {
    let restored = 0
    for (const e of manifest.entries) {
      try {
        await fsp.copyFile(e.backup, e.target)
        restored++
      } catch {
        /* 单个失败继续其余 */
      }
    }
    return restored
  })
}
