/**
 * components/ExpandableText.tsx — 可展开长文本（Step 8c F4）。
 *
 * 评审缺陷：Docker 状态卡 reason / Doctor detail / Dashboard warning detail
 * 长文本被截断且无法看全文。本组件默认按 collapsedLines 行折叠（CSS line-clamp），
 * 仅当文本可能溢出时显示 "Show more / Show less" 小按钮，展开后完整显示全文
 * （内联展开，非弹窗）。正文视觉沿用传入的既有样式类。
 *
 * 折叠阈值用字符数启发式（每行约 70 字符）：宁可多给按钮（误报无害，展开即全文），
 * 不给漏报（截断却不可展开）。
 */

import { useState } from 'react'
import type { CSSProperties } from 'react'

/** 折叠态正文样式：-webkit-box 纵向 + line-clamp（Electron/Chromium 支持）。 */
function clampStyle(lines: number): CSSProperties {
  return {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: lines,
    overflow: 'hidden',
  }
}

export function ExpandableText({
  text,
  className,
  collapsedLines = 2,
}: {
  text: string
  /** 附加到正文的样式类（沿用 warn-detail / diag-detail / repo-meta 等）。 */
  className?: string
  /** 折叠时保留的行数。 */
  collapsedLines?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const clampable = text.length > collapsedLines * 70
  const bodyClass = className === undefined ? 'expandable-body' : `${className} expandable-body`

  if (!clampable) {
    return <span className={bodyClass}>{text}</span>
  }
  return (
    <span className={`expandable-text${expanded ? ' expanded' : ''}`}>
      <span className={bodyClass} style={expanded ? undefined : clampStyle(collapsedLines)}>
        {text}
      </span>
      <button
        type="button"
        className="expandable-toggle"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '收起' : '展开'}
      </button>
    </span>
  )
}
