/**
 * components/StateViews.tsx — 视图三态通用组件（docs/00 约束 #24，docs/06 §4）：
 * Loading / Empty / Error。error 展示 envelope 的 { code, message } 并提供
 * 重试按钮；empty 提供引导文案与可选动作。
 *
 * Toast 面（D5-M3，AUDIT D-Aud I12）：迁移至 App 级唯一队列 ToastProvider.tsx
 * （useToast/show 签名与 <ToastHost/> 渲染均在该模块）；本文件仅保留 ToastData
 * 形状（队列条目契约），旧 per-panel useToast/Toast 已退役。
 */

import type { AsyncError } from '../lib/useAsync.ts'

export function Spinner() {
  return <span className="spinner" aria-label="加载中" />
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  )
}

/**
 * 空态图标：内联 SVG（中性"空盒"——AUDIT D-Aud A6，D5-M5：原"禁止"斜杠圆语义
 * 错位，空态应为"空"而非"禁"；无外部资源纪律不变）。
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M3.5 8.2 12 4l8.5 4.2v7.6L12 20l-8.5-4.2Z" strokeLinejoin="round" />
          <path d="M3.5 8.2 12 12.4l8.5-4.2" strokeLinejoin="round" />
          <path d="M12 12.4V20" />
        </svg>
      </span>
      <span className="empty-title">{title}</span>
      {hint !== undefined && <span className="empty-hint">{hint}</span>}
      {action !== undefined && (
        <button type="button" className="btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}

/** 错误态：code 徽标 + message（来自 Result envelope，无堆栈）+ 重试。 */
export function ErrorState({ error, onRetry }: { error: AsyncError; onRetry: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span className="error-title">加载失败</span>
      <span>
        <span className="error-code">{error.code}</span>
      </span>
      <span className="error-msg">{error.message}</span>
      <button type="button" className="btn" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toast（轻量提示：打开成功 / 操作失败，自动消失）
// D5-M3（AUDIT D-Aud I12）：承载面迁移至 App 级唯一队列（components/ToastProvider.tsx
// 的 ToastProvider/useToast/ToastHost——bottom-right 堆叠不再相互覆盖）；这里只
// 保留队列条目形状契约。
// ---------------------------------------------------------------------------

export interface ToastData {
  tone: 'ok' | 'err'
  text: string
}

/** 小型区块内三态（loading / empty / error 三行以内），用于详情子区块。 */
export function InlineState({
  loading,
  error,
  onRetry,
  empty,
  loadingLabel,
}: {
  loading: boolean
  error: AsyncError | null
  onRetry: () => void
  empty: boolean
  loadingLabel: string
}) {
  if (loading) return <Loading label={loadingLabel} />
  if (error !== null) return <ErrorState error={error} onRetry={onRetry} />
  if (empty) return <div className="inline-note">暂无可展示的内容。</div>
  return null
}
