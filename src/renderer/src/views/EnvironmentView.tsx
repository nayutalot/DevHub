/**
 * views/EnvironmentView.tsx — 环境对比 + Doctor + WSL 监控（docs/06 §3.3，docs/01 §2.3；
 * S4 扩展 docs/09 §8.2）。
 *
 * 数据源：environment:detect（耗时数秒 → loading 态显著）+ environment:doctor
 * + wsl:distroStats（发行版概要卡片：state/版本 + uptime/mem 系统概要，探测不到隐藏不猜）。
 * 表：行 = 工具名，列 = Windows 与每个 WSL 发行版（跳过 docker-desktop*），
 * 格 = 版本（missing 灰显 / error 红；path 进 tooltip）；列底可折叠 PATH 明细。
 * Docker 状态卡：CLI ✓/✗（按环境）+ daemon ✓/✗（来自 doctor 诊断，不可用时给
 * reason 摘要 + warning 徽章）。WSL 无发行版时显示 DEGRADED 结构化横幅（约束 #26）。
 * WSL 动作：Boot（无害幂等，直接执行）/ Terminate（CONFIRM_REQUIRED 两段式，impacts
 * 列出该发行版监听端口）。
 */

import { useState } from 'react'
import { Badge, type BadgeTone, stateTone } from '../components/Badge.tsx'
import { ExpandableText } from '../components/ExpandableText.tsx'
import { EmptyState, ErrorState, Loading, Spinner, Toast, useToast } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { normalizeSeverity, oneLine, severityClass, severityGlyph } from '../lib/format.ts'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type { DoctorCheck, EnvironmentToolInfo, EnvironmentWithTools, WslDistroStats } from '../../../shared/types.ts'

/** docker-desktop / docker-desktop-data 是 Docker Desktop 内部发行版，不参与对比。 */
function isDockerDesktopEnv(env: EnvironmentWithTools): boolean {
  return env.kind === 'wsl' && /^wsl:docker-desktop/i.test(env.name)
}

/**
 * F7：列头/标签展示名统一大小写风格（DB 内部名保持 'windows' / 'wsl:Ubuntu' 不变，
 * 仅在 UI 投影为 'Windows' / 'WSL · Ubuntu'，与全 UI Title-case 规范一致）。
 */
function envDisplayName(name: string): string {
  if (name === 'windows') return 'Windows'
  const m = name.match(/^wsl:(.+)$/)
  return m !== null ? `WSL · ${m[1]}` : name
}

function severityBadgeTone(sev: string | undefined): BadgeTone {
  switch (normalizeSeverity(sev)) {
    case 'error':
      return 'err'
    case 'warning':
      return 'warn'
    case 'info':
      return 'accent'
  }
}

export function EnvironmentView() {
  const { refreshKey } = useApp()
  const detect = useAsync(() => call('environment:detect', {}), [refreshKey])
  const doctor = useAsync(() => call('environment:doctor', {}), [refreshKey])

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h2 className="view-title">Environment</h2>
          <p className="view-sub">Windows vs WSL toolchains, with doctor diagnostics</p>
        </div>
        <div className="view-actions">
          <button
            type="button"
            className="btn"
            disabled={detect.loading}
            onClick={() => {
              detect.refresh()
              doctor.refresh()
            }}
          >
            {detect.loading && <Spinner />} Re-detect
          </button>
        </div>
      </header>

      {detect.loading ? (
        <Loading label="Detecting toolchains (Windows + WSL) — this can take a few seconds…" />
      ) : detect.error !== null ? (
        <ErrorState error={detect.error} onRetry={detect.refresh} />
      ) : detect.data === null ? null : (
        <DetectPanels
          envs={detect.data.environments.filter((e) => !isDockerDesktopEnv(e))}
          checks={doctor.data?.checks ?? null}
        />
      )}

      <WslDistroCards />

      <h3 className="panel-title" style={{ marginTop: 18 }}>
        Doctor
      </h3>
      {doctor.loading ? (
        <Loading label="Running doctor checks…" />
      ) : doctor.error !== null ? (
        <ErrorState error={doctor.error} onRetry={doctor.refresh} />
      ) : doctor.data === null || doctor.data.checks.length === 0 ? (
        <EmptyState title="No doctor findings" hint="environment:doctor reported no diagnostics." />
      ) : (
        doctor.data.checks.map((c) => (
          <div key={c.id} className={`diag-card ${severityClass(c.severity)}`}>
            <div className="diag-head">
              <span className="diag-sev" aria-hidden>
                {severityGlyph(c.severity)}
              </span>
              <span className="diag-title">{c.title}</span>
              <Badge tone={severityBadgeTone(c.severity)}>{c.severity}</Badge>
            </div>
            {c.detail !== undefined && (
              <ExpandableText text={c.detail} className="diag-detail" />
            )}
            {c.suggestion !== undefined && <div className="diag-suggestion">{c.suggestion}</div>}
          </div>
        ))
      )}
    </section>
  )
}

