/**
 * components/LlmReview.tsx — LLM 复核层 UI（LR1 批次，advisory-only；
 * docs/briefs/lr1-llm-review.md 设置卡片 §1/§5 + 咨询条 §4.1 + run 复核 §4.2）。
 *
 * 三个可复用块（全部真实 IPC，无 mock——约束 #23）：
 *   - LlmReviewSettingsCard：settings 页「LLM 复核」卡片——base_url / model 两项
 *     （settings:get/set 白名单键，双键同设才生效）+ 端点测试入口
 *     （review:testEndpoint，{ ok, latencyMs, error? }）。
 *   - ReviewAdvisoryBar：归档确认弹窗咨询条——preview 后对既有 plan 摘要
 *     （零额外扫描）fire-and-forget 调 archive:reviewPre，四态 envelope 展示；
 *     **advisory 纪律：不拦截、不改变 DOUBLE_CONFIRM 流程**（失败/超时静默降级为提示行）。
 *   - ReviewPostButton：run 行「LLM 复核」按钮（归档结果/历史区）——按需触发
 *     archive:reviewPost { runId }；缓存命中展示 cached 徽章（不再打端点）。
 * 密钥红线：v1 零 key 字段；界面无任何凭据输入位（将来引入鉴权走 safeStorage）。
 */

import { useEffect, useRef, useState } from 'react'
import { Badge } from './Badge.tsx'
import { Spinner } from './StateViews.tsx'
import { call } from '../lib/ipc.ts'
import type {
  ArchiveReviewPrePayload,
  ReviewEnvelope,
  ReviewStatus,
  ReviewTestEndpointResult,
  SkillMetaFlag,
  SkillMetaFlagKind,
} from '../../../shared/types.ts'

/** 四态 → 徽章 tone（skipped=dim 等价现状语义，不算异常）。 */
export function reviewStatusTone(status: ReviewStatus): 'ok' | 'warn' | 'err' | 'dim' {
  switch (status) {
    case 'ok':
      return 'ok'
    case 'skipped':
      return 'dim'
    case 'unparseable':
      return 'warn'
    case 'failed':
      return 'err'
  }
}

/** 风险三档 → 徽章 tone。 */
function riskTone(risk: 'low' | 'medium' | 'high'): 'ok' | 'warn' | 'err' {
  return risk === 'low' ? 'ok' : risk === 'medium' ? 'warn' : 'err'
}

// ---------------------------------------------------------------------------
// 设置卡片：base_url / model + 端点测试（任务书 §1「设置卡片 UI」落点）
// ---------------------------------------------------------------------------

