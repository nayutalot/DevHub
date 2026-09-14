/**
 * App.tsx — 布局骨架 + 视图切换 + 全局刷新上下文（docs/06 §2）。
 *
 * 导航为 useState 切换（不引入 router 依赖）；navigate 同步回写 location.hash、
 * initialTarget 全视图映射（深链/F5 刷新保持视图态，AUDIT D-Aud I3）；AppContext
 * 提供 navigate 与 refreshKey/refreshAll（扫描完成后整体重拉）。Topbar 显示当前
 * 视图名与 app:version 真实版本信息（失败静默降级，不影响视图三态）。
 *
 * CP2（docs/22 §4.2）：同一 renderer 产物按 hash 分流——`#overlay` 渲染精简
 * OverlayApp（悬浮窗，无侧栏/顶栏，usePolling 轮询 contestpin:*）；`#contest:<id>`
 * 解析进比赛视图详情态（悬浮窗卡片 openInMain 导航入口）。
 *
 * D3-F2（AUDIT D-Aud F2，行为不变纪律）：11 视图路由级 React.lazy 懒加载——首屏
 * JS 只含壳（Topbar/Sidebar/AppContext）+ 共享依赖，视图代码按 chunk 分包；
 * hash 深链/navigate 回写语义完全不变（D1-M3 回归验证）。懒加载兜底绝不白屏：
 * Suspense 加载态 + 懒加载 rejection / 视图渲染错误捕获 → 结构化 ErrorState +
 * 重试（重建 lazy 组件绕过 React 对 payload rejection 的缓存）。OverlayApp 保持
 * 静态 import（悬浮窗小而常驻，避免微小置顶部件出现加载闪空）。
 *
 * D5-M2（AUDIT D-Aud I11）：窗口级键盘快捷键——F5/Ctrl+R 刷新、Ctrl+1..9 切视图
 * （顺序=侧栏序）、/ 聚焦当前视图搜索框（输入控件聚焦时不抢占）。零 router 依赖，
 * 只加 keydown 监听，useState 路由与 hash 映射机制原样。
 */

import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { Sidebar } from './components/Sidebar.tsx'
import { ToastHost, ToastProvider } from './components/ToastProvider.tsx'
import { AppContext, type ViewTarget } from './lib/appContext.ts'
import { call } from './lib/ipc.ts'
import { useAsync } from './lib/useAsync.ts'
import { ErrorState, Loading } from './components/StateViews.tsx'
import { OverlayApp } from './OverlayApp.tsx'

/** 视图 chunk 加载器（具名导出 → lazy 契约 { default: Component }）。 */
const loadDashboard = (): Promise<{ default: typeof import('./views/DashboardView.tsx').DashboardView }> =>
  import('./views/DashboardView.tsx').then((m) => ({ default: m.DashboardView }))
const loadProjects = (): Promise<{ default: typeof import('./views/ProjectsView.tsx').ProjectsView }> =>
  import('./views/ProjectsView.tsx').then((m) => ({ default: m.ProjectsView }))
const loadEnvironment = (): Promise<{ default: typeof import('./views/EnvironmentView.tsx').EnvironmentView }> =>
  import('./views/EnvironmentView.tsx').then((m) => ({ default: m.EnvironmentView }))
const loadServices = (): Promise<{ default: typeof import('./views/ServicesView.tsx').ServicesView }> =>
  import('./views/ServicesView.tsx').then((m) => ({ default: m.ServicesView }))
const loadSkills = (): Promise<{ default: typeof import('./views/SkillsView.tsx').SkillsView }> =>
  import('./views/SkillsView.tsx').then((m) => ({ default: m.SkillsView }))
const loadApiHub = (): Promise<{ default: typeof import('./views/ApiHubView.tsx').ApiHubView }> =>
  import('./views/ApiHubView.tsx').then((m) => ({ default: m.ApiHubView }))
const loadVersions = (): Promise<{ default: typeof import('./views/VersionsView.tsx').VersionsView }> =>
  import('./views/VersionsView.tsx').then((m) => ({ default: m.VersionsView }))
const loadDocker = (): Promise<{ default: typeof import('./views/DockerView.tsx').DockerView }> =>
  import('./views/DockerView.tsx').then((m) => ({ default: m.DockerView }))
const loadArchive = (): Promise<{ default: typeof import('./views/ArchiveView.tsx').ArchiveView }> =>
  import('./views/ArchiveView.tsx').then((m) => ({ default: m.ArchiveView }))
const loadAgents = (): Promise<{ default: typeof import('./views/AgentsView.tsx').AgentsView }> =>
  import('./views/AgentsView.tsx').then((m) => ({ default: m.AgentsView }))
