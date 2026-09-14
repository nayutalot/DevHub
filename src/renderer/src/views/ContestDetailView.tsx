/**
 * views/ContestDetailView.tsx — 比赛详情（CP2 批次，docs/06「比赛视图」小节）。
 *
 * 数据源：contestpin:get（nodes/materials/reminders/关联 project 全量）。操作：
 * contestpin:update（编辑表单）、contestpin:archive（归档/取消归档）、
 * contestpin:delete（CONFIRM_REQUIRED 两段式——第一段回 impacts，确认弹窗展示
 * 节点/材料/提醒计数后才 confirmed）、contestpin:nodeUpsert / nodeDelete
 * （节点增删改；precision 时间语义 docs/22 §2.2）、contestpin:linkProject
 * （关联项目选择器）、contestpin:openLink（官网/报名/提交入口）。
 * CP4 起：节点卡内提醒规则（NodeReminders：contestpin:reminderUpsert 启停/
 * reminderDelete 两段式/编辑器预设+通道多选）与触发记录面板（ReminderLogPanel，
 * contestpin:reminderLogList 按本比赛过滤）。
 * 全部真实 IPC 无 mock（约束 #23）；三态强制（约束 #24）。
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Badge, stateTone } from '../components/Badge.tsx'
import {ErrorState, Loading, Spinner,} from '../components/StateViews.tsx'
import { useToast } from '../components/ToastProvider.tsx'
import { NodeReminders, ReminderLogPanel } from '../components/ReminderPanels.tsx'
import { useApp } from '../lib/appContext.ts'
import {
  CONTEST_NODE_KIND_LABEL,
  CONTEST_NODE_PRECISION_LABEL,
  CONTEST_STATUS_LABEL,
  formatNodeTime,
  formatDateTime,
} from '../lib/contestFormat.ts'
import { relativeTime, toMs } from '../lib/format.ts'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type {
  ContestDetailView as ContestDetailData,
  ContestGetPayload,
  ContestNodeInput,
  ContestNodeKind,
  ContestNodePrecision,
  ContestNodeView,
  ContestStatus,
} from '../../../shared/types.ts'

const STATUS_OPTIONS: readonly ContestStatus[] = ['watching', 'registered', 'submitted', 'completed', 'given_up']
const KIND_OPTIONS: readonly ContestNodeKind[] = [
  'signup_start',
  'signup_deadline',
  'payment_deadline',
  'contest_start',
  'contest_end',
  'submit_deadline',
  'custom',
]
const PRECISION_OPTIONS: readonly ContestNodePrecision[] = ['exact', 'date', 'month', 'tbd']

export function ContestDetailView({
  id,
  onChanged,
  onRemoved,
}: {
  id: number
  onChanged: () => void
  onRemoved: () => void
}) {
  const { refreshKey } = useApp()
  const detail = useAsync(() => call('contestpin:get', { id } as ContestGetPayload), [id, refreshKey])
  const { show } = useToast()
  const [editing, setEditing] = useState(false)
  const [nodeForm, setNodeForm] = useState<{ open: boolean; node: ContestNodeView | null }>({ open: false, node: null })
  const [deleteImpacts, setDeleteImpacts] = useState<{ nodes: number; materials: number; reminders: number } | null>(null)
  const [busy, setBusy] = useState(false)

  if (detail.loading) {
    return (
      <div className="detail-pane">
        <Loading label="正在加载比赛…" />
      </div>
    )
  }
  if (detail.error !== null || detail.data === null) {
    return (
      <div className="detail-pane">
        {detail.error !== null ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : null}
      </div>
    )
  }

  const c = detail.data

  async function run(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    try {
      await fn()
      detail.refresh()
      onChanged()
      return true
    } catch (err) {
      show(`${label}失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function openLink(url: string | undefined, label: string): Promise<void> {
    if (url === undefined) return
    const ok = await run(label, () => call('contestpin:openLink', { url }))
    if (ok) show(`${label}已在默认浏览器打开`)
  }

  async function toggleArchive(): Promise<void> {
    const ok = await run('归档', () => call('contestpin:archive', { id, archived: !c.archived }))
    if (ok) show(c.archived ? '已取消归档' : '已归档')
  }

  /** 两段式删除：第一段拿 impacts → 弹窗确认 → confirmed 级联删。 */
  async function startDelete(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const start = await call('contestpin:delete', { id })
      if (start.confirmRequired === true) {
        setDeleteImpacts(start.impacts)
      }
    } catch (err) {
      show(`删除失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete(): Promise<void> {
    const ok = await run('删除', () => call('contestpin:delete', { id, confirmed: true }))
    setDeleteImpacts(null)
    if (ok) {
      show(`已删除「${c.name}」`)
      onRemoved()
    }
  }

  async function saveNode(input: ContestNodeInput): Promise<boolean> {
    const ok = await run('节点保存', () => call('contestpin:nodeUpsert', { contestId: id, node: input }))
    if (ok) {
      setNodeForm({ open: false, node: null })
      show('节点已保存')
    }
    return ok
  }

  async function toggleNodeDone(n: ContestNodeView): Promise<void> {
    await run('节点状态', () => call('contestpin:nodeUpsert', { contestId: id, node: { id: n.id, done: !n.done } }))
  }

  async function deleteNode(n: ContestNodeView): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const start = await call('contestpin:nodeDelete', { id: n.id })
      const reminders = start.confirmRequired === true ? start.impacts.reminders : 0
      if (window.confirm(`删除节点「${n.label}」？${reminders > 0 ? `该节点下 ${reminders} 条提醒将一并删除。` : ''}`)) {
        await call('contestpin:nodeDelete', { id: n.id, confirmed: true })
        detail.refresh()
        onChanged()
        show('节点已删除')
      }
    } catch (err) {
      show(`节点删除失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="detail-pane">
      <header className="view-header">
        <div>
          <h2 className="view-title mono">{c.name}</h2>
          <p className="view-sub">
            {c.year !== null ? `${c.year} 年` : ''}
            {c.edition !== undefined ? ` · ${c.edition}` : ''}
            {c.organizer !== undefined ? ` · ${c.organizer}` : ''}
          </p>
        </div>
        <div className="view-actions">
          <Badge tone={stateTone(c.status === 'completed' ? 'done' : c.status)}>{CONTEST_STATUS_LABEL[c.status]}</Badge>
          {c.archived && <Badge tone="dim">已归档</Badge>}
        </div>
      </header>

      <div className="actions-row" style={{ marginBottom: 12 }}>
        <button type="button" className="btn" onClick={() => setEditing((v) => !v)}>
          {editing ? '取消编辑' : '编辑'}
        </button>
        {c.officialSite !== undefined && (
          <button type="button" className="btn" disabled={busy} onClick={() => void openLink(c.officialSite, '官网')}>
            官网
          </button>
        )}
        {c.signupUrl !== undefined && (
          <button type="button" className="btn" disabled={busy} onClick={() => void openLink(c.signupUrl, '报名页')}>
            报名
          </button>
        )}
        {c.submitUrl !== undefined && (
          <button type="button" className="btn" disabled={busy} onClick={() => void openLink(c.submitUrl, '提交页')}>
            提交
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={() => void toggleArchive()}>
          {c.archived ? '取消归档' : '归档'}
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void startDelete()}>
          删除
        </button>
      </div>

      {editing && (
        <EditContestForm
          contest={c}
          onDone={() => {
            setEditing(false)
            detail.refresh()
            onChanged()
            show('已保存')
          }}
        />
      )}

      <div className="section">
        <h3 className="section-title">信息</h3>
        <div className="kv-grid">
          <span className="kv-label">备注</span>
          <span className="kv-value plain">{c.note ?? '—'}</span>
          <span className="kv-label">官网</span>
          <span className="kv-value mono">{c.officialSite ?? '—'}</span>
          <span className="kv-label">报名链接</span>
          <span className="kv-value mono">{c.signupUrl ?? '—'}</span>
          <span className="kv-label">提交链接</span>
          <span className="kv-value mono">{c.submitUrl ?? '—'}</span>
          <span className="kv-label">创建时间</span>
          <span className="kv-value plain">{relativeTime(c.createdAt)}</span>
          <span className="kv-label">更新时间</span>
          <span className="kv-value plain">{relativeTime(c.updatedAt)}</span>
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">
          时间节点（{c.nodes.length}）{c.dueNode != null ? ' · 当前：' + c.dueNode.label : ''}
        </h3>
        <div className="actions-row" style={{ marginBottom: 8 }}>
          <button type="button" className="btn btn-small" onClick={() => setNodeForm({ open: true, node: null })}>
            + 添加节点
          </button>
        </div>
        {c.nodes.length === 0 ? (
          <div className="inline-note">还没有节点 — 添加报名/截止/比赛时间后悬浮窗会展示临近节点。</div>
        ) : (
          c.nodes.map((n) => (
            <div key={n.id} className="repo-card">
              <div className="repo-line">
                <Badge tone="accent">{CONTEST_NODE_KIND_LABEL[n.kind]}</Badge>
                <strong>{n.label}</strong>
                {n.done ? <Badge tone="ok">已完成</Badge> : <Badge tone="warn">未完成</Badge>}
                {c.dueNode?.nodeId === n.id && c.dueNode.overdue && <Badge tone="err">过期未完成</Badge>}
              </div>
              <div className="repo-meta">
                {formatNodeTime(n)}（{CONTEST_NODE_PRECISION_LABEL[n.precision]}）
                {n.rawText !== undefined ? ` · 原文：${n.rawText}` : ''}
                {n.done && n.doneAt != null ? ` · 完成于 ${formatDateTime(toMs(n.doneAt))}` : ''}
              </div>
              <div className="actions-row" style={{ marginTop: 6 }}>
                <button type="button" className="btn btn-small" disabled={busy} onClick={() => void toggleNodeDone(n)}>
                  {n.done ? '标为未完成' : '标为已完成'}
                </button>
                <button type="button" className="btn btn-small" onClick={() => setNodeForm({ open: true, node: n })}>
                  编辑
                </button>
                <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => void deleteNode(n)}>
                  删除
                </button>
              </div>
              {/* CP4 提醒规则（任务书 §1.3 #8）：该节点提醒行 + 添加/编辑器入口 */}
              <NodeReminders
                node={n}
                reminders={c.reminders.filter((r) => r.nodeId === n.id)}
                notify={show}
                onChanged={() => {
                  detail.refresh()
                  onChanged()
                }}
              />
            </div>
          ))
        )}
      </div>

      {nodeForm.open && (
        <NodeForm
          node={nodeForm.node}
          onDone={saveNode}
          onCancel={() => setNodeForm({ open: false, node: null })}
        />
      )}

      <LinkedProjectSection contestId={id} linkedProject={c.project} onChanged={() => { detail.refresh(); onChanged() }} />

      {/* CP4：闹钟触发记录面板（近触发账本，按本比赛过滤，任务书 §1.3 #8） */}
      <ReminderLogPanel contestId={id} contestName={c.name} />

      {deleteImpacts !== null && (
        <div className="cp-modal-overlay" role="dialog" aria-modal="true">
          <div className="cp-modal">
            <h3 className="section-title">确认删除「{c.name}」？</h3>
            <div className="kv-grid">
              <span className="kv-label">时间节点</span>
              <span className="kv-value">{deleteImpacts.nodes} 个（级联删除）</span>
              <span className="kv-label">提醒</span>
              <span className="kv-value">{deleteImpacts.reminders} 条（级联删除）</span>
              <span className="kv-label">材料引用</span>
              <span className="kv-value">{deleteImpacts.materials} 份</span>
            </div>
            <p className="form-error">该操作不可撤销（材料文件本体保留在数据目录，仅解除引用）。</p>
            <div className="form-row">
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirmDelete()}>
                确认删除
              </button>
              <button type="button" className="btn" onClick={() => setDeleteImpacts(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ---------------------------------------------------------------------------
// 编辑表单
// ---------------------------------------------------------------------------

function EditContestForm({ contest, onDone }: { contest: ContestDetailData; onDone: () => void }) {
  const [form, setForm] = useState({
    name: contest.name,
    year: contest.year === null ? '' : String(contest.year),
    edition: contest.edition ?? '',
    organizer: contest.organizer ?? '',
    note: contest.note ?? '',
    officialSite: contest.officialSite ?? '',
    signupUrl: contest.signupUrl ?? '',
    submitUrl: contest.submitUrl ?? '',
  })
  const [status, setStatus] = useState<ContestStatus>(contest.status)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(key: keyof typeof form, value: string): void {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const year = form.year.trim() === '' ? null : Number(form.year.trim())
      await call('contestpin:update', {
        id: contest.id,
        patch: {
          name: form.name.trim(),
          year: year !== null && Number.isFinite(year) ? year : null,
          status,
          edition: form.edition,
          organizer: form.organizer,
          note: form.note,
          officialSite: form.officialSite,
          signupUrl: form.signupUrl,
          submitUrl: form.submitUrl,
        },
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="add-form" onSubmit={(e) => void submit(e)} style={{ marginBottom: 12 }}>
      <div className="form-row">
        <span className="field">
          <label htmlFor="cpe-name">名称 *</label>
          <input id="cpe-name" className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </span>
        <span className="field">
          <label htmlFor="cpe-year">年份（空 = 不编造）</label>
          <input id="cpe-year" className="input" value={form.year} onChange={(e) => set('year', e.target.value)} />
        </span>
        <span className="field">
          <label htmlFor="cpe-status">状态</label>
          <select id="cpe-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as ContestStatus)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {CONTEST_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </span>
      </div>
      <div className="form-row">
        <span className="field">
          <label htmlFor="cpe-edition">届次</label>
          <input id="cpe-edition" className="input" value={form.edition} onChange={(e) => set('edition', e.target.value)} />
        </span>
        <span className="field">
          <label htmlFor="cpe-organizer">主办方</label>
          <input id="cpe-organizer" className="input" value={form.organizer} onChange={(e) => set('organizer', e.target.value)} />
        </span>
        <span className="field">
          <label htmlFor="cpe-note">备注</label>
          <input id="cpe-note" className="input" value={form.note} onChange={(e) => set('note', e.target.value)} />
        </span>
      </div>
      <div className="form-row">
        <span className="field">
          <label htmlFor="cpe-site">官网 URL（空 = 清空）</label>
          <input id="cpe-site" className="input" value={form.officialSite} onChange={(e) => set('officialSite', e.target.value)} />
        </span>
        <span className="field">
          <label htmlFor="cpe-signup">报名 URL（空 = 清空）</label>
          <input id="cpe-signup" className="input" value={form.signupUrl} onChange={(e) => set('signupUrl', e.target.value)} />
        </span>
        <span className="field">
          <label htmlFor="cpe-submit">提交 URL（空 = 清空）</label>
          <input id="cpe-submit" className="input" value={form.submitUrl} onChange={(e) => set('submitUrl', e.target.value)} />
        </span>
      </div>
      <div className="form-row">
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting && <Spinner />}保存
        </button>
      </div>
      {error !== null && <p className="form-error">{error}</p>}
    </form>
  )
}

// ---------------------------------------------------------------------------
// 节点表单（新增 / 编辑；precision 感知时间输入）
// ---------------------------------------------------------------------------

/** 输入值 → unix 秒（本地时区；date/month 按该时区当日/当月 1 日 00:00，docs/22 §2.2）。 */
function timeInputToSec(value: string, precision: ContestNodePrecision): number | null {
  if (value.trim() === '') return null
  if (precision === 'month') {
    const m = value.trim().match(/^(\d{4})-(\d{1,2})$/)
    if (m === null) return null
    return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime() / 1000)
  }
  if (precision === 'date') {
    const m = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (m === null) return null
    return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() / 1000)
  }
  const ms = new Date(value.trim()).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

function secToTimeInput(sec: number | null, precision: ContestNodePrecision): string {
  if (sec === null || precision === 'tbd') return ''
  const d = new Date(toMs(sec))
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n))
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  if (precision === 'month') return date.slice(0, 7)
  if (precision === 'date') return date
  return `${date}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function NodeForm({
  node,
  onDone,
  onCancel,
}: {
  /** contestId 由父级 saveNode 闭包持有（upsert payload 在 ContestDetailView 组装）。 */
  node: ContestNodeView | null
  onDone: (input: ContestNodeInput) => Promise<boolean>
  onCancel: () => void
}) {
  const [kind, setKind] = useState<ContestNodeKind>(node?.kind ?? 'signup_deadline')
  const [label, setLabel] = useState(node?.label ?? '')
  const [precision, setPrecision] = useState<ContestNodePrecision>(node?.precision ?? 'exact')
  const [startAt, setStartAt] = useState(secToTimeInput(node?.startAt ?? null, node?.precision ?? 'exact'))
  const [endAt, setEndAt] = useState(secToTimeInput(node?.endAt ?? null, node?.precision ?? 'exact'))
  const [done, setDone] = useState(node?.done ?? false)
  const [rawText, setRawText] = useState(node?.rawText ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function switchPrecision(next: ContestNodePrecision): void {
    setPrecision(next)
    // 精度切换时保留已有时刻的日期部分（重新格式化输入框）
    const baseSec = timeInputToSec(startAt, precision)
    setStartAt(secToTimeInput(baseSec, next))
    const endSec = timeInputToSec(endAt, precision)
    setEndAt(secToTimeInput(endSec, next))
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const startSec = timeInputToSec(startAt, precision)
      const endSec = timeInputToSec(endAt, precision)
      if (precision === 'tbd') {
        // tbd 强制 null（service 校验同语义）
      } else if (startSec === null) {
        setError('该精度需要提供开始时间。')
        return
      }
      const payload: ContestNodeInput = {
        ...(node !== null ? { id: node.id } : {}),
        kind,
        label: label.trim() === '' ? undefined : label.trim(),
        precision,
        done,
        ...(precision === 'tbd' ? {} : { startAt: startSec, endAt: endSec }),
        ...(rawText.trim() !== '' ? { rawText: rawText.trim() } : {}),
      }
      const ok = await onDone(payload)
      if (!ok) setSubmitting(false)
    } finally {
      setSubmitting(false)
    }
  }

  const timeInputType = precision === 'month' ? 'month' : precision === 'date' ? 'date' : 'datetime-local'

  return (
    <form className="add-form" onSubmit={(e) => void submit(e)} style={{ marginBottom: 12 }}>
      <div className="form-row">
        <span className="field">
          <label htmlFor="cpn-kind">节点类型</label>
          <select id="cpn-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as ContestNodeKind)}>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {CONTEST_NODE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </span>
        <span className="field">
          <label htmlFor="cpn-label">名称（custom 必填）</label>
          <input id="cpn-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如 校内报名截止" />
        </span>
        <span className="field">
          <label htmlFor="cpn-precision">时间精度</label>
          <select id="cpn-precision" className="input" value={precision} onChange={(e) => switchPrecision(e.target.value as ContestNodePrecision)}>
            {PRECISION_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {CONTEST_NODE_PRECISION_LABEL[p]}
              </option>
            ))}
          </select>
        </span>
      </div>
      {precision !== 'tbd' && (
        <div className="form-row">
          <span className="field">
            <label htmlFor="cpn-start">{precision === 'date' ? '日期' : precision === 'month' ? '年月' : '开始时刻'} *</label>
            <input id="cpn-start" className="input" type={timeInputType} value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </span>
          <span className="field">
            <label htmlFor="cpn-end">结束（可选）</label>
            <input id="cpn-end" className="input" type={timeInputType} value={endAt} onChange={(e) => setEndAt(e.target.value)} />
          </span>
          {node !== null && node.precision !== 'exact' && precision === 'exact' && (
            <span className="field">
              <label htmlFor="cpn-raw">原文依据（低精度提升 exact 必填）</label>
              <input id="cpn-raw" className="input" value={rawText} onChange={(e) => setRawText(e.target.value)} placeholder="通知原文摘录" />
            </span>
          )}
        </div>
      )}
      <div className="form-row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
          已完成
        </label>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting && <Spinner />}保存节点
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
      {error !== null && <p className="form-error">{error}</p>}
    </form>
  )
}

// ---------------------------------------------------------------------------
// 关联项目（resources + relationships `uses` 边，docs/22 §2.3）
// ---------------------------------------------------------------------------

function LinkedProjectSection({
  contestId,
  linkedProject,
  onChanged,
}: {
  contestId: number
  linkedProject: { id: number; name: string } | null
  onChanged: () => void
}) {
  const projects = useAsync(() => call('projects:list', {}), [])
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  async function link(projectId: number | null): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await call('contestpin:linkProject', { contestId, projectId })
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="section">
      <h3 className="section-title">关联项目</h3>
      {linkedProject !== null ? (
        <div className="actions-row">
          <span>
            当前关联：<strong className="mono">{linkedProject.name}</strong>
          </span>
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void link(null)}>
            取消关联
          </button>
        </div>
      ) : projects.data === null || projects.data.length === 0 ? (
        <div className="inline-note">暂无项目可关联（先在 Projects 页添加项目）。</div>
      ) : (
        <div className="actions-row">
          <select className="input" style={{ width: 240 }} value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="选择要关联的项目">
            <option value="">选择项目…</option>
            {projects.data.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-small"
            disabled={busy || selected === ''}
            onClick={() => void link(Number(selected))}
          >
            关联
          </button>
        </div>
      )}
      {error !== null && <p className="form-error">{error}</p>}
    </div>
  )
}
