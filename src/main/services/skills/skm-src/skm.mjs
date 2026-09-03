// skm — WSL 伴生 CLI（DevHub 树内副本；由 scripts/build-skm.mjs 用依赖树内 esbuild
// 打成单文件零依赖 ESM bundle）。移植源：Skill-Manager src/companion/skm.ts。
// 所有子命令始终输出单个 JSON 对象到 stdout。绝不访问网络（仅 git 本地操作）。
// 说明：DevHub SQLite 是 Windows 侧元数据唯一事实源；companion 仍读 vault 内
// registry.json 获取 linux agent 清单（WSL 侧无 SQLite，docs/09 §1 职责分工）。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { agentIncludes, parseRegistry } from './registry.mjs'
import { parseFrontmatter } from './frontmatter.mjs'

const VAULT = process.env.SKM_VAULT || '/root/skill-vault'
const SKILLS_DIR = path.join(VAULT, 'skills')
const AGENTS_DIR = path.join(VAULT, 'agents')

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function fail(error) {
  emit({ ok: false, error })
  process.exit(1)
}

function gitRun(args) {
  const r = spawnSync('git', args, { cwd: VAULT, encoding: 'utf8' })
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
  }
}

function loadRegistry() {
  const file = path.join(VAULT, 'registry.json')
  try {
    const r = parseRegistry(fs.readFileSync(file, 'utf8'))
    if (r.ok) return r.registry
    fail(`registry.json 解析失败: ${r.error}`)
  } catch (e) {
    fail(`无法读取 registry.json: ${String(e)}`)
  }
}

