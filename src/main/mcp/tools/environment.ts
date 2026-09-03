/**
 * tools/environment.ts — devhub.environment.detect / devhub.environment.doctor（docs/08 §6.1/§6.2）。
 *
 * detect 的写库是 DevHub 自身状态持久化（upsert environments / environment_tools），
 * 对操作系统零修改 → READ_ONLY 立场成立（docs/08 §6.1 立场声明、决策 D6）。
 */

import { detectEnvironment, runDoctor } from '../../services/environmentService.ts'
import { defineNoArgTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

const detect: ToolDefinition = defineNoArgTool(
  'devhub.environment.detect',
  'Probe the Windows toolchain and every real WSL distribution, then persist the snapshot in the DevHub database. READ_ONLY towards the operating system: only DevHub state is written.',
  async () => {
    const { environments } = await detectEnvironment()
    const lines = environments.map((env) => {
      const installed = env.tools.filter((tool) => tool.state === 'installed')
      const versions = installed
        .slice(0, 8)
        .map((tool) => `${tool.tool} ${tool.version ?? '?'}`)
        .join(', ')
      return `- ${env.name}: ${installed.length} installed tools (snapshot at ${env.detectedAt})${versions.length > 0 ? `: ${versions}` : ''}`
    })
    return {
      data: { environments },
      summary: `Detected ${environments.length} environment(s).\n${lines.join('\n')}`,
    }
  },
)

const doctor: ToolDefinition = defineNoArgTool(
  'devhub.environment.doctor',
  'Run the environment doctor: rule-based checks over a fresh live probe (PATH-first Python, Win/WSL version mismatches, Docker daemon, WSL state, missing tools). Does not write the database.',
  async () => {
    const { checks } = await runDoctor()
    const lines = checks.map((check) => `[${check.severity.toUpperCase()}] ${check.title}${check.detail !== undefined ? ` — ${check.detail}` : ''}`)
    const warnings = checks.filter((check) => check.severity === 'warning' || check.severity === 'error').length
    return {
      data: { checks },
      summary: `Doctor finished with ${checks.length} check(s), ${warnings} warning(s)/error(s).\n${lines.join('\n')}`,
    }
  },
)

export const environmentTools: ToolDefinition[] = [detect, doctor]
