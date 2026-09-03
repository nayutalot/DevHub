/**
 * views/ApiHubView.tsx — ApiHub 接口中心视图（S3 批次，docs/09 §6/§9）。
 *
 * 布局：provider 分组卡片（可用 / N/A 徽章）→ 每 provider 的档案列表（名称、
 * mask 后的 key 尾 4 位、active 徽章（readCurrent 反推）、编辑/删除）→ 新增/编辑
 * 表单（key 输入框 password 型，提交后立即 mask 显示）→ Switch 两段确认：
 * 第一段展示 impacts（将写入哪些文件、检测到的运行中进程），第二段执行并逐文件
 * 展示结果（失败文件标红 + 已回滚提示）。
 *
 * 无 mock：全部数据来自 apihub:* channels；三态用 StateViews；UI 绝不持有 key 明文
 * （输入框 value 提交后清空，展示一律 tail·len 形态）。
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Badge } from '../components/Badge.tsx'
import type { BadgeTone } from '../components/Badge.tsx'
import { EmptyState, ErrorState, Loading, Toast, useToast } from '../components/StateViews.tsx'
import { useApp } from '../lib/appContext.ts'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type {
  ApiHubAdapterEntry,
  ApiHubAdapterId,
  ApiHubFileResult,
  ApiHubProfilesResult,
  ApiHubSwitchImpacts,
} from '../../../shared/types.ts'

interface ProviderData {
  adapter: ApiHubAdapterEntry
  profiles: ApiHubProfilesResult
}

interface LoadData {
  providers: ProviderData[]
}

interface SwitchFeedback {
  adapter: ApiHubAdapterId
  files: ApiHubFileResult[]
  backupFiles: string[]
  failed?: boolean
  error?: string
  warning?: string
}

/** version state → 徽章 tone 不适用于本视图；available/needsRekey/plainStore → tone。 */
function availabilityTone(available: boolean): BadgeTone {
  return available ? 'ok' : 'dim'
}

