/**
 * views/SkillsView.tsx — Skills 管理视图（S2 批次，docs/09 §9 / docs/06 深色令牌）。
 *
 * 布局：vault 概览条（路径 / 健康态 / skill 数 / 上次同步时间 / Scan·Doctor·Sync·
 * Companion 动作）→ agent 卡片区（名称/平台/目录/链接统计 + doctor 徽章）→
 * skill 列表（名称/描述/各 agent 链接态矩阵，单元格点击 toggle；real-dir 禁用并提示）
 * → 操作反馈区（Doctor/Import/Sync/Repair 步骤日志与冲突）。导入走确认对话框：
 * 选源目录 → 预览 plan（SKILL.md frontmatter）→ 勾选目标 agent → 确认执行
 * （CONFIRM_REQUIRED 语义，docs/09 §8.3）。
 *
 * 无 mock：全部数据来自真实 IPC（skills:* channels）；三态用 StateViews；
 * toast 沿用 useToast。
 */

import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Badge } from '../components/Badge.tsx'
import type { BadgeTone } from '../components/Badge.tsx'
import { EmptyState, ErrorState, Loading, Toast, useToast } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { relativeTime } from '../lib/format.ts'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type {
  LinkState,
  SkillAgentScanView,
  SkillDoctorItem,
  SkillImportPlan,
  SkillRow,
  SkillSyncStep,
  SkillsImportResult,
  SkillsSyncResult,
} from '../../../shared/types.ts'

/** 五态 → 徽章 tone（三态之外颜色可分辨；矩阵单元格配色由 CSS 类承担）。 */
function linkTone(state: LinkState): BadgeTone {
  switch (state) {
    case 'linked':
      return 'ok'
    case 'missing':
      return 'dim'
    case 'wrong-target':
    case 'real-dir':
      return 'warn'
    case 'vault-missing':
      return 'err'
  }
}

const LINK_LABEL: Record<LinkState, string> = {
  linked: '已链接',
  missing: '未链接',
  'wrong-target': '目标错误',
  'real-dir': '真实目录',
  'vault-missing': 'vault 缺失',
}

interface LoadData {
  agents: SkillAgentScanView[]
  skills: SkillRow[]
  vaultPath: string
  lastSyncAt: number | undefined
}

