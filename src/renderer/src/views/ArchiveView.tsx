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
import {EmptyState, ErrorState, Loading, Spinner,} from '../components/StateViews.tsx'
import { useConfirm } from '../components/ConfirmDialog.tsx'
import { useToast } from '../components/ToastProvider.tsx'
import { useApp } from '../lib/appContext.ts'
import { call, sleep } from '../lib/ipc.ts'
import { pickPath } from '../lib/pickPath.ts'
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

/** 归档运行状态 → 用户面中文（值保留原样，仅展示层投影）。 */
const RUN_STATUS_LABEL: Record<string, string> = {
  done: '已完成',
  failed: '失败',
  'rolled-back': '已回滚',
}

const PHASE_LABELS: Record<ArchivePhase, string> = {
  moving: '正在移动真实目录…（同卷重命名 / 跨卷复制校验）',
  fixing: '正在改写路径引用…（改写前逐文件备份）',
  verifying: '正在复核残留引用…',
  done: '归档完成',
  failed: '归档失败（源目录保持原样）',
}

export function ArchiveView() {
  const { refreshKey, refreshAll } = useApp()
  const { show } = useToast()
  const confirm = useConfirm()

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

  /** 「浏览…」：原生目录选择器（D5-M1/I8）回填 archive_dest_root 输入框；取消/失败维持原值不报错（保存仍需手点）。 */
  async function browseDestRoot(): Promise<void> {
    const picked = await pickPath('directory', {
      defaultPath: destInput.trim(),
      title: '选择归档目标根目录（archive_dest_root）',
    })
    if (picked !== null) setDestInput(picked)
  }

  async function saveDestRoot(): Promise<void> {
    setDestSaving(true)
    try {
      await call('settings:set', { key: 'archive_dest_root', value: destInput.trim() })
      show('archive_dest_root 已保存')
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
          `回滚第 #${first.impacts.runId} 次归档（${first.impacts.projectName}）？`,
          `${first.impacts.oldPath}  <-  ${first.impacts.newPath}`,
          `内容还原：${first.impacts.undoEntries} 处 · 注：${first.impacts.note}`,
        ]
        if (await confirm({ body: lines.join('\n'), danger: true })) {
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
          <h2 className="view-title">归档</h2>
          <p className="view-sub">将休眠项目移动到归档卷 — dry-run 预检、双重确认、随时可回滚</p>
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
          placeholder="D:\ArchiveRoot — 归档项目的目标根目录（扫描前必填）"
          value={destInput}
          onChange={(e) => setDestInput(e.target.value)}
          disabled={destSetting.loading || destSaving}
        />
        <button
          type="button"
          className="btn"
          disabled={destSetting.loading}
          title="浏览选择归档目标根目录（手输仍可用；保存仍需点击）"
          onClick={() => void browseDestRoot()}
        >
          浏览…
        </button>
        <button type="button" className="btn" disabled={destSaving || destInput.trim() === (destSetting.data?.value ?? '')} onClick={() => void saveDestRoot()}>
          {destSaving && <Spinner />} 保存
        </button>
        {!destReady && <span className="archive-dest-warning">尚未设置归档目标根目录 — 设置前拒绝扫描</span>}
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
          <Loading label="正在加载项目…" />
        ) : projects.error !== null ? (
          <ErrorState error={projects.error} onRetry={projects.refresh} />
        ) : (projects.data?.length ?? 0) === 0 ? (
          <EmptyState title="尚未注册项目" hint="请先在「项目」页扫描注册项目；归档目标来自项目表。" />
        ) : (
          <>
            <label className="archive-picker-label" htmlFor="archive-project">
              要归档的项目
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
              <option value="">— 选择项目 —</option>
              {(projects.data ?? []).map((p: ProjectSummary) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.winPath ?? p.wslPath ?? '（无路径）'}
                  {p.hasGit ? ` · git${p.dirtyCount > 0 ? ` 有改动(${p.dirtyCount})` : ' 干净'}` : ''}
                </option>
              ))}
            </select>
            {selected !== null && (
              <span className="td-dim archive-picker-meta mono" title={selected.winPath}>
                {selected.winPath ?? '—'} · {selected.runtimeHint ?? '运行时未知'}
              </span>
            )}
            <button type="button" className="btn" disabled={projectId === null || scanBusy || !destReady} onClick={() => void runPreview()}>
              {scanBusy ? <Spinner /> : null} 扫描引用（dry-run）
            </button>
          </>
        )}
      </div>

      {scanBusy && <Loading label="正在扫描路径引用、占用与可剥离目录（只读）…" />}

      {/* ① 预检结果 */}
      {step !== 'pick' && impacts !== null && (
        <div className="panel">
          <h3 className="panel-title">预检 — {impacts.projectName}</h3>
          <div className="archive-impacts-grid">
            <ImpactsCard label="引用命中" value={`${impacts.report.totalHits}`} detail="扫描 ${impacts.report.scannedFiles} 个文件 · 展示 ${impacts.report.hits.length} 处" />
            <ImpactsCard label="待改写文件" value={`${new Set(impacts.report.hits.map((h) => h.file)).size}`} detail="含旧根路径的去重文件数" />
            <ImpactsCard label="可剥离目录（可再生）" value={`${impacts.depSkipDirs.length}`} detail={impacts.depSkipDirs.join(', ') || '无'} />
            <ImpactsCard label="占用进程" value={`${impacts.occupiers.length}`} detail={impacts.occupiers.map((o) => `${o.name}(${o.pid})`).join(', ') || '无'} />
            <ImpactsCard label="目标位置" value={impacts.destPath} detail={`${impacts.destRoot} · ${impacts.crossVolume ? '跨卷复制（已校验）' : '同卷重命名'}`} />
          </div>
          {impacts.report.errorSummary.length > 0 && (
            <div className="degraded-banner">扫描错误（降级继续）：{impacts.report.errorSummary.slice(0, 5).join(' · ')}</div>
          )}

          <h4 className="panel-title">引用文件（展开行可看命中行）</h4>
          {impacts.report.hits.length === 0 ? (
            <div className="inline-note">未发现旧路径引用 — 改写步骤将无操作。</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>行:列</th>
                    <th>命中</th>
                    <th>片段</th>
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
              {expandAllHits ? '收起' : `展开全部 ${impacts.report.hits.length} 处命中`}
            </button>
          )}
        </div>
      )}

      {/* ② 确认 */}
      {impacts !== null && step === 'previewed' && (
        <div className="panel archive-confirm">
          <h3 className="panel-title">执行前确认</h3>
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
            title="执行归档 — 将移动真实目录"
            onClick={() => void executeRun()}
          >
            执行归档（将移动真实目录）
          </button>
        </div>
      )}

      {/* ③ 执行进度 */}
      {step === 'running' && (
        <div className="panel">
          <h3 className="panel-title">执行中</h3>
          <ul className="archive-phases">
            {(['moving', 'fixing', 'verifying'] as const).map((p) => (
              <li key={p} className={phase === p ? 'archive-phase current' : phaseIdx(phase) > phaseIdx(p) ? 'archive-phase done' : 'archive-phase'}>
                {phase === p && <Spinner />} {PHASE_LABELS[p]}
              </li>
            ))}
          </ul>
          {percent !== undefined && <div className="inline-note">复制进度：{percent}%</div>}
        </div>
      )}

      {/* 执行结果 */}
      {step === 'result' && runResult !== null && (
        <div className="panel">
          <h3 className="panel-title">
            结果 — 第 #{runResult.runId} 次归档 <Badge tone={runResult.residualHits > 0 ? 'warn' : 'ok'}>{runResult.residualHits > 0 ? '完成（有残留警告）' : '完成'}</Badge>
          </h3>
          <div className="inline-note mono">
            {runResult.movedFrom} → {runResult.movedTo} · mode={runResult.mode} · {runResult.durationMs}ms · replacements={runResult.totalReplacements}
          </div>
          {runResult.skippedDeps.length > 0 && (
            <div className="inline-note">已剥离可再生目录：{runResult.skippedDeps.join(', ')} — 恢复时需在归档位置重装依赖</div>
          )}
          {runResult.sourceLeftovers.length > 0 && <div className="degraded-banner">源目录残留（可手动清理）：{runResult.sourceLeftovers.slice(0, 10).join(' · ')}</div>}
          <FileFixTable title="项目内文件" fixes={runResult.fixed} />
          <FileFixTable title="外部引用文件" fixes={runResult.external} />
          {/* LLM 归档后复核（按需触发；ok 态缓存 review_post_json，命中不再打端点——任务书 §4.2） */}
          <ReviewPostButton runId={runResult.runId} />
          {runResult.residualHits > 0 && (
            <div className="degraded-banner">
              残留 {runResult.residualHits} 处旧路径引用（多为非 UTF-8 跳过文件）——已显式警示，不算失败
            </div>
          )}
          <button type="button" className="btn btn-danger" disabled={rollbackBusy !== null} onClick={() => void rollbackRun(runResult.runId)}>
            {rollbackBusy === runResult.runId && <Spinner />} 回滚本次归档
          </button>
        </div>
      )}

      {/* 历史区（AUDIT D-Aud A3：内部表名 archive_runs 不出用户面，只留规则语义） */}
      <h3 className="panel-title">历史（最近 100 条 — 含导入的旧记录）</h3>
      <div className="panel">
        {history.loading ? (
          <Loading label="正在加载归档历史…" />
        ) : history.error !== null ? (
          <ErrorState error={history.error} onRetry={history.refresh} />
        ) : (history.data?.runs.length ?? 0) === 0 ? (
          <EmptyState title="还没有归档记录" hint="完成的归档会连同回滚入口出现在这里。" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>开始时间</th>
                  <th>项目</th>
                  <th>原路径 → 新路径</th>
                  <th>改写</th>
                  <th>残留</th>
                  <th>剥离</th>
                  <th>状态</th>
                  <th>回滚材料</th>
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
                      <Badge tone={stateTone(r.status === 'rolled-back' ? 'dim' : r.status)}>{RUN_STATUS_LABEL[r.status] ?? r.status}</Badge>
                    </td>
                    <td className="td-dim">{r.undoEntries !== null ? `${r.undoEntries} 个文件` : '—'}</td>
                    <td>
                      <ReviewPostButton runId={r.id} />
                    </td>
                    <td>
                      {r.status === 'done' && (
                        <button type="button" className="btn btn-small btn-danger" disabled={rollbackBusy !== null} onClick={() => void rollbackRun(r.id)}>
                          {rollbackBusy === r.id && <Spinner />} 回滚
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
              <th>文件</th>
              <th>替换数</th>
              <th>类型</th>
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
                    <Badge tone="ok">已改写</Badge>
                  ) : (
                    <Badge tone="err" title={f.kind === 'missing' ? '改写时未找到文件' : '非 UTF-8 编码 — 为避免损坏已跳过'}>
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
            <th>进程名</th>
            <th>命令行</th>
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
