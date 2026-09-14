/**
 * views/ServicesView.tsx — 端口归因表（docs/06 §3.4，docs/01 §2.4）。
 *
 * 数据源：services:list（先渲染缓存，D-Aud I7/D4-M3）→ services:refresh（后台
 * 补扫，完成后重拉 list 原位更新；Dashboard F6 同款 promise 模式，不阻塞首屏）。
 * 手动「刷新」按钮保持既有同步全量流程（refresh → list）。
 * 顶部搜索框：纯前端过滤（lib/format.filterServiceRows）；回车对纯数字查询锁定
 * 精确端口并高亮命中行 —— 即"谁占用了该端口"的直答。Origin 三色徽章，
 * Project 列可点击跳项目详情。
 */

import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Badge, originTone } from '../components/Badge.tsx'
import { EmptyState, ErrorState, Loading } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { filterServiceRows, formatCommandLine } from '../lib/format.ts'
import { call } from '../lib/ipc.ts'
import { useAsync, toAsyncError } from '../lib/useAsync.ts'
import type { AsyncError } from '../lib/useAsync.ts'
import type { ServiceRow } from '../../../shared/types.ts'

/**
 * D4-M3（AUDIT D-Aud I7）：session 级后台补扫 promise（模块级防抖，Dashboard F6
 * 同款 promise 模式）：进入视图先 services:list 渲染缓存（真实 netstat/WSL/Docker
 * 扫描需数秒，不再阻塞首屏），后台 refresh 完成后原位更新；StrictMode 双挂载 /
 * 快速重挂载订阅同一次扫描，不重复触发真实端口扫描。
 */
let servicesRescanPromise: Promise<number> | null = null

function beginServicesRescan(): Promise<number> {
  if (servicesRescanPromise === null) {
    servicesRescanPromise = call('services:refresh', {})
      .then((r) => r.records.length)
      .finally(() => {
        servicesRescanPromise = null
      })
  }
  return servicesRescanPromise
}

export function ServicesView() {
  const { navigate, refreshKey } = useApp()
  // I7：先 services:list 渲染缓存；useAsync 重拉期间保留旧 data（原位更新不闪空）
  const services = useAsync(() => call('services:list', {}), [refreshKey])
  /** 后台/手动补扫进行中（仅按钮态与副文本，不阻塞表格）。 */
  const [rescanning, setRescanning] = useState(false)
  /** 最近一次刷新记录数（进入后补扫完成前为 null，副文本不显）。 */
  const [refreshedCount, setRefreshedCount] = useState<number | null>(null)
  /** 手动「刷新」的结构化失败（失败语义与既有整面错误态一致）。 */
  const [rescanError, setRescanError] = useState<AsyncError | null>(null)

  // 进入视图后台补扫一次：完成后重拉 list 原位更新；失败保留缓存尽力而为（约束 #25）
  useEffect(() => {
    let cancelled = false
    setRescanning(true)
    void beginServicesRescan().then(
      (count) => {
        if (cancelled) return
        setRefreshedCount(count)
        setRescanning(false)
        services.refresh()
      },
      () => {
        if (!cancelled) setRescanning(false)
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅进入视图时触发一次
  }, [])

  /** 手动「刷新」：显式动作保持既有同步全量流程（services:refresh → 重拉 list）。 */
  async function manualRefresh(): Promise<void> {
    if (rescanning || services.loading) return
    setRescanning(true)
    setRescanError(null)
    try {
      const refreshed = await call('services:refresh', {})
      setRefreshedCount(refreshed.records.length)
      services.refresh()
    } catch (err) {
      setRescanError(toAsyncError(err))
    } finally {
      setRescanning(false)
    }
  }

  const [query, setQuery] = useState('')
  /** 回车锁定的精确端口（null = 未锁定）；锁定后仅显匹配行并高亮。 */
  const [lockedPort, setLockedPort] = useState<number | null>(null)

  const rows: ServiceRow[] = services.data ?? []
  const visible = useMemo(() => {
    if (lockedPort !== null) return rows.filter((r) => r.port === lockedPort)
    return filterServiceRows(rows, query)
  }, [rows, query, lockedPort])

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const q = query.trim()
    setLockedPort(/^\d+$/.test(q) ? Number(q) : null)
  }

  // 四态：首拉 loading / 错误（手动刷新失败或无缓存时的 list 失败）/
  // 空表 / 表格；补扫期间已有缓存则原位保留旧表
  const firstLoading = services.loading && services.data === null
  const fatal = rescanError ?? (services.data === null ? services.error : null)

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h2 className="view-title">服务</h2>
          <p className="view-sub">
            监听端口归因到进程、环境与项目
            {rescanning ? ' — 正在后台扫描端口…' : refreshedCount !== null ? ` — 上次刷新记录 ${refreshedCount} 条` : ''}
          </p>
        </div>
        <div className="view-actions">
          <button type="button" className="btn" disabled={rescanning || services.loading} onClick={() => void manualRefresh()}>
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

      {firstLoading ? (
        <Loading label="正在加载监听端口缓存（后台扫描 Windows netstat / WSL / Docker 中…）…" />
      ) : fatal !== null ? (
        <ErrorState error={fatal} onRetry={() => void manualRefresh()} />
      ) : rows.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="没有监听端口"
            hint="上次刷新时没有发现监听。点击「刷新」重新扫描。"
            action={{ label: '刷新', onClick: () => void manualRefresh() }}
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
