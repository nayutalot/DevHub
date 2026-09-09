/**
 * lib/appContext.ts — App 级上下文（docs/06 §2）：
 * 视图切换（useState 路由，不引入 router 依赖）+ 全局刷新键。
 *
 * StatCard / Recent Projects / Services 归因列等"可点击跳转"通过 navigate；
 * 扫描完成后 refreshAll 让所有已挂载视图重拉数据。上下文建在独立模块避免
 * App ↔ views 循环 import。
 */

import { createContext, useContext } from 'react'

/** 目标视图；projects 可携带要选中的项目 id、contest 可携带比赛 id（跨视图跳转到详情，CP2 悬浮窗 openInMain）。 */
export type ViewTarget =
  | { view: 'dashboard' }
  | { view: 'projects'; projectId?: number }
  | { view: 'environment' }
  | { view: 'services' }
  | { view: 'skills' }
  | { view: 'apihub' }
  | { view: 'versions' }
  | { view: 'docker' }
  | { view: 'archive' }
  | { view: 'agents' }
  | { view: 'contest'; contestId?: number }

export interface AppState {
  /** 全局刷新键：refreshAll 自增，视图把它并进 useAsync deps 实现整体重拉。 */
  refreshKey: number
  refreshAll: () => void
  navigate: (target: ViewTarget) => void
}

const noop = (): void => {}

export const AppContext = createContext<AppState>({
  refreshKey: 0,
  refreshAll: noop,
  navigate: noop,
})

export function useApp(): AppState {
  return useContext(AppContext)
}
