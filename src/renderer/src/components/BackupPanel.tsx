/**
 * components/BackupPanel.tsx — ContestView 内「备份导出 / 恢复导入」区（CP6 收官
 * 批，docs/22 §9；任务书 contestpin-m6 §1 #5）。
 *
 * 两入口（全部真实 IPC，零 mock——约束 #23；三态强制——约束 #24）：
 *   - 备份导出：contestpin:backupExport { destDir }（目标目录手填绝对路径，
 *     CP5 exportPack destDir 同款先例；manifest 结构性零凭据 + materials/ sha256
 *     复制幂等；已存在 manifest → BACKUP_EXISTS 结构化拒绝如实展示）；
 *   - 恢复导入：contestpin:backupImport { manifestPath }（manifest.json 经
 *     <input type="file"> + window.devhub.pathForFile 落路径，CP3b/CP5 先例）→
 *     一份待核对草稿（绝不静默覆盖）——导入成功后引导到下方 DraftReviewPanel
 *     核对确认（name+year 相似检测/合并/另建均为既有流程）。
 * 状态面：空闲提示（EmptyState 语义）/ 执行中（Spinner）/ 结构化错误 /
 * 结果摘要四态显式渲染，无静默分支。
 *
 * D4-M1（AUDIT D-Aud I4）：默认折叠（对齐 DraftReviewPanel/MaterialImportPanel
 * 收纳模式），Contests 首屏归还比赛列表+分页；纯 UI，操作语义不变。
 */

import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { EmptyState, ErrorState, Loading, Spinner } from './StateViews.tsx'
import { call } from '../lib/ipc.ts'
import { toAsyncError } from '../lib/useAsync.ts'
import type { AsyncError } from '../lib/useAsync.ts'
import type { ContestBackupExportResult } from '../../../shared/types.ts'

/** 导入结果摘要（成功/失败可见；结构化，不含裸异常）。 */
interface ImportOutcome {
  kind: 'success'
  jobId: number
  stage: string
  contests: number
  flags: number
}

export function BackupPanel() {
  // I4：默认折叠；折叠条对齐 RecognitionSettingsPanel/DraftReviewPanel 收纳模式
  const [open, setOpen] = useState(false)
  const [destDir, setDestDir] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<ContestBackupExportResult | null>(null)
  const [exportError, setExportError] = useState<AsyncError | null>(null)

  const [importing, setImporting] = useState(false)
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null)
  const [importError, setImportError] = useState<AsyncError | null>(null)

  if (!open) {
    return (
      <div className="recog-collapsed" data-testid="contest-backup-panel">
        <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
          备份与恢复 ▸
        </button>
        <span className="dim">manifest 结构性零凭据 · 导入一律走待核对草稿，绝不静默覆盖</span>
      </div>
    )
  }

  async function exportBackup(): Promise<void> {
    if (exporting) return
    if (destDir.trim().length === 0) {
      setExportResult(null)
      setExportError(toAsyncError(new Error('请先填写备份导出目标目录（已存在的绝对路径）')))
      return
    }
    setExporting(true)
    setExportError(null)
    setExportResult(null)
    try {
      const result = await call('contestpin:backupExport', { destDir: destDir.trim() })
      setExportResult(result)
    } catch (err) {
      setExportError(toAsyncError(err))
    } finally {
      setExporting(false)
    }
  }

  async function importBackupManifest(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    setImporting(true)
    setImportError(null)
    setImportOutcome(null)
    try {
      const path = files.length > 0 ? window.devhub.pathForFile(files[0]) : null
      if (path === null) {
        throw new Error('未取到 manifest 文件路径')
      }
      const result = await call('contestpin:backupImport', { manifestPath: path })
      const draft = result.job.result?.draft
      setImportOutcome({
        kind: 'success',
        jobId: result.job.id,
        stage: result.job.stage,
        contests: draft?.contests.length ?? 0,
        flags: draft?.flags.length ?? 0,
      })
    } catch (err) {
      setImportError(toAsyncError(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="panel" data-testid="contest-backup-panel">
      <div className="recog-head">
        <div>
          <h3 className="panel-title">备份与恢复</h3>
          <span className="dim">manifest 结构性零凭据（识别配置/密钥绝不导出） · 材料按 sha256 去重复制 · 导入一律走待核对草稿，绝不静默覆盖</span>
        </div>
        <button type="button" className="btn btn-small" onClick={() => setOpen(false)}>
          收起 ▴
        </button>
      </div>

      <div className="recog-group">
        <div className="recog-group-head">
          <span className="recog-group-title">备份导出</span>
          <span className="dim">全部比赛（含归档）+ 节点 + 提醒元数据 + 材料附件 → 目标目录 manifest.json + materials/</span>
        </div>
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <span className="field">
            <label htmlFor="cp-backup-dir">目标目录</label>
            <input
              id="cp-backup-dir"
              className="input"
              style={{ width: 280 }}
              value={destDir}
              placeholder="如 D:\\contest-backup"
              onChange={(e) => setDestDir(e.target.value)}
            />
          </span>
          <button type="button" className="btn btn-primary btn-small" disabled={exporting} onClick={() => void exportBackup()}>
            {exporting && <Spinner />}备份导出
          </button>
        </div>
        {/* 三态：执行中 / 结构化错误 / 结果摘要；空闲由分组标题行说明兜底 */}
        {exporting && <Loading label="正在导出备份…" />}
        {!exporting && exportError !== null && (
          <ErrorState
            error={exportError}
            onRetry={() => {
              setExportError(null)
              void exportBackup()
            }}
          />
        )}
        {!exporting && exportError === null && exportResult !== null && (
          <p className="dim" style={{ margin: '4px 0' }}>
            已导出：{exportResult.manifestPath}（比赛 {exportResult.contestCount} · 节点 {exportResult.nodeCount} · 提醒 {exportResult.reminderCount} · 材料 {exportResult.materialCount}，共 {exportResult.bytes} 字节）
          </p>
        )}
        {!exporting && exportError === null && exportResult === null && <EmptyState title="尚未导出" hint="填写目标目录后点击「备份导出」。目录已有 manifest.json 时将拒绝覆盖（请换目录）。" />}
      </div>

      <div className="recog-group">
        <div className="recog-group-head">
          <span className="recog-group-title">恢复导入</span>
          <span className="dim">选择备份目录中的 manifest.json → 材料 sha256 对账 → 全部比赛作为一份待核对草稿（确认/合并才落库）</span>
        </div>
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <label className="btn btn-primary btn-small">
            {importing && <Spinner />}选择 manifest.json 导入
            <input type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => void importBackupManifest(e)} />
          </label>
        </div>
        {importing && <Loading label="正在解析备份并对账材料…" />}
        {!importing && importError !== null && (
          <ErrorState
            error={importError}
            onRetry={() => {
              setImportError(null)
            }}
          />
        )}
        {!importing && importError === null && importOutcome !== null && (
          <p className="dim" style={{ margin: '4px 0' }}>
            导入完成（任务 #{importOutcome.jobId}，{importOutcome.contests} 场比赛 / {importOutcome.flags} 条核对提示）→ 已生成待核对草稿，请在下方「待核对草稿」区逐项确认或合并，绝不静默覆盖既有比赛。
          </p>
        )}
        {!importing && importError === null && importOutcome === null && (
          <EmptyState title="尚未导入" hint="选择备份 manifest.json；材料缺失/哈希不符会如实标记为待核对提示（降级导入，不带病落库）。" />
        )}
      </div>
    </div>
  )
}
