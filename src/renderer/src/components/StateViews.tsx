/**
 * components/StateViews.tsx — 视图三态通用组件（docs/00 约束 #24，docs/06 §4）：
 * Loading / Empty / Error + Toast。error 展示 envelope 的 { code, message } 并提供
 * 重试按钮；empty 提供引导文案与可选动作。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
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

/** 空态图标：内联 SVG（斜杠圆），无外部资源。 */
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
          <circle cx="12" cy="12" r="9" />
          <line x1="5.6" y1="18.4" x2="18.4" y2="5.6" />
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
// ---------------------------------------------------------------------------

export interface ToastData {
  tone: 'ok' | 'err'
  text: string
}

export function useToast() {
  const [toast, setToast] = useState<ToastData | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  const show = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ text, tone })
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setToast(null), 3200)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    }
  }, [])

  return { toast, show }
}

export function Toast({ toast }: { toast: ToastData | null }) {
  if (toast === null) return null
  return <div className={`toast toast-${toast.tone}`}>{toast.text}</div>
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
