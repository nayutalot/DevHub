/**
 * views/ContestView.tsx — 比赛列表 + 详情左右分栏（CP2 批次，docs/06「比赛视图」
 * 小节 + docs/22 §2/§4）。
 *
 * 数据源：contestpin:list（服务端搜索/状态筛选/含归档开关/分页）。操作：
 * contestpin:create（内联表单：名称/年份/届次/主办方/备注/状态/三链接 URL）；
 * 详情侧 ContestDetailView（编辑 / 归档 / 两段式删除（弹窗展示 impacts）/
 * 节点增删改 / 关联项目选择器）。CP3a 起含「识别设置」折叠面板
 * （RecognitionSettingsPanel：掩码配置列表/新建编辑/连接测试/两段式删除/
 * 默认识别模式，docs/22 §6）。全部数据经真实 IPC，无 mock（约束 #23）；
 * loading/empty/error 三态强制（约束 #24）。
 */

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { BackupPanel } from '../components/BackupPanel.tsx'
import { Badge, stateTone } from '../components/Badge.tsx'
import { DraftReviewPanel } from '../components/DraftReviewPanel.tsx'
import { MaterialImportPanel } from '../components/MaterialImportPanel.tsx'
import { RecognitionSettingsPanel } from '../components/RecognitionSettingsPanel.tsx'
import { ReminderBell } from '../components/ReminderPanels.tsx'
import { EmptyState, ErrorState, Loading, Spinner } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import {
  CONTEST_STATUS_LABEL,
  dueNodeSummary,
} from '../lib/contestFormat.ts'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import { ContestDetailView } from './ContestDetailView.tsx'
import type { ContestListItem, ContestStatus } from '../../../shared/types.ts'

const PAGE_SIZE = 20

const STATUS_OPTIONS: readonly ContestStatus[] = ['watching', 'registered', 'submitted', 'completed', 'given_up']