function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return []
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => {
      const hasSkillMd = fs.existsSync(path.join(SKILLS_DIR, e.name, 'SKILL.md'))
      let description = ''
      if (hasSkillMd) {
        try {
          description = parseFrontmatter(fs.readFileSync(path.join(SKILLS_DIR, e.name, 'SKILL.md'), 'utf8')).description ?? ''
        } catch {
          description = ''
        }
      }
      return { name: e.name, hasSkillMd, description }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function linuxAgents(registry) {
  return registry.agents.filter((a) => a.platform === 'linux')
}

/** vault agents/ 下的 .md 文件清单（排序；目录不存在返回空） */
function listAgentFiles() {
  if (!fs.existsSync(AGENTS_DIR)) return []
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

function linkState(linkPath, expected) {
  let st
  try {
    st = fs.lstatSync(linkPath)
  } catch {
    return 'missing'
  }
  if (!st.isSymbolicLink()) return st.isDirectory() ? 'real-dir' : 'wrong-target'
  let t = ''
  try {
    t = fs.readlinkSync(linkPath)
  } catch {
    return 'wrong-target'
  }
  const abs = path.isAbsolute(t) ? t : path.resolve(path.dirname(linkPath), t)
  if (path.resolve(abs) !== path.resolve(expected)) return 'wrong-target'
  return fs.existsSync(expected) ? 'linked' : 'vault-missing'
}

// ---------- commands ----------

function cmdScan() {
  const registry = loadRegistry()
  const agentFiles = listAgentFiles()
  const agents = []
  for (const a of linuxAgents(registry)) {
    const links = {}
    for (const s of listSkills()) {
      if (!agentIncludes(a.include, s.name)) continue
      links[s.name] = linkState(path.join(a.skillsDir, s.name), path.join(SKILLS_DIR, s.name))
    }
    const scan = { name: a.name, platform: 'linux', skillsDir: a.skillsDir, links }
    if (a.agentsDir) {
      scan.agentsDir = a.agentsDir
      scan.agentsDirState = linkState(a.agentsDir, AGENTS_DIR)
      scan.agentFiles = agentFiles
    }
    agents.push(scan)
  }
  emit({ ok: true, skills: listSkills(), agents, vaultOk: fs.existsSync(path.join(VAULT, '.git')) })
}

function cmdLink(skill, agentName) {
  if (!skill) fail('用法: skm link <skill> [--agent <name>]')
  const expected = path.join(SKILLS_DIR, skill)
  if (!fs.existsSync(expected)) fail(`vault 中不存在 skill: ${skill}`)
  const registry = loadRegistry()
  const results = []
  for (const a of linuxAgents(registry)) {
    if (agentName && a.name !== agentName) continue
    if (!agentIncludes(a.include, skill)) continue
    fs.mkdirSync(a.skillsDir, { recursive: true })
    const linkPath = path.join(a.skillsDir, skill)
    const st = linkState(linkPath, expected)
    if (st === 'linked') {
      results.push(`${linkPath} 已链接，跳过`)
      continue
    }
    if (st === 'real-dir') {
      results.push(`${linkPath} 是真实目录，拒绝覆盖，跳过`)
      continue
    }
    if (st !== 'missing') {
      // wrong-target / vault-missing：仅移除旧链接本身
      fs.unlinkSync(linkPath)
      results.push(`${linkPath} 旧链接已移除（${st}）`)
    }
    const rel = path.relative(a.skillsDir, expected)
    fs.symlinkSync(rel, linkPath)
    results.push(`${linkPath} -> ${rel}`)
  }
  emit({ ok: true, results })
}

function cmdUnlink(skill, agentName) {
  if (!skill) fail('用法: skm unlink <skill> [--agent <name>]')
  const registry = loadRegistry()
  const results = []
  for (const a of linuxAgents(registry)) {
    if (agentName && a.name !== agentName) continue
    const linkPath = path.join(a.skillsDir, skill)
    let st
    try {
      st = fs.lstatSync(linkPath)
    } catch {
      results.push(`${linkPath} 不存在，跳过`)
      continue
    }
    if (!st.isSymbolicLink()) {
      results.push(`${linkPath} 不是链接，拒绝删除`)
      continue
    }
    fs.unlinkSync(linkPath)
    results.push(`${linkPath} 已解链`)
  }
  emit({ ok: true, results })
}

/** 子智能体整目录链接：agentsDir → vault agents/（相对 symlink；linked 跳过、real-dir 拒绝） */
function cmdAgentsLink(agentName) {
  const registry = loadRegistry()
  if (!fs.existsSync(AGENTS_DIR)) fail(`vault 中不存在 agents 目录: ${AGENTS_DIR}`)
  const results = []
  for (const a of linuxAgents(registry)) {
    if (agentName && a.name !== agentName) continue
    if (!a.agentsDir) {
      if (agentName) fail(`agent 未配置 agentsDir: ${a.name}`)
      continue
    }
    fs.mkdirSync(path.dirname(a.agentsDir), { recursive: true })
    const st = linkState(a.agentsDir, AGENTS_DIR)
    if (st === 'linked') {
      results.push(`${a.agentsDir} 已链接，跳过`)
      continue
    }
    if (st === 'real-dir') {
      results.push(`${a.agentsDir} 是真实目录，拒绝覆盖，跳过`)
      continue
    }
    if (st !== 'missing') {
      fs.unlinkSync(a.agentsDir)
      results.push(`${a.agentsDir} 旧链接已移除（${st}）`)
    }
    // 相对 symlink：从 agentsDir 所在目录出发（如 /root/.zcode/agents → ../skill-vault/agents）
    const rel = path.relative(path.dirname(a.agentsDir), AGENTS_DIR)
    fs.symlinkSync(rel, a.agentsDir)
    results.push(`${a.agentsDir} -> ${rel}`)
  }
  emit({ ok: true, results })
}

/** 删除子智能体整目录链接（仅删链接本身，真实目录拒绝） */
function cmdAgentsUnlink(agentName) {
  const registry = loadRegistry()
  const results = []
  for (const a of linuxAgents(registry)) {
    if (agentName && a.name !== agentName) continue
    if (!a.agentsDir) {
      if (agentName) fail(`agent 未配置 agentsDir: ${a.name}`)
      continue
    }
    let st
    try {
      st = fs.lstatSync(a.agentsDir)
    } catch {
      results.push(`${a.agentsDir} 不存在，跳过`)
      continue
    }
    if (!st.isSymbolicLink()) {
      results.push(`${a.agentsDir} 不是链接，拒绝删除`)
      continue
    }
    fs.unlinkSync(a.agentsDir)
    results.push(`${a.agentsDir} 已解链`)
  }
  emit({ ok: true, results })
}

function cmdSync() {
  const steps = []
  const conflicts = []
  const record = (cmd, r) => {
    steps.push({ side: 'wsl', cmd, ok: r.ok, detail: (r.stderr || r.stdout || '').trim().slice(-600) })
  }
  record('git add -A', gitRun(['add', '-A']))
  const st = gitRun(['status', '--porcelain'])
  if (st.stdout.trim()) {
    record('git commit', gitRun(['commit', '-m', `devhub sync ${new Date().toISOString()}`]))
  } else {
    steps.push({ side: 'wsl', cmd: 'git status（无变更，跳过 commit）', ok: true, detail: 'clean' })
  }
  let r = gitRun(['pull', '--rebase', 'origin', 'main'])
  record('git pull --rebase origin main', r)
  if (!r.ok) conflicts.push(`wsl pull --rebase:\n${(r.stderr || r.stdout).trim()}`)
  r = gitRun(['push', 'origin', 'main'])
  record('git push origin main', r)
  if (!r.ok) conflicts.push(`wsl push:\n${(r.stderr || r.stdout).trim()}`)
  emit({ ok: conflicts.length === 0, steps, conflicts })
}

/** 收集每个 skill 的 scripts 目录下含 shebang 的文件（可检测或修复执行位） */
function shebangScripts(opts) {
  const out = []
  if (!fs.existsSync(SKILLS_DIR)) return out
  for (const s of listSkills()) {
    const scriptsDir = path.join(SKILLS_DIR, s.name, 'scripts')
    if (!fs.existsSync(scriptsDir)) continue
    const visit = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) visit(full)
        else if (e.isFile()) {
          try {
            const fd = fs.openSync(full, 'r')
            const buf = Buffer.alloc(2)
            fs.readSync(fd, buf, 0, 2, 0)
            fs.closeSync(fd)
            if (buf.toString('utf8') !== '#!') continue
            if (opts?.onlyMissingExec && fs.statSync(full).mode & 0o111) continue
            out.push({
              rel: path.posix.join(s.name, 'scripts', path.relative(scriptsDir, full).replace(/\\/g, '/')),
              full,
            })
          } catch {
            /* ignore */
          }
        }
      }
    }
    visit(scriptsDir)
  }
  return out
}

