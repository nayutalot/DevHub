/**
 * lib/useAsync.ts — 自研数据获取 hook（不新增 npm 依赖，docs/00 约束 #23/#24）。
 *
 * useAsync(fn, deps)：挂载 / deps 变化 / refresh() 时执行 fn，管理
 * loading / data / error 三态；过期请求（竞态）一律丢弃；错误统一折叠为
 * { code, message } 结构（约束 #14，无堆栈）。视图三态由 StateViews 渲染。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IpcError } from './ipc.ts'

/** 视图 error 态的错误形状（与 Result envelope 的 DomainError 对齐）。 */
export interface AsyncError {
  code: string
  message: string
}

function toAsyncError(err: unknown): AsyncError {
  if (err instanceof IpcError) return { code: err.code, message: err.message }
  if (err instanceof Error) return { code: 'INTERNAL', message: err.message }
  return { code: 'INTERNAL', message: String(err) }
}

/** 导出给 usePolling（同款错误折叠；约束 #14 形状统一）。 */
export { toAsyncError }

export interface UseAsyncResult<T> {
  data: T | null
  loading: boolean
  error: AsyncError | null
  /** 手动重跑（deps 不变时的重试 / 刷新入口）。 */
  refresh: () => void
  /** 本地写回（如操作完成后同步数据，避免整页 loading）。 */
  setData: (data: T) => void
}

/**
 * @param fn 数据获取函数（通常是一次 call(channel, payload)）
 * @param deps 依赖数组：变化即重跑；调用方保证数组字面长度稳定
 */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): UseAsyncResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<AsyncError | null>(null)
  const [tick, setTick] = useState(0)

  // 竞态防护：自增序号，只有最新一次请求允许写回状态
  const seqRef = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    const id = ++seqRef.current
    setLoading(true)
    setError(null)
    fnRef.current().then(
      (result) => {
        if (seqRef.current === id) {
          setData(result)
          setLoading(false)
        }
      },
      (err) => {
        if (seqRef.current === id) {
          setError(toAsyncError(err))
          setLoading(false)
        }
      },
    )
    return () => {
      // 卸载 / deps 变化：使在途请求失效
      seqRef.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式给定
  }, [...deps, tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  return { data, loading, error, refresh, setData }
}
