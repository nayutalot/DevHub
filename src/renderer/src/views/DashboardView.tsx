/**
 * views/DashboardView.tsx — 汇总视图（docs/06 §3.1，docs/01 §2.1）。
 *
 * 数据源（真实 IPC，约束 #23 无 mock）：dashboard:summary。
 * 行为：进入即拉 summary；首次且 projectCount===0 时自动触发一次 scan:start
 * （session 内仅一次，模块级 promise 防抖），2s 轮询 scan:status 并显示扫描进度行，
 * 终态后 refreshAll 重拉统计。Docker daemon offline / WSL 降级均为结构化文案
 * （约束 #26）。
 * Step 8c：F6 —— 首次 summary 若 serviceCount===0（services 表尚无取样），后台
 * 触发一次 services:refresh 后重拉 summary（模块级防抖，不阻塞首屏）；
 * F4 —— warning detail 经 ExpandableText 支持展开看全文。
 */

import { useEffect, useState } from 'react'
import { Badge, stateTone } from '../components/Badge.tsx'
import { ExpandableText } from '../components/ExpandableText.tsx'
import { StatCard } from '../components/StatCard.tsx'
import { EmptyState, ErrorState, Loading, Spinner } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { relativeTime, severityClass, severityGlyph } from '../lib/format.ts'
import { call, sleep } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'

const POLL_INTERVAL_MS = 2000

/**
 * 自动首扫共享流程（模块级，与 F6 servicesRefreshPromise 同模式）：流程整体挂在
 * promise 上，scan:start 全 session 仅触发一次；进度同步写入 latest 快照。StrictMode
 * 双挂载 / 视图切换重挂载时，第二个实例订阅同一次流程（boolean 方案的缺陷：首挂载
 * 被 cancel 后标记已置位，重挂载会跳过触发 → 不轮询不刷新，这里以快照 + 订阅消除）。
 */
let autoScanProgress: ScanLine | null = null
let autoScanPromise: Promise<ScanLine> | null = null

/**
 * F6：session 级后台端口补扫 promise（模块级防抖标记）。用 promise 而非 boolean，
 * StrictMode 双挂载 / 视图切换重挂载时第二次 effect 可订阅同一次补扫的完成事件，
 * 不会把"scanning"提示永久卡住，也不会重复触发真实端口扫描。
 */
let servicesRefreshPromise: Promise<void> | null = null

interface ScanLine {
  running: boolean
  foundCount: number
  terminalNote?: string
}

