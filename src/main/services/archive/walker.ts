// 进程内 async walker（docs/10 §4）——替代老 ArchiveKeeper 的 utilityProcess
// 子进程（DevHub 铁律禁新增进程形态）。S5 批次自 `main/worker/scan.worker.ts`
// + `main/services/scanner.ts` 语义移植：显式栈 DFS、IGNORE_DIRS 整棵剪枝、
// venv/.venv 例外定点扫描、取消 token 逐文件检查、每 64 文件让步事件循环、
// 8 并发读取池、单文件命中上限 50（totalHits 保留真实值）、单文件失败计入
// error_summary 降级继续。electron-free，可被 smoke 在系统 Node 下直载。

import { readFile, readdir, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { findPathRefs, lineColOf, snippetAround } from './pathRefs.ts'
import { IGNORE_DIRS, hasBinaryExtension, isVenvActivationFile, looksBinary } from './scanRules.ts'

/** 共享取消 token：preview 阶段每个文件循环检查（docs/10 §4）。 */
export interface CancelToken {
  cancelled: boolean
}

export function createCancelToken(): CancelToken {
  return { cancelled: false }
}

export class WalkerCancelledError extends Error {
  constructor() {
    super('扫描已取消')
    this.name = 'WalkerCancelledError'
  }
}

/** 单处路径引用命中（扫描时记录旧位置路径；改写前经 remapMovedPath 映射）。 */
export interface PathHit {
  file: string
  line: number
  col: number
  snippet: string
  matched: string
}

export interface RefScanResult {
  hits: PathHit[]
  /** 命中总数（hits 超过单文件上限截断时仍为真实值） */
  totalHits: number
  scannedFiles: number
  skippedBinary: number
  skippedOversize: number
  /** 单文件失败摘要（上限 50 条；docs/10 §1「计入 error_summary 降级继续」） */
  errorSummary: string[]
}

export interface FindRefsOptions {
  token?: CancelToken
  onProgress?: (scanned: number, totalHits: number) => void
  /** 超过该字节数的文件跳过（计数 skippedOversize），缺省 2MB */
  maxFileBytes?: number
}

/** 让步间隔：每处理 64 个文件 await setTimeout(0) 让出事件循环（docs/10 §4） */
const YIELD_EVERY = 64
/** 单文件命中上限：日志类文件每行都含路径，截断条目不影响按文件整体改写 */
const PER_FILE_HIT_CAP = 50
/** 命中读取阶段并发池大小（游标递增模式，docs/10 §4） */
const READ_CONCURRENCY = 8
const ERROR_SUMMARY_CAP = 50

function sleep0(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 深度优先遍历目录，收集全部文件路径；忽略目录整棵剪枝
 * （venv/.venv 只定点取 pyvenv.cfg 与 Scripts|bin 下的 activate*）。
 */
async function collectFiles(root: string, out: string[], token?: CancelToken): Promise<void> {
  const stack: string[] = [root]
  while (stack.length > 0) {
    if (token?.cancelled === true) throw new WalkerCancelledError()
    const dir = stack.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // 无权限/已消失的目录直接跳过
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase()
        if (IGNORE_DIRS.has(lower)) {
          if (lower === 'venv' || lower === '.venv') await collectVenvFiles(full, out)
          continue
        }
        stack.push(full)
      } else if (e.isFile()) {
        out.push(full)
      }
    }
    await sleep0() // 目录层让步：大树上层目录间不阻塞主进程 UI
  }
}

/** venv 目录内的定点扫描：pyvenv.cfg 与 Scripts|bin 下的 activate* 写死了绝对路径 */
async function collectVenvFiles(venvDir: string, out: string[]): Promise<void> {
  const pushIfFile = async (p: string): Promise<void> => {
    try {
      if ((await stat(p)).isFile()) out.push(p)
    } catch {
      /* 不存在则忽略 */
    }
  }
  await pushIfFile(path.join(venvDir, 'pyvenv.cfg'))
  for (const sub of ['Scripts', 'bin']) {
    let entries
    try {
      entries = await readdir(path.join(venvDir, sub), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() && isVenvActivationFile(`${sub}/${e.name}`)) {
        out.push(path.join(venvDir, sub, e.name))
      }
    }
  }
}

/**
 * 在多个目标根目录中查找旧根路径的全部引用（强制 dry-run，只读，永不改文件）。
 * targets[0] 约定为被归档项目自身（老路径），其余为其他已登记项目（引用方）。
 */
export async function findRefs(
  targets: { label: string; root: string }[],
  needleRoot: string,
  opts: FindRefsOptions = {},
): Promise<RefScanResult> {
  const files: string[] = []
  for (const t of targets) await collectFiles(t.root, files, opts.token)

  const hits: PathHit[] = []
  let totalHits = 0
  let scanned = 0
  let skippedBinary = 0
  let skippedOversize = 0
  const errorSummary: string[] = []
  const maxBytes = opts.maxFileBytes ?? 2 * 1024 * 1024
  let processed = 0
  let lastProgressAt = 0

  let cursor = 0
  const n = Math.max(1, Math.min(READ_CONCURRENCY, files.length))
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      if (opts.token?.cancelled === true) return
      const i = cursor++
      if (i >= files.length) return
      const file = files[i] as string
      try {
        await scanOneFile(file)
      } catch (err) {
        // 单文件失败计入 error_summary 降级继续（docs/10 §1）
        if (errorSummary.length < ERROR_SUMMARY_CAP) {
          errorSummary.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      processed++
      if (processed % YIELD_EVERY === 0) await sleep0()
    }
  })

  async function scanOneFile(file: string): Promise<void> {
    if (hasBinaryExtension(path.basename(file))) return
    const st = await stat(file)
    if (st.size > maxBytes) {
      skippedOversize++
      return
    }
    const buf = await readFile(file)
    if (looksBinary(buf)) {
      skippedBinary++
      return
    }
    let text = buf.toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 去 BOM 保证行列定位准确
    const matches = findPathRefs(text, needleRoot)
    totalHits += matches.length
    for (const m of matches.slice(0, PER_FILE_HIT_CAP)) {
      const { line, col } = lineColOf(text, m.index)
      hits.push({
        file,
        line,
        col,
        snippet: snippetAround(text, m.index),
        matched: m.matched,
      })
    }
    scanned++
    const now = Date.now()
    if (opts.onProgress !== undefined && now - lastProgressAt > 300) {
      lastProgressAt = now
      opts.onProgress(scanned, totalHits)
    }
  }

  await Promise.all(workers)
  if (opts.token?.cancelled === true) throw new WalkerCancelledError()

  return { hits, totalHits, scannedFiles: scanned, skippedBinary, skippedOversize, errorSummary }
}

/** 供归档流程把 hit 按文件分组去重（scanner.uniqueHitFiles 语义移植）。 */
export function uniqueHitFiles(hits: PathHit[]): string[] {
  return [...new Set(hits.map((h) => h.file))]
}
