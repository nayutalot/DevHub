/**
 * views/DockerView.tsx — Docker 页（docs/09 §8.1 Portainer 风格；docs/06 §3.5）。
 *
 * 数据源：docker:overview（info + containers + images 单次探测三合一）。
 * daemon 不可用是常态而非异常：横幅展示结构化 reason（可展开）+ 降级文案，
 * 容器/镜像区显示引导空态，绝不白屏（约束 #26）。
 * 动作：每行 Start/Stop/Restart（CONFIRM_REQUIRED 两段式 —— 第一段返回 impacts
 * （容器现状/发布端口/关联项目）经确认弹窗展示，确认后 confirmed 重发）+ Remove
 * （DOUBLE_CONFIRM：服务端两段式之上，确认弹窗要求输入容器名精确匹配，docs/09 §8.1）+
 * Logs（内联日志面板，tail 100/200/500 可选，>64KB 提示截断）。三态强制（约束 #24）。
 */

import { useState } from 'react'
import { Badge, stateTone } from '../components/Badge.tsx'
import { ExpandableText } from '../components/ExpandableText.tsx'
import { EmptyState, ErrorState, Loading, Spinner, Toast, useToast } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type {
  ContainerPortMapping,
  DockerActionImpacts,
  DockerActionName,
  DockerLogsResult,
} from '../../../shared/types.ts'

const LOG_TAIL_OPTIONS = [100, 200, 500] as const

function formatPorts(ports: ContainerPortMapping[]): string {
  return ports.map((p) => `${p.host}->${p.container}/${p.proto}`).join(', ')
}

