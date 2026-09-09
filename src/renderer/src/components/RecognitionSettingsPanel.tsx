/**
 * components/RecognitionSettingsPanel.tsx — ContestView 内「识别设置」折叠面板
 * （CP3a 批次，docs/22 §6 + 任务书 §2.4）。
 *
 * 数据源（全部真实 IPC，无 mock——约束 #23）：
 *   contestpin:configList（按角色分组掩码列表）/ contestpin:configSave（新建/编辑，
 *   apiKey 密码框留空 = 不改动，ApiHubView 约定）/ contestpin:configDelete
 *   （CONFIRM_REQUIRED 两段式，window.confirm 展示 impacts.importJobs，
 *   ContestDetailView 先例）/ contestpin:configTest（测试按钮：ok/延迟/实测
 *   usage/分类错误文案）；默认模式经既有 settings:get/set 读写
 *   contestpin_default_mode（two_stage/multimodal，CP1 白名单键，零新通道）。
 * 三态强制（约束 #24）：Loading / ErrorState / EmptyState（无配置时引导新建）。
 * 密钥红线：界面只见掩码（apiKeyTail 首尾打点），无明文/无 sealed 任何展示位。
 */

import { useState } from 'react'
import type { FormEvent } from 'react'
import { Badge } from './Badge.tsx'
import { EmptyState, ErrorState, Loading, Spinner, Toast, useToast } from './StateViews.tsx'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import type {
  RecognitionConfigRole,
  RecognitionConfigView,
  RecognitionTestResult,
} from '../../../shared/types.ts'

const ROLE_GROUPS: readonly { role: RecognitionConfigRole; label: string; hint: string }[] = [
  { role: 'vision', label: 'Vision（视觉识别）', hint: '两段式识别第一阶段：材料图片 → 结构化文字' },
  { role: 'text', label: 'Text（文本整理）', hint: '两段式识别第二阶段：结构化文字 → 校对整理' },
  { role: 'multimodal', label: 'Multimodal（多模态一步式）', hint: '多模态单次调用：材料图片 → 识别结果' },
]

const MODE_OPTIONS: readonly { value: 'two_stage' | 'multimodal'; label: string }[] = [
  { value: 'two_stage', label: '两段式（vision + text）' },
  { value: 'multimodal', label: '多模态一步式（multimodal）' },
]

/** 实测 usage 摘要：优先 total_tokens，缺则紧凑 JSON（服务端形状不猜死）。 */
function usageSummary(usage: Record<string, unknown> | 'unknown' | null): string {
  if (usage === null || usage === 'unknown') return 'usage 未返回'
  const total = usage.total_tokens
  if (typeof total === 'number') return `usage 实测 total_tokens=${total}`
  return `usage 实测 ${JSON.stringify(usage).slice(0, 80)}`
}

function formatTestAt(unixSec: number | null): string {
  if (unixSec === null) return '未测试'
  return `上次测试 ${new Date(unixSec * 1000).toLocaleString()}`
}

export function RecognitionSettingsPanel() {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <div className="recog-collapsed">
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
          识别设置 ▸
        </button>
        <span className="dim">识别模型配置（vision / text / multimodal）与默认识别模式</span>
      </div>
    )
  }
  return <RecognitionSettingsPanelOpen onClose={() => setOpen(false)} />
}