export function ContestView({ initialContestId }: { initialContestId?: number }) {
  const { refreshKey } = useApp()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'' | ContestStatus>('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [offset, setOffset] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<number | undefined>(initialContestId)

  const list = useAsync(
    () =>
      call('contestpin:list', {
        query: query.trim() === '' ? undefined : query.trim(),
        status: status === '' ? undefined : status,
        archived: includeArchived || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    [refreshKey, query, status, includeArchived, offset],
  )

  // 选中项被删除 / 翻页后消失时回落到当前页第一项
  useEffect(() => {
    if (list.data === null) return
    if (selectedId !== undefined && list.data.items.some((c) => c.id === selectedId)) return
    setSelectedId(list.data.items.length > 0 ? list.data.items[0].id : undefined)
  }, [list.data, selectedId])

  const total = list.data?.total ?? 0
  const items = list.data?.items ?? []

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h2 className="view-title">比赛</h2>
          <p className="view-sub">赛程钉 — 比赛、时间节点与悬浮窗提醒源</p>
        </div>
        <div className="view-actions">
          {/* CP4：顶栏小铃铛（近 24h 已触发/待办聚合，60s 轮询 reminderLogList summary） */}
          <ReminderBell />
          <button type="button" className="btn btn-primary" onClick={() => setCreateOpen((v) => !v)}>
            新建比赛
          </button>
        </div>
      </header>

      {createOpen && (
        <CreateContestForm
          onDone={(created) => {
            setCreateOpen(false)
            list.refresh()
            if (created !== undefined) setSelectedId(created.id)
          }}
          onCancel={() => setCreateOpen(false)}
        />
      )}

      {/* CP3a：识别设置折叠面板（掩码配置列表 / 新建编辑 / 连接测试 / 两段式删除 / 默认模式） */}
      <RecognitionSettingsPanel />

      {/* CP3b：材料导入与识别进度（文件选择/拖入/粘贴截图 → 两阶段状态机轮询） */}
      <MaterialImportPanel />

      {/* CP6：备份导出 / 恢复导入（manifest 零凭据 + materials sha256 复制幂等；
          导入 → 一份待核对草稿走下方核对界面，绝不静默覆盖） */}
      <BackupPanel />

      {/* CP3b：待核对草稿（字段级来源/flags/编辑/相似合并/两段式确认） */}
      <DraftReviewPanel />

      <div className="toolbar" style={{ marginBottom: 8 }}>
        <input
          type="text"
          className="search-input"
          style={{ width: 220 }}
          placeholder="搜索名称 / 年份…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOffset(0)
          }}
        />
        <select
          className="input"
          style={{ width: 140 }}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as '' | ContestStatus)
            setOffset(0)
          }}
          aria-label="按状态筛选"
        >
          <option value="">全部状态</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {CONTEST_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => {
              setIncludeArchived(e.target.checked)
              setOffset(0)
            }}
          />
          含已归档
        </label>
        <span className="dim mono" style={{ marginLeft: 'auto' }}>
          {total > 0 ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} / ${total}` : `共 ${total} 条`}
        </span>
        <button type="button" className="btn btn-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          ← 上一页
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          下一页 →
        </button>
      </div>

      <div className="projects-split">
        <div>
          {list.loading ? (
            <Loading label="正在加载比赛…" />
          ) : list.error !== null ? (
            <ErrorState error={list.error} onRetry={list.refresh} />
          ) : items.length === 0 ? (
            <div className="list-pane">
              {total === 0 && offset === 0 ? (
                <EmptyState
                  title="还没有比赛"
                  hint="手动新建比赛并维护报名/截止节点，悬浮窗将展示临近节点。"
                  action={{ label: '新建比赛', onClick: () => setCreateOpen(true) }}
                />
              ) : (
                <EmptyState title="无匹配结果" hint="调整搜索词、状态筛选或归档开关后重试。" />
              )}
            </div>
          ) : (
            <div className="list-pane">
              {items.map((c) => (
                <ContestListItemRow key={c.id} c={c} selected={c.id === selectedId} onSelect={() => setSelectedId(c.id)} />
              ))}
            </div>
          )}
        </div>

        {selectedId === undefined ? (
          <div className="detail-pane">
            {items.length > 0 || total > 0 ? (
              <EmptyState title="选择一个比赛" hint="在左侧选择比赛查看节点、材料与关联项目。" />
            ) : null}
          </div>
        ) : (
          <ContestDetailView
            key={selectedId}
            id={selectedId}
            onChanged={() => list.refresh()}
            onRemoved={() => {
              setSelectedId(undefined)
              list.refresh()
            }}
          />
        )}
      </div>
    </section>
  )
}

function ContestListItemRow({ c, selected, onSelect }: { c: ContestListItem; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`project-item${selected ? ' selected' : ''}`} onClick={onSelect}>
      <span className="pi-head">
        <span className="pi-name">
          {c.name}
          {c.year !== null && <Badge tone="accent">{c.year}</Badge>}
          {c.archived && <Badge tone="dim">已归档</Badge>}
        </span>
        <Badge tone={stateTone(c.status === 'completed' ? 'done' : c.status)}>{CONTEST_STATUS_LABEL[c.status]}</Badge>
      </span>
      <span className="pi-path">
        {c.dueNode != null ? dueNodeSummary(c.dueNode) : `节点 ${c.nodeCount} 个 · 暂无临近节点`}
      </span>
    </button>
  )
}

/** 新建表单：名称必填，其余可选（三链接 URL 仅 http/https，service 校验）。 */
function CreateContestForm({
  onDone,
  onCancel,
}: {
  onDone: (created?: { id: number }) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState({ name: '', year: '', edition: '', organizer: '', note: '', officialSite: '', signupUrl: '', submitUrl: '' })
  const [status, setStatus] = useState<ContestStatus>('watching')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(key: keyof typeof form, value: string): void {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (submitting) return
    if (form.name.trim() === '') {
      setError('名称必填。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const year = form.year.trim() === '' ? undefined : Number(form.year.trim())
      const created = await call('contestpin:create', {
        name: form.name.trim(),
        year: year !== undefined && Number.isFinite(year) ? year : undefined,
        status,
        edition: form.edition.trim() === '' ? undefined : form.edition.trim(),
        organizer: form.organizer.trim() === '' ? undefined : form.organizer.trim(),
        note: form.note.trim() === '' ? undefined : form.note.trim(),
        officialSite: form.officialSite.trim() === '' ? undefined : form.officialSite.trim(),
        signupUrl: form.signupUrl.trim() === '' ? undefined : form.signupUrl.trim(),
        submitUrl: form.submitUrl.trim() === '' ? undefined : form.submitUrl.trim(),
      })
      onDone({ id: created.id })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="add-form" onSubmit={(e) => void submit(e)}>
      <div className="form-row">
        <span className="field">
          <label htmlFor="cp-name">名称 *</label>
          <input id="cp-name" className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如 ICPC Asia Regional" />
        </span>
        <span className="field">
          <label htmlFor="cp-year">年份</label>
          <input id="cp-year" className="input" value={form.year} onChange={(e) => set('year', e.target.value)} placeholder="2026（可空）" />
        </span>
        <span className="field">
          <label htmlFor="cp-edition">届次</label>
          <input id="cp-edition" className="input" value={form.edition} onChange={(e) => set('edition', e.target.value)} placeholder="第 50 届" />
        </span>
        <span className="field">
          <label htmlFor="cp-status">状态</label>
          <select id="cp-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as ContestStatus)}>
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
          <label htmlFor="cp-organizer">主办方</label>
          <input id="cp-organizer" className="input" value={form.organizer} onChange={(e) => set('organizer', e.target.value)} />
        </span>
        <span className="field">
          <label htmlFor="cp-note">备注</label>
          <input id="cp-note" className="input" value={form.note} onChange={(e) => set('note', e.target.value)} />
        </span>
      </div>
      <div className="form-row">
        <span className="field">
          <label htmlFor="cp-site">官网 URL</label>
          <input id="cp-site" className="input" value={form.officialSite} onChange={(e) => set('officialSite', e.target.value)} placeholder="https://…" />
        </span>
        <span className="field">
          <label htmlFor="cp-signup">报名 URL</label>
          <input id="cp-signup" className="input" value={form.signupUrl} onChange={(e) => set('signupUrl', e.target.value)} placeholder="https://…" />
        </span>
        <span className="field">
          <label htmlFor="cp-submit">提交 URL</label>
          <input id="cp-submit" className="input" value={form.submitUrl} onChange={(e) => set('submitUrl', e.target.value)} placeholder="https://…" />
        </span>
      </div>
      <div className="form-row">
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting && <Spinner />}创建
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
      {error !== null && <p className="form-error">{error}</p>}
    </form>
  )
}
