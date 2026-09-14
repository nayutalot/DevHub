/**
 * components/ReminderPanels.tsx — ContestPin 提醒 UI 三件（CP4 批次，docs/22 §7
 * + 任务书 §1.2 #6 / §1.3 #8）：
 *
 *  - ReminderBell：ContestView 顶栏小铃铛——轮询 contestpin:reminderLogList 的
 *    summary 聚合（近 24h 已触发 / 未来 24h 待办；60s 节拍与引擎桶扫同频，
 *    refreshKey 变化即刷新；无推送面，docs/22 §7.1）。三态强制（约束 #24）。
 *  - NodeReminders：ContestDetailView 节点卡内的提醒规则行（启停/删除两段式）+
 *    「添加提醒」入口。
 *  - ReminderEditor：提醒编辑器——预设 7/3/1 天快捷 + 自定义
 *    before_days/before_hours/at_time + 通道 windows/in_app 多选（一行规则一个
 *    channel，多选即逐通道各建一条）+ 启停；before_hours 仅 exact 节点
 *    （服务端 BAD_PAYLOAD 权威，前端按 node.precision 预判禁用）。
 *  - ReminderLogPanel：闹钟触发记录面板（近触发账本，按当前比赛过滤展示）。
 *
 * 全部真实 IPC 无 mock（约束 #23）；删除为 CONFIRM_REQUIRED 两段式
 * （应用内确认弹窗展示 impacts.logRows，nodeDelete 先例）。
 */

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Badge } from './Badge.tsx'
import { EmptyState, ErrorState, Loading, Spinner } from './StateViews.tsx'
import { useConfirm } from './ConfirmDialog.tsx'
import { useApp } from '../lib/appContext.ts'
import { formatDateTime, reminderOffsetText } from '../lib/contestFormat.ts'
import { toMs } from '../lib/format.ts'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type {
  ContestReminderChannel,
  ContestReminderLogEntry,
  ContestReminderOffsetKind,
  ContestReminderView,
  ContestNodeView,
} from '../../../shared/types.ts'

type Notify = (text: string, tone?: 'ok' | 'err') => void

const CHANNEL_OPTIONS: readonly { value: ContestReminderChannel; label: string }[] = [
  { value: 'windows', label: '系统通知' },
  { value: 'in_app', label: '应用内记录' },
]

// ---------------------------------------------------------------------------
// 顶栏小铃铛（近 24h 已触发 / 未来 24h 待办；60s 轮询聚合，无推送面）
// ---------------------------------------------------------------------------

function BellIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: '-2px' }}
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  )
}

