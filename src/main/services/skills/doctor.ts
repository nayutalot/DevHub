/**
 * skills/doctor.ts — Skill 全链路体检与修复（docs/09 §4.3；Skill-Manager
 * src/main/doctor.ts 的 Service 层归宿）。
 *
 * 适配点：
 *  - agent 清单来自 SQLite skill_agents（调用方传入投影），registry.json 弃用；
 *  - git 经 skills/execGit.ts（→ core/exec，约束 #7-#10）；companion 经 wslBridge；
 *  - expected unavailability（companion 不可达）降级为结构化 warn 项，绝不 throw。
 *
 * 修复语义红线（docs/09 §4.1）：real-dir 永不自动处理（fixable=false，需人工）；
 * 普通文件形态的 wrong-target 不自动删除（报 error 交人工）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { LinkState, SkillAgentInfo, SkillDoctorItem } from '../../../shared/types.ts'
import { gitRun } from './execGit.ts'
import { runCompanion, wslBash, wslEnvPassthrough } from './wslBridge.ts'
import { agentIncludes, validateSkillName } from './registryLogic.ts'
import {
  agentsDirStateOf,
  createJunction,
  getLinkState,
  isLinkPath,
  listVaultSkills,
  pathExists,
  removeLink,
  repairAgentsDirHardlinks,
  vaultSkillDir,
} from './winLinks.ts'

const TEXT_EXTS = new Set([
  '.md', '.txt', '.py', '.sh', '.js', '.mjs', '.cjs', '.ts', '.json',
  '.yml', '.yaml', '.toml', '.css', '.html', '.xml', '.svg', '.bat', '.ps1',
])

const COMPANION_TIMEOUT_MS = 120_000

export interface DoctorContext {
  vaultPath: string
  /** WSL 发行版（companion selfcheck 用）；未解析出可用发行版时 undefined → 跳过 WSL 段并注记。 */
  distro?: string
}

function findCrlfFiles(vaultPath: string, limit = 200): string[] {
  const root = path.join(vaultPath, 'skills')
  const found: string[] = []
  if (!fs.existsSync(root)) return found
  const visit = (dir: string): void => {
    if (found.length >= limit) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) visit(full)
      else if (e.isFile() && TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
        try {
          const buf = fs.readFileSync(full)
          if (buf.includes(Buffer.from('\r\n'))) {
            found.push(path.relative(vaultPath, full).replace(/\\/g, '/'))
            if (found.length >= limit) return
          }
        } catch {
          /* 不可读文件跳过 */
        }
      }
    }
  }
  visit(root)
  return found
}

/**
 * 全量体检。agentId 传入时只检该 agent 的链接项（vault/git 段仍然全检）。
 * 期望性不可用一律折叠为结构化 DoctorItem，绝不抛异常。
 */
