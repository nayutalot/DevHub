/**
 * components/ZcodeManaged.tsx — ZCode 托管模型设置卡（T2b 批次，renderer 补面；
 * docs/briefs/t2b-zcode-managed-ui.md）。仿 LlmReview.tsx 的 LlmReviewSettingsCard
 * 形态（settings:get 回填 / settings:set 保存 / inline-note 提示），零新 IPC 通道。
 *
 * 单键 zcode_managed_model（T2 已入 settingsService 19 键白名单）：值 = 完整
 * "provider/model" 串，默认空 = 托管停用。就绪性（ApiHub zcode 活动档案
 * baseURL+密钥）不在本卡展示——App Agents 页 caps 卡已可见 managed/observed。
 * 凭据三零：本卡只编辑模型串，不涉及 key，值展示无敏感物。
 */

import { useEffect, useState } from 'react'
import { Badge } from './Badge.tsx'
import { Spinner } from './StateViews.tsx'
import { call } from '../lib/ipc.ts'

export function ZcodeManagedSettingsCard() {
  const [model, setModel] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  // 首次回填（仅一次；用户编辑后不覆盖输入框）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await call('settings:get', { key: 'zcode_managed_model' })
        if (cancelled) return
        setModel(result.value)
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
      const value = model.trim()
      await call('settings:set', { key: 'zcode_managed_model', value })
      // 保存后回显：以主进程实际落库值为准
      const echoed = await call('settings:get', { key: 'zcode_managed_model' })
      setModel(echoed.value)
      setMessage({
        ok: true,
        text:
          echoed.value.trim().length > 0
            ? `已保存 zcode_managed_model = ${echoed.value}`
            : '已保存：值为空，ZCode 托管保持停用',
      })
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel review-settings-card">
      <h3 className="panel-title">ZCode 托管模型（可选）</h3>
      <div className="inline-note">
        完整 <span className="mono">provider/model</span> 串（由 ZCode 托管面注入 App Agents 的 zcode provider）。
        默认空 = 托管停用；填写后还需 ApiHub 的 zcode 活动档案（baseURL+密钥）齐备才就绪——
        就绪状态见 App Agents 页 caps 卡，此处不展示。
      </div>
      <div className="review-settings-row">
        <label>
          ZCode 托管模型
          <input
            className="input mono"
            type="text"
            placeholder="zai-glm/glm-4.7"
            value={model}
            disabled={!loaded || saving}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <button type="button" className="btn" disabled={!loaded || saving} onClick={() => void save()}>
          {saving && <Spinner />} Save
        </button>
      </div>
      {message !== null && (
        <div className="inline-note td-dim">
          {message.ok ? (
            <>
              <Badge tone="ok">saved</Badge> {message.text}
            </>
          ) : (
            <>
              <Badge tone="err">failed</Badge> {message.text}
            </>
          )}
        </div>
      )}
    </div>
  )
}
