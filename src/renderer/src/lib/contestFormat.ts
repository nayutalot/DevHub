/**
 * lib/contestFormat.ts — ContestPin 纯展示辅助（CP2）。
 *
 * 与 lib/format.ts 同纪律：electron-free / react-free，全部输入 → 输出纯函数，
 * 无 IPC / DOM / 时钟副作用（now 由调用方注入）。时间语义权威 = docs/22 §2.2：
 * precision 'date' 展示必须标"未注明具体时刻"，'tbd' 展示"时间待定"，
 * 'month' 只展示年月。
 */

import type {
  ContestDueNode,
  ContestNodeKind,
  ContestNodePrecision,
  ContestReminderOffsetKind,
  ContestStatus,
} from '../../../shared/types.ts'
import { toMs } from './format.ts'

export const CONTEST_STATUS_LABEL: Record<ContestStatus, string> = {
  watching: '关注中',
  registered: '已报名',
  submitted: '已提交',
  completed: '已完成',
  given_up: '已放弃',
}

export const CONTEST_NODE_KIND_LABEL: Record<ContestNodeKind, string> = {
  signup_start: '报名开始',
  signup_deadline: '报名截止',
  payment_deadline: '缴费截止',
  contest_start: '比赛开始',
  contest_end: '比赛结束',
  submit_deadline: '提交截止',
  custom: '自定义',
}

export const CONTEST_NODE_PRECISION_LABEL: Record<ContestNodePrecision, string> = {
  exact: '精确时刻',
  date: '仅日期',
  month: '仅年月',
  tbd: '时间待定',
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 本地日期：YYYY-MM-DD。 */
export function formatDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 本地日期时刻：YYYY-MM-DD HH:mm。 */
export function formatDateTime(ms: number): string {
  const d = new Date(ms)
  return `${formatDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 节点时间文案（precision 感知，docs/22 §2.2 展示红线）：
 *  - tbd → "时间待定"（start_at 恒 NULL）
 *  - month → "YYYY-MM（仅年月）"
 *  - date → "YYYY-MM-DD · 未注明具体时刻"
 *  - exact → "YYYY-MM-DD HH:mm"
 *  endAt 存在时附 "→ <end>"。
 */
export function formatNodeTime(
  node: { precision: ContestNodePrecision; startAt: number | null; endAt: number | null },
): string {
  if (node.precision === 'tbd' || node.startAt === null) return '时间待定'
  const ms = toMs(node.startAt)
  let text: string
  if (node.precision === 'month') {
    text = `${formatDate(ms).slice(0, 7)}（仅年月）`
  } else if (node.precision === 'date') {
    text = `${formatDate(ms)} · 未注明具体时刻`
  } else {
    text = formatDateTime(ms)
  }
  if (node.endAt !== null) {
    text += ` → ${node.precision === 'exact' ? formatDateTime(toMs(node.endAt)) : formatDate(toMs(node.endAt))}`
  }
  return text
}

/**
 * 剩余天数文案（悬浮窗/列表用）：未来 "N 天后"，当天 "今天"，过去 "已过 N 天"。
 * 跨自然日按绝对日差（start_at 当日 00:00 的 date 精度语义天然对齐）。
 */
export function daysRemainingText(startAtSec: number, nowMs?: number): string {
  const now = nowMs ?? Date.now()
  const startMs = toMs(startAtSec)
  const startDay = Math.floor(startMs / 86_400_000)
  const nowDay = Math.floor(now / 86_400_000)
  const diffDays = startDay - nowDay
  if (diffDays > 0) return `${diffDays} 天后`
  if (diffDays === 0) return '今天'
  return `已过 ${-diffDays} 天`
}

/** dueNode 一行摘要（悬浮窗卡片/列表副行）：过期红标语义由调用方用 overdue 渲染。 */
export function dueNodeSummary(due: ContestDueNode, nowMs?: number): string {
  const kind = CONTEST_NODE_KIND_LABEL[due.kind]
  if (due.startAt === null) return `${kind} · ${due.label} · 时间待定`
  return `${kind} · ${due.label} · ${formatDate(toMs(due.startAt))} · ${daysRemainingText(due.startAt, nowMs)}`
}

/** 提醒提前量文案（CP4；date 精度 before_days 实际触发时刻为当日 09:00 本地）。 */
export function reminderOffsetText(offsetKind: ContestReminderOffsetKind, offsetValue: number): string {
  if (offsetKind === 'before_days') return `提前 ${offsetValue} 天`
  if (offsetKind === 'before_hours') return `提前 ${offsetValue} 小时`
  return '准时（开始时刻）'
}