export function LlmReviewSettingsCard() {
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ReviewTestEndpointResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // 首次回填（仅一次；用户编辑后不覆盖输入框）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [base, mdl] = await Promise.all([
          call('settings:get', { key: 'llm_review_base_url' }),
          call('settings:get', { key: 'llm_review_model' }),
        ])
        if (cancelled) return
        setBaseUrl(base.value)
        setModel(mdl.value)
        setLoaded(true)
      } catch {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function save(): Promise<void> {
    setSaving(true)
    setMessage(null)
    try {
      await call('settings:set', { key: 'llm_review_base_url', value: baseUrl.trim() })
      await call('settings:set', { key: 'llm_review_model', value: model.trim() })
      setMessage('已保存（双键同设才生效）')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function test(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    setMessage(null)
    try {
      const result: ReviewTestEndpointResult = await call('review:testEndpoint', { baseUrl: baseUrl.trim(), model: model.trim() })
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const configured = baseUrl.trim().length > 0 && model.trim().length > 0

  return (
    <div className="panel review-settings-card">
      <h3 className="panel-title">LLM 复核（advisory，可选）</h3>
      <div className="inline-note">
        局域网 OpenAI chat/completions 兼容端点（自备，如 <span className="mono">http://&lt;lan-ip&gt;:11434/v1</span>）。
        两项都填写才启用；留空 = 停用，归档与 Skills 页行为等价现状（复核永不阻塞主流程）。
      </div>
      <div className="review-settings-row">
        <label>
          Base URL
          <input
            className="input mono"
            type="text"
            placeholder="http://<lan-ip>:11434/v1"
            value={baseUrl}
            disabled={!loaded || saving}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label>
          Model
          <input
            className="input mono"
            type="text"
            placeholder="qwen2.5:7b"
            value={model}
            disabled={!loaded || saving}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <button type="button" className="btn" disabled={!loaded || saving || testing} onClick={() => void save()}>
          {saving && <Spinner />} Save
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!loaded || testing || !configured}
          title={configured ? '向端点发一次连通性探测（不落库）' : '双键同设后才可测试'}
          onClick={() => void test()}
        >
          {testing && <Spinner />} Test endpoint
        </button>
      </div>
      {testResult !== null && (
        <div className="inline-note">
          {testResult.ok ? (
            <>
              <Badge tone="ok">ok</Badge> 端点可达 · {testResult.latencyMs}ms
            </>
          ) : (
            <>
              <Badge tone="err">failed</Badge> {testResult.error ?? 'endpoint unreachable'} · {testResult.latencyMs}ms
            </>
          )}
        </div>
      )}
      {message !== null && <div className="inline-note td-dim">{message}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 确认弹窗咨询条（archive:reviewPre；advisory 不拦截 DOUBLE_CONFIRM）
// ---------------------------------------------------------------------------

export function ReviewAdvisoryBar({ plan }: { plan: ArchiveReviewPrePayload['plan'] }) {
  const [state, setState] = useState<{ loading: boolean; envelope: ReviewEnvelope | null }>({ loading: true, envelope: null })
  const planKeyRef = useRef<string>('')
  const planKey = `${plan.oldPath}->${plan.destPath}`

  useEffect(() => {
    if (planKeyRef.current === planKey) return
    planKeyRef.current = planKey
    let cancelled = false
    setState({ loading: true, envelope: null })
    void (async () => {
      try {
        const envelope: ReviewEnvelope = await call('archive:reviewPre', { plan })
        if (!cancelled) setState({ loading: false, envelope })
      } catch (err) {
        // advisory 纪律：通道异常也不拦截确认流程，仅展示提示行
        if (!cancelled) setState({ loading: false, envelope: { status: 'failed', note: err instanceof Error ? err.message : String(err) } })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- plan 为预检产物，对象身份不稳定，以路径对为依赖键
  }, [planKey])

  const envelope = state.envelope

  return (
    <div className="review-advisory-bar">
      <span className="review-advisory-label">LLM 复核咨询（advisory，不拦截执行）</span>
      {state.loading ? (
        <span className="inline-note">
          <Spinner /> 正在咨询 LLM…（失败自动跳过，不影响归档）
        </span>
      ) : envelope === null ? (
        <span className="inline-note td-dim">LLM 复核不可用（advisory，已跳过）</span>
      ) : envelope.status === 'ok' ? (
        <div className="review-advisory-body">
          <Badge tone={riskTone(envelope.risk ?? 'low')}>risk: {envelope.risk}</Badge>
          <span className="td-dim">
            {envelope.model} · {envelope.latencyMs}ms
          </span>
          {envelope.concerns !== undefined && envelope.concerns.length > 0 && (
            <ul className="review-concerns">
              {envelope.concerns.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {envelope.rationale !== undefined && <div className="inline-note td-dim">{envelope.rationale}</div>}
        </div>
      ) : (
        <span className="inline-note td-dim">
          <Badge tone={reviewStatusTone(envelope.status)}>{envelope.status}</Badge> {envelope.note ?? '复核未返回结果（不影响归档）'}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// run 行复核按钮（archive:reviewPost；缓存命中标注 cached）
// ---------------------------------------------------------------------------

export function ReviewPostButton({ runId }: { runId: number }) {
  const [state, setState] = useState<{ busy: boolean; envelope: ReviewEnvelope | null }>({ busy: false, envelope: null })

  async function review(): Promise<void> {
    setState({ busy: true, envelope: null })
    try {
      const envelope: ReviewEnvelope = await call('archive:reviewPost', { runId })
      setState({ busy: false, envelope })
    } catch (err) {
      setState({ busy: false, envelope: { status: 'failed', note: err instanceof Error ? err.message : String(err) } })
    }
  }

  const envelope = state.envelope

  return (
    <div className="review-post">
      <button type="button" className="btn btn-small" disabled={state.busy} title="按需触发 LLM 归档后复核（advisory；结果缓存，命中不再打端点）" onClick={() => void review()}>
        {state.busy && <Spinner />} LLM 复核
      </button>
      {envelope !== null && (
        <div className="review-advisory-body">
          {envelope.status === 'ok' ? (
            <>
              <Badge tone={riskTone(envelope.risk ?? 'low')}>risk: {envelope.risk}</Badge>
              {envelope.cached === true && <Badge tone="dim">cached</Badge>}
              <span className="td-dim">
                {envelope.model} · {envelope.latencyMs}ms
              </span>
              {envelope.concerns !== undefined && envelope.concerns.length > 0 && (
                <ul className="review-concerns">
                  {envelope.concerns.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
              {envelope.rationale !== undefined && <div className="inline-note td-dim">{envelope.rationale}</div>}
            </>
          ) : (
            <span className="inline-note td-dim">
              <Badge tone={reviewStatusTone(envelope.status)}>{envelope.status}</Badge> {envelope.note ?? ''}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Skills 元数据体检结果展示（flags 三类；只读咨询不落库）
// ---------------------------------------------------------------------------

const FLAG_LABEL: Record<SkillMetaFlagKind, string> = {
  short_description: '描述过短',
  language_mismatch: '语言不一致',
  suspected_duplicate: '疑似重复',
}

export function SkillMetaFlags({ flags }: { flags: SkillMetaFlag[] }) {
  if (flags.length === 0) {
    return <div className="inline-note">体检完成：未发现元数据问题（描述过短 / 语言不一致 / 疑似重复均无）。</div>
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Skill</th>
            <th>Flag</th>
            <th>依据</th>
          </tr>
        </thead>
        <tbody>
          {flags.map((f, i) => (
            <tr key={`${f.skillId}:${f.kind}:${i}`}>
              <td className="td-mono">{f.name}</td>
              <td>
                <Badge tone={f.kind === 'suspected_duplicate' ? 'warn' : 'accent'}>{FLAG_LABEL[f.kind]}</Badge>
              </td>
              <td className="td-dim">{f.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
