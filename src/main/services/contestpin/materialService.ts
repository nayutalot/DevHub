/**
 * materialService.ts — ContestPin 材料导入（CP3b 批次，任务书 §2.1）。
 *
 * - electron-free 纯 Node 模块（db 经 getDatabase()，DEVHUB_HOME 驱动；文件落盘
 *   getDataDir()/contestpin/materials/<sha256>.<ext>）；SQL 全参数绑定（约束 #11）；
 *   结构化 ServiceError（约束 #14）。
 * - **sha256 文件级去重**：UNIQUE(sha256) 命中 → 返回既有行，不重复复制/建行
 *   （docs/22 §2.1/§5；并发双插以 UNIQUE 异常回读兜底，幂等）。
 * - **限制（可配常量 + params 覆盖，硬上限封顶）**：单文件 20MB / 单批 20 份 /
 *   PDF 50 页；超限 ServiceError('BAD_PAYLOAD') 带 reason（含路径/字段名）。
 *   覆盖入口 resolveMaterialLimits（页上限供 pdfService/pipeline 消费），硬上限
 *   = 默认值 ×5（100MB/100 份/250 页），params 越界按上限截断（绝不放开）。
 * - **kind 判定**：扩展名 + 魔数双证（%PDF- → pdf；PNG/JPEG/GIF/WebP/BMP →
 *   image；其余 other）。pages 对 PDF 延后填充（管线预处理阶段经 pdfService）。
 * - **粘贴截图**：main 侧读系统剪贴板（electron 胶水经 setClipboardImageReader
 *   注入——keyStoreWire 同款注入范式；纯 Node/smoke 语境未注入 → 结构化 no-op
 *   clipboardUnavailable:true，绝不抛裸异常）；renderer 不拿 Node fs。
 * - 凭据三零：本模块零凭据、零网络（pdfService 亦全本地）。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { getDatabase } from '../../db/index.ts'
import { getDataDir } from '../../core/paths.ts'
import { logger } from '../../core/logger.ts'
import { nowSec, ServiceError } from '../internal.ts'
import { sniffImageMime } from './pdfService.ts'
import type { ContestMaterialView } from '../../../shared/types.ts'

// ---------------------------------------------------------------------------
// 限制常量（任务书 §2.1 #2：可配常量 + params 覆盖，硬上限封顶）
// ---------------------------------------------------------------------------

export interface MaterialLimits {
  /** 单文件上限字节（默认 20MB）。 */
  maxFileBytes: number
  /** 单批份数上限（默认 20）。 */
  maxBatch: number
  /** PDF 页数上限（默认 50；pdfService 提取/管线视觉阶段消费）。 */
  maxPdfPages: number
}

export const DEFAULT_MATERIAL_LIMITS: Readonly<MaterialLimits> = {
  maxFileBytes: 20 * 1024 * 1024,
  maxBatch: 20,
  maxPdfPages: 50,
}

/** 硬上限 = 默认 ×5：params 覆盖越界按上限截断，绝不放开。 */
const LIMIT_CEILINGS: Readonly<MaterialLimits> = {
  maxFileBytes: 100 * 1024 * 1024,
  maxBatch: 100,
  maxPdfPages: 250,
}

/** params 覆盖 → 夹在 [1, 硬上限] 的生效限制（非正整数键忽略取默认）。 */
export function resolveMaterialLimits(overrides?: Partial<MaterialLimits>): MaterialLimits {
  const clamp = (raw: unknown, fallback: number, ceiling: number): number => {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) return fallback
    return Math.min(raw, ceiling)
  }
  return {
    maxFileBytes: clamp(overrides?.maxFileBytes, DEFAULT_MATERIAL_LIMITS.maxFileBytes, LIMIT_CEILINGS.maxFileBytes),
    maxBatch: clamp(overrides?.maxBatch, DEFAULT_MATERIAL_LIMITS.maxBatch, LIMIT_CEILINGS.maxBatch),
    maxPdfPages: clamp(overrides?.maxPdfPages, DEFAULT_MATERIAL_LIMITS.maxPdfPages, LIMIT_CEILINGS.maxPdfPages),
  }
}

// ---------------------------------------------------------------------------
// 行投影与存储路径
// ---------------------------------------------------------------------------

interface MaterialDbRow {
  id: number
  sha256: string
  original_name: string
  stored_path: string
  size_bytes: number | null
  pages: number | null
  kind: string
  imported_at: number
}

export type MaterialKind = 'pdf' | 'image' | 'other'

function toMaterialView(row: MaterialDbRow): ContestMaterialView {
  return {
    id: Number(row.id),
    sha256: row.sha256,
    originalName: row.original_name,
    storedPath: row.stored_path,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    pages: row.pages === null ? null : Number(row.pages),
    kind: row.kind as MaterialKind,
    importedAt: Number(row.imported_at),
  }
}

