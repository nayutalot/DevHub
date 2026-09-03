/**
 * skills/registryLogic.ts — agent include 白名单与 agent 输入校验的纯函数
 * （docs/09 §2 模块映射：Skill-Manager src/shared/registry.ts 的 DevHub 归宿）。
 *
 * 适配点（docs/09 §3.1）：registry.json 在 DevHub 中只读弃用，SQLite skill_agents
 * 是唯一事实源 —— 这里只保留解析/校验逻辑（include 匹配语义、agent 字段校验），
 * v1/v2 registry.json 文件解析不再移植（S1 一次性导入器已负责历史数据）。
 */

import type { SkillAgentInfo } from '../../../shared/types.ts'

/** include 为 ["*"] 或技能名列表（docs/09 §3.1 同语义）。 */
export function agentIncludes(include: readonly string[], skillName: string): boolean {
  return include.includes('*') || include.includes(skillName)
}

/** skill 名规范：小写 kebab-case（a-z0-9 与 -），导入/命名体检共用。 */
export function validateSkillName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
}

export type AgentValidationResult = { ok: true } | { ok: false; error: string }

/**
 * upsertAgent 入参校验（docs/09 §3.1 映射规则）：
 * name 非空、platform 枚举、skillsDir 非空、include 非空字符串数组、agentsDir 可选非空。
 */
export function validateAgentInput(input: {
  name: string
  platform: string
  skillsDir: string
  agentsDir?: string
  include: readonly string[]
}): AgentValidationResult {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return { ok: false, error: 'agent name must be a non-empty string' }
  }
  if (input.platform !== 'windows' && input.platform !== 'linux') {
    return { ok: false, error: `agent ${input.name} platform must be "windows" or "linux"` }
  }
  if (typeof input.skillsDir !== 'string' || input.skillsDir.trim().length === 0) {
    return { ok: false, error: `agent ${input.name} skillsDir must be a non-empty string` }
  }
  if (input.agentsDir !== undefined && (typeof input.agentsDir !== 'string' || input.agentsDir.trim().length === 0)) {
    return { ok: false, error: `agent ${input.name} agentsDir must be a non-empty string when present` }
  }
  if (
    !Array.isArray(input.include) ||
    input.include.length === 0 ||
    !input.include.every((x) => typeof x === 'string' && x.trim().length > 0)
  ) {
    return {
      ok: false,
      error: `agent ${input.name} include must be a non-empty string array (["*"] or skill names)`,
    }
  }
  return { ok: true }
}

/** include_json 列的解析；损坏数据降级为 ['*'] 并由调用方记录（绝不抛错）。 */
export function parseIncludeJson(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return ['*']
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string')) {
      return parsed as string[]
    }
  } catch {
    // 落到降级
  }
  return ['*']
}

/** DB 行 → SkillAgentInfo 投影（snake_case → camelCase，agents_dir 空串归一为缺省）。 */
export function projectAgentRow(row: {
  id: number
  name: string
  platform: string
  skills_dir: string
  agents_dir: string | null
  include_json: string
  enabled: number
}): SkillAgentInfo {
  return {
    id: Number(row.id),
    name: row.name,
    platform: row.platform === 'linux' ? 'linux' : 'windows',
    skillsDir: row.skills_dir,
    ...(row.agents_dir !== null && row.agents_dir !== '' ? { agentsDir: row.agents_dir } : {}),
    include: parseIncludeJson(row.include_json),
    enabled: Number(row.enabled) === 1,
  }
}
