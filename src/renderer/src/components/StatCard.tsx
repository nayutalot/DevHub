/**
 * components/StatCard.tsx — Dashboard 统计卡（docs/06 §3.1）：
 * 数字（等宽）+ 标题 + 副文本；onClick 提供时渲染为可点击卡片（跳转对应视图）。
 */

import type { ReactNode } from 'react'

export function StatCard({
  label,
  value,
  valueTone,
  sub,
  onClick,
}: {
  label: string
  value: ReactNode
  /** 数值强调色（缺省主前景）。 */
  valueTone?: 'ok' | 'warn' | 'err'
  sub?: ReactNode
  onClick?: () => void
}) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className={`stat-value${valueTone !== undefined ? ` ${valueTone}` : ''}`}>{value}</span>
      {sub !== undefined && <span className="stat-sub">{sub}</span>}
    </>
  )
  if (onClick === undefined) {
    return <div className="stat-card">{body}</div>
  }
  return (
    <button type="button" className="stat-card" onClick={onClick} title="View details">
      {body}
    </button>
  )
}