function RecognitionSettingsPanelOpen({ onClose }: { onClose: () => void }) {
  const { toast, show } = useToast()
  const list = useAsync(() => call('contestpin:configList', {}), [])
  const defaultMode = useAsync(() => call('settings:get', { key: 'contestpin_default_mode' }), [])
  const [formState, setFormState] = useState<{ open: boolean; config: RecognitionConfigView | null }>({ open: false, config: null })

  function refreshAll(): void {
    list.refresh()
  }

  async function changeDefaultMode(value: string): Promise<void> {
    const mode = value === 'multimodal' ? 'multimodal' : 'two_stage'
    try {
      await call('settings:set', { key: 'contestpin_default_mode', value: mode })
      show('默认识别模式已保存')
      defaultMode.refresh()
    } catch (err) {
      show(`默认模式保存失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  const configs = list.data?.configs ?? []
  const modeValue = defaultMode.data?.value === 'multimodal' ? 'multimodal' : 'two_stage'

  return (
    <div className="panel">
      {toast !== null && <Toast toast={toast} />}
      <div className="recog-head">
        <h3 className="panel-title">识别设置</h3>
        <div className="recog-head-actions">
          <label className="recog-mode">
            默认模式
            <select
              className="input"
              value={modeValue}
              disabled={defaultMode.loading || defaultMode.error !== null}
              onChange={(e) => void changeDefaultMode(e.target.value)}
            >
              {MODE_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => setFormState({ open: true, config: null })}
          >
            新建配置
          </button>
          <button type="button" className="btn btn-small" onClick={onClose}>
            收起 ▴
          </button>
        </div>
      </div>

      {formState.open && (
        <ConfigForm
          config={formState.config}
          onDone={(saved) => {
            setFormState({ open: false, config: null })
            refreshAll()
            if (saved !== null) show(`配置「${saved.name}」已保存`)
          }}
          onCancel={() => setFormState({ open: false, config: null })}
        />
      )}

      {list.loading ? (
        <Loading label="Loading configs…" />
      ) : list.error !== null ? (
        <ErrorState error={list.error} onRetry={list.refresh} />
      ) : configs.length === 0 ? (
        <EmptyState
          title="还没有识别配置"
          hint="为材料识别配置 OpenAI 兼容端点：vision/text/multimodal 三种角色，key 只存掩码。"
          action={{ label: '新建配置', onClick: () => setFormState({ open: true, config: null }) }}
        />
      ) : (
        ROLE_GROUPS.map(({ role, label, hint }) => {
          const group = configs.filter((c) => c.role === role)
          if (group.length === 0) return null
          return (
            <div key={role} className="recog-group">
              <div className="recog-group-head">
                <span className="recog-group-title">{label}</span>
                <span className="dim">{hint}</span>
              </div>
              {group.map((c) => (
                <ConfigRow key={c.id} config={c} onChanged={refreshAll} onEdit={() => setFormState({ open: true, config: c })} show={show} />
              ))}
            </div>
          )
        })
      )}
      {defaultMode.error !== null && (
        <p className="form-error">默认模式读取失败 — {defaultMode.error.message}</p>
      )}
    </div>
  )
}

/** 单行配置：掩码 key + 上次测试摘要 + 测试/编辑/删除（两段式）。 */
function ConfigRow({
  config,
  onChanged,
  onEdit,
  show,
}: {
  config: RecognitionConfigView
  onChanged: () => void
  onEdit: () => void
  show: (text: string, tone?: 'ok' | 'err') => void
}) {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<RecognitionTestResult | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function runTest(): Promise<void> {
    if (testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await call('contestpin:configTest', { id: config.id })
      setTestResult(result)
      onChanged()
      if (result.ok) show(`「${config.name}」连接测试通过（${result.latencyMs}ms）`)
      else show(`「${config.name}」连接测试失败 — ${result.error?.message ?? '未知错误'}`, 'err')
    } catch (err) {
      show(`连接测试失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setTesting(false)
    }
  }

  async function runDelete(): Promise<void> {
    if (deleting) return
    setDeleting(true)
    try {
      const start = await call('contestpin:configDelete', { id: config.id })
      if (start.confirmRequired === true) {
        const hint = start.impacts.importJobs > 0 ? `该配置被 ${start.impacts.importJobs} 个导入任务引用（删除后任务保留、引用置空）。` : ''
        if (window.confirm(`删除识别配置「${config.name}」（${config.role}）？${hint}`)) {
          await call('contestpin:configDelete', { id: config.id, confirmed: true })
          show(`配置「${config.name}」已删除`)
          onChanged()
        }
      }
    } catch (err) {
      show(`删除失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="recog-row">
      <div className="recog-row-main">
        <span className="recog-row-name">
          {config.name}
          {config.lastTestOk === true && <Badge tone="ok" title={formatTestAt(config.lastTestAt)}>测试通过</Badge>}
          {config.lastTestOk === false && <Badge tone="err" title={formatTestAt(config.lastTestAt)}>测试失败</Badge>}
        </span>
        <span className="dim mono">
          {config.model} · {config.baseUrl}
          {config.timeoutMs !== null ? ` · 超时 ${config.timeoutMs}ms` : ''}
        </span>
        <span className="dim mono">
          key: {config.apiKeySet ? (config.apiKeyTail !== null ? `••••${config.apiKeyTail}（${config.apiKeyLen ?? '?'} 位）` : '已设置（当前环境不可解读取）') : '未设置（无鉴权端点）'}
        </span>
        <span className="dim">
          {formatTestAt(config.lastTestAt)}
          {config.lastTestUsage !== null ? ` · ${usageSummary(config.lastTestUsage)}` : ''}
        </span>
        {testResult !== null && (
          <span className={testResult.ok ? 'recog-test-ok' : 'recog-test-err'}>
            {testResult.ok
              ? `通过 · ${testResult.latencyMs}ms · ${usageSummary(testResult.usage)}`
              : `失败（${testResult.error?.kind ?? '?'}）· ${testResult.latencyMs}ms · ${testResult.error?.message ?? ''}`}
          </span>
        )}
      </div>
      <div className="recog-row-actions">
        <button type="button" className="btn btn-small" disabled={testing || deleting} onClick={() => void runTest()}>
          {testing && <Spinner />}测试
        </button>
        <button type="button" className="btn btn-small" disabled={testing || deleting} onClick={onEdit}>
          编辑
        </button>
        <button type="button" className="btn btn-small" disabled={testing || deleting} onClick={() => void runDelete()}>
          {deleting && <Spinner />}删除
        </button>
      </div>
    </div>
  )
}

/** 新建/编辑表单：apiKey 密码框留空 = 不改动（编辑）或不设 key（新建）。 */
function ConfigForm({
  config,
  onDone,
  onCancel,
}: {
  config: RecognitionConfigView | null
  onDone: (saved: RecognitionConfigView | null) => void
  onCancel: () => void
}) {
  const editing = config !== null
  const [name, setName] = useState(config?.name ?? '')
  const [role, setRole] = useState<RecognitionConfigRole>(config?.role ?? 'vision')
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '')
  const [model, setModel] = useState(config?.model ?? '')
  const [apiKey, setApiKey] = useState('')
  const [timeoutText, setTimeoutText] = useState(config?.timeoutMs !== null && config?.timeoutMs !== undefined ? String(config.timeoutMs) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    if (name.trim() === '' || baseUrl.trim() === '' || model.trim() === '') {
      setError('名称 / Base URL / Model 必填。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const timeoutTrim = timeoutText.trim()
      const saved = await call('contestpin:configSave', {
        ...(editing ? { id: config.id } : {}),
        name: name.trim(),
        role,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        // 密码框留空 = 保持既有（编辑）或不设 key（新建）——绝不回传掩码假值
        ...(apiKey.length > 0 ? { apiKey } : {}),
        ...(timeoutTrim !== '' ? { timeoutMs: Number(timeoutTrim) } : editing ? {} : { timeoutMs: null }),
      })
      onDone(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="add-form" onSubmit={(e) => void submit(e)}>
      <div className="form-row">
        <span className="field">
          <label htmlFor="recog-name">名称 *</label>
          <input id="recog-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 vis-main / ollama-local" />
        </span>
        <span className="field">
          <label htmlFor="recog-role">角色 *</label>
          <select id="recog-role" className="input" value={role} onChange={(e) => setRole(e.target.value as RecognitionConfigRole)}>
            {ROLE_GROUPS.map((g) => (
              <option key={g.role} value={g.role}>
                {g.label}
              </option>
            ))}
          </select>
        </span>
        <span className="field">
          <label htmlFor="recog-model">Model *</label>
          <input id="recog-model" className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 qwen2.5-vl-7b" />
        </span>
      </div>
      <div className="form-row">
        <span className="field">
          <label htmlFor="recog-baseurl">Base URL *</label>
          <input id="recog-baseurl" className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://host/v1（自动补 /chat/completions）" />
        </span>
      </div>
      <div className="form-row">
        <span className="field">
          <label htmlFor="recog-key">API Key{editing ? '（留空 = 不改动）' : '（留空 = 无鉴权端点）'}</label>
          <input
            id="recog-key"
            className="input"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={editing ? '••••••••' : 'sk-…（可空）'}
          />
        </span>
        <span className="field">
          <label htmlFor="recog-timeout">超时毫秒{editing ? '（留空 = 不改动）' : ''}</label>
          <input id="recog-timeout" className="input" value={timeoutText} onChange={(e) => setTimeoutText(e.target.value)} placeholder="60000（缺省）" inputMode="numeric" />
        </span>
      </div>
      <div className="form-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <Spinner />}{editing ? '保存配置' : '新建配置'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <span className="dim">保存后列表只显示 key 掩码（尾 4 位 + 长度），明文不回显。</span>
      </div>
      {error !== null && <p className="form-error">{error}</p>}
    </form>
  )
}
