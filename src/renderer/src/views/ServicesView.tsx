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
          <h2 className="view-title">Services</h2>
          <p className="view-sub">
            Listening ports attributed to processes, environments and projects
            {services.data !== null ? ` — last refresh saw ${services.data.refreshedCount} record(s)` : ''}
          </p>
        </div>
        <div className="view-actions">
          <button type="button" className="btn" disabled={services.loading} onClick={services.refresh}>
            Refresh
          </button>
        </div>
      </header>

      <form className="toolbar" onSubmit={submit}>
        <input
          type="text"
          className="search-input"
          placeholder="Filter ports, processes, projects"
          title="Substring filter; press Enter on a pure number to lock that exact port"
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
            Clear port {lockedPort}
          </button>
        )}
      </form>

      {lockedPort !== null && (
        <div className="port-answer">
          Port {lockedPort} — {visible.length} listener(s)
          {visible.length === 0 ? <span className="dim"> (nobody is listening on this port right now)</span> : null}
        </div>
      )}

      {services.loading ? (
        <Loading label="Scanning listening ports (Windows netstat / WSL / Docker)…" />
      ) : services.error !== null ? (
        <ErrorState error={services.error} onRetry={services.refresh} />
      ) : rows.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No listening ports"
            hint="Nothing was listening when the last refresh ran. Hit Refresh to scan again."
            action={{ label: 'Refresh', onClick: services.refresh }}
          />
        </div>
      ) : visible.length === 0 ? (
        <div className="panel">
          <EmptyState title="No matches" hint={`Nothing matches "${query.trim()}".`} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Port</th>
                <th>PID</th>
                <th>Process</th>
                <th>Origin</th>
                <th>Project</th>
                <th>Command</th>
              </tr>
            </thead>
            <tbody>
              {[...visible]
                .sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0))
                .map((r) => (
                  <tr key={r.id} className={lockedPort !== null && r.port === lockedPort ? 'row-hit' : undefined}>
                    <td className="td-mono">{r.port}</td>
                    <td className="td-mono td-dim">{r.pid ?? '—'}</td>
                    <td className="td-mono">{r.processName ?? 'unknown'}</td>
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
