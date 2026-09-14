/**
 * components/ConfirmDialog.tsx — 应用内统一确认弹窗（AUDIT D-Aud A5，D5-M5）。
 *
 * 旧形态：native window.confirm 在站内与 cp-modal 应用内 modal 三套并存，且
 * window.confirm 是系统原生样式（D1-M1 已证 Electron 原生输入面不可靠——prompt
 * 必抛，confirm 亦非应用内呈现）。本组件把剩余 window.confirm 全部统一为
 * cp-modal 式应用内确认（DockerView removeConfirm / ApiHub import-overlay 同形态）。
 *
 * 确认时机语义零变化：confirm(opts) 返回 Promise<boolean>——用户点「确认」才
 * resolve true，取消/Esc/点击遮罩 resolve false；await 期间动作不发起（与
 * window.confirm 的阻塞语义等价，只是呈现层进应用内）。CONFIRM_REQUIRED 两段式
 * 的 impacts 文案原样进 body；Skills I5 直切裁决不回退（异常态一次确认保留，
 * 只换呈现形态）。
 *
 * Esc/Enter 键：Esc=取消；Enter=确认（焦点在确认按钮上，autoFocus）。双实例并发
 * 不可能（provider 单请求槽，新请求顶替旧请求时旧请求按取消结算——防御分支）。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface ConfirmOptions {
  /** 弹窗标题（可省；省略时直接展示 body）。 */
  title?: string
  /** 正文（保留换行——两段式 impacts 多行文案原样）。 */
  body: string
  /** 确认按钮文案（缺省「确认」；删除类调用点传「删除」等）。 */
  confirmLabel?: string
  /** 危险动作着色（确认按钮 btn-danger）。 */
  danger?: boolean
}

type ResolveFn = (ok: boolean) => void

const noop = async (): Promise<boolean> => true

/** 缺省 = 直接放行（provider 外误用不阻塞业务——比卡死安全，且等价无确认面）。 */
const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(noop)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmOptions | null>(null)
  const resolveRef = useRef<ResolveFn | null>(null)

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      // 单请求槽：已有未决请求时按取消结算（防御分支，正常流程不会出现）
      if (resolveRef.current !== null) resolveRef.current(false)
      resolveRef.current = resolve
      setRequest(opts)
    })
  }, [])

  const settle = useCallback((ok: boolean) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setRequest(null)
    resolve?.(ok)
  }, [])

  // Esc = 取消（window.confirm 的 Esc 语义原样）
  useEffect(() => {
    if (request === null) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        settle(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [request, settle])

  const value = useMemo(() => confirm, [confirm])

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {request !== null && (
        <div
          className="cp-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={request.title ?? '确认操作'}
          data-testid="confirm-dialog"
          onClick={() => settle(false)}
        >
          <div className="cp-modal" onClick={(e) => e.stopPropagation()}>
            {request.title !== undefined && <h3 className="section-title">{request.title}</h3>}
            <pre className="mono confirm-body">{request.body}</pre>
            <div className="form-row">
              <button
                type="button"
                className={`btn${request.danger === true ? ' btn-danger' : ''}`}
                autoFocus
                onClick={() => settle(true)}
              >
                {request.confirmLabel ?? '确认'}
              </button>
              <button type="button" className="btn" onClick={() => settle(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

/** 应用内确认：await true=确认 / false=取消（替代 window.confirm，语义等价）。 */
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  return useContext(ConfirmContext)
}