export async function runDoctor(ctx: DoctorContext, agents: SkillAgentInfo[], agentId?: number): Promise<SkillDoctorItem[]> {
  const items: SkillDoctorItem[] = []
  const vault = ctx.vaultPath

  // ---- vault / git ----
  if (!fs.existsSync(path.join(vault, '.git'))) {
    items.push({ id: 'vault', severity: 'error', message: `vault 不存在或不是 git 仓库: ${vault}`, fixable: false })
  } else {
    const st = await gitRun(vault, ['status', '--porcelain'])
    if (!st.ok) {
      items.push({ id: 'vault-git', severity: 'error', message: `vault git status 失败: ${(st.stderr || '').trim().slice(-200)}`, fixable: false })
    } else if (st.stdout.trim().length > 0) {
      items.push({
        id: 'vault-dirty',
        severity: 'warn',
        message: `vault 有 ${st.stdout.trim().split('\n').length} 项未提交变更，请到同步页处理`,
        fixable: false,
      })
    } else {
      items.push({ id: 'vault-clean', severity: 'info', message: 'vault git 状态干净', fixable: false })
    }
  }

  // ---- Windows agent 目录与链接 ----
  const targets = agentId === undefined ? agents.filter((a) => a.platform === 'windows') : agents.filter((a) => a.id === agentId && a.platform === 'windows')
  for (const agent of targets) {
    if (!agent.enabled) {
      items.push({ id: `agent-disabled:${agent.name}`, severity: 'info', message: `agent ${agent.name} 已停用（doctor/toggle 跳过）`, fixable: false })
      continue
    }
    if (!fs.existsSync(agent.skillsDir)) {
      items.push({
        id: `agent-dir:${agent.name}`,
        severity: 'error',
        message: `agent 目录不存在: ${agent.skillsDir}（${agent.name}）`,
        fixable: true,
        fixId: 'mkdir-agent',
        payload: { skillsDir: agent.skillsDir, agentId: agent.id },
      })
      continue
    }
    for (const meta of listVaultSkills(vault)) {
      if (!agentIncludes(agent.include, meta.name)) continue
      const linkPath = path.join(agent.skillsDir, meta.name)
      const target = vaultSkillDir(vault, meta.name)
      const state = getLinkState(linkPath, target)
      if (state === 'wrong-target') {
        items.push({
          id: `wrong-target:${agent.name}:${meta.name}`,
          severity: 'warn',
          message: `${agent.name}/${meta.name} 链接目标错误（${linkPath}），可重建为指向 vault`,
          fixable: true,
          fixId: 'relink',
          payload: { linkPath, vaultSkillDir: target, agentId: agent.id, skill: meta.name },
        })
      } else if (state === 'vault-missing') {
        items.push({
          id: `dangling:${agent.name}:${meta.name}`,
          severity: 'error',
          message: `${agent.name}/${meta.name} 链接指向的 vault 目录缺失: ${target}`,
          fixable: false,
        })
      } else if (state === 'real-dir') {
        items.push({
          id: `real-dir:${agent.name}:${meta.name}`,
          severity: 'warn',
          message: `${agent.name}/${meta.name} 是真实目录而非链接（${linkPath}），可能含独有内容 —— 永不自动处理；建议走导入流水线（skills:import）或人工处理`,
          fixable: false,
        })
      } else if (state === 'missing') {
        items.push({
          id: `unlinked:${agent.name}:${meta.name}`,
          severity: 'info',
          message: `${agent.name}/${meta.name} 未链接`,
          fixable: true,
          fixId: 'relink',
          payload: { linkPath, vaultSkillDir: target, agentId: agent.id, skill: meta.name },
        })
      }
    }
    // agentsDir（子智能体整目录）：junction 语义 + 真实目录硬链接共享识别（docs/09 §4.2）
    if (agent.agentsDir !== undefined) {
      const s = agentsDirStateOf(vault, agent.agentsDir)
      if (s.state === 'linked') {
        items.push({
          id: `agents-dir-ok:${agent.name}`,
          severity: 'info',
          message: `${agent.name} agentsDir 正常（${s.note ?? '链接形态'}）: ${agent.agentsDir}`,
          fixable: false,
        })
      } else if (s.state === 'vault-missing') {
        items.push({
          id: `agents-dir-dangling:${agent.name}`,
          severity: 'error',
          message: `${agent.name} agentsDir 链接悬空（vault agents/ 缺失）: ${agent.agentsDir}`,
          fixable: false,
        })
      } else if (s.state === 'wrong-target' && isLinkPath(agent.agentsDir)) {
        items.push({
          id: `agents-dir-wrong:${agent.name}`,
          severity: 'warn',
          message: `${agent.name} agentsDir 链接目标错误，可重建为硬链接共享目录: ${agent.agentsDir}`,
          fixable: true,
          fixId: 'agents-dir',
          payload: { agentId: agent.id },
        })
      } else {
        // missing / real-dir（非硬链接共享的真实目录）：一键修复为硬链接共享形态
        items.push({
          id: `agents-dir-fix:${agent.name}`,
          severity: s.state === 'real-dir' ? 'warn' : 'info',
          message:
            s.state === 'real-dir'
              ? `${agent.name} agentsDir 是普通真实目录（非硬链接共享），可一键重建为 vault agents/ 硬链接共享: ${agent.agentsDir}`
              : `${agent.name} agentsDir 缺失，可创建为 vault agents/ 硬链接共享目录: ${agent.agentsDir}`,
          fixable: true,
          fixId: 'agents-dir',
          payload: { agentId: agent.id },
        })
      }
    }
  }

  // ---- vault 内 CRLF ----
  const crlf = findCrlfFiles(vault)
  if (crlf.length > 0) {
    items.push({
      id: 'crlf',
      severity: 'warn',
      message: `vault 内 ${crlf.length} 个文本文件含 CRLF（示例: ${crlf.slice(0, 3).join(', ')}），可统一转换为 LF`,
      fixable: true,
      fixId: 'crlf',
      payload: { files: crlf },
    })
  }

  // ---- 命名规范 ----
  for (const meta of listVaultSkills(vault)) {
    if (!validateSkillName(meta.name)) {
      items.push({ id: `naming:${meta.name}`, severity: 'warn', message: `skill 名 "${meta.name}" 不符合小写 kebab-case 规范`, fixable: false })
    }
    if (!meta.hasSkillMd) {
      items.push({ id: `no-skill-md:${meta.name}`, severity: 'warn', message: `skill "${meta.name}" 缺少 SKILL.md`, fixable: false })
    }
  }

  // ---- WSL 侧（companion selfcheck；不可达为常态，降级为 warn 项）----
  if (ctx.distro === undefined) {
    items.push({ id: 'wsl', severity: 'warn', message: 'WSL companion 未检查：没有可用的 WSL 发行版', fixable: false })
  } else {
    const sc = await runCompanion(ctx.distro, ['selfcheck'], COMPANION_TIMEOUT_MS)
    const p = sc.parsed as
      | { ok?: boolean; identity?: { name?: string; email?: string }; originOk?: boolean; execIssues?: { rel: string }[]; mntLinks?: { agent: string; skill: string; target: string }[] }
      | undefined
    if (!sc.ok || p === undefined || p === null || typeof p !== 'object' || p.ok !== true) {
      items.push({
        id: 'wsl',
        severity: 'warn',
        message: `WSL companion 不可用（检查 clone /root/skill-vault 与 bin/skm.mjs，可用 skills:companion.deploy 重新部署）: ${(sc.parseError || sc.stderr || sc.stdout).slice(0, 200)}`,
        fixable: false,
      })
    } else {
      const idName = (p.identity?.name ?? '').trim()
      const idEmail = (p.identity?.email ?? '').trim()
      if (idName.length === 0 || idEmail.length === 0) {
        items.push({ id: 'wsl-identity', severity: 'warn', message: 'WSL 侧 git 身份未配置（user.name/user.email）', fixable: true, fixId: 'wsl-identity' })
      }
      if (!p.originOk) {
        items.push({ id: 'wsl-origin', severity: 'error', message: 'WSL clone 的 origin 不可达', fixable: false })
      }
      if ((p.execIssues ?? []).length > 0) {
        items.push({
          id: 'wsl-exec',
          severity: 'warn',
          message: `WSL 侧 ${p.execIssues?.length ?? 0} 个含 shebang 的脚本缺执行位（示例: ${(p.execIssues ?? []).slice(0, 3).map((x) => x.rel).join(', ')}）`,
          fixable: true,
          fixId: 'wsl-exec',
        })
      }
      for (const m of p.mntLinks ?? []) {
        items.push({
          id: `wsl-mnt:${m.agent}:${m.skill}`,
          severity: 'warn',
          message: `WSL ${m.agent}/${m.skill} 是 /mnt 式旧链接 → ${m.target}，建议替换为指向 ~/skill-vault 的原生相对链接`,
          fixable: true,
          fixId: 'wsl-mnt',
          payload: { skill: m.skill, agent: m.agent },
        })
      }
    }
  }

  return items
}

