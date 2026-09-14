/**
 * views/ProjectDetailView.tsx — 项目详情（docs/06 §3.2）。
 *
 * 数据源：projects:get（真实关系：repositories / containers / services /
 * environments）。操作：projects:openFolder / openVSCode / openTerminal /
 * openWSL（成功 toast "已打开"，失败 toast error.message）、projects:rescan
 * （单项目 Git Status，轮询 scan:status 至终态后重拉详情）、projects:remove
 * （二次确认）。空仓库 / 空容器 / 空服务均为结构化空态文案。
 */

import { useEffect, useRef, useState } from 'react'
import { Badge, originTone, stateTone } from '../components/Badge.tsx'
import { ErrorState, Loading, Toast, useToast } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { formatCommandLine, relativeTime, truncate } from '../lib/format.ts'
import { call, sleep } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type { ContainerRecord } from '../../../shared/types.ts'

const POLL_INTERVAL_MS = 1500

export function ProjectDetailView({
  id,
  onRemoved,
  onChanged,
}: {
  id: number
  onRemoved: () => void
  /** 单项目 rescan 终态后通知父级（刷新左侧列表与全局统计）。 */
  onChanged: () => void
}) {
  const { refreshKey } = useApp()
  const detail = useAsync(() => call('projects:get', { id }), [id, refreshKey])
  const { toast, show } = useToast()
  const [busyAction, setBusyAction] = useState<string | null>(null)
  // D4-M4（AUDIT D-Aud I9）：rescanGit 轮询循环的卸载取消标志——组件卸载（切换
  // 选中项目 / 离开视图）后不再空转 sleep+scan:status（setup 内复位兼容 StrictMode）
  const rescanAbortedRef = useRef(false)
  useEffect(() => {
    rescanAbortedRef.current = false
    return () => {
      rescanAbortedRef.current = true
    }
  }, [])

  if (detail.loading) {
    return (
      <div className="detail-pane">
        <Loading label="正在加载项目详情…" />
      </div>
    )
  }
  if (detail.error !== null || detail.data === null) {
    return (
      <div className="detail-pane">
        {detail.error !== null ? (
          <ErrorState error={detail.error} onRetry={detail.refresh} />
        ) : null}
      </div>
    )
  }

  const p = detail.data

  /** 打开类操作的统一包装：busy 防重入 + toast 结果（约束 #14 结构化失败）。 */
  async function runAction(name: string, label: string, fn: () => Promise<unknown>) {
    if (busyAction !== null) return
    setBusyAction(name)
    try {
      await fn()
      show('已打开')
    } catch (err) {
      show(`${label}失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusyAction(null)
    }
  }

  async function rescanGit() {
    if (busyAction !== null) return
    setBusyAction('rescan')
    try {
      const { scanId } = await call('projects:rescan', { id })
      // 轮询到终态再刷新（docs/06 §4：scan/refresh 类操作轮询 scan:status）；
      // 卸载取消：出循环且不写状态/弹 toast（I9）
      for (;;) {
        if (rescanAbortedRef.current) return
        await sleep(POLL_INTERVAL_MS)
        if (rescanAbortedRef.current) return
        const status = await call('scan:status', { scanId })
        if (status.status !== 'running') {
          if (status.status === 'failed' && status.errorSummary !== undefined) {
            show(`Git 状态扫描失败 — ${status.errorSummary}`, 'err')
          }
          break
        }
      }
      detail.refresh()
      onChanged()
      show('Git 状态已刷新')
    } catch (err) {
      show(`重新扫描失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusyAction(null)
    }
  }

  async function removeProject() {
    if (busyAction !== null) return
    if (!window.confirm(`移除项目「${p.name}」？关联关系将被清理。`)) return
    setBusyAction('remove')
    try {
      await call('projects:remove', { id })
      show(`已移除「${p.name}」`)
      onRemoved()
    } catch (err) {
      show(`移除失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusyAction(null)
    }
  }

  const busy = busyAction !== null

  return (
    <div className="detail-pane">
      <header className="view-header">
        <div>
          <h2 className="view-title mono">{p.name}</h2>
          <p className="view-sub mono">{p.winPath ?? p.wslPath ?? '—'}</p>
        </div>
        <div className="view-actions">
          {p.runtimeHint !== undefined && <Badge tone="accent">{p.runtimeHint}</Badge>}
          {p.hasGit && (
            <Badge tone={stateTone(p.dirtyCount > 0 ? 'dirty' : 'clean')}>
              {p.dirtyCount > 0 ? `有改动 ×${p.dirtyCount}` : '干净'}
            </Badge>
          )}
        </div>
      </header>

      <div className="actions-row" style={{ marginBottom: 12 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => void runAction('folder', '打开文件夹', () => call('projects:openFolder', { id }))}>
          打开文件夹
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void runAction('vscode', '在 VS Code 打开', () => call('projects:openVSCode', { id }))}>
          在 VS Code 打开
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void runAction('terminal', '打开终端', () => call('projects:openTerminal', { id }))}>
          打开终端
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void runAction('wsl', '在 WSL 打开', () => call('projects:openWSL', { id }))}>
          在 WSL 打开
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void rescanGit()}>
          {busyAction === 'rescan' ? <span className="spinner" /> : null}
          Git 状态
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void removeProject()}>
          移除
        </button>
      </div>

      <div className="section">
        <h3 className="section-title">位置</h3>
        <div className="kv-grid">
          <span className="kv-label">Windows 路径</span>
          <span className="kv-value">{p.winPath ?? '—'}</span>
          <span className="kv-label">WSL 路径</span>
          <span className="kv-value">{p.wslPath ?? '—'}</span>
          <span className="kv-label">最近打开</span>
          <span className="kv-value plain">{relativeTime(p.lastOpenedAt)}</span>
          {p.description !== undefined && (
            <>
              <span className="kv-label">描述</span>
              <span className="kv-value plain">{p.description}</span>
            </>
          )}
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Git</h3>
        {!p.hasGit || p.repositories.length === 0 ? (
          <div className="inline-note">不是 git 仓库</div>
        ) : (
          p.repositories.map((r) => (
            <div key={r.id} className="repo-card">
              <div className="repo-line">
                <strong className="mono">{r.branch ?? 'HEAD'}</strong>
                <Badge tone={stateTone(r.isDirty ? 'dirty' : 'clean')}>{r.isDirty ? '有改动' : '干净'}</Badge>
                <span className="repo-meta">
                  ↑{r.ahead} ↓{r.behind}
                </span>
                {r.headSha !== undefined && <span className="repo-meta mono">{truncate(r.headSha, 11)}</span>}
                {r.lastStatusAt !== undefined && (
                  <span className="repo-meta" title="上次状态">
                    {relativeTime(r.lastStatusAt)}
                  </span>
                )}
              </div>
              {r.remoteUrl !== undefined && <div className="repo-meta mono">{truncate(r.remoteUrl, 100)}</div>}
            </div>
          ))
        )}
      </div>

      <div className="section">
        <h3 className="section-title">运行时</h3>
        <div className="kv-grid">
          <span className="kv-label">运行时提示</span>
          <span className="kv-value plain">{p.runtimeHint ?? '—'}</span>
          <span className="kv-label">环境</span>
          <span className="kv-value plain">
            {p.environments.length === 0
              ? '—'
              : p.environments.map((e) => (
                  <span key={e.id}>
                    <Badge tone={e.kind === 'wsl' ? 'wsl' : 'accent'} title={`检测到 ${e.tools.length} 个工具`}>
                      {e.name}
                    </Badge>{' '}
                  </span>
                ))}
          </span>
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Docker</h3>
        {p.containers.length === 0 ? (
          <div className="inline-note">未关联容器</div>
        ) : (
          p.containers.map((c) => <ContainerLine key={c.id} c={c} />)
        )}
      </div>

      <div className="section">
        <h3 className="section-title">Services</h3>
        {p.services.length === 0 ? (
          <div className="inline-note">无归因服务</div>
        ) : (
          p.services.map((s) => (
            <div key={s.id} className="svc-row">
              <strong className="mono">{s.port}</strong>
              <span className="mono dim">{s.processName ?? '未知'}</span>
              {s.pid !== undefined && <span className="mono dim">pid {s.pid}</span>}
              <Badge tone={originTone(s.origin)}>{s.origin}</Badge>
              <span className="mono dim" title={s.commandLine}>
                {formatCommandLine(s.commandLine, 64)}
              </span>
            </div>
          ))
        )}
      </div>

      <Toast toast={toast} />
    </div>
  )
}

function ContainerLine({ c }: { c: ContainerRecord }) {
  return (
    <div className="container-row">
      <strong className="mono">{c.name}</strong>
      <span className="mono dim">{c.image ?? '未知镜像'}</span>
      <Badge tone={stateTone(c.state)}>{c.state ?? '未知'}</Badge>
      {c.ports.length > 0 && (
        <span className="mono dim">
          {c.ports.map((m) => `${m.host}→${m.container}/${m.proto}`).join(', ')}
        </span>
      )}
    </div>
  )
}
