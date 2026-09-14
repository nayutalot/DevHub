/**
 * components/ToastProvider.tsx — 主窗口 App 级唯一 toast 队列（AUDIT D-Aud I12，
 * D5-M3）。
 *
 * 旧形态（StateViews.useToast）：每面板独立实例 + 各自渲染 `.toast`（fixed 定位
 * 同坐标）——同屏多操作时相互覆盖（AgentsView 6+ 面板尤甚）。本形态：主窗口唯一
 * ToastProvider 持有 FIFO 队列，唯一 ToastHost 渲染 `.toast-stack`（bottom-right
 * 纵向堆叠不重叠）；可见上限 3 + 排队（FIFO 出队），单条 3200ms 自动消失（与旧
 * useToast 时长一致）。
 *
 * 双 context 分离（D3-F1 渲染面纪律延续）：`show` 走 ToastApiContext（值恒稳定，
 * show() 不触发任何消费组件重渲染）；items 只走 ToastItemsContext，订阅面=唯一
 * ToastHost。全 UI 中 toast 弹出/消失只重渲染 ToastHost 一个组件。
 *
 * API 形状尽量不变：show(text, tone?) 签名与旧 useToast.show 完全一致，全部调用
 * 点反馈语义零变化（仅承载从"每面板单条"变为"App 级队列"）。
 * OverlayApp 悬浮窗是独立窗口（#overlay 分流，不经 MainApp）——保持无 toast 面，
 * 不挂本 provider（AUDIT 既有裁决，D5 不动）。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToastData } from './StateViews.tsx'

/** 同屏可见上限（其余排队等待，FIFO 出队后顶上）。 */
const TOAST_VISIBLE_MAX = 3
/** 排队总量上限（防连点无限堆积；超限丢最旧等待项，可见段不受影响）。 */
const TOAST_QUEUE_MAX = 9
/** 单条停留时长（= 旧 useToast 3200ms，语义一致）。 */
const TOAST_TTL_MS = 3200

interface QueuedToast extends ToastData {
  id: number
}

interface ToastApi {
  show: (text: string, tone?: 'ok' | 'err') => void
}

const noop = (): void => {}

/** 缺省 = 静默 no-op（provider 外误用不炸，等价旧行为的无 toast 分支）。 */
const ToastApiContext = createContext<ToastApi>({ show: noop })
const ToastItemsContext = createContext<QueuedToast[]>([])

/** 模块级自增 id：同 text/tone 的连续 toast 也各占独立队列槽（不合并、不覆盖）。 */
let nextToastId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<QueuedToast[]>([])
  const timersRef = useRef(new Map<number, number>())

  const show = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    const id = nextToastId++
    setItems((prev) => {
      const next = [...prev, { id, text, tone }]
      return next.length > TOAST_QUEUE_MAX ? next.slice(next.length - TOAST_QUEUE_MAX) : next
    })
    // 每条自带 3200ms 定时器（= 旧 useToast 语义：TTL 从自己 show 时刻起算），
    // 先 show 的先到期出队 → 队列整体 FIFO 排空。
    const timer = window.setTimeout(() => {
      timersRef.current.delete(id)
      setItems((prev) => prev.filter((t) => t.id !== id))
    }, TOAST_TTL_MS)
    timersRef.current.set(id, timer)
  }, [])

  // 卸载清尽全部在途定时器（守门：ref'd 定时器不得拖住窗口销毁，AC9 同款纪律）
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers.values()) window.clearTimeout(t)
      timers.clear()
    }
  }, [])

  const api = useMemo<ToastApi>(() => ({ show }), [show])
  return (
    <ToastApiContext.Provider value={api}>
      <ToastItemsContext.Provider value={items}>{children}</ToastItemsContext.Provider>
    </ToastApiContext.Provider>
  )
}

/**
 * 队列消费 hook：API 与旧 StateViews.useToast 对齐（show(text, tone?)）；
 * 不再返回局部 toast 状态——渲染统一由 App 级唯一 <ToastHost/> 承担。
 * show() 不触发本 hook 使用方重渲染（ToastApiContext 值恒稳定）。
 */
export function useToast(): { show: (text: string, tone?: 'ok' | 'err') => void } {
  return useContext(ToastApiContext)
}

/** 主窗口唯一 toast 出口：渲染可见段（≤TOAST_VISIBLE_MAX），纵向堆叠不相互覆盖。 */
export function ToastHost() {
  const items = useContext(ToastItemsContext)
  const visible = items.length > TOAST_VISIBLE_MAX ? items.slice(items.length - TOAST_VISIBLE_MAX) : items
  if (visible.length === 0) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite" data-testid="toast-host">
      {visible.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
