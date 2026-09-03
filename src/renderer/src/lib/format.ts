/**
 * lib/format.ts — 纯展示辅助函数（Step 7，docs/06）。
 *
 * 硬性约束（docs/00 约束 #23 + 交付规格）：本模块 electron-free、react-free，
 * 供 scripts/smoke.mjs 在系统 Node（类型剥离）下直接加载；全部输入 → 输出
 * 纯函数，不做任何 IPC / DOM / 时钟副作用（now 由调用方注入）。
 */

// ---------------------------------------------------------------------------
// 时间：epoch → 相对时间（DB 秒级时间戳；容忍毫秒级输入）
// ---------------------------------------------------------------------------

/**
 * epoch 秒/毫秒启发式归一为毫秒：>= 1e12 视为毫秒，否则视为秒。
 * （DevHub DB 时间戳为秒级，docs/03；毫秒容忍用于防御未来字段迁移。）
 */
export function toMs(epoch: number): number {
  return epoch >= 1e12 ? epoch : epoch * 1000
}

/**
 * 相对时间文案："刚刚" / "N 分钟前" / "N 小时前" / "N 天前" / 超过 30 天回退
 * 本地日期。undefined / NaN / 非正数 → "—"（未打开过等缺省语义）。
 */
export function relativeTime(epoch: number | undefined, nowMs?: number): string {
  if (epoch === undefined || !Number.isFinite(epoch) || epoch <= 0) return '—'
  const now = nowMs ?? Date.now()
  const diffMs = now - toMs(epoch)
  if (diffMs < 0) return '刚刚' // 时钟偏差容忍
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(toMs(epoch)).toLocaleDateString()
}

// ---------------------------------------------------------------------------
// 文本：单行化 + 截断（命令行 / 路径展示）
// ---------------------------------------------------------------------------

/** 把命令行 / 路径折叠成安全单行：换行、制表符、多空格 → 单空格；trim。 */
export function oneLine(text: string | undefined): string {
  if (text === undefined) return ''
  return text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/**
 * 截断到 max 字符（含省略号）。超长时保留前缀 + "…"，绝不超长输出；
 * "不破坏显示"语义：先单行化再截断，控制字符不会进入 UI。
 */
export function truncate(text: string, max: number): string {
  if (max < 1) return ''
  const line = oneLine(text)
  if (line.length <= max) return line
  return line.slice(0, Math.max(1, max - 1)) + '…'
}

/** 命令行展示：缺省 → "—"；有值 → 单行化 + 截断（默认 96 列）。 */
export function formatCommandLine(cmd: string | undefined, max = 96): string {
  if (cmd === undefined || oneLine(cmd) === '') return '—'
  return truncate(cmd, max)
}

// ---------------------------------------------------------------------------
// Services 表过滤：端口精确 / 模糊 + 非数字按进程 / 项目名匹配
// ---------------------------------------------------------------------------

/** 过滤入参所需的最小行形状（结构化子集，避免依赖 shared 类型保持零依赖）。 */
export interface ServiceRowLike {
  port: number
  processName?: string
  projectName?: string
}

/**
 * 端口查询匹配（纯函数）：
 * - 空查询 → true（不过滤）
 * - 全数字查询 → 先精确匹配（port === Number(q)）；无精确命中时回退模糊
 *   子串匹配（String(port).includes(q)，如 "08" → 8080）
 * - 非数字查询 → 进程名 / 项目名大小写不敏感子串匹配
 */
export function portQueryMatches<T extends ServiceRowLike>(row: T, query: string): boolean {
  const q = query.trim()
  if (q === '') return true
  if (/^\d+$/.test(q)) {
    if (row.port === Number(q)) return true
    return String(row.port).includes(q)
  }
  const needle = q.toLowerCase()
  return (
    (row.processName ?? '').toLowerCase().includes(needle) ||
    (row.projectName ?? '').toLowerCase().includes(needle)
  )
}

/**
 * Services 表过滤：精确命中优先（回答"谁占用了 8080"时只回精确端口），
 * 否则模糊子串过滤；查询为空返回原数组（同一引用，便于调用方判断）。
 */
export function filterServiceRows<T extends ServiceRowLike>(rows: readonly T[], query: string): T[] {
  const q = query.trim()
  if (q === '') return [...rows]
  if (/^\d+$/.test(q)) {
    const exact = rows.filter((r) => r.port === Number(q))
    if (exact.length > 0) return exact
  }
  return rows.filter((r) => portQueryMatches(r, q))
}

// ---------------------------------------------------------------------------
// severity → 样式 / 图标映射（info / warning / error 三态，无 fallback 缺口）
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warning' | 'error'

/**
 * 任意输入折叠进三态 severity 枚举（大小写不敏感；非字符串 / 未知 / 缺省 →
 * 'info'）。保证下游样式映射不存在未覆盖分支（docs/04 doctor / dashboard
 * warnings 契约；入参从宽，防脏数据炸 UI）。
 */
export function normalizeSeverity(value: unknown): Severity {
  const v = typeof value === 'string' ? value.toLowerCase() : ''
  switch (v) {
    case 'warning':
    case 'warn':
      return 'warning'
    case 'error':
    case 'err':
      return 'error'
    default:
      return 'info'
  }
}

/** severity → CSS 修饰类（diag-info / diag-warning / diag-error）。 */
export function severityClass(value: unknown): string {
  return `diag-${normalizeSeverity(value)}`
}

/** severity → 文本图标（三态互异；未知输入归 info 图标，无缺口）。 */
export function severityGlyph(value: unknown): string {
  switch (normalizeSeverity(value)) {
    case 'warning':
      return '▲'
    case 'error':
      return '✖'
    case 'info':
      return 'ℹ'
  }
}
