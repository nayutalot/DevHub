// 移动引擎：优先同卷 rename（瞬时），跨卷退化为 复制 → 校验 → 删除源。
// S5 批次自 ArchiveKeeper `main/services/archiver.ts` 移植（docs/10 §5）：
// - 去掉 withoutAsar 依赖（Electron asar 拦截场景改用 process.noAsar 开关，见下）；
// - rename / copyFile 均为可注入 seam（smoke 用注入模拟 EXDEV 与中途复制失败）；
// - 归档副本默认剥离可再生的依赖/缓存目录（node_modules、venv 等，见 depDirs）；
// - 源目录删除做到最大容忍（junction/只读/短暂占用），删不动的残留不判定为失败。
//
// 铁律（docs/10 安全规则 3）：绝不删数据，只移动 + 备份；跨卷复制失败保源
// 清半成品；任何删除失败都降级为残留报告而非报错回滚。

import { createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  CACHE_DIR_NAMES,
  JS_DEP_DIR,
  JS_LOCKFILES,
  PY_MANIFESTS,
  VENV_DIR_NAMES,
} from './depDirs.ts'

export class CancelledError extends Error {
  constructor() {
    super('操作已取消')
    this.name = 'CancelledError'
  }
}

export interface MoveHooks {
  /** 节流 150ms 的复制进度回调（同卷 rename 汇报 1/1）。 */
  onProgress: (doneBytes: number, totalBytes: number) => void
  isCancelled: () => boolean
}

export interface MoveOptions {
  /** 剥离可再生依赖/缓存目录（node_modules、venv、__pycache__ 等） */
  skipDepDirs?: boolean
}

export interface MoveSeams {
  /** 注入 rename 实现（smoke 用抛 EXDEV 模拟跨卷，docs/10 §12）。缺省 fsp.rename。 */
  renameFn?: (a: string, b: string) => Promise<void>
  /** 注入逐文件复制实现（smoke 用中途失败验证「失败保源清半成品」）。缺省 fsp.copyFile。 */
  copyFileFn?: (src: string, dst: string) => Promise<void>
}

export interface MoveResult {
  mode: MoveMode
  /** 本次剥离的目录名（如 node_modules、.venv；剥离清单入 archive_runs.stripped_json） */
  skippedDeps: string[]
  /** 删除失败的残留项（不判定为失败；多为短暂占用/失效链接） */
  sourceLeftovers: string[]
  /** 复制时被跳过的链接数（junction/符号链接不跨卷复制） */
  skippedLinks: number
}

export type MoveMode = 'renamed' | 'copied'

/** 目标重名时生成不冲突路径：<name>-archived-YYYYMMDD(-N)（老 uniqueDestPath 语义原样） */
export async function uniqueDestPath(destRoot: string, name: string): Promise<string> {
  const join = (n: string): string => path.join(destRoot, n)
  if (!(await exists(join(name)))) return join(name)
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const dated = `${name}-archived-${day}`
  if (!(await exists(join(dated)))) return join(dated)
  for (let i = 2; ; i++) {
    const p = join(`${dated}-${i}`)
    if (!(await exists(p))) return p
  }
}

/**
 * 探测项目内可剥离的依赖/缓存目录名。
 * node_modules 需根目录存在 lockfile（保证可原样重装）才剥离；
 * venv 含绝对路径移动后必坏，有 Python 清单即剥离；缓存目录一律剥离。
 */
export async function detectDepSkipDirs(root: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fsp.readdir(root)
  } catch {
    return []
  }
  const names = new Set(entries)
  const skip = new Set<string>()
  if (JS_LOCKFILES.some((f) => names.has(f))) skip.add(JS_DEP_DIR)
  if (PY_MANIFESTS.some((f) => names.has(f))) VENV_DIR_NAMES.forEach((v) => skip.add(v))
  for (const c of CACHE_DIR_NAMES) {
    if (names.has(c)) skip.add(c)
  }
  return [...skip]
}

/**
 * 健壮删除：先交给 fs.rm（带重试），失败后逐项清扫——
 * junction/符号链接用 rmdir（RemoveDirectory 只删链接本身，不追目标），
 * 只读文件先清属性再删，短暂占用（EBUSY/EPERM）多轮退避重试。
 * 返回最终仍删不掉的路径列表（调用方决定是否算失败）。
 */
