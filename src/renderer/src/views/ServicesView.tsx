/**
 * views/ServicesView.tsx — 端口归因表（docs/06 §3.4，docs/01 §2.4）。
 *
 * 数据源：services:refresh（真扫端口并回写归因）→ services:list（join 项目名）。
 * 顶部搜索框：纯前端过滤（lib/format.filterServiceRows）；回车对纯数字查询锁定
 * 精确端口并高亮命中行 —— 即"谁占用了该端口"的直答。Origin 三色徽章，
 * Project 列可点击跳项目详情。
 */

import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Badge, originTone } from '../components/Badge.tsx'
import { EmptyState, ErrorState, Loading } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { filterServiceRows, formatCommandLine } from '../lib/format.ts'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type { ServiceRow } from '../../../shared/types.ts'

export function ServicesView() {
  const { navigate, refreshKey } = useApp()
  const services = useAsync(async () => {
    const refreshed = await call('services:refresh', {})
    const rows = await call('services:list', {})
    return { rows, refreshedCount: refreshed.records.length }
  }, [refreshKey])

  const [query, setQuery] = useState('')
  /** 回车锁定的精确端口（null = 未锁定）；锁定后仅显匹配行并高亮。 */
  const [lockedPort, setLockedPort] = useState<number | null>(null)

  const rows: ServiceRow[] = services.data?.rows ?? []
  const visible = useMemo(() => {
    if (lockedPort !== null) return rows.filter((r) => r.port === lockedPort)
    return filterServiceRows(rows, query)
  }, [rows, query, lockedPort])

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const q = query.trim()
    setLockedPort(/^\d+$/.test(q) ? Number(q) : null)
  }

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h2 className="view-title">服务</h2>
          <p className="view-sub">
            监听端口归因到进程、环境与项目
            {services.data !== null ? ` — 上次刷新记录 ${services.data.refreshedCount} 条` : ''}
          </p>
        </div>
        <div className="view-actions">
          <button type="button" className="btn" disabled={services.loading} onClick={services.refresh}>
            刷新
          </button>
        </div>
      </header>

      <form className="toolbar" onSubmit={submit}>
        <input
          type="text"
          className="search-input"
          placeholder="筛选端口、进程、项目"
          title="子串筛选；输入纯数字按回车可锁定该精确端口"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            if (e.target.value.trim() === '') setLockedPort(null)
          }}
        />
        {lockedPort !== null && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setLockedPort(null)
              setQuery('')
            }}
          >
            解除锁定端口 {lockedPort}
          </button>
        )}
      </form>

      {lockedPort !== null && (
        <div className="port-answer">
          端口 {lockedPort} — {visible.length} 个监听者
          {visible.length === 0 ? <span className="dim">（当前没有进程监听该端口）</span> : null}
        </div>
      )}

      {services.loading ? (
        <Loading label="正在扫描监听端口（Windows netstat / WSL / Docker）…" />
      ) : services.error !== null ? (
        <ErrorState error={services.error} onRetry={services.refresh} />
      ) : rows.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="没有监听端口"
            hint="上次刷新时没有发现监听。点击「刷新」重新扫描。"
            action={{ label: '刷新', onClick: services.refresh }}
          />
        </div>
      ) : visible.length === 0 ? (
        <div className="panel">
          <EmptyState title="无匹配结果" hint={`没有匹配「${query.trim()}」的结果。`} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>端口</th>
                <th>PID</th>
                <th>进程</th>
                <th>来源</th>
                <th>项目</th>
                <th>命令</th>
              </tr>
            </thead>
            <tbody>
              {[...visible]
                .sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0))
                .map((r) => (
                  <tr key={r.id} className={lockedPort !== null && r.port === lockedPort ? 'row-hit' : undefined}>
                    <td className="td-mono">{r.port}</td>
                    <td className="td-mono td-dim">{r.pid ?? '—'}</td>
                    <td className="td-mono">{r.processName ?? '未知'}</td>
                    <td>
                      <Badge tone={originTone(r.origin)}>{r.origin}</Badge>
                    </td>
                    <td>
                      {r.projectId !== undefined ? (
                        <button
                          type="button"
                          className="btn-link"
                          title={r.projectName ?? `project #${r.projectId}`}
                          onClick={() => navigate({ view: 'projects', projectId: r.projectId })}
                        >
                          {r.projectName ?? `#${r.projectId}`}
                        </button>
                      ) : (
                        <span className="td-dim">—</span>
                      )}
                    </td>
                    <td className="td-mono td-dim" title={r.commandLine}>
                      {formatCommandLine(r.commandLine, 80)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