function cmdFixPermissions() {
  const fixed = []
  for (const s of shebangScripts()) {
    fs.chmodSync(s.full, 0o755)
    fixed.push(s.rel)
  }
  emit({ ok: true, fixed })
}

function cmdSelfcheck() {
  const registry = loadRegistry()
  const name = gitRun(['config', 'user.name'])
  const email = gitRun(['config', 'user.email'])
  const origin = gitRun(['ls-remote', '--heads', 'origin'])
  const execIssues = shebangScripts({ onlyMissingExec: true }).map((s) => ({ rel: s.rel }))
  const mntLinks = []
  for (const a of linuxAgents(registry)) {
    // agentsDir 本身是 /mnt 式绝对链接 → 同样报告（建议 agents-link 重建为相对路径）
    if (a.agentsDir) {
      let st
      try {
        st = fs.lstatSync(a.agentsDir)
      } catch {
        st = null
      }
      if (st && st.isSymbolicLink()) {
        try {
          const t = fs.readlinkSync(a.agentsDir)
          const abs = path.isAbsolute(t) ? t : path.resolve(path.dirname(a.agentsDir), t)
          if (abs.includes('/mnt/')) mntLinks.push({ agent: a.name, skill: '(agentsDir)', target: abs })
        } catch {
          /* ignore */
        }
      }
    }
    const dir = a.skillsDir
    if (!fs.existsSync(dir)) continue
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isSymbolicLink()) continue
      try {
        const t = fs.readlinkSync(path.join(dir, e.name))
        const abs = path.isAbsolute(t) ? t : path.resolve(dir, t)
        if (abs.includes('/mnt/')) mntLinks.push({ agent: a.name, skill: e.name, target: abs })
      } catch {
        /* ignore */
      }
    }
  }
  emit({
    ok: true,
    identity: { name: name.stdout.trim(), email: email.stdout.trim() },
    originOk: origin.ok && origin.stdout.trim().length > 0,
    execIssues,
    mntLinks,
  })
}

// ---------- main ----------

function main() {
  const argv = process.argv.slice(2).filter((a) => a !== '--json')
  const cmd = argv[0]
  const flagAgent = (() => {
    const i = argv.indexOf('--agent')
    return i >= 0 ? argv[i + 1] : undefined
  })()
  switch (cmd) {
    case 'scan':
      return cmdScan()
    case 'link':
      return cmdLink(argv[1] ?? '', flagAgent)
    case 'unlink':
      return cmdUnlink(argv[1] ?? '', flagAgent)
    case 'agents-link':
      return cmdAgentsLink(flagAgent)
    case 'agents-unlink':
      return cmdAgentsUnlink(flagAgent)
    case 'sync':
      return cmdSync()
    case 'fix-permissions':
      return cmdFixPermissions()
    case 'selfcheck':
      return cmdSelfcheck()
    default:
      fail(`未知命令: ${cmd ?? '(空)'}。可用: scan|link|unlink|agents-link|agents-unlink|sync|fix-permissions|selfcheck`)
  }
}

main()
