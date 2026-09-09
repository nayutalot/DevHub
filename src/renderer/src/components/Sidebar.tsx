/**
 * components/Sidebar.tsx — 固定导航（docs/06 §2；S2 批次追加 Skills，S3 批次追加
 * ApiHub / Versions，S4 批次追加 Docker，S5 批次启用 Archive，AC5 批次启用
 * Agents，CP2 批次追加 Contests）：Dashboard / Projects / Environment / Services /
 * Skills / ApiHub / Versions / Docker / Archive / Agents / Contests，图标为内联
 * SVG（无图标库依赖），高亮当前项；不折叠。
 */

import type { ReactElement } from 'react'
import type { ViewTarget } from '../lib/appContext.ts'

const NAV_ITEMS: { target: ViewTarget; label: string; icon: ReactElement }[] = [
  { target: { view: 'dashboard' }, label: 'Dashboard', icon: <IconDashboard /> },
  { target: { view: 'projects' }, label: 'Projects', icon: <IconProjects /> },
  { target: { view: 'environment' }, label: 'Environment', icon: <IconEnvironment /> },
  { target: { view: 'services' }, label: 'Services', icon: <IconServices /> },
  { target: { view: 'skills' }, label: 'Skills', icon: <IconSkills /> },
  { target: { view: 'apihub' }, label: 'ApiHub', icon: <IconApiHub /> },
  { target: { view: 'versions' }, label: 'Versions', icon: <IconVersions /> },
  { target: { view: 'docker' }, label: 'Docker', icon: <IconDocker /> },
  { target: { view: 'archive' }, label: 'Archive', icon: <IconArchive /> },
  { target: { view: 'agents' }, label: 'Agents', icon: <IconAgents /> },
  { target: { view: 'contest' }, label: 'Contests', icon: <IconContests /> },
]

function iconProps() {
  return {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
}

function IconDashboard() {
  return (
    <svg {...iconProps()}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  )
}

function IconProjects() {
  return (
    <svg {...iconProps()}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

function IconEnvironment() {
  return (
    <svg {...iconProps()}>
      <rect x="6" y="6" width="12" height="12" />
      <rect x="10" y="10" width="4" height="4" />
      <line x1="9" y1="3" x2="9" y2="6" />
      <line x1="15" y1="3" x2="15" y2="6" />
      <line x1="9" y1="18" x2="9" y2="21" />
      <line x1="15" y1="18" x2="15" y2="21" />
      <line x1="3" y1="9" x2="6" y2="9" />
      <line x1="3" y1="15" x2="6" y2="15" />
      <line x1="18" y1="9" x2="21" y2="9" />
      <line x1="18" y1="15" x2="21" y2="15" />
    </svg>
  )
}

function IconServices() {
  return (
    <svg {...iconProps()}>
      <polyline points="2 12 6 12 9 4 14 20 17 12 22 12" />
    </svg>
  )
}

/** Skills：积木/拼块形态（与四项内联 SVG 同风格）。 */
function IconSkills() {
  return (
    <svg {...iconProps()}>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="7" width="8" height="8" rx="1" />
      <rect x="6" y="13" width="8" height="8" rx="1" />
    </svg>
  )
}

/** ApiHub：钥匙形态（接口中心档案/密钥切换）。 */
function IconApiHub() {
  return (
    <svg {...iconProps()}>
      <circle cx="8" cy="15" r="4" />
      <line x1="11" y1="12" x2="20" y2="3" />
      <line x1="16.5" y1="6.5" x2="19.5" y2="9.5" />
      <line x1="14" y1="9" x2="16" y2="11" />
    </svg>
  )
}

/** Versions：下载/版本形态（向下箭头入托盘）。 */
function IconVersions() {
  return (
    <svg {...iconProps()}>
      <path d="M12 3v10" />
      <polyline points="8 9 12 13 16 9" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

/** Docker：集装箱堆 + 底座（Portainer 风格页）。 */
function IconDocker() {
  return (
    <svg {...iconProps()}>
      <rect x="4" y="11" width="5" height="4" />
      <rect x="9.5" y="11" width="5" height="4" />
      <rect x="6.75" y="6.5" width="5" height="4" />
      <path d="M2.5 15h19a8 8 0 0 1 -6 5h-7a8 8 0 0 1 -6 -5Z" />
    </svg>
  )
}

/** Archive：归档箱（docs/10 归档模块页）。 */
function IconArchive() {
  return (
    <svg {...iconProps()}>
      <path d="M3 7h18v4H3z" />
      <path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
      <line x1="10" y1="15" x2="14" y2="15" />
    </svg>
  )
}

/** Agents：机器人形态（头身 + 天线 + 双眼，docs/11 §5 Agent Control 页）。 */
function IconAgents() {
  return (
    <svg {...iconProps()}>
      <rect x="5" y="9" width="14" height="10" rx="2" />
      <line x1="12" y1="9" x2="12" y2="5" />
      <circle cx="12" cy="4" r="1" />
      <line x1="9" y1="13" x2="9" y2="13.01" />
      <line x1="15" y1="13" x2="15" y2="13.01" />
      <path d="M9.5 16.5h5" />
    </svg>
  )
}

/** Contests：奖杯形态（赛程钉比赛模块页，CP2）。 */
function IconContests() {
  return (
    <svg {...iconProps()}>
      <path d="M8 4h8v5a4 4 0 0 1-8 0Z" />
      <path d="M8 5H5a3 3 0 0 0 3 4" />
      <path d="M16 5h3a3 3 0 0 1-3 4" />
      <line x1="12" y1="13" x2="12" y2="16" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="10" y1="16" x2="14" y2="16" />
    </svg>
  )
}

export function Sidebar({ current, onNavigate }: { current: string; onNavigate: (t: ViewTarget) => void }) {
  return (
    <nav className="nav" aria-label="Main navigation">
      {NAV_ITEMS.map((item) => {
        const active = item.target.view === current
        return (
          <button
            key={item.target.view}
            type="button"
            className={`nav-item${active ? ' active' : ''}`}
            onClick={() => onNavigate(item.target)}
            aria-current={active ? 'page' : undefined}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
