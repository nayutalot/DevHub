/**
 * lib/usePolling.ts — 轮询数据获取 hook（AC5，docs/14 §A.3 轮询模式：renderer
 * 事件获取 = 游标轮询，无广播 channel）。自研、零新依赖（docs/00 约束 #23）。
 *
 * 与 useAsync 的差异：按 intervalMs 周期重跑。调度为「promise 链」——下一轮
 * setTimeout 只在当前 promise 落定后排队（R6：不用 setInterval，避免慢响应堆积）。
 *
 * React 19 StrictMode 双挂载防抖（R6，HANDOFF §6 promise 模式）：
 * - effect 级 cancelled 标志 + 组件级自增 seqRef（竞态防护同 useAsync）；
 *   cleanup 使在途请求失效（过期响应绝不写回 state）；
 * - 禁止模块级 boolean 防抖标记（有 StrictMode 竞态坑，HANDOFF §6）；
 * - 游标幂等由调用方保证：追加按 id 去重（见 AgentsView 事件/消息面板）。
 */

import { useEffect, useRef, useState } from 'react'
import { toAsyncError } from './useAsync.ts'
import type { AsyncError } from './useAsync.ts'

export interface PollingResult<T> {
  data: T | null
  /** 仅首次加载（尚无任何成功响应）为 true——四态规范的 loading。 */
  loading: boolean
  /** 最近一次轮询错误（已有数据时不清空 data，供降级横幅）。 */
  error: AsyncError | null
  /** 手动重跑（重试 / 立即刷新）。 */
  refresh: () => void
}

export function usePolling<T>(fn: () => Promise<T>, deps: readonly unknown[], intervalMs: number): PollingResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<AsyncError | null>(null)
  const [tick, setTick] = useState(0)

  const seqRef = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    let cancelled = false
    const id = ++seqRef.current
    let timer: number | undefined

    const runOnce = async (): Promise<void> => {
      try {
        const result = await fnRef.current()
        if (cancelled || seqRef.current !== id) return
        setData(result)
        setError(null)
        setLoading(false)
      } catch (err) {
        if (cancelled || seqRef.current !== id) return
        setError(toAsyncError(err))
        setLoading(false)
      } finally {
        if (!cancelled && seqRef.current === id) {
          timer = window.setTimeout(() => void runOnce(), intervalMs)
        }
      }
    }

    setLoading(true)
    void runOnce()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      seqRef.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式给定
  }, [...deps, tick, intervalMs])

  const refresh = () => setTick((t) => t + 1)

  return { data, loading, error, refresh }
}

/** AGENTS_POLL_MS：docs/14 §A.3 规定的 Agents 视图轮询间隔（2s）。 */
export const AGENTS_POLL_MS = 2000
