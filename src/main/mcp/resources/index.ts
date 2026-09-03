/**
 * resources/index.ts — 6 个 devhub:// resource 的注册清单（docs/08 §7）。
 *
 * 注册逻辑集中在 server.ts；本模块只提供 URI 恒定的 ResourceDefinition 列表。
 */

import { renderDashboard } from './dashboard.ts'
import { renderDocker } from './docker.ts'
import { renderEnvironment } from './environment.ts'
import { renderProjects } from './projects.ts'
import { renderServices } from './services.ts'
import { renderWsl } from './wsl.ts'
import type { ResourceDefinition } from '../toolkit.ts'

export const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    name: 'dashboard',
    uri: 'devhub://dashboard',
    description: 'DevHub dashboard counters (projects / dirty repos / docker / services), recent projects and warnings.',
    render: renderDashboard,
  },
  {
    name: 'environment',
    uri: 'devhub://environment',
    description: 'Environment snapshot: Windows and WSL toolchain version tables, PATH-first Python note, Docker daemon status and doctor diagnostics.',
    render: renderEnvironment,
  },
  {
    name: 'projects',
    uri: 'devhub://projects',
    description: 'All tracked projects with path, runtime hint, git summary and container counts.',
    render: renderProjects,
  },
  {
    name: 'services',
    uri: 'devhub://services',
    description: 'Latest services snapshot: ports, processes, origins and project attribution (unknown when unattributed).',
    render: renderServices,
  },
  {
    name: 'docker',
    uri: 'devhub://docker',
    description: 'Docker daemon status and container table with project attribution.',
    render: renderDocker,
  },
  {
    name: 'wsl',
    uri: 'devhub://wsl',
    description: 'WSL availability and distribution table with tool snapshot summaries.',
    render: renderWsl,
  },
]
