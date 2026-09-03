/**
 * skills/importer.ts — Skill 导入流水线：拷贝 → 校验 → 删源 → 建链 → git commit
 * （docs/09 §5；Skill-Manager src/main/importer.ts 的 Service 层归宿）。
 *
 * 铁律不变：删除源之前必须完成校验；校验失败中止，vault 副本保留待人工处理，
 * 绝不先删后验。全部 git 调用经 skills/execGit.ts（→ core/exec，约束 #7-#10）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { SkillImportPlan } from '../../../shared/types.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { validateSkillName } from './registryLogic.ts'
import { gitRun } from './execGit.ts'
import {
  createJunction,
  lstatSafe,
  normalizeWinPath,
  removeLink,
  stripWinPrefix,
  vaultSkillDir,
  vaultSkillsDir,
} from './winLinks.ts'

export type { SkillImportPlan }

/** 解析 junction/symlink 到真身目录；返回原始路径是否本身是链接 */
export function resolveRealDir(p: string): { realPath: string; isLink: boolean } {
  let cur = path.resolve(p)
  let wasLink = false
  for (let i = 0; i < 16; i++) {
    const st = lstatSafe(cur)
    if (st === null) throw new Error(`路径不存在: ${cur}`)
    if (!st.isSymbolicLink()) return { realPath: cur, isLink: wasLink }
    wasLink = true
    let target = stripWinPrefix(fs.readlinkSync(cur))
    if (!path.isAbsolute(target)) target = path.resolve(path.dirname(cur), target)
    cur = path.resolve(target)
  }
  throw new Error(`junction/symlink 解析深度超限: ${p}`)
}

export interface WalkedFile {
  rel: string
  size: number
}

/**
 * 校验拷贝结果：文件数一致 + 逐文件字节数一致。
 * 任何不一致都抛错 —— 调用方必须在校验通过后才允许删除原目录。
 */
export function verifyCopy(sourceRealPath: string, targetDir: string): void {
  const srcFiles = walkFiles(sourceRealPath)
  const dstFiles = walkFiles(targetDir)
  if (srcFiles.length !== dstFiles.length) {
    throw new Error(
      `校验失败：文件数不一致（源 ${srcFiles.length} / vault ${dstFiles.length}）。vault 副本保留待人工处理: ${targetDir}`,
    )
  }
  for (const f of srcFiles) {
    const s = lstatSafe(relJoin(sourceRealPath, f.rel))
    const d = lstatSafe(relJoin(targetDir, f.rel))
    if (s === null || d === null || s.size !== d.size) {
      throw new Error(`校验失败：文件字节不一致: ${f.rel}。vault 副本保留待人工处理: ${targetDir}`)
    }
  }
}

/** 递归列出普通文件（排除 .git；跳过源内嵌链接以防越界复制） */
export function walkFiles(root: string): WalkedFile[] {
  const out: WalkedFile[] = []
  const visit = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const full = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) visit(full)
      else if (e.isFile()) out.push({ rel: path.relative(root, full).replace(/\\/g, '/'), size: lstatSafe(full)?.size ?? 0 })
    }
  }
  visit(root)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function relJoin(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'))
}