export async function rmTreeRobust(target: string): Promise<string[]> {
  try {
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    return []
  } catch {
    /* 落入逐项清扫 */
  }

  const left = new Set<string>()
  for (let round = 0; round < 3; round++) {
    left.clear()
    const dirs: string[] = []
    const stack: string[] = [target]
    while (stack.length > 0) {
      const cur = stack[stack.length - 1] as string
      let st
      try {
        st = await fsp.lstat(cur)
      } catch {
        stack.pop()
        continue
      }
      if (st.isSymbolicLink()) {
        stack.pop()
        try {
          await fsp.rmdir(cur)
        } catch {
          try {
            await fsp.unlink(cur)
          } catch (e) {
            left.add(`${cur}\0${(e as NodeJS.ErrnoException).code}`)
          }
        }
      } else if (st.isDirectory()) {
        let children: string[]
        try {
          children = await fsp.readdir(cur)
        } catch (e) {
          stack.pop()
          left.add(`${cur}\0${(e as NodeJS.ErrnoException).code}`)
          continue
        }
        if (children.length === 0) {
          stack.pop()
          dirs.push(cur)
        } else {
          for (const name of children) stack.push(path.join(cur, name))
        }
      } else {
        stack.pop()
        try {
          await fsp.unlink(cur)
        } catch {
          try {
            await fsp.chmod(cur, 0o666)
            await fsp.unlink(cur)
          } catch (e) {
            left.add(`${cur}\0${(e as NodeJS.ErrnoException).code}`)
          }
        }
      }
    }
    // 自底向上删空目录
    for (const d of dirs.reverse()) {
      try {
        await fsp.rmdir(d)
      } catch (e) {
        left.add(`${d}\0${(e as NodeJS.ErrnoException).code}`)
      }
    }
    if (left.size === 0) return []
    await new Promise((r) => setTimeout(r, 500 * (round + 1)))
  }
  return [...left].map((s) => s.split('\0')[0] as string)
}

interface CopyPlan {
  dirs: string[]
  files: { src: string; dst: string; rel: string; size: number }[]
  totalBytes: number
  skippedLinks: number
}

/** 复制前规划；skipNames 用于按目录名剪枝（可再生依赖/缓存） */
async function planCopy(src: string, dest: string, skipNames: ReadonlySet<string> | null): Promise<CopyPlan> {
  const dirs: string[] = []
  const files: CopyPlan['files'] = []
  let totalBytes = 0
  let skippedLinks = 0
  const stack: string[] = [src]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    dirs.push(path.join(dest, path.relative(src, dir)))
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (skipNames?.has(e.name) === true) continue
      const s = path.join(dir, e.name)
      const d = path.join(dest, path.relative(src, s))
      if (e.isDirectory()) {
        stack.push(s)
      } else if (e.isFile()) {
        const st = await fsp.stat(s)
        files.push({ src: s, dst: d, rel: path.relative(src, s), size: st.size })
        totalBytes += st.size
      } else if (e.isSymbolicLink()) {
        skippedLinks++
      }
    }
  }
  dirs.shift() // dest 根目录由调用方创建
  return { dirs, files, totalBytes, skippedLinks }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
}

async function dirHasEntries(p: string): Promise<boolean> {
  try {
    return (await fsp.readdir(p)).length > 0
  } catch {
    return false
  }
}

