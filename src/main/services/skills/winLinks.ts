/**
 * skills/winLinks.ts — Windows 侧 junction/硬链接扫描与 LinkState 五态判定
 * （docs/09 §2 模块映射：Skill-Manager src/main/winLinks.ts 的 Service 层归宿）。
 *
 * 自只读参考实现逐语义移植，适配点：
 *  - 纯 node:fs 直用（docs/09 §11.2：node:fs 链接操作在 Service 层内做）；
 *  - agent 数据来自调用方（SQLite skill_agents 投影），不再读 registry.json；
 *  - junction 判定用 fs.readlink + fs.statSync(..., { throwIfNoEntry: false })。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { LinkState, SkillMeta } from '../../../shared/types.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { agentIncludes } from './registryLogic.ts'

/** 去掉 \\?\ / \??\ 前缀，统一反斜杠（保留大小写，用于真实路径解析） */
export function stripWinPrefix(p: string): string {
  let s = String(p ?? '').replace(/\//g, '\\')
  if (s.startsWith('\\\\?\\')) s = s.slice(4)
  else if (s.startsWith('\\??\\')) s = s.slice(4)
  return s
}

/** 归一化用于比较：去前缀 + normalize + 小写 + 去尾部反斜杠（保留盘根），Windows 路径不区分大小写 */
export function normalizeWinPath(p: string): string {
  const n = path.normalize(stripWinPrefix(p)).toLowerCase()
  return n.length > 3 && n.endsWith('\\') ? n.slice(0, -1) : n
}

export function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

export function pathExists(p: string): boolean {
  return lstatSafe(p) !== null
}

/** 该路径当前是否为链接（junction/symlink；lstat 的 isSymbolicLink 判定） */
export function isLinkPath(p: string): boolean {
  const st = lstatSafe(p)
  return st !== null && st.isSymbolicLink()
}

/**
 * LinkState 判定（docs/09 §4.1）：
 * - linked         链接存在且指向 vault 目标，且目标存在
 * - vault-missing  链接指向 vault 目标但 vault 目录缺失（悬空）
 * - wrong-target   链接指向其它位置，或该位置是普通文件
 * - real-dir       同名真实目录（非链接）
 * - missing        路径不存在
 */
export function getLinkState(linkPath: string, expectedTarget: string): LinkState {
  const st = lstatSafe(linkPath)
  if (st === null) return 'missing'
  if (!st.isSymbolicLink()) return st.isDirectory() ? 'real-dir' : 'wrong-target'
  let target = ''
  try {
    target = fs.readlinkSync(linkPath)
  } catch {
    return 'wrong-target'
  }
  const matches = normalizeWinPath(target) === normalizeWinPath(expectedTarget)
  if (!matches) return 'wrong-target'
  return fs.statSync(expectedTarget, { throwIfNoEntry: false }) !== undefined ? 'linked' : 'vault-missing'
}

// ---------- agentsDir 专属判定：junction/symlink 之外，识别「真实目录 + 硬链接共享」形态 ----------
// 背景（docs/09 §4.2）：Windows junction 会在 ZCode 重启时被替换成空目录，.zcode\agents
// 的正确形态是真实目录 + 指向 vault agents/*.md 的硬链接（同一 dev+ino）。

/** agentsDir 状态为 linked 时的附注：真实目录形态的硬链接共享 */
export const AGENTS_DIR_HARDLINK_NOTE = '硬链接共享'

export type AgentsDirState = { state: LinkState; note?: string }

/** 同一文件判定：stat 的 dev+ino 相等（Windows NTFS 上可用；硬链接即同一文件） */
export function sameFileByIno(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    return sa.dev === sb.dev && sa.ino === sb.ino
  } catch {
    return false
  }
}