export function planImport(sourceDir: string, vaultPath: string): SkillImportPlan {
  const plan: SkillImportPlan = {
    ok: false,
    sourceDir,
    sourceRealPath: '',
    sourceIsLink: false,
    skillName: '',
    nameOk: false,
    hasSkillMd: false,
    targetDir: '',
    fileCount: 0,
    totalBytes: 0,
    vaultConflict: false,
    actions: [],
  }
  if (lstatSafe(sourceDir) === null) {
    plan.error = `源目录不存在: ${sourceDir}`
    return plan
  }
  const { realPath, isLink } = resolveRealDir(sourceDir)
  plan.sourceRealPath = realPath
  plan.sourceIsLink = isLink
  plan.skillName = path.basename(realPath)
  plan.nameOk = validateSkillName(plan.skillName)
  plan.hasSkillMd = fs.existsSync(path.join(realPath, 'SKILL.md'))
  plan.targetDir = vaultSkillDir(vaultPath, plan.skillName)
  plan.vaultConflict = lstatSafe(plan.targetDir) !== null

  // frontmatter 预览（导入对话框展示用；缺失/解析失败不阻断）
  if (plan.hasSkillMd) {
    try {
      plan.frontmatter = parseFrontmatter(fs.readFileSync(path.join(realPath, 'SKILL.md'), 'utf8'))
    } catch {
      // 预览失败不影响计划
    }
  }

  if (!plan.hasSkillMd) {
    plan.error = `源目录缺少 SKILL.md，拒绝导入: ${realPath}`
    return plan
  }
  if (!plan.nameOk) {
    plan.error = `skill 名 "${plan.skillName}" 不符合小写 kebab-case 规范（a-z0-9 与 -）`
    return plan
  }
  const vaultSkills = normalizeWinPath(vaultSkillsDir(vaultPath))
  const src = normalizeWinPath(realPath)
  if (src === vaultSkills || src.startsWith(vaultSkills + '\\')) {
    plan.error = '源目录位于 vault 内部，拒绝导入'
    return plan
  }

  const files = walkFiles(realPath)
  plan.fileCount = files.length
  plan.totalBytes = files.reduce((s, f) => s + f.size, 0)

  if (plan.vaultConflict) {
    plan.error = `vault 已存在同名 skill: ${plan.targetDir}，请先处理冲突（不会覆盖）`
    return plan
  }

  plan.ok = true
  if (isLink) plan.actions.push(`源路径是链接，解析到真身目录: ${realPath}`)
  plan.actions.push(`递归拷贝 ${files.length} 个文件（共 ${plan.totalBytes} 字节）→ ${plan.targetDir}`)
  plan.actions.push('校验：文件数一致 + 逐文件字节数一致（校验通过后才删除原位置）')
  plan.actions.push(isLink ? `删除原链接（仅链接本身，不动真身）: ${sourceDir}` : `删除原目录: ${realPath}`)
  plan.actions.push(`在原位置创建 junction: ${sourceDir} → ${plan.targetDir}`)
  plan.actions.push(`vault 内 git add -A + commit（devhub: import ${plan.skillName}，仅本地不 push）`)
  return plan
}

export type ImportOptions = { commit?: boolean }

/**
 * 执行导入（plan 必须先经 planImport 校验通过）。
 * commit message：静态前缀 `devhub: import ` + skill 名经 args 数组传入（约束 #8）。
 */
export async function executeImport(sourceDir: string, vaultPath: string, opts?: ImportOptions): Promise<SkillImportPlan & { steps: string[] }> {
  const doCommit = opts?.commit !== false
  const plan = planImport(sourceDir, vaultPath)
  if (!plan.ok) throw new Error(plan.error ?? '导入计划失败')
  const steps: string[] = []

  // 1) 递归拷贝（字节保真）
  fs.mkdirSync(plan.targetDir, { recursive: true })
  for (const f of walkFiles(plan.sourceRealPath)) {
    const dest = relJoin(plan.targetDir, f.rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(relJoin(plan.sourceRealPath, f.rel), dest)
  }
  steps.push(`已复制 ${plan.fileCount} 个文件 → ${plan.targetDir}`)

  // 2) 校验：文件数 + 逐文件字节数（必须全部通过才进入删除步骤）
  verifyCopy(plan.sourceRealPath, plan.targetDir)
  steps.push('校验通过：文件数与逐文件字节数一致')

  // 3) 删除原位置（链接 → 仅删链接本身；真实目录 → 递归删除）
  if (plan.sourceIsLink) {
    removeLink(sourceDir)
    steps.push(`已删除原链接: ${sourceDir}`)
  } else {
    fs.rmSync(plan.sourceRealPath, { recursive: true, force: true })
    steps.push(`已删除原目录: ${plan.sourceRealPath}`)
  }

  // 4) 原位置建 junction 指向 vault
  createJunction(plan.targetDir, sourceDir)
  steps.push(`已创建 junction: ${sourceDir} → ${plan.targetDir}`)

  // 5) vault 内 git add + commit（仅本地；git 不可用/非 git 仓时结构化记录，不阻断导入）
  if (doCommit) {
    const add = await gitRun(vaultPath, ['add', '-A'])
    steps.push(add.ok ? 'git add -A 完成' : `git add -A 失败（vault 可能不是 git 仓）: ${(add.stderr || '').trim().slice(-200)}`)
    if (add.ok) {
      const st = await gitRun(vaultPath, ['status', '--porcelain'])
      if (st.stdout.trim().length > 0) {
        const c = await gitRun(vaultPath, ['commit', '-m', `devhub: import ${plan.skillName}`])
        if (!c.ok) throw new Error(`git commit 失败: ${c.stderr || c.stdout}`)
        steps.push('git commit 完成（仅本地，未 push）')
      } else {
        steps.push('vault 无变更，跳过 commit')
      }
    }
  }
  return { ...plan, steps }
}
