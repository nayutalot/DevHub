/**
 * App.tsx — 布局骨架 + 视图切换 + 全局刷新上下文（docs/06 §2）。
 *
 * 导航为 useState 切换（不引入 router 依赖）；AppContext 提供 navigate 与
 * refreshKey/refreshAll（扫描完成后整体重拉）。Topbar 显示当前视图名与
 * app:version 真实版本信息（失败静默降级，不影响视图三态）。
 *
 * CP2（docs/22 §4.2）：同一 renderer 产物按 hash 分流——`#overlay` 渲染精简
 * OverlayApp（悬浮窗，无侧栏/顶栏，usePolling 轮询 contestpin:*）；`#contest:<id>`
 * 解析进比赛视图详情态（悬浮窗卡片 openInMain 导航入口）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Sidebar } from './components/Sidebar.tsx'
import { AgentsView } from './views/AgentsView.tsx'
import { ApiHubView } from './views/ApiHubView.tsx'
import { AppContext, type ViewTarget } from './lib/appContext.ts'
import { call } from './lib/ipc.ts'
import { useAsync } from './lib/useAsync.ts'
import { ArchiveView } from './views/ArchiveView.tsx'
import { ContestView } from './views/ContestView.tsx'
import { DashboardView } from './views/DashboardView.tsx'
import { DockerView } from './views/DockerView.tsx'
import { EnvironmentView } from './views/EnvironmentView.tsx'
import { OverlayApp } from './OverlayApp.tsx'
import { ProjectsView } from './views/ProjectsView.tsx'
import { ServicesView } from './views/ServicesView.tsx'
import { SkillsView } from './views/SkillsView.tsx'
import { VersionsView } from './views/VersionsView.tsx'

const VIEW_TITLES: Record<ViewTarget['view'], string> = {
  dashboard: 'Dashboard',
  projects: 'Projects',
  environment: 'Environment',
  services: 'Services',
  skills: 'Skills',
  apihub: 'ApiHub',
  versions: 'Versions',
  docker: 'Docker',
  archive: 'Archive',
  agents: 'Agents',
  contest: 'Contests',
}

/** 页面模式：#overlay → 悬浮窗壳（无主布局）；其余 → 主窗口布局。 */
function initialMode(): 'overlay' | 'main' {
  const hash = window.location.hash
  return hash === '#overlay' || hash === '#/overlay' ? 'overlay' : 'main'
}

/**
 * hash 导航解析（主窗口）：#agents（托盘「查看 Agent 摘要」先例）/
 * #contest:<id>（CP2 悬浮窗卡片 → 比赛详情）/ 默认 dashboard。
 */
function initialTarget(): ViewTarget {
  const hash = window.location.hash
  if (hash === '#agents' || hash === '#/agents') return { view: 'agents' }
  const contestMatch = hash.match(/^#\/?contest:(\d+)$/)
  if (contestMatch !== null) return { view: 'contest', contestId: Number(contestMatch[1]) }
  return { view: 'dashboard' }
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
  const navigate = useCallback((t: ViewTarget) => setTarget(t), [])
  const appState = useMemo(() => ({ refreshKey, refreshAll, navigate }), [refreshKey, refreshAll, navigate])

  return (
    <AppContext.Provider value={appState}>
      <div className="app">
        <Topbar view={target.view} />
        <aside className="sidebar">
          <Sidebar current={target.view} onNavigate={navigate} />
        </aside>
        <main className="content">
          {target.view === 'dashboard' && <DashboardView />}
          {target.view === 'projects' && <ProjectsView initialProjectId={target.projectId} />}
          {target.view === 'environment' && <EnvironmentView />}
          {target.view === 'services' && <ServicesView />}
          {target.view === 'skills' && <SkillsView />}
          {target.view === 'apihub' && <ApiHubView />}
          {target.view === 'versions' && <VersionsView />}
          {target.view === 'docker' && <DockerView />}
          {target.view === 'archive' && <ArchiveView />}
          {target.view === 'agents' && <AgentsView />}
          {target.view === 'contest' && <ContestView initialContestId={target.contestId} />}
        </main>
      </div>
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
