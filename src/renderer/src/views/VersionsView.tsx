/**
 * views/VersionsView.tsx — 版本中心视图（S3 批次，docs/09 §7/§9）。
 *
 * 布局：8 目标表格（名称 / 通道 / 已装版本 / 最新或目标 / 状态徽章 / 上次检查）+
 * Check All 按钮 + 单项 Update（两段确认：第一段 confirmRequired（可含 blocked 进程
 * 预检结果）→ window.confirm 展示 → confirmed 执行）+ job 进度行（versions:job 轮询
 * 增量日志）；N/A / 检测失败目标显式降级说明（note 列），绝不白屏。
 */

import { useEffect, useRef, useState } from 'react'
import { Badge } from '../components/Badge.tsx'
import type { BadgeTone } from '../components/Badge.tsx'
import { ErrorState, Loading, Toast, useToast } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { relativeTime } from '../lib/format.ts'
import { call, sleep } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type { VersionJobSnapshot, VersionStatus } from '../../../shared/types.ts'

function stateToneOf(state: VersionStatus['state']): BadgeTone {
  switch (state) {
    case 'up-to-date':
      return 'ok'
    case 'upgradable':
      return 'warn'
    case 'check-failed':
      return 'err'
    default:
      return 'dim'
  }
}

const STATE_LABEL: Record<VersionStatus['state'], string> = {
  'up-to-date': '最新',
  upgradable: '可升级',
  unknown: '未知',
  'check-failed': '检测失败',
  'detect-only': '仅检测',
}

export function VersionsView() {
  const { refreshKey } = useApp()
  const { toast, show } = useToast()
  const data = useAsync<{ targets: VersionStatus[] }>(async () => call('versions:list', {}), [refreshKey])

  const [busy, setBusy] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [jobs, setJobs] = useState<VersionJobSnapshot[]>([])
  const pollRef = useRef<number | undefined>(undefined)

  // job 轮询：running 的 job 每 1.5s 拉一次快照，全部结束后停止
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'running')) return
    pollRef.current = window.setInterval(() => {
      void (async () => {
        const next = await Promise.all(
          jobs.map(async (j) => (j.status === 'running' ? call('versions:job', { jobId: j.jobId }).catch(() => j) : j)),
        )
        const stillRunning = next.some((j) => j.status === 'running')
        setJobs([...next])
        if (!stillRunning) {
          const doneJob = next.find((j) => j.status === 'done')
          show(doneJob !== undefined ? '更新完成' : '更新已结束', doneJob !== undefined ? 'ok' : 'err')
          data.refresh()
        }
      })()
    }, 1500)
    return () => window.clearInterval(pollRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- jobs/data 为轮询内部闭包所需
  }, [jobs])

  async function runAction(name: string, fn: () => Promise<void>): Promise<void> {
    setBusy(name)
    try {
      await fn()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      show(`${name} 失败: ${detail}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  function handleCheckAll(): void {
    void runAction('全部检测', async () => {
      setChecking(true)
      try {
        const r = await call('versions:check', {})
        show(`检测完成：${r.statuses.filter((s) => s.state !== 'check-failed').length}/${r.statuses.length} 成功`)
      } finally {
        setChecking(false)
      }
      data.refresh()
    })
  }

  function handleUpdate(target: VersionStatus): void {
    void runAction('更新', async () => {
      // 第一段：confirmRequired（github 条目一律 blocked；winget 条目可带进程预检结果）
      const first = await call('versions:update', { id: target.id })
      if (first.confirmRequired !== true) return
      const reason =
        first.blocked === true && first.running === true
          ? `目标进程正在运行：${first.processName ?? ''}。`
          : first.blocked === true
            ? '该目标为耗时重建/源码更新。'
            : ''
      if (!window.confirm(`确认更新「${target.name}」？\n${reason}更新命令超时 20 分钟（源码重建 30 分钟），期间可关闭本页。`)) return
      // 第二段：confirmed 执行 → job 轮询
      const started = await call('versions:update', { id: target.id, confirmed: true })
      if (started.jobId !== undefined) {
        const snap = await call('versions:job', { jobId: started.jobId })
        setJobs((prev) => [...prev.filter((j) => j.jobId !== snap.jobId), snap])
        await sleep(50)
      }
    })
  }

  const targets = data.data?.targets ?? []

  return (
    <div>
      <div className="view-header">
        <span className="view-title">版本中心</span>
        <span className="view-sub">8 目标检测与更新（检测 90s / 更新 20min / 源码重建 30min 超时）</span>
        <div className="view-actions">
          <button type="button" className="btn" onClick={data.refresh} disabled={data.loading || checking}>
            刷新
          </button>
          <button type="button" className="btn btn-primary" onClick={handleCheckAll} disabled={checking || busy !== null}>
            {checking ? '检测中…' : '全部检测'}
          </button>
        </div>
      </div>

      {data.loading && <Loading label="正在加载版本目标…" />}
      {data.error !== null && <ErrorState error={data.error} onRetry={data.refresh} />}

      {data.data !== null && (
        <div className="panel">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>目标</th>
                  <th>通道</th>
                  <th>已装版本</th>
                  <th>最新 / 目标</th>
                  <th>状态</th>
                  <th>上次检查</th>
                  <th>动作</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.name}</strong>
                      {t.hint !== undefined && (
                        <div className="dim skill-desc" title={t.hint}>
                          {t.hint}
                        </div>
                      )}
                    </td>
                    <td className="mono td-mono">{t.channel}</td>
                    <td className="mono td-mono">{t.installed ?? '—'}</td>
                    <td className="mono td-mono">{t.latest ?? '—'}</td>
                    <td>
                      <Badge tone={stateToneOf(t.state)} title={t.note}>
                        {STATE_LABEL[t.state]}
                      </Badge>
                      {t.note !== undefined && (
                        <div className="dim skill-desc">{t.note}</div>
                      )}
                    </td>
                    <td className="td-dim">{t.lastCheckedAt !== null ? relativeTime(t.lastCheckedAt) : '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy !== null || t.state === 'detect-only'}
                        title={t.state === 'detect-only' ? '该目标无自动升级通道' : undefined}
                        onClick={() => handleUpdate(t)}
                      >
                        更新
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="panel">
          <div className="panel-title">更新任务</div>
          {jobs.map((j) => (
            <div key={j.jobId} className="repo-card">
              <div className="repo-line">
                <strong>{j.entryId}</strong>
                <Badge tone={j.status === 'running' ? 'accent' : j.status === 'done' ? 'ok' : 'err'}>{j.status}</Badge>
                {j.after !== undefined && (
                  <span className="dim">
                    复查：已装 {j.after.installed ?? '—'} · 最新 {j.after.latest ?? '—'} · {STATE_LABEL[j.after.state]}
                  </span>
                )}
              </div>
              {j.error !== undefined && <div className="cell-error">{j.error}</div>}
              <div className="feedback-lines mono">
                {j.log.slice(-12).map((line, i) => (
                  <div key={`${j.jobId}-${i}`}>{line}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <Toast toast={toast} />
    </div>
  )
}