export function ReminderBell() {
  const { refreshKey } = useApp()
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error'
    fired: number
    upcoming: number
  }>({ status: 'loading', fired: 0, upcoming: 0 })

  useEffect(() => {
    let alive = true
    async function tick(): Promise<void> {
      try {
        // limit=1：铃铛只要服务端 summary 聚合（entries 面由触发记录面板按需拉全量）
        const res = await call('contestpin:reminderLogList', { limit: 1 })
        if (alive) setState({ status: 'ready', fired: res.summary.firedLast24h, upcoming: res.summary.upcoming24h })
      } catch {
        if (alive) setState((s) => ({ ...s, status: 'error' }))
      }
    }
    void tick()
    const handle = setInterval(() => void tick(), 60_000)
    return () => {
      alive = false
      clearInterval(handle)
    }
  }, [refreshKey])

  if (state.status === 'loading') {
    return (
      <span className="dim" title="提醒状态加载中">
        <BellIcon /> 提醒 …
      </span>
    )
  }
  if (state.status === 'error') {
    return (
      <span className="dim" title="提醒状态不可用（contestpin:reminderLogList 失败）">
        <BellIcon /> 提醒状态不可用
      </span>
    )
  }
  return (
    <span
      className="dim"
      title={`近 24h 已触发 ${state.fired} 条 · 未来 24h 待触发 ${state.upcoming} 条（60s 轮询）`}
    >
      <BellIcon /> 已触发 {state.fired} · 待办 {state.upcoming}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 节点卡提醒规则行 + 添加入口
// ---------------------------------------------------------------------------

export function NodeReminders({
  node,
  reminders,
  notify,
  onChanged,
}: {
  node: ContestNodeView
  reminders: ContestReminderView[]
  notify: Notify
  onChanged: () => void
}) {
  const [editorOpen, setEditorOpen] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const confirm = useConfirm()

  async function toggleEnabled(r: ContestReminderView): Promise<void> {
    if (busyId !== null) return
    setBusyId(r.id)
    try {
      await call('contestpin:reminderUpsert', {
        nodeId: node.id,
        rule: { offsetKind: r.offsetKind, offsetValue: r.offsetValue, channel: r.channel, enabled: !r.enabled },
      })
      onChanged()
      notify(r.enabled ? '提醒已停用' : '提醒已启用')
    } catch (err) {
      notify(`提醒状态切换失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusyId(null)
    }
  }

  /** 两段式删除：第一段拿 impacts.logRows → 应用内确认（D5-M5 A5）→ confirmed。 */
  async function remove(r: ContestReminderView): Promise<void> {
    if (busyId !== null) return
    setBusyId(r.id)
    try {
      const start = await call('contestpin:reminderDelete', { id: r.id })
      const logRows = start.confirmRequired === true ? start.impacts.logRows : 0
      if (
        await confirm({
          body:
            `删除提醒「${reminderOffsetText(r.offsetKind, r.offsetValue)} · ${r.channel === 'windows' ? '系统通知' : '应用内记录'}」？` +
            (logRows > 0 ? `其 ${logRows} 条触发记录将一并删除。` : ''),
          danger: true,
          confirmLabel: '删除',
        })
      ) {
        await call('contestpin:reminderDelete', { id: r.id, confirmed: true })
        onChanged()
        notify('提醒已删除')
      }
    } catch (err) {
      notify(`提醒删除失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div style={{ marginTop: 6 }}>
      {reminders.length > 0 && (
        <div className="repo-meta" style={{ marginBottom: 4 }}>
          {reminders.map((r) => (
            <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 10 }}>
              <span className="mono">{reminderOffsetText(r.offsetKind, r.offsetValue)}</span>
              <Badge tone={r.channel === 'windows' ? 'accent' : 'dim'}>
                {r.channel === 'windows' ? '系统通知' : '应用内'}
              </Badge>
              {!r.enabled && <Badge tone="warn">已停用</Badge>}
              <button
                type="button"
                className="btn btn-small"
                disabled={busyId !== null}
                onClick={() => void toggleEnabled(r)}
              >
                {r.enabled ? '停用' : '启用'}
              </button>
              <button
                type="button"
                className="btn btn-small btn-danger"
                disabled={busyId !== null}
                onClick={() => void remove(r)}
              >
                删除
              </button>
            </span>
          ))}
        </div>
      )}
      {editorOpen ? (
        <ReminderEditor
          node={node}
          onDone={(count) => {
            setEditorOpen(false)
            onChanged()
            notify(count > 1 ? `已添加 ${count} 条提醒` : '提醒已保存')
          }}
          onCancel={() => setEditorOpen(false)}
        />
      ) : (
        <button type="button" className="btn btn-small" onClick={() => setEditorOpen(true)}>
          {reminders.length > 0 ? '+ 添加提醒' : '添加提醒'}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 提醒编辑器（预设快捷 + 自定义 + 通道多选 + 启停）
// ---------------------------------------------------------------------------

function ReminderEditor({
  node,
  onDone,
  onCancel,
}: {
  node: ContestNodeView
  onDone: (created: number) => void
  onCancel: () => void
}) {
  const [offsetKind, setOffsetKind] = useState<ContestReminderOffsetKind>('before_days')
  const [offsetValue, setOffsetValue] = useState('7')
  const [channels, setChannels] = useState<ContestReminderChannel[]>(['windows'])
  const [enabled, setEnabled] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hoursIllegal = offsetKind === 'before_hours' && node.precision !== 'exact'
  const valueRequired = offsetKind !== 'at_time'

  function applyPreset(days: number): void {
    setOffsetKind('before_days')
    setOffsetValue(String(days))
  }

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (submitting) return
    if (channels.length === 0) {
      setError('至少选择一个通道（系统通知 / 应用内记录）。')
      return
    }
    let value = 0
    if (valueRequired) {
      const parsed = Number(offsetValue.trim())
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        setError('提前量必须是非负整数。')
        return
      }
      value = parsed
    }
    if (hoursIllegal) {
      setError('before_hours 仅适用于「精确时刻」节点（date/month 节点请用提前天数）。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      for (const channel of channels) {
        await call('contestpin:reminderUpsert', {
          nodeId: node.id,
          rule: { offsetKind, offsetValue: value, channel, enabled },
        })
      }
      onDone(channels.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="add-form" onSubmit={(e) => void submit(e)} style={{ marginBottom: 8 }}>
      <div className="form-row">
        <span className="field">
          <label htmlFor={`cpr-preset-${node.id}`}>快捷预设</label>
          <span className="actions-row" id={`cpr-preset-${node.id}`}>
            {[7, 3, 1].map((d) => (
              <button
                key={d}
                type="button"
                className="btn btn-small"
                disabled={submitting}
                onClick={() => applyPreset(d)}
              >
                提前 {d} 天
              </button>
            ))}
          </span>
        </span>
        <span className="field">
          <label htmlFor={`cpr-kind-${node.id}`}>提醒方式</label>
          <select
            id={`cpr-kind-${node.id}`}
            className="input"
            value={offsetKind}
            onChange={(e) => setOffsetKind(e.target.value as ContestReminderOffsetKind)}
          >
            <option value="before_days">提前天数（date 节点=当日 09:00）</option>
            <option value="before_hours">提前小时（仅精确时刻节点）</option>
            <option value="at_time">准时（开始时刻本身）</option>
          </select>
        </span>
        {valueRequired && (
          <span className="field">
            <label htmlFor={`cpr-value-${node.id}`}>{offsetKind === 'before_days' ? '提前天数' : '提前小时'}</label>
            <input
              id={`cpr-value-${node.id}`}
              className="input"
              style={{ width: 90 }}
              type="number"
              min={0}
              step={1}
              value={offsetValue}
              onChange={(e) => setOffsetValue(e.target.value)}
              disabled={submitting}
            />
          </span>
        )}
      </div>
      <div className="form-row">
        <span className="field">
          <label>通道（可多选）</label>
          <span className="actions-row">
            {CHANNEL_OPTIONS.map((opt) => (
              <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={channels.includes(opt.value)}
                  onChange={(e) =>
                    setChannels((cs) => (e.target.checked ? [...cs, opt.value] : cs.filter((c) => c !== opt.value)))
                  }
                />
                {opt.label}
              </label>
            ))}
          </span>
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'end' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用
        </label>
      </div>
      {hoursIllegal && <p className="form-error">该节点精度为「{node.precision}」——提前小时仅适用于精确时刻节点。</p>}
      {error !== null && <p className="form-error">{error}</p>}
      <div className="form-row">
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting && <Spinner />}保存提醒
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// 触发记录面板（近触发账本，按当前比赛过滤；三态强制）
// ---------------------------------------------------------------------------

export function ReminderLogPanel({ contestId, contestName }: { contestId: number; contestName: string }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <div className="recog-collapsed">
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
          提醒触发记录 ▸
        </button>
        <span className="dim">闹钟账本（contest_reminder_log，近触发列表）</span>
      </div>
    )
  }
  return <ReminderLogPanelOpen contestId={contestId} contestName={contestName} onClose={() => setOpen(false)} />
}

function ReminderLogPanelOpen({
  contestId,
  contestName,
  onClose,
}: {
  contestId: number
  contestName: string
  onClose: () => void
}) {
  const list = useAsync(() => call('contestpin:reminderLogList', { limit: 100 }), [])
  const entries: ContestReminderLogEntry[] = (list.data?.entries ?? []).filter((e) => e.contestId === contestId)

  return (
    <div className="section">
      <h3 className="section-title">
        提醒触发记录（{entries.length}）— {contestName}
      </h3>
      <div className="actions-row" style={{ marginBottom: 8 }}>
        <button type="button" className="btn btn-small" onClick={onClose}>
          收起
        </button>
        <button type="button" className="btn btn-small" onClick={() => list.refresh()}>
          刷新
        </button>
      </div>
      {list.loading ? (
        <Loading label="正在加载触发记录…" />
      ) : list.error !== null ? (
        <ErrorState error={list.error} onRetry={list.refresh} />
      ) : entries.length === 0 ? (
        <EmptyState title="还没有触发记录" hint="提醒到期（含补发）后会计入账本，去重键 = reminder + fire_key。" />
      ) : (
        entries.map((e) => (
          <div key={e.id} className="repo-card">
            <div className="repo-line">
              <Badge tone={e.channel === 'windows' ? 'accent' : 'dim'}>
                {e.channel === 'windows' ? '系统通知' : '应用内'}
              </Badge>
              <strong>{e.nodeLabel}</strong>
              <span className="dim">{reminderOffsetText(e.offsetKind, e.offsetValue)}</span>
            </div>
            <div className="repo-meta">
              计划 {formatDateTime(toMs(e.fireAt))} · 触发于 {formatDateTime(toMs(e.createdAt))}
              <span className="mono dim"> · {e.fireKey}</span>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