export function SkillsView() {
  const { refreshKey } = useApp()
  const { toast, show } = useToast()
  const data = useAsync<LoadData>(async () => {
    const [agentsResult, listResult, vault, lastSync] = await Promise.all([
      call('skills:agents', {}),
      call('skills:list', {}),
      call('settings:get', { key: 'vault_path' }),
      call('settings:get', { key: 'skills_last_sync_at' }),
    ])
    const parsedSync = Number(lastSync.value)
    return {
      agents: agentsResult.agents,
      skills: listResult.skills,
      vaultPath: vault.value,
      lastSyncAt: Number.isSafeInteger(parsedSync) && parsedSync > 0 ? parsedSync : undefined,
    }
  }, [refreshKey])

  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ title: string; lines: string[]; conflicts?: string[] } | null>(null)
  const [doctorItems, setDoctorItems] = useState<SkillDoctorItem[] | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const agents = data.data?.agents ?? []
  const skills = data.data?.skills ?? []
  const skillNames = skills.map((s) => s.name)
  /** 矩阵 Description 列：库内镜像行的描述（缺失为空串，绝不硬造）。 */
  const descriptionFor = (name: string): string => skills.find((s) => s.name === name)?.description ?? ''

  /** doctor 徽章：按 agent 名统计 error/warn 项（item id 形如 kind:<agent>:<skill>）。 */
  const doctorBadge = useMemo(() => {
    const map = new Map<string, { errors: number; warns: number }>()
    if (doctorItems === null) return map
    for (const item of doctorItems) {
      if (item.severity !== 'error' && item.severity !== 'warn') continue
      const parts = item.id.split(':')
      const agentName = parts.length >= 2 ? parts[1] : undefined
      if (agentName === undefined) continue
      const entry = map.get(agentName) ?? { errors: 0, warns: 0 }
      if (item.severity === 'error') entry.errors += 1
      else entry.warns += 1
      map.set(agentName, entry)
    }
    return map
  }, [doctorItems])

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

  function handleScan(): void {
    void runAction('Scan', async () => {
      const r = await call('skills:scan', {})
      setFeedback({
        title: `Scan 完成：${r.skills.length} skill · vault ${r.vaultOk ? '健康' : '异常'}`,
        lines: r.vaultOk ? r.skills.map((s) => `${s.name} — ${s.description.slice(0, 60) || '(无描述)'}`) : r.issues,
        ...(r.vaultOk ? {} : { conflicts: r.issues }),
      })
      data.refresh()
      show('Scan 完成')
    })
  }

  function handleScanWsl(): void {
    void runAction('Scan WSL', async () => {
      const r = await call('skills:scanWsl', {})
      const lines: string[] = []
      if (r.report !== null) {
        lines.push(`skills: ${r.report.skills.length} · agents: ${r.report.agents.length} · 缓存时间: ${new Date(r.report.ts).toLocaleString()}`)
        for (const a of r.report.agents) {
          const linked = Object.values(a.links).filter((s) => s === 'linked').length
          lines.push(`${a.name}: ${linked}/${Object.keys(a.links).length} linked`)
        }
      } else {
        lines.push('companion 不可达且无缓存')
      }
      if (r.reason !== undefined) lines.push(`note: ${r.reason}`)
      setFeedback({ title: r.stale ? 'Scan WSL（缓存回落，stale）' : 'Scan WSL 完成', lines })
      data.refresh()
      show(r.stale ? 'Scan WSL 使用了缓存' : 'Scan WSL 完成', r.stale ? 'err' : 'ok')
    })
  }

  function handleDoctor(): void {
    void runAction('Doctor', async () => {
      const r = await call('skills:doctor', {})
      setDoctorItems(r.items)
      const errors = r.items.filter((i) => i.severity === 'error').length
      const warns = r.items.filter((i) => i.severity === 'warn').length
      setFeedback({
        title: `Doctor 完成：${r.items.length} 项（error ${errors} · warn ${warns}）`,
        lines: r.items.map((i) => `[${i.severity}]${i.fixable ? ' (可修复)' : ''} ${i.message}`),
      })
      show(`Doctor 完成：error ${errors} · warn ${warns}`, errors > 0 ? 'err' : 'ok')
    })
  }

  function handleSync(): void {
    if (!window.confirm('执行双侧同步（Windows commit/push → WSL companion sync → Windows pull）？')) return
    void runAction('Sync', async () => {
      const r: SkillsSyncResult = await call('skills:sync', { confirmed: true })
      if (r.confirmRequired === true) {
        setFeedback({ title: 'Sync 需要确认', lines: ['未携带 confirmed，操作未执行'] })
        return
      }
      const lines = r.steps.map((s: SkillSyncStep) => `[${s.side}] ${s.ok ? 'ok' : 'FAIL'} — ${s.cmd}${s.detail.length > 0 ? ` · ${s.detail.slice(-160)}` : ''}`)
      setFeedback({
        title: r.degraded === true ? `Sync 降级：${r.reason ?? ''}` : `Sync 完成：${r.steps.length} 步 · 冲突 ${r.conflicts.length}`,
        lines,
        ...(r.conflicts.length > 0 ? { conflicts: r.conflicts } : {}),
      })
      data.refresh()
      show(r.degraded === true ? 'Sync 结构化降级' : 'Sync 完成', r.degraded === true || r.conflicts.length > 0 ? 'err' : 'ok')
    })
  }

  function handleDeploy(): void {
    if (!window.confirm('部署/更新 WSL companion（skm）到 /root/skill-vault/bin？')) return
    void runAction('Deploy', async () => {
      const r = await call('skills:companion.deploy', { confirmed: true })
      if (r.confirmRequired === true) return
      setFeedback({
        title: r.deployed ? 'Companion 部署完成' : `Companion 部署未完成：${r.reason ?? ''}`,
        lines: r.steps,
      })
      show(r.deployed ? 'Companion 已部署' : 'Companion 部署失败', r.deployed ? 'ok' : 'err')
    })
  }

  function handleToggle(agent: SkillAgentScanView, skill: string, state: LinkState): void {
    if (state === 'real-dir') return
    const enable = state !== 'linked'
    if (!window.confirm(`${enable ? '建立' : '解除'}链接：${agent.name} / ${skill}？`)) return
    void runAction('Toggle', async () => {
      const r = await call('skills:toggleLink', { agentId: agent.id, skill, enable, confirmed: true })
      setFeedback({ title: `Toggle ${agent.name}/${skill}: ${r.changed ? '已变更' : '无变更'} → ${LINK_LABEL[r.state]}`, lines: r.steps })
      data.refresh()
      show(`${agent.name}/${skill} → ${LINK_LABEL[r.state]}`, r.state === 'linked' || (!enable && r.state === 'missing') ? 'ok' : 'err')
    })
  }

  function handleRepair(item: SkillDoctorItem): void {
    if (!window.confirm(`执行修复「${item.fixId}」？\n${item.message}`)) return
    void runAction('Repair', async () => {
      const r = await call('skills:repair', { fixId: item.fixId ?? '', payload: item.payload, confirmed: true })
      if (r.manualRequired === true) {
        setFeedback({ title: '该项需人工处理（永不自动处理）', lines: [r.message ?? ''] })
        show('需人工处理', 'err')
        return
      }
      setFeedback({ title: `Repair (${item.fixId}) 完成`, lines: r.steps })
      data.refresh()
      show('Repair 完成')
    })
  }

  if (data.loading) {
    return (
      <section className="view">
        <ViewHeader />
        <Loading label="Loading skills (vault scan + live link states)…" />
      </section>
    )
  }
  if (data.error !== null) {
    return (
      <section className="view">
        <ViewHeader />
        <ErrorState error={data.error} onRetry={data.refresh} />
      </section>
    )
  }

  const vaultPath = data.data?.vaultPath ?? ''
  const vaultSkills = skills.length

  return (
    <section className="view">
      <ViewHeader />

      {/* vault 概览条 */}
      <div className="vault-bar">
        <span className="vault-path mono" title={vaultPath}>
          {vaultPath.length > 0 ? vaultPath : '(vault_path 未设置)'}
        </span>
        <Badge tone={vaultSkills > 0 ? 'accent' : 'warn'}>{vaultSkills} skills</Badge>
        <span className="dim">上次同步: {data.data?.lastSyncAt !== undefined ? relativeTime(data.data.lastSyncAt) : '从未'}</span>
        <span className="vault-bar-actions">
          <button type="button" className="btn" disabled={busy !== null} onClick={handleScan}>
            Scan
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={handleScanWsl}>
            Scan WSL
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={handleDeploy} title="部署/更新 WSL companion（skm）到 /root/skill-vault/bin">
            Deploy Companion
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={handleDoctor}>
            Doctor
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={handleSync}>
            Sync
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => setImportOpen(true)}>
            Import
          </button>
        </span>
      </div>

      {/* agent 卡片区 */}
      {agents.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No agents registered"
            hint="skill_agents 表为空 —— 可先运行一次性导入（scripts/migrate-legacy.mjs）或在本页添加 agent。"
          />
        </div>
      ) : (
        <div className="agent-grid">
          {agents.map((a) => {
            const badge = doctorBadge.get(a.name)
            return (
              <div key={a.id} className="agent-card">
                <div className="agent-card-head">
                  <span className="agent-name">{a.name}</span>
                  <Badge tone={a.platform === 'windows' ? 'accent' : 'wsl'}>{a.platform}</Badge>
                  {!a.enabled && <Badge tone="dim">停用</Badge>}
                  {a.stale === true && <Badge tone="warn" title="companion 缓存已过期（>10 分钟）">stale</Badge>}
                  {badge !== undefined && (
                    <Badge tone={badge.errors > 0 ? 'err' : 'warn'} title="最近一次 Doctor 的该 agent 异常计数">
                      doctor {badge.errors > 0 ? `${badge.errors} err` : `${badge.warns} warn`}
                    </Badge>
                  )}
                </div>
                <div className="agent-dir mono" title={a.skillsDir}>
                  {a.skillsDir}
                </div>
                {a.agentsDir !== undefined && (
                  <div className="agent-dir mono dim" title={a.agentsDir}>
                    agents: {a.agentsDir}
                    {a.agentsDirState !== undefined && (
                    <>
                      {' · '}
                      <Badge tone={linkTone(a.agentsDirState)}>
                        {LINK_LABEL[a.agentsDirState]}
                        {a.agentsDirNote !== undefined ? `（${a.agentsDirNote}）` : ''}
                      </Badge>
                    </>
                    )}
                  </div>
                )}
                {a.available ? (
                  <div className="agent-counts">
                    <Badge tone="ok" title="linked">{a.counts.linked} linked</Badge>
                    <Badge tone="dim" title="missing">{a.counts.missing} missing</Badge>
                    {a.counts.wrongTarget > 0 && <Badge tone="warn" title="wrong-target">{a.counts.wrongTarget} wrong</Badge>}
                    {a.counts.realDir > 0 && <Badge tone="warn" title="real-dir">{a.counts.realDir} real-dir</Badge>}
                    {a.counts.vaultMissing > 0 && <Badge tone="err" title="vault-missing">{a.counts.vaultMissing} dangling</Badge>}
                  </div>
                ) : (
                  <div className="agent-counts dim">{a.reason ?? '状态不可用'}</div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* skill 列表（链接态矩阵） */}
      {skillNames.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="No skills in the vault mirror"
            hint="点击 Scan 扫描 vault_path 下的 skills/<name>/SKILL.md 并镜像入库。"
            action={{ label: 'Scan', onClick: handleScan }}
          />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Description</th>
                {agents.map((a) => (
                  <th key={a.id} className="th-agent" title={a.skillsDir}>
                    {a.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {skillNames.map((name) => (
                <tr key={name}>
                  <td className="td-mono">{name}</td>
                  <td className="skill-desc" title={descriptionFor(name)}>
                    {descriptionFor(name)}
                  </td>
                  {agents.map((a) => {
                    if (!a.available) {
                      return (
                        <td key={a.id} className="matrix-cell">
                          <span className="dim" title={a.reason}>—</span>
                        </td>
                      )
                    }
                    const included = a.include.includes('*') || a.include.includes(name)
                    const state = a.links[name]
                    if (!included || state === undefined) {
                      return (
                        <td key={a.id} className="matrix-cell">
                          <span className="dim" title="不在该 agent 的 include 白名单内">excluded</span>
                        </td>
                      )
                    }
                    if (state === 'real-dir') {
                      return (
                        <td key={a.id} className="matrix-cell">
                          <button
                            type="button"
                            className="link-cell link-real-dir"
                            disabled
                            title="真实目录（非链接）：永不自动处理，请人工处理或走导入流水线"
                          >
                            real-dir
                          </button>
                        </td>
                      )
                    }
                    return (
                      <td key={a.id} className="matrix-cell">
                        <button
                          type="button"
                          className={`link-cell link-${state}`}
                          disabled={busy !== null}
                          title={`${LINK_LABEL[state]} — 点击${state === 'linked' ? '解除' : '建立'}链接`}
                          onClick={() => handleToggle(a, name, state)}
                        >
                          {LINK_LABEL[state]}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 操作反馈区 */}
      {feedback !== null && (
        <div className="panel feedback">
          <div className="panel-title">{feedback.title}</div>
          <pre className="feedback-lines">{feedback.lines.join('\n')}</pre>
          {feedback.conflicts !== undefined && feedback.conflicts.length > 0 && (
            <>
              <div className="panel-title">Conflicts</div>
              <pre className="feedback-lines feedback-err">{feedback.conflicts.join('\n')}</pre>
            </>
          )}
        </div>
      )}

      {/* Doctor 结果（可修复项带按钮） */}
      {doctorItems !== null && doctorItems.length > 0 && (
        <div className="panel feedback">
          <div className="panel-title">Doctor items</div>
          <ul className="doctor-list">
            {doctorItems.map((item) => (
              <li key={item.id} className={`doctor-item diag-${item.severity === 'warn' ? 'warning' : item.severity === 'error' ? 'error' : 'info'}`}>
                <span className="doctor-msg">{item.message}</span>
                {item.fixable && item.fixId !== undefined && (
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => handleRepair(item)}>
                    Fix ({item.fixId})
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {importOpen && (
        <ImportDialog
          agents={agents}
          onClose={() => setImportOpen(false)}
          onDone={(r) => {
            setFeedback({
              title: `Import ${r.plan.skillName}: ${r.steps.length} 步`,
              lines: r.steps,
            })
            data.refresh()
            show(`Import ${r.plan.skillName} 完成`)
          }}
          onError={(msg) => show(msg, 'err')}
        />
      )}

      <Toast toast={toast} />
    </section>
  )
}

function ViewHeader() {
  return (
    <header className="view-header">
      <div>
        <h2 className="view-title">Skills</h2>
        <p className="view-sub">AI skills vault: agents, links (junction / hardlink / WSL symlink), doctor and two-side sync</p>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// 导入对话框（plan 预览 → agent 选择 → confirmed 执行）
// ---------------------------------------------------------------------------

function ImportDialog({
  agents,
  onClose,
  onDone,
  onError,
}: {
  agents: SkillAgentScanView[]
  onClose: () => void
  onDone: (r: SkillsImportResult) => void
  onError: (msg: string) => void
}) {
  const [sourceDir, setSourceDir] = useState('')
  const [plan, setPlan] = useState<SkillImportPlan | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [busy, setBusy] = useState(false)

  async function preview(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await call('skills:import', { sourceDir: sourceDir.trim() })
      setPlan(r.plan)
      if (!r.plan.ok && r.plan.error !== undefined) onError(r.plan.error)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function confirmImport(): Promise<void> {
    if (plan === null || !plan.ok) return
    setBusy(true)
    try {
      const r = await call('skills:import', { sourceDir: sourceDir.trim(), agentIds: selected, confirmed: true })
      onDone(r)
      onClose()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="import-overlay" role="dialog" aria-label="Import skill">
      <div className="import-dialog">
        <div className="panel-title">Import skill</div>
        <form className="toolbar" onSubmit={(e) => void preview(e)}>
          <input
            type="text"
            className="search-input mono"
            placeholder="F:\\path\\to\\skill-dir（目录名即 skill 名，须为小写 kebab-case）"
            value={sourceDir}
            onChange={(e) => {
              setSourceDir(e.target.value)
              setPlan(null)
            }}
          />
          <button type="submit" className="btn" disabled={busy || sourceDir.trim().length === 0}>
            Preview
          </button>
        </form>

        {plan !== null && (
          <div className="import-plan">
            {plan.ok ? (
              <>
                <div>
                  <span className="dim">skill 名: </span>
                  <span className="mono">{plan.skillName}</span>
                  <Badge tone="ok">kebab-case ok</Badge>
                  <Badge tone="dim">
                    {plan.fileCount} files · {plan.totalBytes} bytes
                  </Badge>
                  {plan.sourceIsLink && <Badge tone="warn">源是链接 → {plan.sourceRealPath}</Badge>}
                </div>
                <div className="import-fm">
                  <span className="dim">frontmatter: </span>
                  <span className="mono">
                    name={plan.frontmatter?.name ?? '(缺)'}
                    {plan.frontmatter?.description !== undefined && plan.frontmatter.description.length > 0
                      ? ` · description=${plan.frontmatter.description.slice(0, 120)}${plan.frontmatter.description.length > 120 ? '…' : ''}`
                      : ' · description=(缺)'}
                  </span>
                </div>
                <div className="import-actions dim">{plan.actions.join(' → ')}</div>
                <div className="import-agents">
                  <span className="dim">导入后建立链接到:</span>
                  {agents
                    .filter((a) => a.enabled)
                    .map((a) => (
                      <label key={a.id} className="import-agent">
                        <input
                          type="checkbox"
                          checked={selected.includes(a.id)}
                          onChange={(e) =>
                            setSelected((prev) => (e.target.checked ? [...prev, a.id] : prev.filter((id) => id !== a.id)))
                          }
                        />
                        {a.name} <span className="dim">({a.platform})</span>
                      </label>
                    ))}
                </div>
                <div className="import-confirm">
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirmImport()}>
                    确认导入（拷贝 → 校验 → 删源 → 建链 → commit）
                  </button>
                </div>
              </>
            ) : (
              <div className="feedback-err">{plan.error}</div>
            )}
          </div>
        )}

        <div className="import-footer">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
