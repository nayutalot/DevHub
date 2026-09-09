/**
 * components/MaterialImportPanel.tsx — ContestView 内「材料导入」区（CP3b 批次，
 * 任务书 §2.4 #14）。
 *
 * 数据源（全部真实 IPC，无 mock——约束 #23）：
 *   - 文件选择/拖入：<input type="file"> / drop 事件得到 File 后经
 *     window.devhub.pathForFile（preload webUtils 包装）落成磁盘路径，随
 *     contestpin:importMaterials {paths} 送 main 侧校验导入——renderer 不拿
 *     Node fs（约束 #18）；
 *   - 粘贴截图：contestpin:importMaterials {pasteClipboard:true}（main 读系统
 *     剪贴板；不可用回 clipboardUnavailable 结构化提示）；
 *   - 材料清单：contestpin:materialsList（READ_ONLY）；识别任务进度：
 *     contestpin:importStatus（READ_ONLY 轮询，取消/重试按钮）；
 *   - 开始识别：contestpin:importCreate（mode 缺省读 settings
 *     contestpin_default_mode；vision/text 配置经 contestpin:configList 选择）。
 * 三态强制（约束 #24）：Loading / ErrorState / EmptyState。
 */

import { useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { Badge } from './Badge.tsx'
import { EmptyState, ErrorState, Loading, Spinner, Toast, useToast } from './StateViews.tsx'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import { usePolling } from '../lib/usePolling.ts'
import type {
  ContestImportCreateParams,
  ContestImportJobView,
  ContestImportMode,
  ContestImportRetryFromStage,
  ContestImportStage,
  ContestMaterialView,
  RecognitionConfigView,
} from '../../../shared/types.ts'

const STAGE_LABEL: Record<ContestImportStage, string> = {
  imported: '已导入',
  preprocessed: '预处理完成',
  vision_done: '视觉识别完成',
  text_done: '文本整理完成',
  validated: '校验通过',
  draft: '待核对',
  confirmed: '已确认',
  failed: '失败',
  cancelled: '已取消',
}

const RETRYABLE_STAGES: readonly ContestImportStage[] = ['failed', 'vision_done', 'text_done', 'validated', 'draft', 'preprocessed']

const ACCEPT_EXTS = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp'

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function MaterialImportPanel() {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <div className="recog-collapsed">
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
          材料导入 ▸
        </button>
        <span className="dim">导入比赛通知（PDF/截图）→ 两阶段识别 → 核对确认</span>
      </div>
    )
  }
  return <MaterialImportPanelOpen onClose={() => setOpen(false)} />
}

