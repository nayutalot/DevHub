/**
 * OverlayApp.tsx — 比赛悬浮窗壳（CP2 批次，docs/22 §4.2/§4.4/§4.5）。
 *
 * 由 App.tsx 按 `#overlay` hash 分流渲染（同一 renderer 产物，唯一 devhub:invoke
 * 网关，不写第二个 preload）。结构：紧凑卡片列表（比赛名 + dueNode（含
 * "过期未完成"红标）+ 日期 + 剩余天数 + 官网/报名/提交入口按钮）+ 折叠按钮
 * （折叠态单行摘要，contestpin:overlaySetCollapsed 切换）。整窗 CSS
 * `-webkit-app-region: drag` 拖动区，按钮/卡片交互位 no-drag；卡片主体点击 →
 * contestpin:openInMain（主进程聚焦主窗口并导航 #contest:<id>）。数据
 * usePolling 轮询 contestpin:list（主窗口隐藏时照常工作，docs/22 §1）；
 * loading/empty/error 三态（约束 #24），无 mock。
 */

import { useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'
import { Badge } from './components/Badge.tsx'
import { EmptyState, ErrorState, Loading } from './components/StateViews.tsx'
import { CONTEST_NODE_KIND_LABEL, daysRemainingText, formatDate } from './lib/contestFormat.ts'
import { toMs } from './lib/format.ts'
import { call } from './lib/ipc.ts'
import { useAsync } from './lib/useAsync.ts'
import { usePolling } from './lib/usePolling.ts'
import type { ContestListItem } from '../../shared/types.ts'

const POLL_MS = 5000
const LIST_LIMIT = 50

/** React 类型缺 electron 的 -webkit-app-region，显式收窄。 */
const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties
const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties

export function OverlayApp() {
  const list = usePolling(() => call('contestpin:list', { limit: LIST_LIMIT }), [], POLL_MS)
  const overlayState = useAsync(() => call('contestpin:overlayState', {}), [])
  // null = 尚未从持久化态初始化（首切换前以 settings 值为准）
  const [collapsed, setCollapsed] = useState<boolean | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const isCollapsed = collapsed ?? overlayState.data?.collapsed ?? false
  const items = list.data?.items ?? []

  async function toggleCollapsed(): Promise<void> {
    const next = !isCollapsed
    setCollapsed(next) // 乐观更新（失败回滚）
    try {
      await call('contestpin:overlaySetCollapsed', { collapsed: next })
    } catch {
      setCollapsed(!next)
    }
  }

  async function openInMain(contestId: number): Promise<void> {
    try {
      await call('contestpin:openInMain', { contestId })
    } catch {
      // 结构化失败静默（NOT_FOUND 等不打断悬浮窗展示）
    }
  }

  async function openLink(contestId: number, url: string, event: MouseEvent): Promise<void> {
    event.stopPropagation()
    if (busyId !== null) return
    setBusyId(contestId)
    try {
      await call('contestpin:openLink', { url }) // 仅 http/https，service 校验
    } catch {
      // URL 非法等结构化错误：静默（悬浮窗无 toast 面）
    } finally {
      setBusyId(null)
    }
  }

  if (list.loading) {
    return (
      <div className="overlay-root" style={dragStyle}>
        <OverlayHeader isCollapsed={isCollapsed} onToggle={toggleCollapsed} count={null} />
        <div className="ovl-empty">
          <Loading label="…" />
        </div>
      </div>
    )
  }
  if (list.error !== null) {
    return (
      <div className="overlay-root" style={dragStyle}>
        <OverlayHeader isCollapsed={isCollapsed} onToggle={toggleCollapsed} count={null} />
        <div className="ovl-empty">
          <ErrorState error={list.error} onRetry={list.refresh} />
        </div>
      </div>
    )
  }

  if (isCollapsed) {
    // 折叠态：单行摘要（最近一个 due 节点 + 比赛计数）
    const nearest = items.find((c) => c.dueNode != null) ?? null
    return (
      <div className="overlay-root" style={dragStyle}>
        <div className="ovl-collapsed-bar">
          <span className="ovl-title">赛程钉 · {items.length} 项</span>
          {nearest?.dueNode != null && (
            <span className={nearest.dueNode.overdue ? 'ovl-due ovl-due-overdue' : 'ovl-due'}>
              {nearest.name} · {nearest.dueNode.label}
              {nearest.dueNode.startAt !== null ? ` · ${daysRemainingText(nearest.dueNode.startAt)}` : ''}
            </span>
          )}
          <button type="button" className="btn btn-small" style={{ ...noDragStyle, marginLeft: 'auto' }} onClick={() => void toggleCollapsed()}>
            展开
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay-root" style={dragStyle}>
      <OverlayHeader isCollapsed={false} onToggle={toggleCollapsed} count={items.length} />
      <div className="ovl-list">
        {items.length === 0 ? (
          <div className="ovl-empty">
            <EmptyState title="暂无进行中的比赛" hint="在主窗口「比赛」页新建比赛并添加时间节点。" />
          </div>
        ) : (
          items.map((c) => <OverlayCard key={c.id} c={c} busy={busyId === c.id} onOpen={() => void openInMain(c.id)} onLink={(url, e) => void openLink(c.id, url, e)} />)
        )}
      </div>
    </div>
  )
}

function OverlayHeader({
  isCollapsed,
  onToggle,
  count,
}: {
  isCollapsed: boolean
  onToggle: () => void
  count: number | null
}) {
  return (
    <div className="ovl-header">
      <span className="ovl-title">赛程钉{count !== null ? ` · ${count} 项` : ''}</span>
      <button type="button" className="btn btn-small" style={noDragStyle} onClick={onToggle}>
        {isCollapsed ? '展开' : '折叠'}
      </button>
    </div>
  )
}

function OverlayCard({
  c,
  busy,
  onOpen,
  onLink,
}: {
  c: ContestListItem
  busy: boolean
  onOpen: () => void
  onLink: (url: string, event: MouseEvent) => void
}) {
  const due = c.dueNode ?? null
  const links: { label: string; url: string }[] = []
  if (c.officialSite !== undefined) links.push({ label: '官网', url: c.officialSite })
  if (c.signupUrl !== undefined) links.push({ label: '报名', url: c.signupUrl })
  if (c.submitUrl !== undefined) links.push({ label: '提交', url: c.submitUrl })

  return (
    <div
      className="ovl-card"
      style={noDragStyle}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <div className="ovl-name">
        {c.name}
        {c.year !== null && <Badge tone="accent">{c.year}</Badge>}
      </div>
      {due !== null ? (
        <div className={due.overdue ? 'ovl-due ovl-due-overdue' : 'ovl-due'} title={CONTEST_NODE_KIND_LABEL[due.kind]}>
          {due.overdue ? '过期未完成 · ' : ''}
          {due.label}
          {due.startAt !== null ? ` · ${formatDate(toMs(due.startAt))} · ${daysRemainingText(due.startAt)}` : ' · 时间待定'}
        </div>
      ) : (
        <div className="ovl-due">暂无临近节点</div>
      )}
      {links.length > 0 && (
        <div className="ovl-links">
          {links.map((l) => (
            <button key={l.label} type="button" className="btn btn-small" disabled={busy} onClick={(e) => onLink(l.url, e)}>
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