export function DockerView() {
  const { refreshKey } = useApp()
  const overview = useAsync(() => call('docker:overview', {}), [refreshKey])
  const { toast, show } = useToast()

  /** 当前展开日志面板的容器名（null = 关闭）。 */
  const [logsName, setLogsName] = useState<string | null>(null)
  const [logTail, setLogTail] = useState<number>(200)
  /** 正在执行动作的容器（禁用该行按钮，防重复点击）。 */
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * Remove 两段式第二段的应用内确认 modal（AUDIT D-Aud I1：window.prompt 在
   * Electron 必抛 → 改 cp-modal 式确认流，输入匹配语义不变 —— 与 Archive
   * DOUBLE_CONFIRM / ContestDetailView 删除确认同形态）。
   */
  const [removeConfirm, setRemoveConfirm] = useState<DockerActionImpacts | null>(null)
  const [removeInput, setRemoveInput] = useState('')

  async function runAction(name: string, action: DockerActionName): Promise<void> {
    setBusy(`${name}:${action}`)
    try {
      // 第一段：confirmRequired + impacts（容器现状/发布端口/关联项目；remove 另带
      // 数据面影响 note —— docs/09 §8.3 DOUBLE_CONFIRM 档，夜间#1 批次落地）
      const first = await call('docker:action', { name, action })
      if (first.confirmRequired === true) {
        if (action === 'remove') {
          // DOUBLE_CONFIRM：改应用内 modal 输入容器名匹配（docs/09 §8.1「输入容器名
          // 匹配」），不匹配 / 取消 → 绝不发 confirmed（原 window.prompt 在 Electron 必抛）
          setRemoveInput('')
          setRemoveConfirm(first.impacts)
          return
        }
        if (!window.confirm(buildConfirmText(action, first.impacts))) {
          return
        }
        await executeConfirmed(name, action)
        return
      }
      if (first.ok) {
        show(`${first.name}: ${first.action} ok`)
        overview.refresh()
      } else {
        show(`${first.name}: ${first.action} failed — ${first.error ?? 'unknown error'}`, 'err')
      }
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  /** 第二段：confirmed 重发（start/stop/restart 的 window.confirm 与 remove modal 通过后共用）。 */
  async function executeConfirmed(name: string, action: DockerActionName): Promise<void> {
    setBusy(`${name}:${action}`)
    try {
      const done = await call('docker:action', { name, action, confirmed: true })
      if (done.confirmRequired === true) return
      if (done.ok) {
        show(`${done.name}: ${done.action === 'remove' ? 'removed' : `${done.action}ed`}${done.detail !== undefined ? ` — ${done.detail}` : ''}`)
        overview.refresh()
      } else {
        show(`${done.name}: ${done.action} failed — ${done.error ?? 'unknown error'}`, 'err')
      }
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setBusy(null)
    }
  }

  /** remove modal 确认：输入精确匹配（trim 容差同原 prompt 语义）才发 confirmed。 */
  async function confirmRemove(): Promise<void> {
    if (removeConfirm === null) return
    if (removeInput.trim() !== removeConfirm.name) {
      show('remove cancelled — name did not match', 'err')
      return
    }
    const name = removeConfirm.name
    setRemoveConfirm(null)
    await executeConfirmed(name, 'remove')
  }

  const data = overview.data
  const daemonUp = data !== null && data.status.available === true

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h2 className="view-title">Docker</h2>
          <p className="view-sub">Containers, images and engine status — daemon unreachable is a normal state</p>
        </div>
        <div className="view-actions">
          <button type="button" className="btn" disabled={overview.loading} onClick={overview.refresh}>
            {overview.loading && <Spinner />} Refresh
          </button>
        </div>
      </header>

      {overview.loading ? (
        <Loading label="Probing Docker CLI and daemon…" />
      ) : overview.error !== null ? (
        <ErrorState error={overview.error} onRetry={overview.refresh} />
      ) : data === null ? null : (
        <>
          <DaemonBanner status={data.status} />

          {daemonUp ? (
            <>
              <h3 className="panel-title">Containers</h3>
              {data.containers.length === 0 ? (
                <div className="panel">
                  <EmptyState title="No containers" hint="docker ps -a returned no rows." />
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Image</th>
                        <th>State</th>
                        <th>Ports</th>
                        <th>Project</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.containers.map((c) => (
                        <tr key={c.dockerId}>
                          <td className="td-mono" title={c.dockerId}>
                            {c.name}
                          </td>
                          <td className="td-mono td-dim" title={c.image}>
                            {c.image ?? '—'}
                          </td>
                          <td>
                            <Badge tone={stateTone(c.state)}>{c.state ?? 'unknown'}</Badge>
                          </td>
                          <td className="td-mono td-dim">{c.ports.length > 0 ? formatPorts(c.ports) : '—'}</td>
                          <td>
                            {c.project === 'unknown' ? <span className="td-dim">unknown</span> : <span className="mono">{c.project}</span>}
                          </td>
                          <td>
                            <div className="action-cell">
                              {(['start', 'stop', 'restart'] as const).map((action) => (
                                <button
                                  key={action}
                                  type="button"
                                  className={`btn btn-small${action === 'stop' ? ' btn-danger' : ''}`}
                                  disabled={busy !== null}
                                  title={`${action} ${c.name} (asks for confirmation)`}
                                  onClick={() => {
                                    void runAction(c.name, action)
                                  }}
                                >
                                  {busy === `${c.name}:${action}` ? <Spinner /> : null}
                                  {action}
                                </button>
                              ))}
                              <button
                                type="button"
                                className="btn btn-small btn-danger"
                                disabled={busy !== null}
                                title={`remove ${c.name} (double confirm: type the container name)`}
                                onClick={() => {
                                  void runAction(c.name, 'remove')
                                }}
                              >
                                {busy === `${c.name}:remove` ? <Spinner /> : null}
                                remove
                              </button>
                              <button
                                type="button"
                                className="btn btn-small"
                                disabled={busy !== null}
                                title={`logs of ${c.name}`}
                                onClick={() => setLogsName((cur) => (cur === c.name ? null : c.name))}
                              >
                                logs
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {logsName !== null && (
                <LogsPanel
                  name={logsName}
                  tail={logTail}
                  onTail={(tail) => setLogTail(tail)}
                  onClose={() => setLogsName(null)}
                  onError={(message) => show(message, 'err')}
                />
              )}

              <h3 className="panel-title">
                Images{data.images.available ? ` — ${data.images.count} (dangling ${data.images.danglingCount})` : ''}
              </h3>
              {!data.images.available ? (
                <div className="degraded-banner">DEGRADED: image list unavailable — {data.images.reason ?? 'unknown reason'}</div>
              ) : data.images.images.length === 0 ? (
                <div className="panel">
                  <EmptyState title="No images" hint="docker images returned no rows." />
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Repository</th>
                        <th>Tag</th>
                        <th>ID</th>
                        <th>Size</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.images.images.map((img) => (
                        <tr key={`${img.repository}:${img.tag}:${img.imageId}`}>
                          <td className="td-mono">{img.repository}</td>
                          <td className="td-mono">{img.tag}</td>
                          <td className="td-mono td-dim" title={img.imageId}>
                            {img.imageId.slice(0, 12)}
                          </td>
                          <td className="td-mono td-dim">{img.size || '—'}</td>
                          <td className="td-dim">{img.createdAt || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className="panel">
              <EmptyState
                title="Docker daemon unreachable"
                hint="Containers and images stay unavailable until the engine runs. The structured reason is in the banner above; start Docker Desktop, then hit Refresh."
                action={{ label: 'Refresh', onClick: overview.refresh }}
              />
            </div>
          )}
        </>
      )}

      {removeConfirm !== null && (
        <div className="cp-modal-overlay" role="dialog" aria-modal="true">
          <div className="cp-modal">
            <h3 className="section-title">Confirm REMOVE of container &quot;{removeConfirm.name}&quot;?</h3>
            <pre className="mono docker-confirm-impacts">{buildConfirmText('remove', removeConfirm)}</pre>
            <label className="docker-confirm-input-label">
              Type the container name to confirm removal (mismatch or empty = no removal):
              <input
                type="text"
                className="input mono"
                value={removeInput}
                placeholder={removeConfirm.name}
                autoFocus
                onChange={(e) => setRemoveInput(e.target.value)}
              />
            </label>
            <div className="form-row">
              <button
                type="button"
                className="btn btn-danger"
                disabled={removeInput.trim() !== removeConfirm.name}
                title="Remove container (enabled only when the typed name matches exactly)"
                onClick={() => {
                  void confirmRemove()
                }}
              >
                Remove
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setRemoveConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </section>
  )
}

/** daemon 状态横幅：online → 轻量信息行；down → 降级横幅 + reason 可展开（约束 #26）。 */
function DaemonBanner({ status }: { status: { available: boolean; clientVersion?: string; serverVersion?: string; reason?: string } }) {
  if (status.available) {
    return (
      <div className="inline-note docker-online">
        daemon online · client {status.clientVersion ?? '?'} · server {status.serverVersion ?? '?'}
      </div>
    )
  }
  return (
    <div className="degraded-banner">
      Docker: daemon unreachable (engine-down){' — '}
      {status.reason !== undefined && status.reason.length > 0 ? (
        <ExpandableText text={status.reason} className="repo-meta" collapsedLines={1} />
      ) : (
        'unknown reason'
      )}
    </div>
  )
}

function buildConfirmText(action: DockerActionName, impacts: DockerActionImpacts): string {
  const ports = impacts.ports.length > 0 ? formatPorts(impacts.ports) : '—'
  const lines =
    action === 'remove'
      ? [
          `Confirm REMOVE of container "${impacts.name}"?`,
          `image: ${impacts.image ?? '—'} · state: ${impacts.state ?? '?'} · project: ${impacts.project ?? 'unknown'}`,
        ]
      : [
          `Confirm "${action}" on container "${impacts.name}"?`,
          `image: ${impacts.image ?? '—'} · state: ${impacts.state ?? '?'} · project: ${impacts.project ?? 'unknown'}`,
          `published ports: ${ports}`,
        ]
  if (impacts.note !== undefined) lines.push(impacts.note)
  return lines.join('\n')
}

/** 内联日志面板：tail 选择 + 只读拉取（ok:false / truncated 均结构化提示，不猜）。 */
function LogsPanel({
  name,
  tail,
  onTail,
  onClose,
  onError,
}: {
  name: string
  tail: number
  onTail: (tail: number) => void
  onClose: () => void
  onError: (message: string) => void
}) {
  const logs = useAsync<DockerLogsResult>(async () => {
    try {
      return await call('docker:logs', { name, tail })
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }, [name, tail])

  return (
    <div className="panel logs-panel">
      <div className="repo-line">
        <span className="mono">logs · {name}</span>
        <label className="logs-tail-label">
          tail{' '}
          <select value={tail} onChange={(e) => onTail(Number(e.target.value))}>
            {LOG_TAIL_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-small" disabled={logs.loading} onClick={logs.refresh}>
          {logs.loading && <Spinner />} Reload
        </button>
        <button type="button" className="btn btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      {logs.loading ? (
        <Loading label={`Fetching logs (tail ${tail})…`} />
      ) : logs.error !== null ? (
        <ErrorState error={logs.error} onRetry={logs.refresh} />
      ) : logs.data === null ? null : logs.data.ok === false ? (
        <div className="inline-note">logs unavailable — {logs.data.error ?? 'unknown error'}</div>
      ) : (
        <>
          {logs.data.truncated === true && (
            <div className="inline-note">output truncated to 64KB — lower the tail or use --since to see more</div>
          )}
          <pre className="logs-text mono">{logs.data.text.length > 0 ? logs.data.text : '(no log output for this tail)'}</pre>
        </>
      )}
    </div>
  )
}