function MaterialImportPanelOpen({ onClose }: { onClose: () => void }) {
  const { toast, show } = useToast()
  const materials = useAsync(() => call('contestpin:materialsList', {}), [])
  const configs = useAsync(() => call('contestpin:configList', {}), [])
  const defaultMode = useAsync(() => call('settings:get', { key: 'contestpin_default_mode' }), [])
  const jobs = usePolling(() => call('contestpin:importStatus', {}), [], 2500)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [mode, setMode] = useState<ContestImportMode | ''>('')
  const [visionConfigId, setVisionConfigId] = useState<number | ''>('')
  const [textConfigId, setTextConfigId] = useState<number | ''>('')
  const [skipTextPages, setSkipTextPages] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [importing, setImporting] = useState(false)
  const [starting, setStarting] = useState(false)

  const effectiveMode: ContestImportMode = mode !== '' ? mode : defaultMode.data?.value === 'multimodal' ? 'multimodal' : 'two_stage'
  const visionConfigs = (configs.data?.configs ?? []).filter((c) => c.role === 'vision')
  const textConfigs = (configs.data?.configs ?? []).filter((c: RecognitionConfigView) => c.role === 'text')
  const multimodalConfigs = (configs.data?.configs ?? []).filter((c) => c.role === 'multimodal')
  const callConfigs: RecognitionConfigView[] = effectiveMode === 'multimodal' ? multimodalConfigs : visionConfigs
  const materialList = materials.data?.materials ?? []
  const jobList = jobs.data?.jobs ?? []

  async function importPaths(paths: string[]): Promise<void> {
    setImporting(true)
    try {
      const result = await call('contestpin:importMaterials', { paths })
      show(`已导入 ${result.materials.length} 份材料（重复文件自动去重）`)
      materials.refresh()
      setSelected((prev) => new Set([...prev, ...result.materials.map((m) => m.id)]))
    } catch (err) {
      show(`导入失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setImporting(false)
    }
  }

  async function onFilesPicked(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    const paths = files.map((f) => window.devhub.pathForFile(f)).filter((p): p is string => p !== null)
    if (paths.length === 0) {
      show('未取到有效文件路径（renderer 不直接读文件，请从磁盘选择）', 'err')
      return
    }
    await importPaths(paths)
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    const paths = files.map((f) => window.devhub.pathForFile(f)).filter((p): p is string => p !== null)
    if (paths.length === 0) {
      show('拖入项不是磁盘文件', 'err')
      return
    }
    void importPaths(paths)
  }

  async function pasteClipboard(): Promise<void> {
    setImporting(true)
    try {
      const result = await call('contestpin:importMaterials', { pasteClipboard: true })
      if (result.clipboardUnavailable) {
        show('剪贴板没有图片或不可用', 'err')
      } else {
        show(`已导入剪贴板截图（${result.materials.length} 份）`)
        materials.refresh()
        setSelected((prev) => new Set([...prev, ...result.materials.map((m) => m.id)]))
      }
    } catch (err) {
      show(`粘贴导入失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setImporting(false)
    }
  }

  async function startRecognition(): Promise<void> {
    if (starting || selected.size === 0) return
    const params: ContestImportCreateParams = { skipTextPages }
    const pickedCall = callConfigs.find((c) => c.id === (effectiveMode === 'multimodal' ? visionConfigId : visionConfigId))
    if (pickedCall !== undefined) params.visionConfigId = pickedCall.id
    else if (callConfigs.length > 0) params.visionConfigId = callConfigs[0].id
    if (effectiveMode === 'two_stage') {
      const pickedText = textConfigs.find((c) => c.id === textConfigId)
      if (pickedText !== undefined) params.textConfigId = pickedText.id
      else if (textConfigs.length > 0) params.textConfigId = textConfigs[0].id
    }
    setStarting(true)
    try {
      const result = await call('contestpin:importCreate', { materialIds: [...selected], mode: effectiveMode, params })
      show(`已创建 ${result.jobs.length} 个识别任务`)
      jobs.refresh()
    } catch (err) {
      show(`创建识别任务失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setStarting(false)
    }
  }

  async function cancelJob(jobId: number): Promise<void> {
    try {
      const result = await call('contestpin:importCancel', { jobId })
      show(result.cancelled ? '任务已取消（晚到结果将被丢弃）' : `任务已是终态（${STAGE_LABEL[result.stage]}），无需取消`)
      jobs.refresh()
    } catch (err) {
      show(`取消失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  async function retryJob(jobId: number, fromStage: ContestImportRetryFromStage): Promise<void> {
    try {
      await call('contestpin:importRetry', { jobId, fromStage })
      show(`已从 ${fromStage} 阶段重试`)
      jobs.refresh()
    } catch (err) {
      show(`重试失败 — ${err instanceof Error ? err.message : String(err)}`, 'err')
    }
  }

  return (
    <div className="panel">
      {toast !== null && <Toast toast={toast} />}
      <div className="recog-head">
        <h3 className="panel-title">材料导入与识别</h3>
        <div className="recog-head-actions">
          <label className="recog-mode">
            模式
            <select
              className="input"
              value={effectiveMode}
              disabled={defaultMode.loading}
              onChange={(e) => setMode(e.target.value as ContestImportMode)}
            >
              <option value="two_stage">两段式（vision + text）</option>
              <option value="multimodal">多模态一步式</option>
            </select>
          </label>
          <button type="button" className="btn btn-small" onClick={onClose}>
            收起 ▴
          </button>
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className="add-form"
        style={{
          border: dragOver ? '1px dashed var(--accent, #4a7dff)' : '1px dashed var(--border, #888)',
          padding: 12,
          borderRadius: 6,
        }}
      >
        <div className="form-row">
          <label className="btn btn-small">
            选择文件（PDF / 图片，可多选）
            <input type="file" multiple accept={ACCEPT_EXTS} style={{ display: 'none' }} onChange={(e) => void onFilesPicked(e)} />
          </label>
          <button type="button" className="btn btn-small" disabled={importing} onClick={() => void pasteClipboard()}>
            {importing && <Spinner />}粘贴截图
          </button>
          <span className="dim">拖入文件到此区域也可导入 · 单文件 ≤20MB · 单批 ≤20 份</span>
        </div>
      </div>

      {materials.loading ? (
        <Loading label="Loading materials…" />
      ) : materials.error !== null ? (
        <ErrorState error={materials.error} onRetry={materials.refresh} />
      ) : materialList.length === 0 ? (
        <EmptyState title="还没有材料" hint="选择文件、拖入或粘贴截图后开始识别。" />
      ) : (
        <div style={{ maxHeight: 180, overflowY: 'auto', margin: '8px 0' }}>
          {materialList.map((m: ContestMaterialView) => (
            <label key={m.id} className="recog-row" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 4px' }}>
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={(e) => {
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(m.id)
                    else next.delete(m.id)
                    return next
                  })
                }}
              />
              <span className="recog-row-main">
                <span className="recog-row-name">
                  {m.originalName}
                  <Badge tone="dim">{m.kind}</Badge>
                  {m.pages != null && <Badge tone="dim">{m.pages} 页</Badge>}
                </span>
                <span className="dim mono">{formatBytes(m.sizeBytes ?? null)} · sha256 {m.sha256.slice(0, 12)}…</span>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="form-row" style={{ alignItems: 'center' }}>
        {effectiveMode === 'two_stage' ? (
          <>
            <span className="field">
              <label htmlFor="cp-imp-vision">视觉配置</label>
              <select id="cp-imp-vision" className="input" value={visionConfigId === '' ? '' : String(visionConfigId)} onChange={(e) => setVisionConfigId(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">（首个 vision 配置）</option>
                {visionConfigs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.model}）
                  </option>
                ))}
              </select>
            </span>
            <span className="field">
              <label htmlFor="cp-imp-text">文本配置</label>
              <select id="cp-imp-text" className="input" value={textConfigId === '' ? '' : String(textConfigId)} onChange={(e) => setTextConfigId(e.target.value === '' ? '' : Number(e.target.value))}>
                <option value="">（首个 text 配置）</option>
                {textConfigs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.model}）
                  </option>
                ))}
              </select>
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={skipTextPages} onChange={(e) => setSkipTextPages(e.target.checked)} />
              跳过有文字的 PDF 页（仅识别扫描页）
            </label>
          </>
        ) : (
          <span className="field">
            <label htmlFor="cp-imp-mm">多模态配置</label>
            <select id="cp-imp-mm" className="input" value={visionConfigId === '' ? '' : String(visionConfigId)} onChange={(e) => setVisionConfigId(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">（首个 multimodal 配置）</option>
              {multimodalConfigs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{c.model}）
                </option>
              ))}
            </select>
          </span>
        )}
        <button type="button" className="btn btn-primary btn-small" disabled={starting || selected.size === 0} onClick={() => void startRecognition()}>
          {starting && <Spinner />}开始识别（{selected.size} 份）
        </button>
      </div>

      <div className="recog-group">
        <div className="recog-group-head">
          <span className="recog-group-title">识别任务</span>
          <span className="dim">进度轮询 · 失败可按阶段重试 · 取消后晚到结果自动丢弃</span>
        </div>
        {jobs.loading && jobList.length === 0 ? (
          <Loading label="Loading jobs…" />
        ) : jobs.error !== null ? (
          <ErrorState error={jobs.error} onRetry={jobs.refresh} />
        ) : jobList.length === 0 ? (
          <EmptyState title="暂无识别任务" hint="选择材料并点击「开始识别」。" />
        ) : (
          jobList.map((job: ContestImportJobView) => (
            <JobRow key={job.id} job={job} onCancel={() => void cancelJob(job.id)} onRetry={(from) => void retryJob(job.id, from)} />
          ))
        )}
      </div>
    </div>
  )
}

function JobRow({ job, onCancel, onRetry }: { job: ContestImportJobView; onCancel: () => void; onRetry: (from: ContestImportRetryFromStage) => void }) {
  const [retryFrom, setRetryFrom] = useState<ContestImportRetryFromStage>(job.mode === 'two_stage' ? 'text' : 'vision')
  const active = !['confirmed', 'failed', 'cancelled'].includes(job.stage)
  const retryable = RETRYABLE_STAGES.includes(job.stage) && !active
  return (
    <div className="recog-row">
      <div className="recog-row-main">
        <span className="recog-row-name">
          #{job.id} {job.material?.originalName ?? '(材料已删除)'}
          <Badge tone={job.stage === 'failed' ? 'err' : job.stage === 'confirmed' ? 'ok' : job.stage === 'draft' ? 'accent' : 'dim'}>
            {STAGE_LABEL[job.stage]}
          </Badge>
          {job.result?.vision?.reusedFromJobId !== undefined && <Badge tone="dim">视觉缓存 #{job.result.vision.reusedFromJobId}</Badge>}
        </span>
        <span className="dim mono">
          {job.mode} · 进度 {job.progress ?? 0}%
        </span>
        <div style={{ width: 260, height: 6, background: 'var(--border, #555)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${job.progress ?? 0}%`, height: '100%', background: job.stage === 'failed' ? 'var(--err, #d55)' : 'var(--accent, #4a7dff)' }} />
        </div>
        {job.error !== null && <span className="form-error">{job.error.kind}: {job.error.message}</span>}
      </div>
      <div className="recog-row-actions">
        {active && (
          <button type="button" className="btn btn-small" onClick={onCancel}>
            取消
          </button>
        )}
        {retryable && (
          <>
            <select className="input btn-small" style={{ width: 90 }} value={retryFrom} onChange={(e) => setRetryFrom(e.target.value as ContestImportRetryFromStage)}>
              <option value="vision">从视觉重跑</option>
              {job.mode === 'two_stage' && <option value="text">从文本重跑</option>}
              <option value="validate">仅重新校验</option>
            </select>
            <button type="button" className="btn btn-small" onClick={() => onRetry(retryFrom)}>
              重试
            </button>
          </>
        )}
      </div>
    </div>
  )
}
