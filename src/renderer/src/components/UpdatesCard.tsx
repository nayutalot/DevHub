/**
 * components/UpdatesCard.tsx — 「检查更新」卡（X-U 批，docs/briefs/xu-updater.md §1
 * #3；主窗口「设置面」= Agents 视图控制条/中继/诊断同区的应用级设置分组）。
 *
 * 形态：当前版本 + 「检查更新」按钮 + 三态（最新 / 发现新版 vX.Y.Z→人话更新说明
 * +「下载并安装」确认钮 / 检查失败结构化内联呈现绝不弹窗）→ 下载进度（百分比 +
 * 字节）→ 下载完成「退出并安装」确认弹窗（useConfirm）→ updates:install
 * （quitAndInstall，装后自启）。下载与安装的用户确认前置在 renderer（任务书红线：
 * 绝不自动下载、绝不静默重启）；dev（supported=false）如实显示全链禁用说明。
 *
 * 数据纪律：updates:status 2s 轮询（READ_ONLY 快照，进程内读零 IPC 重量）；全部
 * 真实 IPC 零 mock（约束 #23）；错误结构化内联（约束 #26）；文案全中文按 AUDIT
 * 附注 A 术语表（up-to-date=最新 等）。
 */

import { useState } from 'react'
import { Badge } from './Badge.tsx'
import { useConfirm } from './ConfirmDialog.tsx'
import { ErrorState, Loading, Spinner } from './StateViews.tsx'
import { relativeTime } from '../lib/format.ts'
import { call } from '../lib/ipc.ts'
import { usePolling } from '../lib/usePolling.ts'
import { useToast } from './ToastProvider.tsx'
import type { AsyncError } from '../lib/useAsync.ts'
import type { UpdateStatusView } from '../../../shared/types.ts'

/** 状态快照轮询节奏（进程内内存读，2s 与 agents 状态面同节奏）。 */
const UPDATES_POLL_MS = 2000

