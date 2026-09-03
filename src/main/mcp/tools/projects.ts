/**
 * tools/projects.ts — devhub.projects.list / devhub.projects.get（docs/08 §6.3/§6.4）。
 */

import { z } from 'zod'
import { getProject, listMcpSummaries } from '../../services/projectService.ts'
import { relativeTime } from '../projection.ts'
import { defineNoArgTool, defineTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

const list: ToolDefinition = defineNoArgTool(
  'devhub.projects.list',
  'List every project tracked by DevHub with enhanced summaries: win/wsl path, runtime hint, located environment, git summary (branch/dirty/lastScan), docker container counts and last-opened time.',
  async () => {
    const projects = listMcpSummaries()
    const lines = projects.map((p) => {
      const path = p.winPath ?? p.wslPath ?? '—'
      const git = p.git.hasGit ? `${p.git.branch ?? '?'}${p.git.dirtyCount > 0 ? ` (dirty: ${p.git.dirtyCount})` : ' (clean)'}` : 'no git'
      return `- ${p.name} [${p.slug}] — ${path} — runtime: ${p.runtimeHint ?? '—'} — env: ${p.environment !== null ? p.environment.name : '—'} — git: ${git} — docker: ${p.docker.containersRunning}/${p.docker.containersTotal}`
    })
    return {
      data: { projects, count: projects.length },
      summary: `DevHub tracks ${projects.length} project(s).\n${lines.join('\n')}`,
    }
  },
)

const get: ToolDefinition = defineTool(
  'devhub.projects.get',
  'Get one project in full detail: paths, repositories, containers, attributed services, located environments, resource relationships, plus explicit notAvailable placeholders for skills/mcpServers/archives (tables exist but have no service yet).',
  { projectId: z.number().int().positive() },
  async (args) => {
    const detail = getProject(args.projectId)
    const lines = [
      `Project ${detail.name} [${detail.slug}] (id ${detail.id})`,
      `- win path: ${detail.winPath ?? '—'}`,
      `- wsl path: ${detail.wslPath ?? '—'}`,
      `- runtime: ${detail.runtimeHint ?? '—'}`,
      `- repositories: ${detail.repositories.length} (${detail.repositories.filter((r) => r.isDirty).length} dirty)`,
      `- containers: ${detail.containers.length}`,
      `- services: ${detail.services.length}`,
      `- environments: ${detail.environments.map((env) => env.name).join(', ') || '—'}`,
      `- relationships: ${detail.relationships.length}`,
      `- last opened: ${relativeTime(detail.lastOpenedAt)}`,
      `- skills/mcpServers/archives: not tracked yet (TABLE_EXISTS_NO_SERVICE)`,
    ]
    return { data: detail, summary: lines.join('\n') }
  },
)

export const projectTools: ToolDefinition[] = [list, get]
