/**
 * App.tsx — 布局骨架 + 视图切换 + 全局刷新上下文（docs/06 §2）。
 *
 * 导航为 useState 切换（不引入 router 依赖）；AppContext 提供 navigate 与
 * refreshKey/refreshAll（扫描完成后整体重拉）。Topbar 显示当前视图名与
 * app:version 真实版本信息（失败静默降级，不影响视图三态）。
 */

import { useCallback, useMemo, useState } from 'react'
import { Sidebar } from './components/Sidebar.tsx'
import { AgentsView } from './views/AgentsView.tsx'
import { ApiHubView } from './views/ApiHubView.tsx'
import { AppContext, type ViewTarget } from './lib/appContext.ts'
import { call } from './lib/ipc.ts'
import { useAsync } from './lib/useAsync.ts'
import { ArchiveView } from './views/ArchiveView.tsx'
import { DashboardView } from './views/DashboardView.tsx'
import { DockerView } from './views/DockerView.tsx'
import { EnvironmentView } from './views/EnvironmentView.tsx'
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
}

/** 托盘「查看 Agent 摘要」导航（docs/12 §10）：主进程以 #agents hash 重载页面。 */
function initialTarget(): ViewTarget {
  const hash = window.location.hash
  return hash === '#agents' || hash === '#/agents' ? { view: 'agents' } : { view: 'dashboard' }
}

export default function App() {
  const [target, setTarget] = useState<ViewTarget>(initialTarget)
  const [refreshKey, setRefreshKey] = useState(0)

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