function toAsyncErrorLocal(err: unknown): AsyncError {
  const e = err as { code?: string; message?: string } | null
  return {
    code: typeof e?.code === 'string' ? e.code : 'IPC_ERROR',
    message: err instanceof Error ? err.message : String(err),
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/** 三态徽章投影（phase → 中文标签 + 着色，契约原值只在数据层）。 */
function phaseBadge(s: UpdateStatusView): { label: string; tone: 'ok' | 'warn' | 'err' | 'accent' | 'dim' } {
  switch (s.phase) {
    case 'checking':
      return { label: '检查中', tone: 'accent' }
    case 'available':
      return { label: `发现新版本 v${s.availableVersion ?? '?'}`, tone: 'warn' }
    case 'not-available':
      return { label: '最新', tone: 'ok' }
    case 'downloading':
      return { label: '下载中', tone: 'accent' }
    case 'downloaded':
      return { label: '已下载就绪', tone: 'warn' }
    case 'installing':
      return { label: '安装中', tone: 'accent' }
    case 'error':
      return { label: '检查失败', tone: 'err' }
    case 'idle':
      return { label: '未检查', tone: 'dim' }
  }
}

export function UpdatesCard() {
  const status = usePolling(() => call('updates:status', {}), [], UPDATES_POLL_MS)
  const { show } = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null)

  if (status.loading && status.data === null) return <Loading label="正在读取更新状态…" />
  if (status.data === null && status.error !== null) {
    return <ErrorState error={status.error} onRetry={status.refresh} />
  }
  const s = status.data
  if (s === null) return <div className="inline-note">暂无更新状态。</div>

  const badge = phaseBadge(s)
  const inFlight = s.phase === 'checking' || s.phase === 'downloading' || s.phase === 'installing'

  async function onCheck(): Promise<void> {
    setBusy('check')
    try {
      await call('updates:check', {})
      // 结果经 updates:status 轮询呈现（三态/失败结构化内联，绝不弹窗）
    } catch (err) {
      const e = toAsyncErrorLocal(err)
      show(`检查更新未受理 [${e.code}]：${e.message}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  async function onDownload(): Promise<void> {
    setBusy('download')
    try {
      await call('updates:download', {})
      show(`已开始下载 v${s?.availableVersion ?? ''}（完成后需确认才会安装）`)
    } catch (err) {
      const e = toAsyncErrorLocal(err)
      show(`下载未受理 [${e.code}]：${e.message}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  async function onInstall(): Promise<void> {
    const ok = await confirm({
      title: '安装更新',
      body: `将退出 DevHub 并运行安装程序（版本 v${s?.availableVersion ?? ''}），安装完成后自动重新启动。\n未完成的下载与界面输入不受影响；监控与托盘将随退出收尾。`,
      confirmLabel: '退出并安装',
    })
    if (!ok) return
    setBusy('install')
    try {
      await call('updates:install', {})
      // 受理后主进程 quitAndInstall → 既有退出收尾 → 安装向导
    } catch (err) {
      const e = toAsyncErrorLocal(err)
      show(`安装未受理 [${e.code}]：${e.message}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      {status.error !== null && (
        <div className="degraded-banner">updates:status 轮询异常（显示为最后成功快照）: {status.error.code} — {status.error.message}</div>
      )}
      <div className="agents-control-bar">
        <span>
          当前版本 <span className="mono">v{s.currentVersion}</span>
        </span>
        <button
          type="button"
          className="btn btn-small btn-primary"
          disabled={!s.supported || inFlight || busy !== null}
          onClick={() => void onCheck()}
        >
          检查更新
        </button>
        {busy === 'check' && <Spinner />}
        {badge.tone === 'dim' ? (
          <span className="td-dim">{badge.label}</span>
        ) : (
          <Badge tone={badge.tone}>{badge.label}</Badge>
        )}
        {s.lastCheckedAt !== null && <span className="td-dim">上次检查：{relativeTime(s.lastCheckedAt)}</span>}
      </div>

      {!s.supported && (
        <div className="inline-note">
          开发模式（<span className="mono">app.isPackaged=false</span>）下自动更新全链禁用——打包安装版才提供检查/下载/安装。
        </div>
      )}

      {s.phase === 'available' && (
        <div>
          {s.releaseNotes !== null && (
            <div className="inline-note">
              更新说明：
              <br />
              {s.releaseNotes}
            </div>
          )}
          <div className="agents-control-bar">
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={busy !== null}
              onClick={() => void onDownload()}
            >
              下载并安装
            </button>
            <span className="td-dim">下载完成后还需确认才会退出并安装（绝不自动安装）</span>
          </div>
        </div>
      )}

      {s.phase === 'downloading' && s.downloadProgress !== null && (
        <div className="inline-note">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                flex: 1,
                height: 6,
                borderRadius: 3,
                background: 'rgba(255,255,255,0.12)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${Math.min(100, Math.max(0, s.downloadProgress.percent))}%`,
                  height: '100%',
                  background: 'var(--accent, #4da3ff)',
                }}
              />
            </div>
            <span className="mono td-dim">{s.downloadProgress.percent.toFixed(0)}%</span>
          </div>
          <span className="td-dim">
            {formatBytes(s.downloadProgress.transferredBytes)} / {formatBytes(s.downloadProgress.totalBytes)}
          </span>{' '}
          <Spinner />
        </div>
      )}

      {s.phase === 'downloaded' && (
        <div className="agents-control-bar">
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={busy !== null}
            onClick={() => void onInstall()}
          >
            退出并安装
          </button>
          <span className="td-dim">新版本 v{s.availableVersion ?? ''} 已下载就绪，确认后将退出并运行安装程序</span>
        </div>
      )}

      {s.phase === 'installing' && <div className="inline-note">正在退出并启动安装程序…</div>}

      {s.phase === 'error' && s.error !== null && (
        <div className="inline-note">
          更新检查/下载失败（不影响使用，可重试）：
          <span className="mono"> [{s.error.code}]</span> {s.error.message}
        </div>
      )}

      {s.silentAnnounced && s.phase !== 'downloaded' && s.phase !== 'downloading' && (
        <div className="inline-note td-dim">启动后台检查已发现新版本——如需现在安装，可重新检查后下载。</div>
      )}
    </div>
  )
}