/** 抽样校验：读文件头部做 sha256（>64MB 大文件，最多 20 个） */
async function headHash(file: string, bytes = 512 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const stream = createReadStream(file, { start: 0, end: bytes - 1 })
    stream.on('data', (chunk) => h.update(chunk))
    stream.on('end', () => resolve(h.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * 项目内容可能自带 .asar（Electron 产物等），整个搬移/改写过程关闭 asar 拦截
 * （老 fsScope.withoutAsar 的等价实现；纯 Node / smoke 下 process.noAsar 无副作用）。
 */
export async function withoutAsar<T>(fn: () => Promise<T>): Promise<T> {
  const p = process as NodeJS.Process & { noAsar?: boolean }
  const prev = p.noAsar
  p.noAsar = true
  try {
    return await fn()
  } finally {
    p.noAsar = prev
  }
}

export function moveDirectory(
  src: string,
  dest: string,
  hooks: MoveHooks,
  opts: MoveOptions = {},
  seams: MoveSeams = {},
): Promise<MoveResult> {
  return withoutAsar(() =>
    moveDirectoryInner(src, dest, hooks, opts, seams.renameFn ?? fsp.rename.bind(fsp), seams.copyFileFn ?? fsp.copyFile.bind(fsp)),
  )
}

// rename/copyFile 均可注入（smoke 模拟跨卷 EXDEV 与中途复制失败，docs/10 §12）
export async function moveDirectoryInner(
  src: string,
  dest: string,
  hooks: MoveHooks,
  opts: MoveOptions,
  renameFn: (a: string, b: string) => Promise<void>,
  copyFileFn: (src: string, dst: string) => Promise<void>,
): Promise<MoveResult> {
  if (hooks.isCancelled()) throw new CancelledError()

  // 依赖剥离在移动前探测（rename 之后源路径即不存在）；剥离清单随 MoveResult
  // 返回，由编排层写入 archive_runs.stripped_json
  let depDirs: string[] = []
  if (opts.skipDepDirs === true) depDirs = await detectDepSkipDirs(src)

  const result: MoveResult = {
    mode: 'renamed',
    skippedDeps: depDirs,
    sourceLeftovers: [],
    skippedLinks: 0,
  }

  // 归档目标不该预存内容：存在非空目录说明此前有失败/外力残留，不能盲目清掉
  if (await exists(dest)) {
    if (await dirHasEntries(dest)) {
      throw new Error(`归档目标已存在且非空：${dest}。请先确认该目录内容并手动处理后重试`)
    }
    await fsp.rmdir(dest).catch(() => {})
  }

  // 1) 同卷：rename 一步到位
  try {
    await renameFn(src, dest)
    hooks.onProgress(1, 1)
    result.mode = 'renamed'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      // 跨卷，走复制流程
      result.mode = 'copied'
    } else {
      throw new Error(
        `移动失败（${code ?? String(e)}）：项目目录可能正被编辑器、终端或其他程序占用，请关闭后重试`,
      )
    }
  }

  if (result.mode === 'copied') {
    // 2) 跨卷：复制（剪枝依赖目录） → 校验 → 删除源
    await fsp.mkdir(dest, { recursive: true })
    const skipSet = depDirs.length > 0 ? new Set<string>(depDirs) : null
    const plan = await planCopy(src, dest, skipSet)
    result.skippedLinks = plan.skippedLinks
    for (const d of plan.dirs) await fsp.mkdir(d, { recursive: true })

    let doneBytes = 0
    let cursor = 0
    let lastTick = 0
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        if (hooks.isCancelled()) throw new CancelledError()
        const i = cursor++
        if (i >= plan.files.length) return
        const f = plan.files[i] as { src: string; dst: string; rel: string; size: number }
        await copyFileFn(f.src, f.dst)
        const st = await fsp.stat(f.dst)
        if (st.size !== f.size) throw new Error(`复制校验失败（大小不一致）：${f.rel}`)
        doneBytes += f.size
        const now = Date.now()
        if (now - lastTick > 150) {
          lastTick = now
          hooks.onProgress(doneBytes, plan.totalBytes)
        }
      }
    })

    try {
      await Promise.all(workers)
    } catch (e) {
      // 失败保源：删除目标半成品，源目录原样保留（docs/10 安全规则 3）
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
      throw e
    }

    // 大文件抽样比对头部哈希（>64MB，最多 20 个）
    const bigFiles = plan.files.filter((f) => f.size > 64 * 1024 * 1024).slice(0, 20)
    for (const f of bigFiles) {
      if (hooks.isCancelled()) {
        await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
        throw new CancelledError()
      }
      if ((await headHash(f.src)) !== (await headHash(f.dst))) {
        await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
        throw new Error(`抽样哈希校验失败：${f.rel}`)
      }
    }

    hooks.onProgress(plan.totalBytes, plan.totalBytes)
    if (hooks.isCancelled()) {
      await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
      throw new CancelledError()
    }

    // 3) 校验通过，删除源目录；删不动的残留不再判定为整体失败
    result.sourceLeftovers = await rmTreeRobust(src)
  }

  // 同卷 rename：从归档副本中剥离依赖目录（跨卷已在复制时剪枝）
  if (result.mode === 'renamed' && depDirs.length > 0) {
    for (const name of depDirs) {
      const left = await rmTreeRobust(path.join(dest, name))
      if (left.length > 0) result.sourceLeftovers.push(...left)
    }
  }

  return result
}

/** 递归统计目录字节数（archive_rows.size_bytes 用；失败 → null，绝不硬造）。 */
export async function dirSizeBytes(root: string, maxEntries = 500_000): Promise<number | null> {
  let total = 0
  let visited = 0
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      visited++
      if (visited > maxEntries) return null // 超大树放弃统计（宁缺毋假）
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(full)).size
        } catch {
          /* 瞬时消失不累计 */
        }
      }
    }
  }
  return total
}
