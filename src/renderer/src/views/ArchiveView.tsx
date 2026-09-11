/**
 * views/ArchiveView.tsx — Archive 归档页（S5 批次，docs/10；docs/06 §2 侧边栏启用）。
 *
 * 布局：上部归档设置条（archive_dest_root 经 settings:get/set 读写，未设置时引导）
 * + 项目选择器（projects 表，显示路径/git/脏文件）；中部三步向导：
 *   ① 预检 — archive:preview（强制 dry-run）：引用命中清单（可展开）、剥离目录、
 *      占用进程、目标路径预览；
 *   ② 确认 — impacts 汇总卡 + 风险文案 + confirmed 勾选 + 输入项目名 DOUBLE_CONFIRM
 *      （docs/10 §10 安全规则 2：影响面全部展示后才可 confirmed）；
 *   ③ 执行 — archive:run { previewId, confirmed }（服务端校验 previewId 确有预览，
 *      安全规则 1），archive:status 轮询移动/改写/复核阶段；结果逐文件展示，
 *      跳过/丢失文件标红，附回滚按钮；
 * 历史区：archive_runs 表 + 每行 Rollback（两段确认）。
 * 三态强制（约束 #24）；执行文案明确「正在移动真实目录」。
 */

import { useEffect, useState } from 'react'
import { Badge, stateTone } from '../components/Badge.tsx'
import { LlmReviewSettingsCard, ReviewAdvisoryBar, ReviewPostButton } from '../components/LlmReview.tsx'
import { ZcodeManagedSettingsCard } from '../components/ZcodeManaged.tsx'
import { EmptyState, ErrorState, Loading, Spinner, Toast, useToast } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { call, sleep } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type {
  ArchiveFileFix,
  ArchiveOccupier,
  ArchivePhase,
  ArchivePreviewResult,
  ArchiveRunResult,
  ArchiveStatusResult,
  ProjectSummary,
} from '../../../shared/types.ts'/** 执行期进度轮询间隔（docs/10 §11 archive:status 轮询模式） */
const STATUS_POLL_MS = 600

type WizardStep = 'pick' | 'previewed' | 'running' | 'result'

const PHASE_LABELS: Record<ArchivePhase, string> = {
  moving: '正在移动真实目录…（同卷重命名 / 跨卷复制校验）',
  fixing: '正在改写路径引用…（改写前逐文件备份）',
  verifying: '正在复核残留引用…',
  done: '归档完成',
  failed: '归档失败（源目录保持原样）',
}

