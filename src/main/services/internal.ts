/**
 * internal.ts — Service 层共享小工具（Step 5；M2 增补路径归一键）。
 *
 * 只被 src/main/services/* 与 src/main/mcp/* 引用：unix 秒时间戳、结构化领域错误、
 * 扫描行（scans 表）写入助手、slug 生成、路径归一键。无 electron 依赖，
 * 保持可被 smoke 在系统 Node 下直接加载（约束 #20：只有 Service 层写库）。
 */

import type { DatabaseSync } from 'node:sqlite'
import type { ScanKind, ScanStatusType } from '../../shared/types.ts'

/** unix 秒时间戳（docs/03 §1：全部时间字段为 INTEGER 秒）。 */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * 结构化领域错误（docs/02 §3，约束 #14）：code 取稳定枚举值，
 * IPC 网关负责折叠为 { ok:false, error:{ code, message } } envelope。
 */
export class ServiceError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** undefined → null（node:sqlite 拒绝绑定 undefined，约束 #11 配套）。 */
export function dbVal<T>(value: T | undefined | null): T | null {
  return value === undefined ? null : value
}

/** 任意异常 → 可读消息（error_summary / 日志用，约束 #25）。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 路径归一键（docs/08 §10.3）：大小写不敏感（Windows）+ 反斜杠归一为正斜杠 +
 * 去尾部分隔符。M2 起为本模块共享实现，供 servicesService 归因与
 * gitService 白名单比对、mcp/projection 输出规整三处复用，禁止各自再造。
 */
export function normalizePathKey(value: string): string {
  return value.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// scans 行写入助手（docs/03 3.13：running → done/cancelled/failed 完整生命周期）
// ---------------------------------------------------------------------------

interface ScanRow {
  id: number
  kind: string
  root_path: string | null
  started_at: number
  finished_at: number | null
  status: string
  found_count: number
  error_summary: string | null
}

/** 新开一条 running 扫描行，返回 scanId。 */
export function insertScanRow(db: DatabaseSync, kind: ScanKind, rootPath: string | null): number {
  const result = db
    .prepare('INSERT INTO scans (kind, root_path, started_at, status, found_count) VALUES (?, ?, ?, ?, 0)')
    .run(kind, dbVal(rootPath), nowSec(), 'running')
  return Number(result.lastInsertRowid)
}

/** 终结扫描行：status + found_count + error_summary（分号连接，截断 2000）。 */
export function finishScanRow(
  db: DatabaseSync,
  scanId: number,
  status: ScanStatusType,
  foundCount: number,
  errors: readonly string[],
): void {
  const summary = errors.length > 0 ? errors.join('; ').slice(0, 2000) : null
  db.prepare('UPDATE scans SET status = ?, finished_at = ?, found_count = ?, error_summary = ? WHERE id = ?').run(
    status,
    nowSec(),
    foundCount,
    summary,
    scanId,
  )
}

/** 读取扫描行；不存在 → NOT_FOUND。 */
export function readScanRow(db: DatabaseSync, scanId: number): ScanRow {
  const row = db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId) as ScanRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `scan ${scanId} not found`)
  }
  return row
}

// ---------------------------------------------------------------------------
// slug（projects.slug 有 UNIQUE 索引，docs/03 3.1）
// ---------------------------------------------------------------------------

/** 目录名/项目名 → URL/文件系统友好的小写 slug；无字母数字时回退到小写原名。 */
export function slugify(name: string): string {
  const parts = name.toLowerCase().match(/[a-z0-9]+/g)
  const base = parts !== null && parts.length > 0 ? parts.join('-') : name.toLowerCase().trim()
  const trimmed = base.slice(0, 64)
  return trimmed.length > 0 ? trimmed : 'project'
}

/** 生成不与现有行冲突的 slug；冲突时追加 -2 / -3 …（excludeId 用于更新场景）。 */
export function uniqueSlug(db: DatabaseSync, base: string, excludeId?: number): string {
  let candidate = base
  let counter = 2
  while (true) {
    const row =
      excludeId === undefined
        ? (db.prepare('SELECT id FROM projects WHERE slug = ?').get(candidate) as { id: number } | undefined)
        : (db.prepare('SELECT id FROM projects WHERE slug = ? AND id != ?').get(candidate, excludeId) as
            | { id: number }
            | undefined)
    if (row === undefined) return candidate
    candidate = `${base}-${counter}`
    counter += 1
  }
}
