/**
 * components/DraftReviewPanel.tsx — 「待核对」草稿界面（CP3b 批次，任务书 §2.4 #15）。
 *
 * 数据源（真实 IPC，无 mock——约束 #23）：contestpin:draftList（READ_ONLY 轮询）
 * / contestpin:draftConfirm（两段式：先回相似比赛检测 + 规范化草稿，用户在 diff
 * 面选择「合并进既有」或「另建新赛」，绝不静默覆盖）/ contestpin:draftDiscard
 * （两段式）。字段级来源展示（details 展开页码+原文摘录）、flags 高亮、逐字段
 * 编辑（编辑后随 confirm 的 draft 载荷提交，服务端过同款程序化校验）。
 */

import { useState } from 'react'
import { Badge } from './Badge.tsx'
import { EmptyState, ErrorState, Loading, Spinner, Toast, useToast } from './StateViews.tsx'
import { call } from '../lib/ipc.ts'
import { usePolling } from '../lib/usePolling.ts'
import { CONTEST_NODE_KIND_LABEL, CONTEST_NODE_PRECISION_LABEL } from '../lib/contestFormat.ts'
import type {
  ContestImportDraftConfirmStart,
  ContestImportJobView,
  ContestNodeKind,
  ContestNodePrecision,
  ImportContestDraft,
  ImportDraftView,
  ImportNodeDraft,
  ImportProvenance,
} from '../../../shared/types.ts'

const NODE_KINDS: readonly ContestNodeKind[] = ['signup_start', 'signup_deadline', 'payment_deadline', 'contest_start', 'contest_end', 'submit_deadline', 'custom']
const NODE_PRECISIONS: readonly ContestNodePrecision[] = ['exact', 'date', 'month', 'tbd']

export function DraftReviewPanel() {
  const [open, setOpen] = useState(false)
  const drafts = usePolling(() => call('contestpin:draftList', {}), [], 3000)
  const count = drafts.data?.jobs.length ?? 0
  if (!open) {
    return (
      <div className="recog-collapsed">
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
          待核对草稿 ▸{count > 0 ? `（${count}）` : ''}
        </button>
        <span className="dim">识别草稿的字段级核对：来源/flags/编辑/相似合并/两段式确认</span>
      </div>
    )
  }
  return (
    <div className="panel">
      <div className="recog-head">
        <h3 className="panel-title">待核对草稿{count > 0 ? `（${count}）` : ''}</h3>
        <button type="button" className="btn btn-small" onClick={() => setOpen(false)}>
          收起 ▴
        </button>
      </div>
      {drafts.loading && count === 0 ? (
        <Loading label="正在加载草稿…" />
      ) : drafts.error !== null ? (
        <ErrorState error={drafts.error} onRetry={drafts.refresh} />
      ) : count === 0 ? (
        <EmptyState title="没有待核对草稿" hint="识别完成的任务会出现在这里等待人工确认。" />
      ) : (
        drafts.data!.jobs.map((job) => <DraftJobEditor key={job.id} job={job} onChanged={drafts.refresh} />)
      )}
    </div>
  )
}

