/**
 * views/ProjectsView.tsx — 项目列表 + 详情左右分栏（docs/06 §3.2，docs/01 §2.2）。
 *
 * 数据源：projects:list。操作：scan:start kind='full'（轮询 scan:status，运行中
 * 禁用按钮）、projects:add（内联表单 name+winPath 必填）、projects:remove /
 * rescan 经 ProjectDetailView。列表名过滤为纯前端展示辅助（lib 约定）。
 * 空列表给扫描/手动添加引导（docs/06 §4）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Badge } from '../components/Badge.tsx'
import { EmptyState, ErrorState, Loading, Spinner } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { truncate } from '../lib/format.ts'
import { call, sleep } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import { ProjectDetailView } from './ProjectDetailView.tsx'

const POLL_INTERVAL_MS = 1500

export function ProjectsView({ initialProjectId }: { initialProjectId?: number }) {
  const { refreshAll, refreshKey } = useApp()
  const list = useAsync(() => call('projects:list', {}), [refreshKey])
  const [selectedId, setSelectedId] = useState<number | undefined>(initialProjectId)
  const [filter, setFilter] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [scanRunning, setScanRunning] = useState(false)
  // D4-M4（AUDIT D-Aud I9）：扫描轮询循环的卸载取消标志——视图卸载后不再空转
  // sleep+scan:status 至终态（setup 内复位以兼容 StrictMode 双挂载）
  const scanAbortedRef = useRef(false)
  useEffect(() => {
    scanAbortedRef.current = false
    return () => {
      scanAbortedRef.current = true
    }
  }, [])

  // 选中项不存在（被移除 / 列表刷新后消失）时自动落到第一项
  useEffect(() => {
    if (list.data === null) return
    if (selectedId !== undefined && list.data.some((p) => p.id === selectedId)) return
    setSelectedId(list.data.length > 0 ? list.data[0].id : undefined)
  }, [list.data, selectedId])

  async function startScan() {
    if (scanRunning) return
    setScanRunning(true)
    try {
      const { scanId } = await call('scan:start', { kind: 'full' })
      for (;;) {
        if (scanAbortedRef.current) return // 卸载取消：出循环，不写任何状态（I9）
        await sleep(POLL_INTERVAL_MS)
        if (scanAbortedRef.current) return
        const status = await call('scan:status', { scanId })
        if (status.status !== 'running') break
      }
      list.refresh()
      refreshAll()
    } catch {
      // 结构化失败不再弹窗：扫描按钮回到可用态，列表错误态/汇总警告会呈现问题
      // （scan:status 的 errorSummary 会经 dashboard warnings 展示）
    } finally {
      setScanRunning(false)
    }
  }

  const projects = list.data ?? []
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (q === '') return projects
    return projects.filter((p) => p.name.toLowerCase().includes(q) || (p.winPath ?? '').toLowerCase().includes(q))
  }, [projects, filter])

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h2 className="view-title">项目</h2>
          <p className="view-sub">已发现与手动添加的项目及其关联关系</p>
        </div>
        <div className="view-actions">
          <button type="button" className="btn" disabled={scanRunning} onClick={() => void startScan()}>
            {scanRunning && <Spinner />}
            {scanRunning ? '扫描中…' : '扫描'}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setAddOpen((v) => !v)}>
            添加项目
          </button>
        </div>
      </header>

      {addOpen && (
        <AddProjectForm
          onDone={(added) => {
            setAddOpen(false)
            list.refresh()
            refreshAll()
            if (added !== undefined) setSelectedId(added.id)
          }}
          onCancel={() => setAddOpen(false)}
        />
      )}

      <div className="projects-split">
        <div>
          <input
            type="text"
            className="search-input"
            style={{ width: '100%', marginBottom: 8 }}
            placeholder="按名称或路径筛选…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {list.loading ? (
            <Loading label="正在加载项目…" />
          ) : list.error !== null ? (
            <ErrorState error={list.error} onRetry={list.refresh} />
          ) : projects.length === 0 ? (
            <div className="list-pane">
              <EmptyState
                title="还没有项目"
                hint="扫描配置的根目录可自动发现项目，也可手动添加。"
                action={{ label: '立即扫描', onClick: () => void startScan() }}
              />
            </div>
          ) : visible.length === 0 ? (
            <div className="list-pane">
              <EmptyState title="无匹配结果" hint={`没有项目匹配「${filter}」。`} />
            </div>
          ) : (
            <div className="list-pane">
              {visible.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`project-item${p.id === selectedId ? ' selected' : ''}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className="pi-head">
                    <span className="pi-name">
                      {p.name}
                      {p.runtimeHint !== undefined && <Badge tone="accent">{p.runtimeHint}</Badge>}
                    </span>
                    {p.dirtyCount > 0 && (
                      <span className="dirty-dot" title={`${p.dirtyCount} 处未提交改动`} />
                    )}
                  </span>
                  <span className="pi-path">{truncate(p.winPath ?? p.wslPath ?? '', 34)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedId === undefined ? (
          <div className="detail-pane">
            {projects.length > 0 ? (
              <EmptyState title="选择一个项目" hint="在左侧选择项目以查看其关联详情。" />
            ) : null}
          </div>
        ) : (
          <ProjectDetailView
            key={selectedId}
            id={selectedId}
            onRemoved={() => {
              setSelectedId(undefined)
              list.refresh()
              refreshAll()
            }}
            onChanged={() => {
              list.refresh()
              refreshAll()
            }}
          />
        )}
      </div>
    </section>
  )
}

/** 手动添加表单：name + winPath 必填 → projects:add；失败展示 error.message。 */
function AddProjectForm({ onDone, onCancel }: { onDone: (added?: { id: number }) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [winPath, setWinPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    if (name.trim() === '' || winPath.trim() === '') {
      setError('名称与 Windows 路径必填。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const added = await call('projects:add', { name: name.trim(), winPath: winPath.trim() })
      onDone(added)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="add-form" onSubmit={(e) => void submit(e)}>
      <div className="form-row">
        <span className="field">
          <label htmlFor="add-name">名称 *</label>
          <input id="add-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" />
        </span>
        <span className="field">
          <label htmlFor="add-path">Windows 路径 *</label>
          <input id="add-path" className="input" value={winPath} onChange={(e) => setWinPath(e.target.value)} placeholder="F:\\somewhere\\my-project" />
        </span>
      </div>
      <div className="form-row">
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting && <Spinner />}添加
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
      {error !== null && <p className="form-error">{error}</p>}
    </form>
  )
}