const loadContest = (): Promise<{ default: typeof import('./views/ContestView.tsx').ContestView }> =>
  import('./views/ContestView.tsx').then((m) => ({ default: m.ContestView }))

const VIEW_TITLES: Record<ViewTarget['view'], string> = {
  dashboard: '仪表盘',
  projects: '项目',
  environment: '环境',
  services: '服务',
  skills: '技能',
  apihub: 'ApiHub',
  versions: '版本',
  docker: 'Docker',
  archive: '归档',
  agents: 'Agents',
  contest: '比赛',
}

/** 页面模式：#overlay → 悬浮窗壳（无主布局）；其余 → 主窗口布局。 */
function initialMode(): 'overlay' | 'main' {
  const hash = window.location.hash
  return hash === '#overlay' || hash === '#/overlay' ? 'overlay' : 'main'
}

/**
 * hash 导航解析（主窗口）：11 视图全映射（AUDIT D-Aud I3——原仅 #agents/
 * #contest:<id> 两个入口，其余视图深链/刷新全落 Dashboard）。canonical 形态
 * `#<view>` / `#contest:<id>`（托盘「查看 Agent 摘要」#agents 与 CP2 悬浮窗
 * openInMain #contest:<id> 既有行为不变；#/​<view> 斜杠变体兼容保留）。
 */
const VIEW_IDS: readonly ViewTarget['view'][] = [
  'dashboard',
  'projects',
  'environment',
  'services',
  'skills',
  'apihub',
  'versions',
  'docker',
  'archive',
  'agents',
  'contest',
]

/** ViewTarget → canonical hash（projects 的 projectId 属视图内选中态，不入 hash）。 */
function hashForTarget(t: ViewTarget): string {
  return t.view === 'contest' && t.contestId !== undefined ? `#contest:${t.contestId}` : `#${t.view}`
}

/**
 * Ctrl+1..9 → 视图映射（AUDIT D-Aud I11，D5-M2）：顺序=侧栏序（Sidebar NAV_ITEMS）
 * 前 9 项；Agents/比赛无数字位（Ctrl+0/10+ 不占用，侧栏点击仍可达）。
 */
const SHORTCUT_VIEWS: readonly ViewTarget['view'][] = VIEW_IDS.slice(0, 9)