export function ApiHubView() {
  const { refreshKey } = useApp()
  const { toast, show } = useToast()
  const data = useAsync<LoadData>(async () => {
    const adaptersResult = await call('apihub:adapters', {})
    const providers = await Promise.all(
      adaptersResult.adapters.map(async (adapter) => ({
        adapter,
        profiles: await call('apihub:profiles', { adapterId: adapter.id }),
      })),
    )
    return { providers }
  }, [refreshKey])

  const [busy, setBusy] = useState<string | null>(null)
  const [formOpenFor, setFormOpenFor] = useState<string | null>(null)
  const [switchConfirm, setSwitchConfirm] = useState<{ adapterId: ApiHubAdapterId; id: number; impacts: ApiHubSwitchImpacts } | null>(null)
  const [switchResult, setSwitchResult] = useState<SwitchFeedback | null>(null)

  const providers = data.data?.providers ?? []

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

  function handleDelete(adapterId: ApiHubAdapterId, id: number, name: string): void {
    if (!window.confirm(`删除档案「${name}」？该操作不可撤销（目标配置文件不受影响）。`)) return
    void runAction('删除档案', async () => {
      await call('apihub:deleteProfile', { adapterId, id })
      show('档案已删除')
      data.refresh()
    })
  }

  function handleSwitchStart(adapterId: ApiHubAdapterId, id: number): void {
    void runAction('切换预检', async () => {
      const r = await call('apihub:switch', { adapterId, id })
      if (r.confirmRequired === true) {
        setSwitchConfirm({ adapterId, id, impacts: r.impacts })
        setSwitchResult(null)
        return
      }
      setSwitchResult(toFeedback(adapterId, r))
      data.refresh()
    })
  }

  function handleSwitchConfirm(): void {
    if (switchConfirm === null) return
    const { adapterId, id } = switchConfirm
    setSwitchConfirm(null)
    void runAction('切换', async () => {
      const r = await call('apihub:switch', { adapterId, id, confirmed: true })
      if (r.confirmRequired === true) return
      setSwitchResult(toFeedback(adapterId, r))
      show(r.failed === true ? '切换失败（已回滚）' : '切换完成', r.failed === true ? 'err' : 'ok')
      data.refresh()
    })
  }

  function toFeedback(adapterId: ApiHubAdapterId, r: { files: ApiHubFileResult[]; backupFiles: string[]; failed?: boolean; error?: string; warning?: string }): SwitchFeedback {
    return { adapter: adapterId, files: r.files, backupFiles: r.backupFiles, failed: r.failed, error: r.error, warning: r.warning }
  }

  return (
    <div>
      <div className="view-header">
        <span className="view-title">ApiHub 接口中心</span>
        <span className="view-sub">API 档案管理与一键切换（key 全程脱敏，仅展示尾 4 位）</span>
        <div className="view-actions">
          <button type="button" className="btn" onClick={data.refresh} disabled={data.loading}>
            Refresh
          </button>
        </div>
      </div>

      {data.loading && <Loading label="Loading adapters…" />}
      {data.error !== null && <ErrorState error={data.error} onRetry={data.refresh} />}

      {data.data !== null && providers.length === 0 && (
        <EmptyState title="没有适配器" hint="适配器目录为空（异常状态，请重启应用）" />
      )}

      <div className="agent-grid">
        {providers.map(({ adapter, profiles }) => (
          <AdapterCard
            key={adapter.id}
            adapter={adapter}
            profiles={profiles}
            busy={busy !== null}
            formOpen={formOpenFor === adapter.id}
            onToggleForm={() => setFormOpenFor(formOpenFor === adapter.id ? null : adapter.id)}
            onSaved={() => {
              setFormOpenFor(null)
              data.refresh()
              show('档案已保存（key 已加密入库）')
            }}
            onDelete={(id, name) => handleDelete(adapter.id, id, name)}
            onSwitch={(id) => handleSwitchStart(adapter.id, id)}
            switchConfirmActive={switchConfirm !== null && switchConfirm.adapterId === adapter.id}
          />
        ))}
      </div>

      {switchConfirm !== null && (
        <div className="import-overlay" role="dialog" aria-modal="true">
          <div className="import-dialog">
            <div className="import-confirm">
              <strong>确认切换（第 2 段确认）</strong>
              <div className="import-plan">
                <div>将写入以下目标文件：</div>
                {switchConfirm.impacts.files.map((f) => (
                  <div key={f} className="mono pi-path">
                    {f}
                  </div>
                ))}
                <div style={{ marginTop: 6 }}>
                  检测到的运行中进程：
                  {switchConfirm.impacts.processes.length === 0 ? (
                    <span className="dim"> 无</span>
                  ) : (
                    switchConfirm.impacts.processes.map((p) => (
                      <span key={p.pid} className="mono">
                        {' '}
                        {p.name}(pid {p.pid})
                      </span>
                    ))
                  )}
                </div>
                {switchConfirm.impacts.warning !== undefined && <div className="warn-detail">{switchConfirm.impacts.warning}</div>}
              </div>
              <div className="import-footer">
                <button type="button" className="btn" onClick={() => setSwitchConfirm(null)}>
                  取消
                </button>
                <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={handleSwitchConfirm}>
                  确认执行切换
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {switchResult !== null && (
        <div className={`feedback${switchResult.failed === true ? ' feedback-err' : ''}`}>
          <strong>
            {switchResult.failed === true ? `切换失败：${switchResult.adapter}` : `切换完成：${switchResult.adapter}`}
          </strong>
          <div className="feedback-lines">
            {switchResult.files.map((f) => (
              <div key={f.path} className={f.rolledBack === true || f.written === false ? 'cell-error' : undefined}>
                {f.rolledBack === true
                  ? `✗ ${f.path} — 已回滚（恢复自备份）`
                  : f.written
                    ? `✓ ${f.path}`
                    : `✗ ${f.path} — 未写入（此前不存在，已清理）`}
                {f.error !== undefined ? ` · ${f.error}` : ''}
              </div>
            ))}
            {switchResult.backupFiles.map((b) => (
              <div key={b} className="dim">
                备份: {b}
              </div>
            ))}
            {switchResult.error !== undefined && <div className="cell-error">{switchResult.error}</div>}
            {switchResult.warning !== undefined && <div className="warn-detail">{switchResult.warning}</div>}
          </div>
        </div>
      )}

      <Toast toast={toast} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Provider 卡片：适配器信息 + 档案列表 + 新增/编辑表单
// ---------------------------------------------------------------------------

function AdapterCard({
  adapter,
  profiles,
  busy,
  formOpen,
  onToggleForm,
  onSaved,
  onDelete,
  onSwitch,
  switchConfirmActive,
}: {
  adapter: ApiHubAdapterEntry
  profiles: ApiHubProfilesResult
  busy: boolean
  formOpen: boolean
  onToggleForm: () => void
  onSaved: () => void
  onDelete: (id: number, name: string) => void
  onSwitch: (id: number) => void
  switchConfirmActive: boolean
}) {
  const [editing, setEditing] = useState<{ id: number; name: string; fields: Record<string, string> } | null>(null)

  return (
    <div className="agent-card">
      <div className="agent-card-head">
        <span className="agent-name">{adapter.label}</span>
        <Badge tone={availabilityTone(adapter.available)}>{adapter.available ? '可用' : 'N/A'}</Badge>
        {profiles.activeId !== null && <Badge tone="accent">当前生效</Badge>}
      </div>

      {!adapter.available ? (
        <div className="inline-note">{adapter.naReason ?? '该适配器不可用'}</div>
      ) : (
        <>
          <div className="agent-dir mono">{adapter.targetPaths.join('  +  ')}</div>
          {adapter.notes.map((n) => (
            <div key={n} className="dim skill-desc">
              · {n}
            </div>
          ))}

          <div className="section">
            <div className="section-title">档案（{profiles.profiles.length}）</div>
            {profiles.profiles.length === 0 && <div className="inline-note">暂无档案，点击「新增档案」创建。</div>}
            {profiles.profiles.map((p) => (
              <div key={p.id} className="svc-row">
                <span>
                  <strong>{p.name}</strong>
                  <span className="mono td-mono">
                    {' '}
                    key: {p.apiKeyTail !== null ? `***${p.apiKeyTail}` : '—'}（{p.apiKeyLen ?? '?'} 位）
                  </span>
                </span>
                <span className="agent-counts">
                  {profiles.activeId === p.id && <Badge tone="ok">active</Badge>}
                  {p.needsRekey && <Badge tone="err" title="密钥待重加密/重录，禁止切换">needs rekey</Badge>}
                  {p.plainStore && <Badge tone="warn" title="密钥为明文降级形态（base64），建议重新保存以启用加密">plain</Badge>}
                  <button
                    type="button"
                    className="btn btn-link"
                    disabled={busy || switchConfirmActive || p.needsRekey}
                    title={p.needsRekey ? 'needs_rekey 档案禁止切换，请编辑重新录入 key' : undefined}
                    onClick={() => onSwitch(p.id)}
                  >
                    Switch
                  </button>
                  <button
                    type="button"
                    className="btn btn-link"
                    disabled={busy || switchConfirmActive}
                    onClick={() => {
                      setEditing({ id: p.id, name: p.name, fields: { ...p.fields } })
                      if (!formOpen) onToggleForm()
                    }}
                  >
                    编辑
                  </button>
                  <button type="button" className="btn btn-link" disabled={busy || switchConfirmActive} onClick={() => onDelete(p.id, p.name)}>
                    删除
                  </button>
                </span>
              </div>
            ))}
          </div>

          {formOpen ? (
            <ProfileForm
              adapter={adapter}
              editing={editing}
              busy={busy}
              onCancel={() => {
                setEditing(null)
                onToggleForm()
              }}
              onSaved={() => {
                setEditing(null)
                onSaved()
              }}
            />
          ) : (
            <div className="import-actions">
              <button type="button" className="btn" disabled={busy} onClick={onToggleForm}>
                新增档案
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 新增/编辑表单：动态字段 + key password 输入（提交后立即 mask 显示）
// ---------------------------------------------------------------------------

function ProfileForm({
  adapter,
  editing,
  busy,
  onCancel,
  onSaved,
}: {
  adapter: ApiHubAdapterEntry
  editing: { id: number; name: string; fields: Record<string, string> } | null
  busy: boolean
  onCancel: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [fields, setFields] = useState<Record<string, string>>(editing?.fields ?? {})
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(e: FormEvent): void {
    e.preventDefault()
    setError(null)
    const input = {
      adapterId: adapter.id,
      ...(editing !== null ? { id: editing.id } : {}),
      name,
      fields,
    }
    void (async () => {
      try {
        await call('apihub:saveProfile', { input, ...(apiKey.length > 0 ? { apiKeyPlain: apiKey } : {}) })
        setApiKey('') // 明文即刻清空（提交后 UI 只显示 mask）
        onSaved()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  return (
    <form className="add-form" onSubmit={(e) => handleSubmit(e)}>
      <div className="form-row">
        <label className="field">
          档案名
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 prod-key" required />
        </label>
        {adapter.fieldDefs.map((def) =>
          def.kind === 'select' ? (
            <label key={def.key} className="field">
              {def.label}
              <select
                className="input"
                value={fields[def.key] ?? ''}
                onChange={(e) => setFields({ ...fields, [def.key]: e.target.value })}
              >
                <option value="">（未设置）</option>
                {(def.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label key={def.key} className="field">
              {def.label}
              <input
                className="input"
                value={fields[def.key] ?? ''}
                placeholder={def.placeholder}
                onChange={(e) => setFields({ ...fields, [def.key]: e.target.value })}
              />
            </label>
          ),
        )}
        <label className="field">
          API Key{editing !== null ? '（留空 = 不改动）' : ''}
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={editing !== null ? '••••••••' : 'sk-…'}
            required={editing === null}
          />
        </label>
      </div>
      {error !== null && <div className="form-error">{error}</div>}
      <div className="import-footer">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          保存档案
        </button>
      </div>
    </form>
  )
}
