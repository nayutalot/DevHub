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
import {EmptyState, ErrorState, Loading, Spinner,} from '../components/StateViews.tsx'
import { useToast } from '../components/ToastProvider.tsx'
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

/** docker 动作名 → 用户面动词（契约值保留在 payload，仅展示层投影）。 */
const ACTION_LABEL: Record<DockerActionName, string> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
  remove: '删除',
}

function formatPorts(ports: ContainerPortMapping[]): string {
  return ports.map((p) => `${p.host}->${p.container}/${p.proto}`).join(', ')
}

export function DockerView() {
  const { refreshKey } = useApp()
  const overview = useAsync(() => call('docker:overview', {}), [refreshKey])
  const { show } = useToast()

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
        show(`${first.name}：${ACTION_LABEL[first.action]}成功`)
        overview.refresh()
      } else {
        show(`${first.name}：${ACTION_LABEL[first.action]}失败 — ${first.error ?? '原因未知'}`, 'err')
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
        show(`${done.name}：${done.action === 'remove' ? '已删除' : `${ACTION_LABEL[done.action]}成功`}${done.detail !== undefined ? ` — ${done.detail}` : ''}`)
        overview.refresh()
      } else {
        show(`${done.name}：${ACTION_LABEL[done.action]}失败 — ${done.error ?? '原因未知'}`, 'err')
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
      show('已取消删除 — 名称不匹配', 'err')
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
          <p className="view-sub">容器、镜像与引擎状态 — daemon 不可达属正常态</p>
        </div>
        <div className="view-actions">
          <button type="button" className="btn" disabled={overview.loading} onClick={overview.refresh}>
            {overview.loading && <Spinner />} 刷新
          </button>
        </div>
      </header>

      {overview.loading ? (
        <Loading label="正在探测 Docker CLI 与 daemon…" />
      ) : overview.error !== null ? (
        <ErrorState error={overview.error} onRetry={overview.refresh} />
      ) : data === null ? null : (
        <>
          <DaemonBanner status={data.status} />

          {daemonUp ? (
            <>
              <h3 className="panel-title">容器</h3>
              {data.containers.length === 0 ? (
                <div className="panel">
                  <EmptyState title="没有容器" hint="docker ps -a 未返回任何行。" />
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>镜像</th>
                        <th>状态</th>
                        <th>端口</th>
                        <th>项目</th>
                        <th>操作</th>
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
                            <Badge tone={stateTone(c.state)}>{c.state ?? '未知'}</Badge>
                          </td>
                          <td className="td-mono td-dim">{c.ports.length > 0 ? formatPorts(c.ports) : '—'}</td>
                          <td>
                            {c.project === 'unknown' ? <span className="td-dim">未知</span> : <span className="mono">{c.project}</span>}
                          </td>
                          <td>
                            <div className="action-cell">
                              {(['start', 'stop', 'restart'] as const).map((action) => (
                                <button
                                  key={action}
                                  type="button"
                                  className={`btn btn-small${action === 'stop' ? ' btn-danger' : ''}`}
                                  disabled={busy !== null}
                                  title={`${ACTION_LABEL[action]} ${c.name}（需确认）`}
                                  onClick={() => {
                                    void runAction(c.name, action)
                                  }}
                                >
                                  {busy === `${c.name}:${action}` ? <Spinner /> : null}
                                  {ACTION_LABEL[action]}
                                </button>
                              ))}
                              <button
                                type="button"
                                className="btn btn-small btn-danger"
                                disabled={busy !== null}
                                title={`删除 ${c.name}（双重确认：输入容器名）`}
                                onClick={() => {
                                  void runAction(c.name, 'remove')
                                }}
                              >
                                {busy === `${c.name}:remove` ? <Spinner /> : null}
                                删除
                              </button>
                              <button
                                type="button"
                                className="btn btn-small"
                                disabled={busy !== null}
                                title={`${c.name} 的日志`}
                                onClick={() => setLogsName((cur) => (cur === c.name ? null : c.name))}
                              >
                                日志
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
                镜像{data.images.available ? ` — 共 ${data.images.count}（悬空 ${data.images.danglingCount}）` : ''}
              </h3>
              {!data.images.available ? (
                <div className="degraded-banner">降级：镜像列表不可用 — {data.images.reason ?? '原因未知'}</div>
              ) : data.images.images.length === 0 ? (
                <div className="panel">
                  <EmptyState title="没有镜像" hint="docker images 未返回任何行。" />
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>仓库</th>
                        <th>标签</th>
                        <th>ID</th>
                        <th>大小</th>
                        <th>创建时间</th>
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
                title="Docker daemon 不可达"
                hint="引擎未运行期间容器与镜像不可用。结构化原因见上方横幅；启动 Docker Desktop 后点击「刷新」。"
                action={{ label: '刷新', onClick: overview.refresh }}
              />
            </div>
          )}
        </>
      )}

      {removeConfirm !== null && (
        <div className="cp-modal-overlay" role="dialog" aria-modal="true">
          <div className="cp-modal">
            <h3 className="section-title">确认删除容器「{removeConfirm.name}」？</h3>
            <pre className="mono docker-confirm-impacts">{buildConfirmText('remove', removeConfirm)}</pre>
            <label className="docker-confirm-input-label">
              输入容器名以确认删除（不匹配或留空 = 不删除）：
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
                title="删除容器（输入名称精确匹配后才可点）"
                onClick={() => {
                  void confirmRemove()
                }}
              >
                删除
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setRemoveConfirm(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

    </section>
  )
}

/** daemon 状态横幅：online → 轻量信息行；down → 降级横幅 + reason 可展开（约束 #26）。 */
function DaemonBanner({ status }: { status: { available: boolean; clientVersion?: string; serverVersion?: string; reason?: string } }) {
  if (status.available) {
    return (
      <div className="inline-note docker-online">
        daemon 在线 · client {status.clientVersion ?? '?'} · server {status.serverVersion ?? '?'}
      </div>
    )
  }
  return (
    <div className="degraded-banner">
      Docker：daemon 不可达（引擎未运行）{' — '}
      {status.reason !== undefined && status.reason.length > 0 ? (
        <ExpandableText text={status.reason} className="repo-meta" collapsedLines={1} />
      ) : (
        '原因未知'
      )}
    </div>
  )
}

function buildConfirmText(action: DockerActionName, impacts: DockerActionImpacts): string {
  const ports = impacts.ports.length > 0 ? formatPorts(impacts.ports) : '—'
  const lines =
    action === 'remove'
      ? [
          `确认删除容器「${impacts.name}」？`,
          `镜像：${impacts.image ?? '—'} · 状态：${impacts.state ?? '?'} · 项目：${impacts.project ?? '未知'}`,
        ]
      : [
          `确认对容器「${impacts.name}」执行「${ACTION_LABEL[action]}」？`,
          `镜像：${impacts.image ?? '—'} · 状态：${impacts.state ?? '?'} · 项目：${impacts.project ?? '未知'}`,
          `发布端口：${ports}`,
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
        <span className="mono">日志 · {name}</span>
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
          {logs.loading && <Spinner />} 重新加载
        </button>
        <button type="button" className="btn btn-small" onClick={onClose}>
          关闭
        </button>
      </div>
      {logs.loading ? (
        <Loading label={`正在拉取日志（tail ${tail}）…`} />
      ) : logs.error !== null ? (
        <ErrorState error={logs.error} onRetry={logs.refresh} />
      ) : logs.data === null ? null : logs.data.ok === false ? (
        <div className="inline-note">日志不可用 — {logs.data.error ?? '原因未知'}</div>
      ) : (
        <>
          {logs.data.truncated === true && (
            <div className="inline-note">输出已截断至 64KB — 可调低 tail 或用 --since 查看更多</div>
          )}
          <pre className="logs-text mono">{logs.data.text.length > 0 ? logs.data.text : '（该 tail 范围内无日志输出）'}</pre>
        </>
      )}
    </div>
  )
}