export function ArchiveView() {
  const { refreshKey, refreshAll } = useApp()
  const { toast, show } = useToast()

  // --- 归档设置条：archive_dest_root（settings:get/set，003 种子键） ---
  const destSetting = useAsync(() => call('settings:get', { key: 'archive_dest_root' }), [refreshKey])
  const [destInput, setDestInput] = useState('')
  const [destSaving, setDestSaving] = useState(false)

  // --- 项目选择器（projects 表） ---
  const projects = useAsync(() => call('projects:list', {}), [refreshKey])
  const [projectId, setProjectId] = useState<number | null>(null)
  const selected = projects.data?.find((p) => p.id === projectId) ?? null

  // --- 向导状态 ---
  const [step, setStep] = useState<WizardStep>('pick')
  const [preview, setPreview] = useState<ArchivePreviewResult | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [expandAllHits, setExpandAllHits] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [typedName, setTypedName] = useState('')
  const [killOccupiers, setKillOccupiers] = useState(false)
  const [runResult, setRunResult] = useState<ArchiveRunResult | null>(null)
  const [phase, setPhase] = useState<ArchivePhase>('moving')
  const [percent, setPercent] = useState<number | undefined>(undefined)

  // --- 历史区 ---
  const history = useAsync(() => call('archive:history', {}), [refreshKey])
  const [rollbackBusy, setRollbackBusy] = useState<number | null>(null)

  useEffect(() => {
    if (destSetting.data !== null && destInput === '') setDestInput(destSetting.data.value)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在设置数据首次到达时回填输入框
  }, [destSetting.data])

  async function saveDestRoot(): Promise<void> {
    setDestSaving(true)
    try {
      await call('settings:set', { key: 'archive_dest_root', value: destInput.trim() })
      show('archive_dest_root saved')
      destSetting.refresh()
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setDestSaving(false)
    }
  }

  async function runPreview(): Promise<void> {
    if (projectId === null) return
    setScanBusy(true)
    setPreview(null)
    setRunResult(null)
    setConfirmed(false)
    setTypedName('')
    setKillOccupiers(false)
    try {
      const result = await call('archive:preview', { projectId })
      setPreview(result)
      setStep('previewed')
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setScanBusy(false)
    }
  }

  async function executeRun(): Promise<void> {
    if (preview === null || !confirmed) return
    setStep('running')
    setPhase('moving')
    setPercent(undefined)
    const killPids =
      killOccupiers && preview.impacts.occupiers.length > 0 ? preview.impacts.occupiers.map((o) => o.pid) : undefined
    const pendingRun = call('archive:run', { previewId: preview.previewId, confirmed: true, ...(killPids !== undefined ? { killPids } : {}) })
    // 轮询进度直到执行 promise 落定（docs/10 §11 轮询模式，无广播 channel）
    let polling = true
    void (async () => {
      while (polling) {
        try {
          const status: ArchiveStatusResult = await call('archive:status', { previewId: preview.previewId })
          setPhase(status.phase)
          setPercent(status.percent)
        } catch {
          /* 执行结束后的末次轮询可能 404，忽略 */
        }
        await sleep(STATUS_POLL_MS)
      }
    })()
    try {
      const done = await pendingRun
      if (done.confirmRequired === true) return // 理论不可达：已带 confirmed
      setRunResult(done)
      setPhase('done')
      setStep('result')
      refreshAll()
    } catch (err) {
      setPhase('failed')
      show(err instanceof Error ? err.message : String(err), 'err')
      setStep('previewed') // 失败回到确认步，允许修正后重试（须重新预检）
    } finally {
      polling = false
    }
  }

  async function rollbackRun(runId: number): Promise<void> {
    setRollbackBusy(runId)
    try {
      // 两段式：第一段 confirmRequired + impacts；确认弹窗展示后才 confirmed 重发
      const first = await call('archive:rollback', { runId })
      if (first.confirmRequired === true) {
        const lines = [
          `Rollback run #${first.impacts.runId} (${first.impacts.projectName})?`,
          `${first.impacts.oldPath}  <-  ${first.impacts.newPath}`,
          `content restores: ${first.impacts.undoEntries} · note: ${first.impacts.note}`,
        ]
        if (window.confirm(lines.join('\n'))) {
          const done = await call('archive:rollback', { runId, confirmed: true })
          if (done.confirmRequired === true) return // 理论不可达：已带 confirmed
          show(done.note)
          refreshAll()
        }
      } else {
        show(first.note)
      }
    } catch (err) {
      show(err instanceof Error ? err.message : String(err), 'err')
    } finally {
      setRollbackBusy(null)
    }
  }

  const impacts = preview?.impacts ?? null
  const destReady = destSetting.data !== null && destSetting.data.value.trim().length > 0

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h2 className="view-title">Archive</h2>
          <p className="view-sub">Move dormant projects to the archive volume — dry-run preview, double confirm, always rollback-able</p>
        </div>
      </header>

      {/* 归档设置条：destRoot 显示/设置 */}
      <div className="panel archive-settings-bar">
        <label className="archive-dest-label" htmlFor="archive-dest-root">
          archive_dest_root
        </label>
        <input
          id="archive-dest-root"
          className="archive-dest-input mono"
          type="text"
          placeholder="D:\ArchiveRoot — destination root for archived projects (required before scanning)"
          value={destInput}
          onChange={(e) => setDestInput(e.target.value)}
          disabled={destSetting.loading || destSaving}
        />
        <button type="button" className="btn" disabled={destSaving || destInput.trim() === (destSetting.data?.value ?? '')} onClick={() => void saveDestRoot()}>
          {destSaving && <Spinner />} Save
        </button>
        {!destReady && <span className="archive-dest-warning">destination root is not set — scanning is refused until configured</span>}
      </div>

      {/* LLM 复核设置卡片（LR1 advisory-only：base_url/model 双键 + 端点测试入口；
          默认空 = 停用，全流程行为等价现状——任务书 §1/§5） */}
      <LlmReviewSettingsCard />

      {/* ZCode 托管模型设置卡片（T2b：zcode_managed_model 单键，默认空 = 托管停用；
          就绪性见 App Agents 页 caps 卡——docs/briefs/t2b-zcode-managed-ui.md） */}
      <ZcodeManagedSettingsCard />

      {/* 项目选择器 + 预检动作 */}
      <div className="panel archive-picker">
        {projects.loading ? (
          <Loading label="Loading projects…" />
        ) : projects.error !== null ? (
          <ErrorState error={projects.error} onRetry={projects.refresh} />
        ) : (projects.data?.length ?? 0) === 0 ? (
          <EmptyState title="No projects registered" hint="Register projects via Projects → Scan first; archive targets come from the projects table." />
        ) : (
          <>
            <label className="archive-picker-label" htmlFor="archive-project">
              Project to archive
            </label>
            <select
              id="archive-project"
              className="archive-picker-select"
              value={projectId ?? ''}
              onChange={(e) => {
                setProjectId(e.target.value === '' ? null : Number(e.target.value))
                setStep('pick')
                setPreview(null)
              }}
            >
              <option value="">— select a project —</option>
              {(projects.data ?? []).map((p: ProjectSummary) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.winPath ?? p.wslPath ?? '(no path)'}
                  {p.hasGit ? ` · git${p.dirtyCount > 0 ? ` dirty(${p.dirtyCount})` : ' clean'}` : ''}
                </option>
              ))}
            </select>
            {selected !== null && (
              <span className="td-dim archive-picker-meta mono" title={selected.winPath}>
                {selected.winPath ?? '—'} · {selected.runtimeHint ?? 'unknown runtime'}
              </span>
            )}
            <button type="button" className="btn" disabled={projectId === null || scanBusy || !destReady} onClick={() => void runPreview()}>
              {scanBusy ? <Spinner /> : null} Scan references (dry-run)
            </button>
          </>
        )}
      </div>

      {scanBusy && <Loading label="Scanning path references, occupancy and strip candidates (read-only)…" />}

      {/* ① 预检结果 */}
      {step !== 'pick' && impacts !== null && (
        <div className="panel">
          <h3 className="panel-title">Precheck — {impacts.projectName}</h3>
          <div className="archive-impacts-grid">
            <ImpactsCard label="Reference hits" value={`${impacts.report.totalHits}`} detail={`${impacts.report.scannedFiles} files scanned · ${impacts.report.hits.length} shown`} />
            <ImpactsCard label="Files to rewrite" value={`${new Set(impacts.report.hits.map((h) => h.file)).size}`} detail="unique files containing the old root path" />
            <ImpactsCard label="Strip dirs (regenerable)" value={`${impacts.depSkipDirs.length}`} detail={impacts.depSkipDirs.join(', ') || 'none'} />
            <ImpactsCard label="Occupiers" value={`${impacts.occupiers.length}`} detail={impacts.occupiers.map((o) => `${o.name}(${o.pid})`).join(', ') || 'none'} />
            <ImpactsCard label="Destination" value={impacts.destPath} detail={`${impacts.destRoot} · ${impacts.crossVolume ? 'cross-volume copy (verified)' : 'same-volume rename'}`} />
          </div>
          {impacts.report.errorSummary.length > 0 && (
            <div className="degraded-banner">scan errors (degraded, continued): {impacts.report.errorSummary.slice(0, 5).join(' · ')}</div>
          )}

          <h4 className="panel-title">Reference files (expand a row for the matched line)</h4>
          {impacts.report.hits.length === 0 ? (
            <div className="inline-note">No references to the old path were found — the rewrite step will be a no-op.</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Line:Col</th>
                    <th>Matched</th>
                    <th>Snippet</th>
                  </tr>
                </thead>
                <tbody>
                  {(expandAllHits ? impacts.report.hits : impacts.report.hits.slice(0, 30)).map((h, i) => (
                    <tr key={`${h.file}:${h.line}:${h.col}:${i}`}>
                      <td className="td-mono" title={h.file}>
                        {h.file}
                      </td>
                      <td className="td-mono td-dim">
                        {h.line}:{h.col}
                      </td>
                      <td className="td-mono td-dim">{h.matched}</td>
                      <td className="td-mono td-dim archive-snippet">{h.snippet}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {impacts.report.hits.length > 30 && (
            <button type="button" className="btn btn-small" onClick={() => setExpandAllHits((v) => !v)}>
              {expandAllHits ? 'Show fewer' : `Show all ${impacts.report.hits.length} hits`}
            </button>
          )}
        </div>
      )}

      {/* ② 确认 */}
      {impacts !== null && step === 'previewed' && (
        <div className="panel archive-confirm">
          <h3 className="panel-title">Confirm before execution</h3>
          <div className="degraded-banner">
            执行将把真实目录 {impacts.oldPath} 移动到 {impacts.destPath}
            {impacts.crossVolume ? '（跨卷：复制校验通过后才删源，失败保源）' : '（同卷重命名）'}；被改写的文件会先逐文件备份到 undo 目录，随时可回滚。
            {impacts.dirLocked && ' 目录当前被进程占用（句柄/CWD 锁定），执行会被拒绝。'}
            {impacts.occupiers.length > 0 && ` 检测到 ${impacts.occupiers.length} 个占用进程，需勾选终止或手动关闭后重试。`}
          </div>
          {impacts.occupiers.length > 0 && (
            <div className="archive-occupiers">
              <label>
                <input type="checkbox" checked={killOccupiers} onChange={(e) => setKillOccupiers(e.target.checked)} />
                终止以上占用进程（killPids 必须来自预检清单；温和 taskkill → 2.5s 后强制）
              </label>
            </div>
          )}
          {/* LLM 复核咨询条（LR1 advisory-only）：preview plan 摘要零额外扫描；
              skipped/failed 不拦截、不改变下方 DOUBLE_CONFIRM 流程——任务书 §4.1 */}
          <ReviewAdvisoryBar
            plan={{
              projectName: impacts.projectName,
              oldPath: impacts.oldPath,
              destPath: impacts.destPath,
              crossVolume: impacts.crossVolume,
              totalHits: impacts.report.totalHits,
              filesToRewrite: new Set(impacts.report.hits.map((h) => h.file)).size,
              stripDirs: impacts.depSkipDirs.length,
              occupiers: impacts.occupiers.length,
            }}
          />
          <div className="archive-double-confirm">
            <label>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              我已知晓以上影响（命中 {impacts.report.totalHits} 处 / 剥离 {impacts.depSkipDirs.length} 个目录 / 目标 {impacts.destPath}）
            </label>
            <label>
              输入项目名以二次确认（DOUBLE_CONFIRM）：
              <input type="text" className="archive-name-input mono" value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder={impacts.projectName} />
            </label>
          </div>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!confirmed || typedName !== impacts.projectName}
            title="Run archive — moves the real directory"
            onClick={() => void executeRun()}
          >
            Execute archive (moves the real directory)
          </button>
        </div>
      )}

      {/* ③ 执行进度 */}
      {step === 'running' && (
        <div className="panel">
          <h3 className="panel-title">Executing</h3>
          <ul className="archive-phases">
            {(['moving', 'fixing', 'verifying'] as const).map((p) => (
              <li key={p} className={phase === p ? 'archive-phase current' : phaseIdx(phase) > phaseIdx(p) ? 'archive-phase done' : 'archive-phase'}>
                {phase === p && <Spinner />} {PHASE_LABELS[p]}
              </li>
            ))}
          </ul>
          {percent !== undefined && <div className="inline-note">copy progress: {percent}%</div>}
        </div>
      )}

      {/* 执行结果 */}
      {step === 'result' && runResult !== null && (
        <div className="panel">
          <h3 className="panel-title">
            Result — run #{runResult.runId} <Badge tone={runResult.residualHits > 0 ? 'warn' : 'ok'}>{runResult.residualHits > 0 ? 'done with residual warnings' : 'done'}</Badge>
          </h3>
          <div className="inline-note mono">
            {runResult.movedFrom} → {runResult.movedTo} · mode={runResult.mode} · {runResult.durationMs}ms · replacements={runResult.totalReplacements}
          </div>
          {runResult.skippedDeps.length > 0 && (
            <div className="inline-note">stripped regenerable dirs: {runResult.skippedDeps.join(', ')} — reinstall dependencies at the archive location when restoring</div>
          )}
          {runResult.sourceLeftovers.length > 0 && <div className="degraded-banner">source leftovers (manual cleanup ok): {runResult.sourceLeftovers.slice(0, 10).join(' · ')}</div>}
          <FileFixTable title="Project-internal files" fixes={runResult.fixed} />
          <FileFixTable title="External reference files" fixes={runResult.external} />
          {/* LLM 归档后复核（按需触发；ok 态缓存 review_post_json，命中不再打端点——任务书 §4.2） */}
          <ReviewPostButton runId={runResult.runId} />
          {runResult.residualHits > 0 && (
            <div className="degraded-banner">
              残留 {runResult.residualHits} 处旧路径引用（多为非 UTF-8 跳过文件）——已显式警示，不算失败
            </div>
          )}
          <button type="button" className="btn btn-danger" disabled={rollbackBusy !== null} onClick={() => void rollbackRun(runResult.runId)}>
            {rollbackBusy === runResult.runId && <Spinner />} Rollback this run
          </button>
        </div>
      )}

      {/* 历史区 */}
      <h3 className="panel-title">History (archive_runs, latest 100 — includes imported legacy records)</h3>
      <div className="panel">
        {history.loading ? (
          <Loading label="Loading archive history…" />
        ) : history.error !== null ? (
          <ErrorState error={history.error} onRetry={history.refresh} />
        ) : (history.data?.runs.length ?? 0) === 0 ? (
          <EmptyState title="No archive runs yet" hint="Completed archives land here with their rollback entry." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Started</th>
                  <th>Project</th>
                  <th>Old → New</th>
                  <th>Fixed</th>
                  <th>Residual</th>
                  <th>Stripped</th>
                  <th>Status</th>
                  <th>Undo</th>
                  <th>LLM 复核</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(history.data?.runs ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="td-dim">{r.id}</td>
                    <td className="td-dim">{new Date(r.startedAt * 1000).toLocaleString()}</td>
                    <td className="td-mono">{r.projectName}</td>
                    <td className="td-mono td-dim archive-path-cell" title={`${r.oldPath} → ${r.newPath}`}>
                      {r.oldPath} → {r.newPath}
                    </td>
                    <td>
                      {r.fixedFiles}+{r.externalFiles}
                    </td>
                    <td>{r.residualHits > 0 ? <Badge tone="warn">{r.residualHits}</Badge> : <span className="td-dim">0</span>}</td>
                    <td className="td-dim">{r.strippedDirs !== null ? r.strippedDirs.join(', ') || '—' : '—'}</td>
                    <td>
                      <Badge tone={stateTone(r.status === 'rolled-back' ? 'dim' : r.status)}>{r.status}</Badge>
                    </td>
                    <td className="td-dim">{r.undoEntries !== null ? `${r.undoEntries} files` : '—'}</td>
                    <td>
                      <ReviewPostButton runId={r.id} />
                    </td>
                    <td>
                      {r.status === 'done' && (
                        <button type="button" className="btn btn-small btn-danger" disabled={rollbackBusy !== null} onClick={() => void rollbackRun(r.id)}>
                          {rollbackBusy === r.id && <Spinner />} Rollback
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Toast toast={toast} />
    </section>
  )
}

function phaseIdx(phase: ArchivePhase): number {
  switch (phase) {
    case 'moving':
      return 0
    case 'fixing':
      return 1
    case 'verifying':
      return 2
    case 'done':
      return 3
    case 'failed':
      return 3
  }
}

function ImpactsCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="archive-impact-card">
      <span className="archive-impact-label">{label}</span>
      <span className="archive-impact-value mono" title={value}>
        {value}
      </span>
      <span className="archive-impact-detail td-dim" title={detail}>
        {detail}
      </span>
    </div>
  )
}

/** 逐文件结果表：fixed 绿 / skipped-non-utf8 与 missing 标红（任务书 ③ 要求）。 */
function FileFixTable({ title, fixes }: { title: string; fixes: ArchiveFileFix[] }) {
  if (fixes.length === 0) return null
  return (
    <div className="archive-fix-list">
      <h4 className="panel-title">{title}</h4>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>File</th>
              <th>Replacements</th>
              <th>Kind</th>
            </tr>
          </thead>
          <tbody>
            {fixes.map((f, i) => (
              <tr key={`${f.file}:${i}`} className={f.kind !== 'fixed' ? 'archive-fix-row-bad' : undefined}>
                <td className="td-mono" title={f.file}>
                  {f.file}
                </td>
                <td>{f.kind === 'fixed' ? f.count : '—'}</td>
                <td>
                  {f.kind === 'fixed' ? (
                    <Badge tone="ok">fixed</Badge>
                  ) : (
                    <Badge tone="err" title={f.kind === 'missing' ? 'file not found at rewrite time' : 'non-UTF-8 encoding — skipped to avoid corruption'}>
                      {f.kind}
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 占用进程行内清单（预检表格的一部分；保留供 occupiers 明细展开）。 */
export function OccupierRows({ occupiers }: { occupiers: ArchiveOccupier[] }) {
  if (occupiers.length === 0) return null
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>PID</th>
            <th>Name</th>
            <th>Command line</th>
          </tr>
        </thead>
        <tbody>
          {occupiers.map((o) => (
            <tr key={o.pid}>
              <td className="td-mono">{o.pid}</td>
              <td className="td-mono">{o.name}</td>
              <td className="td-mono td-dim">{o.cmd || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
