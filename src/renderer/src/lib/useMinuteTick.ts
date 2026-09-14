/**
 * lib/useMinuteTick.ts — 全局低频 1 分钟时效 tick（AUDIT D-Aud F6，D5-M4）。
 *
 * 非轮询视图的 relativeTime 文案（"刚刚"/"N 分钟前"）直到数据重拉才变——本模块
 * 提供进程级单例 60s interval：组件订阅 useMinuteTick()，每分钟拿到新版本号触发
 * 一次重渲染，relativeTime 输出随之自然刷新。**format.ts 输出文本契约零触碰**
 * （D2 批 smoke 断言联动 0 处口径——relativeTime 中文输出原样）。
 *
 * 渲染面纪律：单例 interval + 引用计数——首个订阅者挂表、最后一个退订清表；
 * 返回值 1 分钟才变一次，未订阅组件零影响（轮询视图如 AgentsView 自带 2s/30s
 * 时效桶，无需订阅）。
 */

import { useSyncExternalStore } from 'react'

const MINUTE_MS = 60_000

let version = 0
let timer: number | undefined = undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === undefined) {
    timer = window.setInterval(() => {
      version += 1
      for (const l of listeners) l()
    }, MINUTE_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer)
      timer = undefined
    }
  }
}

function getSnapshot(): number {
  return version
}

/** 订阅全局 1min tick：返回值仅在每分钟边界变化（触发订阅组件重渲染一次）。 */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot)
}