/** 单任务草稿编辑器：本地编辑副本 + 确认/弃用两段式。 */
function DraftJobEditor({ job, onChanged }: { job: ContestImportJobView; onChanged: () => void }) {
  const { toast, show } = useToast()
  const [draft, setDraft] = useState<ImportDraftView>(() => job.result?.draft ?? { contests: [], flags: [] })
  const [confirming, setConfirming] = useState(false)
  const [confirmFace, setConfirmFace] = useState<ContestImportDraftConfirmStart | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [busy, setBusy] = useState(false)

  function updateContest(ci: number, patch: Partial<ImportContestDraft>): void {
    setDraft((d) => ({ ...d, contests: d.contests.map((c, i) => (i === ci ? { ...c, ...patch } : c)) }))
  }
  function updateNode(ci: number, ni: number, patch: Partial<ImportNodeDraft>): void {
    setDraft((d) => ({
      ...d,
      contests: d.contests.map((c, i) =>
        i === ci ? { ...c, nodes: c.nodes.map((n, j) => (j === ni ? { ...n, ...patch } : n)) } : c,
      ),
    }))
  }

  async function runConfirmPhase1(): Promise<void> {
    setBusy(true)
    try {
      const start = await call('contestpin:draftConfirm', { jobId: job.id, draft })
      if (start.confirmRequired === true) {
        setConfirmFace(start)
        setDraft(start.draft) // 服务端规范化回写（所见即所建）
      }
    } catch (err) {
      show(`确认预检失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function runConfirmPhase2(mergeIntoContestId?: number): Promise<void> {
    if (confirming) return
    setConfirming(true)
    try {
      const result = await call('contestpin:draftConfirm', {
        jobId: job.id,
        confirmed: true,
        draft,
        ...(mergeIntoContestId !== undefined ? { mergeIntoContestId } : {}),
      })
      if (result.confirmRequired !== true) {
        show(`已${result.merged ? '合并进' : '创建'}比赛「${result.contest.name}」`)
        setConfirmFace(null)
        onChanged()
      }
    } catch (err) {
      show(`确认失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setConfirming(false)
    }
  }

  async function runDiscard(): Promise<void> {
    if (discarding) return
    setDiscarding(true)
    try {
      const start = await call('contestpin:draftDiscard', { jobId: job.id })
      if (start.confirmRequired === true) {
        if (window.confirm(`弃用草稿 #${start.jobId}（材料：${start.materialName ?? '未知'}）？材料文件会保留。`)) {
          await call('contestpin:draftDiscard', { jobId: job.id, confirmed: true })
          show('草稿已弃用')
          onChanged()
        }
      }
    } catch (err) {
      show(`弃用失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setDiscarding(false)
    }
  }

  return (
    <div className="recog-group">
      {toast !== null && <Toast toast={toast} />}
      <div className="recog-group-head">
        <span className="recog-group-title">
          #{job.id} {job.material?.originalName ?? (job.params?.source === 'backupImport' ? '备份导入（多赛事，材料见 flag）' : '(材料已删除)')}
        </span>
        <div className="recog-head-actions">
          <button type="button" className="btn btn-primary btn-small" disabled={busy || confirming} onClick={() => void runConfirmPhase1()}>
            {busy && <Spinner />}确认…
          </button>
          <button type="button" className="btn btn-small" disabled={discarding} onClick={() => void runDiscard()}>
            {discarding && <Spinner />}弃用
          </button>
        </div>
      </div>

      {draft.flags.length > 0 && (
        <div style={{ margin: '4px 0' }}>
          {draft.flags.map((f, i) => (
            <div key={i} className="recog-row" style={{ padding: '2px 6px' }}>
              <Badge tone="err">flag</Badge>
              <span className="dim">
                <span className="mono">{f.field}</span> — {f.reason}
                {f.excerpt !== undefined && f.excerpt !== '' ? ` ·「${f.excerpt.slice(0, 60)}」` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {draft.contests.map((contest, ci) => (
        <div key={ci} className="add-form" style={{ padding: 8 }}>
          <div className="form-row">
            <span className="field">
              <label>名称 *</label>
              <input className="input" value={contest.name} onChange={(e) => updateContest(ci, { name: e.target.value })} />
            </span>
            <span className="field">
              <label>年份（可空）</label>
              <input
                className="input"
                value={contest.year === null ? '' : String(contest.year)}
                onChange={(e) => updateContest(ci, { year: e.target.value.trim() === '' ? null : Number(e.target.value.trim()) })}
              />
            </span>
            <span className="field">
              <label>届次</label>
              <input className="input" value={contest.edition ?? ''} onChange={(e) => updateContest(ci, { edition: e.target.value })} />
            </span>
            <span className="field">
              <label>主办方</label>
              <input className="input" value={contest.organizer ?? ''} onChange={(e) => updateContest(ci, { organizer: e.target.value })} />
            </span>
          </div>
          <div className="form-row">
            {(['officialSite', 'signupUrl', 'submitUrl'] as const).map((key) => (
              <span className="field" key={key}>
                <label>
                  {key === 'officialSite' ? '官网' : key === 'signupUrl' ? '报名 URL' : '提交 URL'}
                  {contest[key] !== undefined && <ProvenanceBadge provenance={contest[key]!.provenance} />}
                </label>
                <input
                  className="input"
                  value={contest[key]?.url ?? ''}
                  placeholder="（无来源不落库）"
                  onChange={(e) => updateContest(ci, { [key]: e.target.value.trim() === '' ? undefined : { url: e.target.value.trim(), ...(contest[key]?.provenance !== undefined ? { provenance: contest[key]!.provenance } : {}) } } as Partial<ImportContestDraft>)}
                />
              </span>
            ))}
          </div>
          <div className="recog-group-head" style={{ marginTop: 4 }}>
            <span className="recog-group-title">节点（{contest.nodes.length}）</span>
          </div>
          {contest.nodes.map((node, ni) => (
            <div key={ni} className="form-row" style={{ alignItems: 'center' }}>
              <select className="input" style={{ width: 120 }} value={node.kind} onChange={(e) => updateNode(ci, ni, { kind: e.target.value as ContestNodeKind })}>
                {NODE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CONTEST_NODE_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <input className="input" style={{ width: 150 }} value={node.label} onChange={(e) => updateNode(ci, ni, { label: e.target.value })} />
              <select className="input" style={{ width: 110 }} value={node.precision} onChange={(e) => updateNode(ci, ni, { precision: e.target.value as ContestNodePrecision })}>
                {NODE_PRECISIONS.map((p) => (
                  <option key={p} value={p}>
                    {CONTEST_NODE_PRECISION_LABEL[p]}
                  </option>
                ))}
              </select>
              <input
                className="input mono"
                style={{ width: 150 }}
                value={node.startAtText ?? ''}
                placeholder="YYYY-MM-DD HH:mm"
                onChange={(e) => updateNode(ci, ni, { startAtText: e.target.value })}
              />
              <ProvenanceBadge provenance={node.provenance} />
              <span className="dim">{node.rawText !== undefined ? `原文：${node.rawText.slice(0, 40)}` : ''}</span>
            </div>
          ))}
        </div>
      ))}

      {confirmFace !== null && (
        <ConfirmFaceModal
          face={confirmFace}
          busy={confirming}
          onNewContest={() => void runConfirmPhase2()}
          onMerge={(contestId) => void runConfirmPhase2(contestId)}
          onClose={() => setConfirmFace(null)}
        />
      )}
    </div>
  )
}

/** 来源徽标 + 展开原文摘录（{页码, 摘录}）。 */
function ProvenanceBadge({ provenance }: { provenance?: ImportProvenance }) {
  if (provenance === undefined) {
    return (
      <span title="缺少来源映射">
        <Badge tone="dim">无来源</Badge>
      </span>
    )
  }
  return (
    <details style={{ display: 'inline-block' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
        <Badge tone="accent" title="点击展开原文摘录">
          来源 M#{provenance.materialId} P{provenance.page}
        </Badge>
      </summary>
      <span className="dim mono" style={{ display: 'block', maxWidth: 320, whiteSpace: 'pre-wrap' }}>
        「{provenance.excerpt.slice(0, 160)}」
      </span>
    </details>
  )
}

/**
 * 确认面：两段式第二段前呈现相似比赛 diff（草稿字段 vs 既有比赛节点/名称），
 * 用户选择「另建」或「合并进既有」（只追加节点，不覆盖既有字段）。
 */
function ConfirmFaceModal({
  face,
  busy,
  onNewContest,
  onMerge,
  onClose,
}: {
  face: ContestImportDraftConfirmStart
  busy: boolean
  onNewContest: () => void
  onMerge: (contestId: number) => void
  onClose: () => void
}) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10, margin: '8px 0' }}>
      <h4 className="panel-title">确认导入（两段式）</h4>
      <p className="dim">
        草稿含 {face.draft.contests.length} 个比赛、{face.draft.contests.reduce((acc, c) => acc + c.nodes.length, 0)} 个节点、
        {face.draft.flags.length} 条 flag。
      </p>
      {face.similar.length > 0 && (
        <div>
          <p>
            <Badge tone="err">相似比赛</Badge> <span className="dim">检测到以下既有比赛可能重复（同名称或名称+年份近似）。选择合并（只追加节点，不改动既有字段/节点）或另建新赛。</span>
          </p>
          {face.similar.map((s) => (
            <div key={s.id} className="recog-row">
              <div className="recog-row-main">
                <span className="recog-row-name">
                  #{s.id} {s.name} {s.year !== null ? `(${s.year})` : ''}
                </span>
                <span className="dim mono">
                  既有节点 {s.nodeCount} 个 · 状态 {s.status}
                </span>
              </div>
              <div className="recog-row-actions">
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => onMerge(s.id)}>
                  合并进 #{s.id}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="form-row" style={{ marginTop: 8 }}>
        <button type="button" className="btn btn-primary btn-small" disabled={busy} onClick={onNewContest}>
          {busy && <Spinner />}另建新比赛
        </button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={onClose}>
          返回编辑
        </button>
      </div>
    </div>
  )
}