export function DashboardView() {
  const { navigate, refreshAll, refreshKey } = useApp()
  const summary = useAsync(() => call('dashboard:summary', {}), [refreshKey])
  const [scanLine, setScanLine] = useState<ScanLine | null>(null)
  /** F6：后台端口补扫进行中（仅影响 Services 卡副文本，不阻塞首屏）。 */
  const [servicesScanning, setServicesScanning] = useState(false)

  // 自动首扫（仅当本 session 尚未触发过且 summary 告知 0 项目）。与 F6 同模式：
  // 流程挂在模块级 promise 上，重挂载实例订阅同一次流程，进度经模块级快照镜像。
  useEffect(() => {
    if (summary.data === null || summary.data.projectCount > 0) return
    if (autoScanPromise === null) {
      autoScanPromise = (async (): Promise<ScanLine> => {
        try {
          const { scanId } = await call('scan:start', { kind: 'full' })
          for (;;) {
            await sleep(POLL_INTERVAL_MS)
            const status = await call('scan:status', { scanId })
            const next: ScanLine =
              status.status === 'running'
                ? { running: true, foundCount: status.foundCount }
                : {
                    running: false,
                    foundCount: status.foundCount,
                    terminalNote:
                      status.status === 'failed'
                        ? `scan failed${status.errorSummary !== undefined ? `: ${status.errorSummary}` : ''}`
                        : undefined,
                  }
            autoScanProgress = next
            if (status.status !== 'running') return next
          }
        } catch (err) {
          const next: ScanLine = {
            running: false,
            foundCount: 0,
            terminalNote: err instanceof Error ? err.message : String(err),
          }
          autoScanProgress = next
          return next
        }
      })()
      // 终态重拉统计挂在共享流程上而非单个挂载实例：首挂载被 StrictMode cancel
      // 也不会漏掉刷新（这是原 boolean 方案的实际 bug）。
      void autoScanPromise.then(() => refreshAll())
    }

    // 订阅共享流程：立即镜像一次快照 + 定时镜像进度，promise 落定后收尾到终态。
    let cancelled = false
    const mirror = (): void => {
      if (!cancelled && autoScanProgress !== null) setScanLine(autoScanProgress)
    }
    mirror()
    const timer = window.setInterval(mirror, POLL_INTERVAL_MS)
    void autoScanPromise.finally(() => {
      window.clearInterval(timer)
      mirror()
    })
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [summary.data, refreshAll])

  // F6：首次加载后 serviceCount===0 说明本 session 还没扫过端口（端口扫描只在
  // Services 视图触发）。后台补扫一次再重拉 summary；真实扫端口需数秒，故不阻塞
  // 首屏，期间 Services 卡副文本显示 scanning。
  useEffect(() => {
    if (summary.data === null || summary.data.serviceCount !== 0) return
    if (servicesRefreshPromise === null) {
      servicesRefreshPromise = call('services:refresh', {})
        .then(() => refreshAll())
        .catch(() => {
          // 后台尽力而为：失败保持 0 与既有 warnings，不打断 Dashboard（约束 #25）
        })
    }
    let cancelled = false
    setServicesScanning(true)
    void servicesRefreshPromise.finally(() => {
      if (!cancelled) setServicesScanning(false)
    })
    return () => {
      cancelled = true
    }
  }, [summary.data, refreshAll])

  if (summary.loading) {
    return (
      <section className="view">
        <ViewHeader />
        <Loading label="正在加载仪表盘摘要…" />
      </section>
    )
  }
  if (summary.error !== null || summary.data === null) {
    return (
      <section className="view">
        <ViewHeader onRefresh={summary.refresh} />
        {summary.error !== null ? (
          <ErrorState error={summary.error} onRetry={summary.refresh} />
        ) : null}
      </section>
    )
  }

  const s = summary.data
  const dockerOffline = s.dockerRunning === 0 && s.dockerTotal === 0 && s.warnings.some((w) => /docker/i.test(w.title) && w.severity !== 'info')
  const wslSub = s.wslStatus.available
    ? s.wslStatus.distros.length > 0
      ? `${s.wslStatus.distros.length} 个发行版：${s.wslStatus.distros.join(', ')}`
      : (s.wslStatus.detail ?? '已安装，无发行版')
    : (s.wslStatus.detail ?? '不可用')
  const recent = s.recentProjects

  return (
    <section className="view">
      <ViewHeader onRefresh={summary.refresh} />

      {scanLine !== null && (
        <div className={`scan-line${scanLine.running ? '' : scanLine.terminalNote !== undefined ? ' failed' : ' done'}`}>
          {scanLine.running && <Spinner />}
          {scanLine.running
            ? `正在扫描项目…已发现 ${scanLine.foundCount} 个`
            : scanLine.terminalNote !== undefined
              ? `扫描结束但出现问题 — ${scanLine.terminalNote}`
              : `扫描完成 — 共 ${scanLine.foundCount} 个项目`}
        </div>
      )}

      <div className="stat-grid">
        <StatCard
          label="项目"
          value={s.projectCount}
          sub="点击打开项目列表"
          onClick={() => navigate({ view: 'projects' })}
        />
        <StatCard
          label="有改动的仓库"
          value={s.dirtyRepoCount}
          valueTone={s.dirtyRepoCount > 0 ? 'warn' : undefined}
          sub="存在未提交改动"
          onClick={() => navigate({ view: 'projects' })}
        />
        <StatCard
          label="Docker"
          value={`${s.dockerRunning}/${s.dockerTotal}`}
          sub={dockerOffline ? 'daemon 离线' : '容器 运行中/总数'}
        />
        <StatCard
          label="WSL"
          value={s.wslStatus.available ? '可用' : '离线'}
          valueTone={s.wslStatus.available ? 'ok' : 'err'}
          sub={wslSub}
        />
        <StatCard
          label="服务"
          value={s.serviceCount}
          sub={servicesScanning ? '正在扫描端口…' : '监听端口'}
          onClick={() => navigate({ view: 'services' })}
        />
      </div>

      {s.projectCount === 0 && scanLine === null && (
        <div className="panel">
          <EmptyState
            title="还没有项目"
            hint="运行一次扫描以发现配置扫描根目录下的项目，或到「项目」页手动添加。"
            action={{ label: '前往项目页', onClick: () => navigate({ view: 'projects' }) }}
          />
        </div>
      )}

      <div className="dash-columns">
        <div className="panel">
          <h3 className="panel-title">最近项目</h3>
          {recent.length === 0 ? (
            <div className="inline-note">暂无近期活动。</div>
          ) : (
            recent.map((p) => (
              <button
                key={p.id}
                type="button"
                className="recent-item"
                onClick={() => navigate({ view: 'projects', projectId: p.id })}
              >
                <span className="recent-name">{p.name}</span>
                {p.hasGit && <Badge tone={stateTone(p.dirtyCount > 0 ? 'dirty' : 'clean')}>{p.dirtyCount > 0 ? `有改动 ×${p.dirtyCount}` : '干净'}</Badge>}
                <span className="recent-time" title="近期活动（取最近打开，缺省回落到最近更新）">
                  {relativeTime(p.lastOpenedAt)}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="panel">
          <h3 className="panel-title">警告</h3>
          {s.warnings.length === 0 ? (
            <div className="inline-note">暂无警告。</div>
          ) : (
            s.warnings.map((w, i) => (
              <div key={`${w.title}-${i}`} className={`warn-item ${severityClass(w.severity)}`}>
                <span className="warn-icon" aria-hidden>
                  {severityGlyph(w.severity)}
                </span>
                <span>
                  <span className="warn-title">{w.title}</span>
                  {w.detail !== undefined && (
                    <>
                      <br />
                      {/* F4：默认折两行，Show more 展开全文（不再只能看到悬垂的 …） */}
                      <ExpandableText text={w.detail} className="warn-detail" />
                    </>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  )
}

function ViewHeader({ onRefresh }: { onRefresh?: () => void }) {
  return (
    <header className="view-header">
      <div>
        <h2 className="view-title">仪表盘</h2>
        <p className="view-sub">项目、WSL、Docker 与服务一览</p>
      </div>
      <div className="view-actions">
        {onRefresh !== undefined && (
          <button type="button" className="btn" onClick={onRefresh}>
            刷新
          </button>
        )}
      </div>
    </header>
  )
}