/** vault agents/ 下的 .md 文件清单（排序；目录不存在返回空） */
export function listVaultAgentFiles(vaultPath: string): string[] {
  const dir = vaultAgentsDir(vaultPath)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * 真实目录是否为指向 vault agents 的硬链接共享目录：
 * vault agents/ 每个 .md 在目录中有同名同 inode 文件，且目录里没有 vault 缺名的多余 .md。
 * 任何 stat/读目录异常（文件被占用等）一律返回 false（从冲突处理，可修复）。
 */
export function isHardlinkSharedAgentsDir(agentsDir: string, vaultPath: string): boolean {
  let vaultFiles: string[]
  try {
    vaultFiles = listVaultAgentFiles(vaultPath)
  } catch {
    return false
  }
  const vaultSet = new Set(vaultFiles)
  let dirFiles: string[]
  try {
    dirFiles = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
  } catch {
    return false
  }
  for (const f of dirFiles) {
    if (!vaultSet.has(f)) return false
  }
  const vaultAgents = vaultAgentsDir(vaultPath)
  for (const f of vaultFiles) {
    if (!sameFileByIno(path.join(vaultAgents, f), path.join(agentsDir, f))) return false
  }
  return true
}

/**
 * agentsDir 的状态判定（扫描专用，不用于 skill 逐目录链接）：
 * - junction/symlink → getLinkState 语义
 * - 真实目录 + 硬链接共享 → linked（附注「硬链接共享」）
 * - 其余真实目录 / stat 异常 → real-dir（冲突，可一键修复）
 */
export function agentsDirStateOf(vaultPath: string, agentsDir: string): AgentsDirState {
  const target = vaultAgentsDir(vaultPath)
  const st = lstatSafe(agentsDir)
  if (st === null) return { state: 'missing' }
  if (st.isSymbolicLink()) return { state: getLinkState(agentsDir, target) }
  if (!st.isDirectory()) return { state: 'wrong-target' }
  if (isHardlinkSharedAgentsDir(agentsDir, vaultPath)) return { state: 'linked', note: AGENTS_DIR_HARDLINK_NOTE }
  return { state: 'real-dir' }
}

// ---------- agentsDir 一键修复（vault 为源，重建硬链接共享目录；docs/09 §4.2） ----------

export type AgentsRepairOptions = {
  /** 备份/回收目录时间戳时钟（测试固定命名） */
  now?: () => Date
  /** 回收根目录覆写（缺省 = vault 同级 .trash-<ts>/；测试注入临时目录） */
  trashRoot?: string
}

export type AgentsRepairResult = { steps: string[]; state: LinkState; note?: string }

/** 把文件移入回收目录；同卷 rename 直移，跨卷/失败降级 copy+unlink；返回回收后的绝对路径 */
function trashMove(file: string, trashDir: string): string {
  fs.mkdirSync(trashDir, { recursive: true })
  const dest = path.join(trashDir, path.basename(file))
  try {
    fs.renameSync(file, dest)
    return dest
  } catch {
    fs.copyFileSync(file, dest)
    fs.unlinkSync(file)
    return dest
  }
}

/**
 * 以 vault agents/ 为源，把 agentsDir 重建为硬链接共享目录：
 * 1) agentsDir 是 junction/symlink → 先解除；是文件 → 拒绝（不自动删除非预期形态）
 * 2) 确保目录存在（含 junction 被替换成空目录后仍存在的常态）
 * 3) vault 每个 .md：同名同 inode 跳过；同名不同文件先移入回收目录再 fs.linkSync；缺失则直接硬链接
 * 4) 目录里 vault 没有的多余 .md → 移入回收目录（不直接删除，可人工找回）
 * vault agents 目录不存在时抛错（无源可链，属 vault 缺失而非 agentsDir 冲突）。
 */
export function repairAgentsDirHardlinks(vaultPath: string, agentsDir: string, opts: AgentsRepairOptions = {}): AgentsRepairResult {
  const vaultAgents = vaultAgentsDir(vaultPath)
  if (!pathExists(vaultAgents)) throw new Error(`vault 中不存在 agents 目录，无源可链接: ${vaultAgents}`)
  const now = opts.now ?? (() => new Date())
  const ts = now().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const trashDir = opts.trashRoot ?? path.join(path.dirname(path.resolve(vaultPath)), '.trash-' + ts)
  const steps: string[] = []

  const st = lstatSafe(agentsDir)
  if (st?.isSymbolicLink() === true) {
    removeLink(agentsDir)
    steps.push('已移除既有链接（junction/symlink），改为真实目录 + 硬链接')
  } else if (st !== null && !st.isDirectory()) {
    throw new Error(`目标是文件，拒绝自动修复: ${agentsDir}`)
  }
  if (st === null) {
    fs.mkdirSync(agentsDir, { recursive: true })
    steps.push('已创建目录: ' + agentsDir)
  }

  const vaultFiles = listVaultAgentFiles(vaultPath)
  for (const f of vaultFiles) {
    const src = path.join(vaultAgents, f)
    const dst = path.join(agentsDir, f)
    if (sameFileByIno(src, dst)) {
      steps.push('同名同 inode，已一致，跳过: ' + f)
      continue
    }
    if (pathExists(dst)) {
      const trashed = trashMove(dst, trashDir)
      steps.push('同名但非同一文件，旧文件移入 ' + trashed)
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.linkSync(src, dst)
    steps.push('已建立硬链接: ' + f)
  }

  const dirEntries = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
  for (const e of dirEntries) {
    if (vaultFiles.includes(e.name)) continue
    const trashed = trashMove(path.join(agentsDir, e.name), trashDir)
    steps.push('vault 没有的多余文件，移入 ' + trashed + ': ' + e.name)
  }

  const after = agentsDirStateOf(vaultPath, agentsDir)
  steps.push('修复后状态: ' + after.state + (after.note ? `（${after.note}）` : ''))
  return { steps, state: after.state, ...(after.note !== undefined ? { note: after.note } : {}) }
}

/**
 * 解除 agentsDir 的硬链接共享（disable 方向）：仅删除与 vault agents/ 同 inode 的
 * 硬链接文件本体，真实目录与非硬链接文件一律保留；目录不存在为幂等 no-op。
 */
export function removeAgentsDirHardlinks(vaultPath: string, agentsDir: string): AgentsRepairResult {
  const steps: string[] = []
  if (!pathExists(agentsDir) || !lstatSafe(agentsDir)?.isDirectory()) {
    return { steps: ['目录不存在或不是真实目录，无需清理'], state: agentsDirStateOf(vaultPath, agentsDir).state }
  }
  const vaultFiles = listVaultAgentFiles(vaultPath)
  let removed = 0
  for (const f of vaultFiles) {
    const dst = path.join(agentsDir, f)
    if (!pathExists(dst)) continue
    if (sameFileByIno(path.join(vaultAgentsDir(vaultPath), f), dst)) {
      fs.rmSync(dst, { force: true })
      removed += 1
      steps.push('已移除硬链接: ' + f)
    } else {
      steps.push('非硬链接（同 inode 不符），保留: ' + f)
    }
  }
  if (removed === 0) steps.push('没有需要清理的硬链接')
  const after = agentsDirStateOf(vaultPath, agentsDir)
  steps.push('清理后状态: ' + after.state + (after.note ? `（${after.note}）` : ''))
  return { steps, state: after.state, ...(after.note !== undefined ? { note: after.note } : {}) }
}

/** 创建 junction（免管理员权限），target 用绝对路径 */
export function createJunction(targetDir: string, linkPath: string): void {
  if (!pathExists(targetDir)) throw new Error(`junction 目标不存在: ${targetDir}`)
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(path.resolve(targetDir), linkPath, 'junction')
}

/** 仅删除链接本身；拒绝删除真实目录/文件 */
export function removeLink(linkPath: string): void {
  const st = lstatSafe(linkPath)
  if (st === null) return
  if (!st.isSymbolicLink()) throw new Error(`拒绝删除：${linkPath} 不是链接（junction/symlink）`)
  fs.rmSync(linkPath, { force: true })
}

export function vaultSkillsDir(vaultPath: string): string {
  return path.join(vaultPath, 'skills')
}

export function vaultSkillDir(vaultPath: string, skillName: string): string {
  return path.join(vaultSkillsDir(vaultPath), skillName)
}

/** vault 内子智能体集合目录（skill_agents.agents_dir 的链接目标） */
export function vaultAgentsDir(vaultPath: string): string {
  return path.join(vaultPath, 'agents')
}

/** 读取 skill 目录下 SKILL.md 的 frontmatter description（缺失/解析失败为空串） */
export function readSkillDescription(skillDir: string): string {
  try {
    return parseFrontmatter(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).description ?? ''
  } catch {
    return ''
  }
}

export function listVaultSkills(vaultPath: string): SkillMeta[] {
  const dir = vaultSkillsDir(vaultPath)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => ({
      name: e.name,
      hasSkillMd: fs.existsSync(path.join(dir, e.name, 'SKILL.md')),
      description: readSkillDescription(path.join(dir, e.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface WinAgentLike {
  name: string
  skillsDir: string
  agentsDir?: string
  include: string[]
}

/** 单个 Windows agent 的实时扫描（junction 判定 + agentsDir 硬链接共享识别）。 */
export function scanWindowsAgent(vaultPath: string, agent: WinAgentLike): {
  links: Record<string, LinkState>
  agentsDirState?: LinkState
  agentsDirNote?: string
  agentFiles: string[]
} {
  const links: Record<string, LinkState> = {}
  for (const meta of listVaultSkills(vaultPath)) {
    if (!agentIncludes(agent.include, meta.name)) continue
    links[meta.name] = getLinkState(path.join(agent.skillsDir, meta.name), vaultSkillDir(vaultPath, meta.name))
  }
  const agentFiles = listVaultAgentFiles(vaultPath)
  if (agent.agentsDir !== undefined) {
    const s = agentsDirStateOf(vaultPath, agent.agentsDir)
    return {
      links,
      agentsDirState: s.state,
      ...(s.note !== undefined ? { agentsDirNote: s.note } : {}),
      agentFiles,
    }
  }
  return { links, agentFiles }
}