/** 材料存储目录：<dataDir>/contestpin/materials。 */
export function materialsDir(): string {
  return join(getDataDir(), 'contestpin', 'materials')
}

function getMaterialRow(id: number): MaterialDbRow {
  const row = getDatabase().prepare('SELECT * FROM contest_materials WHERE id = ?').get(id) as unknown as MaterialDbRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `contest material ${id} not found`)
  }
  return row
}

/** 材料存在性（importCreate 前置校验，一次性拉全 ids）。 */
export function materialsExist(ids: readonly number[]): boolean {
  const db = getDatabase()
  for (const id of ids) {
    if (db.prepare('SELECT 1 FROM contest_materials WHERE id = ?').get(id) === undefined) return false
  }
  return true
}

/** 管线读材料存储文件（stored_path 恒在 materialsDir() 下，防越界校验）。 */
export async function readMaterialStoredFile(id: number): Promise<{ view: ContestMaterialView; data: Buffer }> {
  const row = getMaterialRow(id)
  const view = toMaterialView(row)
  const expectedDir = materialsDir()
  if (!view.storedPath.startsWith(expectedDir)) {
    throw new ServiceError('DB_ERROR', `材料 ${id} 存储路径越界（拒绝读取）`)
  }
  const data = await readFile(view.storedPath)
  return { view, data }
}

// ---------------------------------------------------------------------------
// kind 判定与存储名
// ---------------------------------------------------------------------------

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

function extOf(name: string): string {
  const ext = extname(name).toLowerCase()
  return /^[.][a-z0-9]{1,5}$/.test(ext) ? ext : ''
}

/** kind：扩展名 + 魔数双证（魔数优先级高——扩展名可谎报）。 */
function detectKind(name: string, data: Buffer): { kind: MaterialKind; ext: string } {
  const ext = extOf(name)
  const isPdfMagic = data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-'
  const imageMime = sniffImageMime(data)
  if (isPdfMagic || ext === '.pdf') return { kind: 'pdf', ext: '.pdf' }
  if (imageMime !== null) {
    const mimeExt = imageMime === 'image/jpeg' ? '.jpg' : imageMime.replace('image/', '')
    return { kind: 'image', ext: ext === '.jpeg' ? '.jpg' : (IMAGE_EXTS.has(ext) ? ext : `.${mimeExt}`) }
  }
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', ext: ext === '.jpeg' ? '.jpg' : ext }
  return { kind: 'other', ext: ext !== '' ? ext : '.bin' }
}

// ---------------------------------------------------------------------------
// 导入核心（sha256 去重 → 复制落盘 → 落库）
// ---------------------------------------------------------------------------

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function findExistingBySha(sha: string): MaterialDbRow | undefined {
  return getDatabase().prepare('SELECT * FROM contest_materials WHERE sha256 = ?').get(sha) as unknown as MaterialDbRow | undefined
}

/**
 * buffer 导入核心：sha256 → UNIQUE 命中返回既有行；否则复制落盘（原子名 =
 * sha.<ext>）→ 行落库。kind 由 detectKind 判定（forceImage=true 时非 image
 * → BAD_PAYLOAD，粘贴截图语义）。
 */
async function importBuffer(originalName: string, data: Buffer, opts: { forceImage?: boolean } = {}): Promise<ContestMaterialView> {
  const safeName = originalName.trim().length > 0 ? originalName.trim() : 'material'
  const { kind, ext } = detectKind(safeName, data)
  if (opts.forceImage === true && kind !== 'image') {
    throw new ServiceError('BAD_PAYLOAD', `粘贴内容不是图片（kind=${kind}），仅接受 PNG/JPEG 等位图截图`)
  }
  const sha = sha256Hex(data)
  const existing = findExistingBySha(sha)
  if (existing !== undefined) {
    // 文件级去重：UNIQUE(sha256) 命中 → 原样返回既有行（不重复复制/建行）
    return toMaterialView(existing)
  }
  const dir = materialsDir()
  await mkdir(dir, { recursive: true })
  const storedPath = join(dir, `${sha}${ext}`)
  await writeFile(storedPath, data, { flag: 'wx' }).catch(async (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err
    // 同 sha 文件已落盘（先前写入中断/并发）→ 内容一致，继续
  })
  const now = nowSec()
  try {
    const result = getDatabase()
      .prepare(
        'INSERT INTO contest_materials (sha256, original_name, stored_path, size_bytes, pages, kind, imported_at) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      )
      .run(sha, safeName, storedPath, data.length, kind, now)
    logger.info(`contestpin material imported: id=${Number(result.lastInsertRowid)} kind=${kind} bytes=${data.length}`)
  } catch (err) {
    // 并发双插 UNIQUE 兜底：回读既有行（幂等语义与预检一致）
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      const raced = findExistingBySha(sha)
      if (raced !== undefined) return toMaterialView(raced)
    }
    throw err
  }
  return toMaterialView(findExistingBySha(sha) as MaterialDbRow)
}

