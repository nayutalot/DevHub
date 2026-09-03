/**
 * skills/skm-src/registry.mjs — companion 内联的 registry 读取与 include 匹配。
 * 移植源：Skill-Manager src/shared/registry.ts。适配点：v1/v2 兼容读保留 ——
 * WSL companion 仍读 vault 内 registry.json（DevHub 不再写该文件，但物理文件与
 * WSL clone 中仍在，是 companion 获取 linux agent 清单的唯一通道；DevHub SQLite
 * 是 Windows 侧元数据的唯一事实源，两者职责见 docs/09 §1）。
 */

export function agentIncludes(include, skillName) {
  return include.includes('*') || include.includes(skillName)
}

function isPlatform(v) {
  return v === 'windows' || v === 'linux'
}

export function parseRegistry(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `registry.json 不是合法 JSON: ${String(e)}` }
  }
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'registry.json 根节点必须是对象' }
  const obj = data
  if (obj.version !== 1 && obj.version !== 2) {
    return { ok: false, error: `registry.json version 必须为 1 或 2，实际: ${String(obj.version)}` }
  }
  if (!Array.isArray(obj.agents)) return { ok: false, error: 'registry.json 缺少 agents 数组' }
  const agents = []
  const seen = new Set()
  for (const raw of obj.agents) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'agents 数组存在非对象元素' }
    const a = raw
    if (typeof a.name !== 'string' || !a.name.trim()) return { ok: false, error: 'agent.name 必须是非空字符串' }
    if (seen.has(a.name)) return { ok: false, error: `agent 名重复: ${a.name}` }
    seen.add(a.name)
    if (!isPlatform(a.platform)) return { ok: false, error: `agent ${a.name} platform 必须为 windows|linux` }
    if (typeof a.skillsDir !== 'string' || !a.skillsDir.trim()) {
      return { ok: false, error: `agent ${a.name} skillsDir 必须是非空字符串` }
    }
    if (!Array.isArray(a.include) || a.include.length === 0 || !a.include.every((x) => typeof x === 'string' && x.trim())) {
      return { ok: false, error: `agent ${a.name} include 必须是非空字符串数组（["*"] 或技能名列表）` }
    }
    let agentsDir
    if (a.agentsDir !== undefined) {
      if (typeof a.agentsDir !== 'string' || !a.agentsDir.trim()) {
        return { ok: false, error: `agent ${a.name} agentsDir 必须是非空字符串或缺省` }
      }
      agentsDir = a.agentsDir
    }
    agents.push({
      name: a.name,
      platform: a.platform,
      skillsDir: a.skillsDir,
      include: a.include,
      ...(agentsDir !== undefined ? { agentsDir } : {}),
    })
  }
  return { ok: true, registry: { version: 2, agents } }
}