function DetectPanels({ envs, checks }: { envs: EnvironmentWithTools[]; checks: DoctorCheck[] | null }) {
  const windows = envs.filter((e) => e.kind === 'windows')
  const wslEnvs = envs.filter((e) => e.kind === 'wsl')

  // 行 = 全环境工具名并集（按列出现顺序优先，稳定排序）
  const toolNames: string[] = []
  const seen = new Set<string>()
  for (const env of [...windows, ...wslEnvs]) {
    for (const t of env.tools) {
      if (!seen.has(t.tool)) {
        seen.add(t.tool)
        toolNames.push(t.tool)
      }
    }
  }
  const byTool = new Map<string, Map<string, EnvironmentToolInfo[]>>()
  for (const name of toolNames) byTool.set(name, new Map())
  for (const env of envs) {
    for (const t of env.tools) {
      const row = byTool.get(t.tool)
      if (row === undefined) continue
      const cell = row.get(env.name)
      if (cell === undefined) row.set(env.name, [t])
      else cell.push(t)
    }
  }

  return (
    <>
      {wslEnvs.length === 0 && (
        <div className="degraded-banner">DEGRADED: no WSL distribution detected — WSL columns unavailable</div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Tool</th>
              {[...windows, ...wslEnvs].map((e) => (
              <th key={e.id} title={e.osVersion}>
                {envDisplayName(e.name)}
              </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {toolNames.map((name) => (
              <tr key={name}>
                <td className="td-mono">{name}</td>
                {[...windows, ...wslEnvs].map((env) => (
                  <ToolCell key={env.id} entries={byTool.get(name)?.get(env.name) ?? []} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="path-details">
        <summary>Executable paths</summary>
        {envs.map((env) => (
          <div key={env.id}>
            <strong>{envDisplayName(env.name)}</strong>
            {env.tools
              .filter((t) => t.path !== undefined)
              .map((t) => (
                <div key={`${t.tool}-${t.path ?? ''}`} className="path-line">
                  {t.tool} — {t.path}
                </div>
              ))}
          </div>
        ))}
      </details>

      <DockerCard envs={envs} checks={checks} />
    </>
  )
}

function ToolCell({ entries }: { entries: EnvironmentToolInfo[] }) {
  if (entries.length === 0) {
    return (
      <td className="td-dim cell-missing" title="not probed in this environment">
        —
      </td>
    )
  }
  return (
    <td>
      {entries.map((t, i) => {
        if (t.state === 'installed' && t.version !== undefined) {
          return (
            <div
              key={i}
              className="env-cell-entry"
              title={t.path !== undefined ? `${t.path}${t.rawVersion !== undefined ? `\nraw: ${oneLine(t.rawVersion)}` : ''}` : undefined}
            >
              {t.version}
            </div>
          )
        }
        if (t.state === 'error') {
          return (
            <div key={i} className="env-cell-entry cell-error" title={t.path ?? undefined}>
              probe error
            </div>
          )
        }
        return (
          <div key={i} className="env-cell-entry cell-missing" title={t.path ?? undefined}>
            missing
          </div>
        )
      })}
    </td>
  )
}

/**
 * Docker 状态卡：CLI ✓/✗ 按环境（工具链 state），daemon ✓/✗ 取自 doctor 的
 * docker/daemon 相关诊断（携带 reason 摘要 + severity 徽章）。全部真实数据。
 */
function DockerCard({ envs, checks }: { envs: EnvironmentWithTools[]; checks: DoctorCheck[] | null }) {
  const dockerTools = envs.flatMap((env) =>
    env.tools.filter((t) => t.tool === 'docker').map((t) => ({ env: env.name, tool: t })),
  )
  const daemonCheck =
    checks?.find((c) => /docker/i.test(c.title) && /daemon/i.test(`${c.title} ${c.detail ?? ''}`)) ??
    checks?.find((c) => /daemon/i.test(`${c.title} ${c.detail ?? ''}`)) ??
    null

  return (
    <div className="section">
      <h3 className="section-title">Docker</h3>
      {dockerTools.length === 0 ? (
        <div className="inline-note">docker tool not probed in any environment</div>
      ) : (
        dockerTools.map(({ env, tool }) => (
          <div key={env} className="repo-line">
            <span className="mono dim">{envDisplayName(env)}</span>
            <span>
              CLI {tool.state === 'installed' ? '✓' : '✗'}
            </span>
            <Badge tone={stateTone(tool.state)}>{tool.version ?? tool.state}</Badge>
          </div>
        ))
      )}
      <div className="repo-line" style={{ marginTop: 6 }}>
        <span className="mono dim">daemon</span>
        {daemonCheck !== null ? (
          <>
            <Badge tone={severityBadgeTone(daemonCheck.severity)}>{daemonCheck.severity}</Badge>
            {/* F4：daemon 不可达的 reason 通常很长，默认折 1 行，可展开看全文 */}
            <ExpandableText
              text={daemonCheck.detail !== undefined ? daemonCheck.detail : daemonCheck.title}
              className="repo-meta"
              collapsedLines={1}
            />
          </>
        ) : (
          <span className="repo-meta">{checks === null ? 'waiting for doctor…' : 'no daemon diagnostic reported (assumed reachable)'}</span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// WSL 发行版卡片（S4，docs/09 §8.2「Environment 视图 WSL 监控区」）
// ---------------------------------------------------------------------------

/** 秒 → 人类可读 uptime（探测不到的字段根本不渲染，绝不显示占位猜测值）。 */
function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`
  const days = Math.floor(sec / 86400)
  const hours = Math.floor((sec % 86400) / 3600)
  const minutes = Math.floor((sec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const KB_PER_GB = 1024 * 1024

/** meminfo KB → 「used / total GB (pct%)」；avail 缺失时只报 total。 */
function formatMem(stats: WslDistroStats): string {
  const totalKb = stats.memTotalKb
  if (totalKb === null) return '—'
  const totalGb = totalKb / KB_PER_GB
  if (stats.memAvailKb !== null) {
    const usedGb = Math.max(0, (totalKb - stats.memAvailKb) / KB_PER_GB)
    const pct = totalGb > 0 ? Math.round((usedGb / totalGb) * 100) : 0
    return `${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} GB (${pct}%)`
  }
  return `${totalGb.toFixed(1)} GB total`
}

/**
 * WSL 发行版卡片：state 徽章 + 版本 + 系统概要（uptime/mem，stats=null 时隐藏不猜）+
 * Boot（无害直接执行）/ Terminate（两段式，impacts 列监听端口）。docker-desktop 系
 * 由 Docker Desktop 管理：只显示状态，不给动作按钮。
 */
function WslDistroCards() {
  const { refreshKey } = useApp()
  const stats = useAsync(() => call('wsl:distroStats', {}), [refreshKey])
  const { toast, show } = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  async function terminate(distro: string): Promise<void> {
    setBusy(distro)
    try {
      // 第一段：confirmRequired + impacts（该发行版当前监听端口）
      const first = await call('wsl:action', { distro, action: 'terminate' })
      if (first.confirmRequired === true) {
        const imp = first.impacts
        const ports = imp.listeningPorts
          .map((p) => `${p.port}${p.processName !== null ? ` (${p.processName})` : ''}`)
          .join(', ')
        const lines = [`Terminate WSL distro "${imp.distro}"?`, `state: ${imp.state}`, `listening ports: ${ports || '—'}`]
        if (imp.note !== undefined) lines.push(imp.note)
        if (window.confirm(lines.join('\n'))) {
          const done = await call('wsl:action', { distro, action: 'terminate', confirmed: true })
          if (done.confirmRequired === true) return
          if (done.ok) {
            show(`${done.distro}: terminated${done.detail !== undefined ? ` — ${done.detail}` : ''}`)
            stats.refresh()
          } else {
            show(`${done.distro}: terminate failed — ${done.error ?? 'unknown error'}`, 'err')
          }
        }
        return
      }
      show(`${first.distro}: terminated`)
      stats.refresh()
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  async function boot(distro: string): Promise<void> {
    setBusy(distro)
    try {
      const done = await call('wsl:action', { distro, action: 'boot' })
      if (done.confirmRequired === true) return
      if (done.ok) {
        show(`${done.distro}: running`)
        stats.refresh()
      } else {
        show(`${done.distro}: boot failed — ${done.error ?? 'unknown error'}`, 'err')
      }
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="section">
      <h3 className="section-title">WSL distributions</h3>
      {stats.loading ? (
        <Loading label="Probing WSL distributions (no stopped distro is started)…" />
      ) : stats.error !== null ? (
        <ErrorState error={stats.error} onRetry={stats.refresh} />
      ) : stats.data === null ? null : stats.data.available === false ? (
        <div className="degraded-banner">DEGRADED: WSL unavailable — {stats.data.reason ?? 'unknown reason'}</div>
      ) : stats.data.distros.length === 0 ? (
        <EmptyState title="No WSL distribution" hint="wsl.exe -l -v returned no distributions." />
      ) : (
        <div className="agent-grid">
          {stats.data.distros.map((d) => {
            const running = d.state.toLowerCase() === 'running'
            const summary =
              d.stats !== null && d.stats.uptimeSec !== null
                ? `uptime ${formatUptime(d.stats.uptimeSec)} · mem ${formatMem(d.stats)}`
                : null
            return (
              <div key={d.name} className="agent-card">
                <div className="agent-card-head">
                  <span className="agent-name mono">{d.name}</span>
                  <Badge tone={stateTone(running ? 'running' : d.state)}>{d.state}</Badge>
                  {d.isDefault === true && <Badge tone="accent">default</Badge>}
                </div>
                <div className="agent-dir mono dim">WSL {d.version}</div>
                {d.managedByDocker === true ? (
                  <div className="agent-counts dim">managed by Docker Desktop — status only</div>
                ) : (
                  <>
                    {summary !== null ? <div className="agent-counts mono">{summary}</div> : null}
                    {d.stats === null && d.reason !== undefined ? <div className="agent-counts dim">{d.reason}</div> : null}
                    <div className="action-cell">
                      {running ? (
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          disabled={busy !== null}
                          title={`terminate ${d.name} (asks for confirmation with listening ports)`}
                          onClick={() => {
                            void terminate(d.name)
                          }}
                        >
                          {busy === d.name ? <Spinner /> : null}
                          Terminate
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={busy !== null}
                          title={`boot ${d.name} (harmless, idempotent)`}
                          onClick={() => {
                            void boot(d.name)
                          }}
                        >
                          {busy === d.name ? <Spinner /> : null}
                          Boot
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
      <Toast toast={toast} />
    </div>
  )
}