export type FixOutcome = { message: string; steps?: string[]; state?: LinkState; note?: string }

/**
 * 一键修复。调用方（skillService.repair）负责 confirmed 门与修复后的链接缓存回写。
 * 抛出的异常由调用方折叠为结构化错误（约束 #14）。
 */
export async function applyFix(ctx: DoctorContext, fixId: string, payload: Record<string, unknown>): Promise<FixOutcome> {
  const p = payload as Record<string, string>
  switch (fixId) {
    case 'mkdir-agent': {
      const dir = p.skillsDir
      if (dir === undefined || dir.length === 0) throw new Error('fix 参数缺失: skillsDir')
      fs.mkdirSync(dir, { recursive: true })
      return { message: `已创建目录: ${dir}` }
    }
    case 'relink': {
      const linkPath = p.linkPath
      const target = p.vaultSkillDir
      if (linkPath === undefined || target === undefined) throw new Error('fix 参数缺失: linkPath/vaultSkillDir')
      if (!pathExists(target)) throw new Error(`vault 目标不存在: ${target}`)
      if (fs.existsSync(linkPath)) {
        if (!isLinkPath(linkPath)) throw new Error(`目标是真实目录/文件，拒绝覆盖: ${linkPath}（请先走导入流水线或人工处理）`)
        removeLink(linkPath)
      }
      createJunction(target, linkPath)
      return { message: `已重建链接: ${linkPath} → ${target}` }
    }
    case 'agents-dir': {
      const agentId = Number(p.agentId)
      const agentsDir = p.agentsDir
      if (agentsDir === undefined || agentsDir.length === 0) throw new Error('fix 参数缺失: agentsDir')
      const r = repairAgentsDirHardlinks(ctx.vaultPath, agentsDir)
      return { message: `agentsDir 已重建为硬链接共享（agent ${Number.isFinite(agentId) ? agentId : '?'}）`, steps: r.steps, state: r.state, note: r.note }
    }
    case 'crlf': {
      const files = (payload.files as string[] | undefined) ?? []
      // contained-in-vault 校验（payload 经 IPC 传入，纵深防御）：resolve 后必须严格
      // 位于 vault 内部——`../`、绝对路径、反斜杠穿越一律跳过并计数（结构化降级，不抛）。
      const vaultRoot = path.resolve(ctx.vaultPath)
      let converted = 0
      let skipped = 0
      for (const rel of files) {
        const full = path.resolve(vaultRoot, ...rel.split('/'))
        if (full === vaultRoot || !full.startsWith(vaultRoot + path.sep)) {
          skipped += 1
          continue
        }
        if (!fs.existsSync(full)) continue
        const buf = fs.readFileSync(full)
        fs.writeFileSync(full, buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
        converted += 1
      }
      await gitRun(ctx.vaultPath, ['add', '-A'])
      const c = await gitRun(ctx.vaultPath, ['commit', '-m', 'devhub: convert CRLF to LF'])
      return {
        message: `已转换 ${converted} 个文件为 LF${skipped > 0 ? `，跳过 ${skipped} 个 vault 外路径` : ''}${c.ok ? ' 并提交' : ''}`,
      }
    }
    case 'wsl-exec': {
      if (ctx.distro === undefined) throw new Error('WSL 发行版不可用')
      const r = await runCompanion(ctx.distro, ['fix-permissions'], COMPANION_TIMEOUT_MS)
      const parsed = r.parsed as { fixed?: string[] } | undefined
      if (!r.ok || parsed === undefined || parsed === null) throw new Error(`fix-permissions 失败: ${(r.stderr || r.parseError || '').slice(0, 200)}`)
      const fixed = parsed.fixed ?? []
      return { message: `已为 ${fixed.length} 个脚本补执行位` }
    }
    case 'wsl-mnt': {
      const skill = p.skill
      if (skill === undefined || skill.length === 0) throw new Error('fix 参数缺失: skill')
      if (ctx.distro === undefined) throw new Error('WSL 发行版不可用')
      if (!/^[\w-]+$/.test(skill)) throw new Error(`skill 名不合法: ${skill}`)
      const r = await runCompanion(ctx.distro, ['link', skill], COMPANION_TIMEOUT_MS)
      if (!r.ok || r.parsed === undefined || r.parsed === null) throw new Error(`WSL relink 失败: ${(r.stderr || r.parseError || '').slice(0, 200)}`)
      return { message: `WSL 侧已重建 ${skill} 链接（相对路径指向 ~/skill-vault）` }
    }
    case 'wsl-identity': {
      if (ctx.distro === undefined) throw new Error('WSL 发行版不可用')
      // 动态值（name/email）经 WSLENV 环境变量传入，脚本正文为静态字面量（约束 #12 模式）
      const script = 'git config --global user.name "$DH_NAME" && git config --global user.email "$DH_EMAIL"'
      const r = await wslBash(ctx.distro, script, 60_000, wslEnvPassthrough({ DH_NAME: 'devhub-wsl', DH_EMAIL: 'devhub@local' }))
      if (!r.ok) throw new Error(`WSL git 身份配置失败: ${(r.stderr || '').slice(0, 200)}`)
      return { message: '已在 WSL 配置 git 身份: devhub-wsl <devhub@local>' }
    }
    default:
      throw new Error(`未知修复类型: ${fixId}`)
  }
}