// ---------------------------------------------------------------------------
// contestpin:materialsList / contestpin:importMaterials / 粘贴截图
// ---------------------------------------------------------------------------

export function listMaterials(): { materials: ContestMaterialView[] } {
  const rows = getDatabase()
    .prepare('SELECT * FROM contest_materials ORDER BY imported_at DESC, id DESC LIMIT 200')
    .all() as unknown as MaterialDbRow[]
  return { materials: rows.map(toMaterialView) }
}

/**
 * 路径批量导入（renderer 文件对话框/拖入经 webUtils 落路径）。整批校验：
 * 批量数 ≤ maxBatch、每路径存在+常规文件+大小 ≤ maxFileBytes，违反 →
 * ServiceError('BAD_PAYLOAD') 带 reason（all-or-nothing，不产生半批）。
 */
export async function importMaterials(paths: readonly string[], limits: MaterialLimits = { ...DEFAULT_MATERIAL_LIMITS }): Promise<ContestMaterialView[]> {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ServiceError('BAD_PAYLOAD', 'importMaterials: paths must be a non-empty array')
  }
  if (paths.length > limits.maxBatch) {
    throw new ServiceError('BAD_PAYLOAD', `单批材料份数超限：${paths.length} > ${limits.maxBatch}（可在导入参数中调高，硬上限 ${LIMIT_CEILINGS.maxBatch}）`)
  }
  const stats = await Promise.all(
    paths.map(async (p) => {
      const info = await stat(p).catch(() => null)
      if (info === null || !info.isFile()) {
        throw new ServiceError('BAD_PAYLOAD', `材料文件不存在或非常规文件：${p}`)
      }
      if (info.size > limits.maxFileBytes) {
        throw new ServiceError('BAD_PAYLOAD', `材料文件超限：${p}（${info.size} 字节 > ${limits.maxFileBytes}）`)
      }
      return info
    }),
  )
  void stats
  const views: ContestMaterialView[] = []
  for (let i = 0; i < paths.length; i++) {
    const data = await readFile(paths[i])
    views.push(await importBuffer(paths[i].replace(/\\/g, '/').split('/').pop() ?? paths[i], data))
  }
  return views
}

/**
 * 粘贴截图导入（renderer 传 buffer 场景的 service 入口；main 剪贴板路径见
 * importFromClipboard）。kind 强制 image，超限/非图 → BAD_PAYLOAD。
 */
export async function importImageFromBuffer(name: string, data: Buffer, limits: MaterialLimits = { ...DEFAULT_MATERIAL_LIMITS }): Promise<ContestMaterialView> {
  if (data.length > limits.maxFileBytes) {
    throw new ServiceError('BAD_PAYLOAD', `截图超限：${data.length} 字节 > ${limits.maxFileBytes}`)
  }
  return importBuffer(name, data, { forceImage: true })
}

// ---------------------------------------------------------------------------
// 系统剪贴板注入（electron 胶水经 contestpinWire 注入；纯 Node 语境无实现）
// ---------------------------------------------------------------------------

/** 剪贴板图片读取器：有图返回 PNG/位图 buffer；无图/失败返回 null（async——Electron 44 clipboard 为 W3C 异步形态）。 */
export type ClipboardImageReader = () => Promise<Buffer | null>

let clipboardImageReader: ClipboardImageReader | null = null

/** 生产注入（contestpinWire 启动时调用）；传 null 恢复未注入态。 */
export function setClipboardImageReader(reader: ClipboardImageReader | null): void {
  clipboardImageReader = reader
}

/**
 * 粘贴截图（main 读系统剪贴板）：reader 未注入（纯 Node/smoke）或剪贴板无图 →
 * 结构化 no-op（clipboardUnavailable: true），绝不抛裸异常。落库走
 * importImageFromBuffer 同一入口（超限/非图 BAD_PAYLOAD 语义一致）。
 */
export async function importFromClipboard(limits: MaterialLimits = { ...DEFAULT_MATERIAL_LIMITS }): Promise<{ materials: ContestMaterialView[]; clipboardUnavailable?: boolean }> {
  const reader = clipboardImageReader
  const png = reader !== null ? await reader() : null
  if (png === null || png.length === 0) {
    return { materials: [], clipboardUnavailable: true }
  }
  const view = await importImageFromBuffer(`clipboard-${nowSec()}.png`, png, limits)
  return { materials: [view] }
}
