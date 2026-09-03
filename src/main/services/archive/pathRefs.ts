// 绝对路径引用的匹配与改写（纯函数，无 Electron / Node 依赖，smoke 直载单测）。
// S5 批次自 ArchiveKeeper `shared/pathRefs.ts` 全量移植（docs/10 §3，逐函数原样）。
//
// 目标：在文本中找到「旧项目根路径」的全部书写变体（正反斜杠、大小写、
// URL 编码），并能改写为新路径且保留各处原有的分隔符风格。

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 去掉首尾空白与尾部分隔符，得到规范的可匹配根路径 */
export function normalizeRoot(root: string): string {
  return root.trim().replace(/[\\/]+$/, '')
}

/**
 * 构造旧根路径的匹配正则：
 * - `\` 与 `/` 视为等价（「C:\A\B」也能匹配写作「C:/A/B」的引用）
 * - 大小写不敏感（Windows 盘符与目录名大小写常不一致）
 * - 后向断言要求匹配后紧跟分隔符/引号/空白/标点/结尾，避免
 *   「C:\Proj\Foo」误伤「C:\Proj\FooBar」
 */
export function buildPathRegex(root: string): RegExp {
  const norm = normalizeRoot(root)
  if (!norm) throw new Error('空路径无法构建匹配正则')
  const flexible = escapeRegExp(norm).replace(/[\\/]+/g, '[\\\\/]+')
  return new RegExp(flexible + '(?=$|[^A-Za-z0-9_])', 'gi')
}

/** URL 编码形态：`\`→%5C、`/`→%2F、空格→%20（配置文件里偶见的写法） */
export function buildEncodedPathRegex(root: string): RegExp | null {
  const norm = normalizeRoot(root)
  if (!norm) return null
  const encoded = norm.replace(/\\/g, '%5C').replace(/\//g, '%2F').replace(/ /g, '%20')
  if (!encoded.includes('%')) return null
  return new RegExp(escapeRegExp(encoded) + '(?=$|[^A-Za-z0-9_])', 'gi')
}

/**
 * 新路径按被匹配文本逐位还原分隔符写法。
 * 不只保留方向，还保留连续个数：JSON/INI 类文件里路径常写成「C:\\A\\B」，
 * 若替换成单反斜杠会产生非法转义、损坏文件（真实案例回归，smoke 69）。
 * 旧路径层级少于新路径时，多出的分隔位沿用旧文本的最后一次写法。
 */
export function matchSeparator(newRoot: string, matched: string): string {
  const segs = newRoot.split(/[\\/]+/).filter(Boolean)
  if (segs.length < 2) return newRoot
  const oldRuns = matched.match(/[\\/]+/g) ?? []
  const last = oldRuns[oldRuns.length - 1] ?? '\\'
  let out = segs[0]
  for (let i = 1; i < segs.length; i++) {
    out += (oldRuns[i - 1] ?? last) + segs[i]
  }
  return out
}

export function encodePath(p: string): string {
  return p.replace(/\\/g, '%5C').replace(/\//g, '%2F').replace(/ /g, '%20')
}

export interface RefMatch {
  index: number
  length: number
  matched: string
}

/** 找出文本中所有旧根路径引用（含 URL 编码形态） */
export function findPathRefs(text: string, oldRoot: string): RefMatch[] {
  const out: RefMatch[] = []
  for (const m of text.matchAll(buildPathRegex(oldRoot))) {
    out.push({ index: m.index, length: m[0].length, matched: m[0] })
  }
  const rx2 = buildEncodedPathRegex(oldRoot)
  if (rx2) {
    for (const m of text.matchAll(rx2)) {
      out.push({ index: m.index, length: m[0].length, matched: m[0] })
    }
  }
  return out
}

/** 把文本中所有旧根路径引用改写为新路径，返回新文本与替换次数 */
export function replacePathRefs(
  text: string,
  oldRoot: string,
  newRoot: string,
): { text: string; count: number } {
  let count = 0
  let out = text.replace(buildPathRegex(oldRoot), (matched) => {
    count++
    return matchSeparator(newRoot, matched)
  })
  const rx2 = buildEncodedPathRegex(oldRoot)
  if (rx2) {
    out = out.replace(rx2, () => {
      count++
      return encodePath(newRoot)
    })
  }
  return { text: out, count }
}

/** 根据字符偏移定位行列（1-based） */
export function lineColOf(text: string, index: number): { line: number; col: number } {
  let line = 1
  let lineStart = 0
  const stop = Math.min(index, text.length)
  for (let i = 0; i < stop; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lineStart = i + 1
    }
  }
  return { line, col: index - lineStart + 1 }
}

/** 取出 match 所在行的上下文片段（去首尾空白，超长截断） */
export function snippetAround(text: string, index: number, maxLen = 240): string {
  const { line } = lineColOf(text, index)
  const lines = text.split(/\r?\n/)
  const raw = (lines[line - 1] ?? '').trim()
  return raw.length > maxLen ? raw.slice(0, maxLen) + '…' : raw
}