function initialTarget(): ViewTarget {
  const key = window.location.hash.replace(/^#\/?/, '')
  const contestMatch = key.match(/^contest:(\d+)$/)
  if (contestMatch !== null) return { view: 'contest', contestId: Number(contestMatch[1]) }
  if ((VIEW_IDS as readonly string[]).includes(key)) return { view: key } as ViewTarget
  return { view: 'dashboard' }
}

/**
 * 懒加载视图槽（D3-F2）：Suspense 加载态 + 加载失败兜底，绝不白屏。
 *
 * 重试语义：HTML 规范把加载失败的模块脚本记入 module map——同 URL 再 import
 * 永远命中失败缓存，原地 re-import 不可恢复；唯一可靠的会话内恢复是整页重载。
 * hash 路由（D1-M3）保证重载后 initialTarget 直接回到当前视图，用户无感位置
 * 丢失。捕获面同时覆盖视图渲染错误（此前无边界 = 白屏崩溃，现降级为可重试
 * 错误态，严格更优）。
 */
function LazyView<P>({ load, label, render }: {
  load: () => Promise<{ default: ComponentType<P> }>
  label: string
  render: (View: ComponentType<P>) => ReactNode
}) {
  const [error, setError] = useState<Error | null>(null)
  const Lazy = useMemo(() => lazy(load), [load])
  if (error !== null) {
    return (
      <ErrorState
        error={{ code: 'VIEW_CHUNK_LOAD_FAILED', message: `${label}视图加载失败：${error.message}` }}
        onRetry={() => window.location.reload()}
      />
    )
  }
  return (
    <LazyErrorCatcher onError={setError}>
      <Suspense fallback={<Loading label={`正在加载${label}视图…`} />}>{render(Lazy)}</Suspense>
    </LazyErrorCatcher>
  )
}

/** 仅捕获并上报（懒加载 rejection / 渲染错误）——兜底 UI 与重试在 LazyView。 */
class LazyErrorCatcher extends Component<{ children: ReactNode; onError: (error: Error) => void }> {
  override componentDidCatch(error: Error): void {
    this.props.onError(error)
  }
  override render(): ReactNode {
    return this.props.children
  }
}

export default function App() {
  const [mode] = useState(initialMode)
  if (mode === 'overlay') return <OverlayApp />
  return <MainApp />
}

function MainApp() {
  const [target, setTarget] = useState<ViewTarget>(initialTarget)
  const [refreshKey, setRefreshKey] = useState(0)

  // 同文档 hash 导航（loadFile 仅换 fragment）Chromium 不重载页面：hashchange 时重解析目标，覆盖 openInMain `#contest:<id>` 与托盘 `#agents` 两路径。
  useEffect(() => {
    const onHashChange = (): void => setTarget(initialTarget())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const refreshAll = useCallback(() => setRefreshKey((k) => k + 1), [])
  // navigate 同步回写 hash（AUDIT D-Aud I3：F5/重开保持视图态）。setTarget 先行
  // 保证即时切换；hashchange 随后的重解析产生等价 target（initial*Id 均为
  // useState 初值，prop 变更无副作用），不回环。
  const navigate = useCallback((t: ViewTarget) => {
    setTarget(t)
    const h = hashForTarget(t)
    if (window.location.hash !== h) window.location.hash = h
  }, [])

  // 键盘快捷键（AUDIT D-Aud I11，D5-M2；零 router 依赖，只加监听不动路由机制）：
  //   F5 / Ctrl+R → 刷新（refreshAll 全局键自增；已挂载视图=当前视图随之重拉）；
  //   Ctrl+1..9   → 切视图（顺序=侧栏序前 9 项，经既有 navigate→hash 回写路径）；
  //   /           → 聚焦当前视图搜索框（.search-input；无则忽略；输入控件聚焦时
  //                 不抢占——在输入框里打 / 必须是字面字符）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const plainCtrl = e.ctrlKey && !e.altKey && !e.metaKey
      if (e.key === 'F5' || (plainCtrl && !e.shiftKey && (e.key === 'r' || e.key === 'R'))) {
        e.preventDefault()
        refreshAll()
        return
      }
      if (plainCtrl && !e.shiftKey && e.key >= '1' && e.key <= '9') {
        const view = SHORTCUT_VIEWS[Number(e.key) - 1]
        if (view !== undefined) {
          e.preventDefault()
          navigate({ view } as ViewTarget)
        }
        return
      }
      if (e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        const t = e.target
        if (
          t instanceof HTMLElement &&
          (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
        ) {
          return
        }
        const search = document.querySelector<HTMLElement>('.content .search-input')
        if (search !== null) {
          e.preventDefault()
          search.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate, refreshAll])

  const appState = useMemo(() => ({ refreshKey, refreshAll, navigate }), [refreshKey, refreshAll, navigate])

  return (
    <AppContext.Provider value={appState}>
      {/* App 级唯一 toast 队列（AUDIT D-Aud I12，D5-M3）：主窗口全部视图共享，
          bottom-right 堆叠不再相互覆盖；OverlayApp 独立窗口不经此处（保持不动） */}
      <ToastProvider>
        <div className="app">
          <Topbar view={target.view} />
          <aside className="sidebar">
            <Sidebar current={target.view} onNavigate={navigate} />
          </aside>
          <main className="content">
            {target.view === 'dashboard' && <LazyView load={loadDashboard} label="仪表盘" render={(V) => <V />} />}
            {target.view === 'projects' && (
              <LazyView load={loadProjects} label="项目" render={(V) => <V initialProjectId={target.projectId} />} />
            )}
            {target.view === 'environment' && <LazyView load={loadEnvironment} label="环境" render={(V) => <V />} />}
            {target.view === 'services' && <LazyView load={loadServices} label="服务" render={(V) => <V />} />}
            {target.view === 'skills' && <LazyView load={loadSkills} label="技能" render={(V) => <V />} />}
            {target.view === 'apihub' && <LazyView load={loadApiHub} label="ApiHub" render={(V) => <V />} />}
            {target.view === 'versions' && <LazyView load={loadVersions} label="版本" render={(V) => <V />} />}
            {target.view === 'docker' && <LazyView load={loadDocker} label="Docker" render={(V) => <V />} />}
            {target.view === 'archive' && <LazyView load={loadArchive} label="归档" render={(V) => <V />} />}
            {target.view === 'agents' && <LazyView load={loadAgents} label="Agents" render={(V) => <V />} />}
            {target.view === 'contest' && (
              <LazyView load={loadContest} label="比赛" render={(V) => <V initialContestId={target.contestId} />} />
            )}
          </main>
          <ToastHost />
        </div>
      </ToastProvider>
    </AppContext.Provider>
  )
}

function Topbar({ view }: { view: ViewTarget['view'] }) {
  const version = useAsync(() => call('app:version', {}), [])
  return (
    <header className="topbar">
      <span className="topbar-title">DevHub</span>
      <span className="topbar-sep">·</span>
      <span className="topbar-view">{VIEW_TITLES[view]}</span>
      <span className="topbar-sub mono">
        {version.data !== null
          ? `v${version.data.appVersion} · electron ${version.data.electronVersion || '-'} · node ${version.data.nodeVersion}`
          : ''}
      </span>
    </header>
  )
}
