#!/usr/bin/env node
// migrate-legacy.mjs — S1 批次一次性导入器（可重复运行，幂等）。
//
// 只读探测并导入两类老软件数据（docs/09 §12、docs/03 §4.7）：
//   1. SkillVault（F:\Active_Project\Skill-Manager）
//      - <vault>\registry.json → skill_agents（按 name upsert）
//      - <vault>\skills\       → skills 镜像（按 name upsert；vault_rel_path + frontmatter）
//      - 老 app userData 下的 api-hub-profiles.json / kimi-profiles.json
//        → apihub_profiles 占位行（needs_rekey=1，绝不尝试解密——S3 批次再迁移重加密）
//   2. ArchiveKeeper（F:\Active_Project\Archive-Tool\source）
//      - %APPDATA%\project-archiver\config.json
//        → history[] → archive_runs（按 old_path+at 查重；projects 按 win_path 归一匹配关联，
//          匹配不上只入 archive_runs 且 project_id 为 NULL，绝不伪造 projects 行）
//        → settings.lastDestRoot → settings.archive_dest_root（仅当目标为空）
//
// 铁律：
//   - 老目录与其数据文件**绝对只读**：本脚本对 legacy 路径只有 readFileSync / readdirSync /
//     existsSync / statSync，没有任何写路径。
//   - 全部 SQL 参数绑定（约束 #11；PRAGMA user_version 由 migrate.ts 字面量管理）。
//   - 幂等：所有写入都是按唯一键 upsert / 先查后插，重复运行结果一致（除时间戳刷新）。
//   - 输出导入报告：导入了什么、跳过什么、为什么；绝不静默。
//
// 真实运行：node scripts/migrate-legacy.mjs（写入真实 DevHub DB，受 DEVHUB_HOME 影响）。
// 测试注入：runLegacyMigration({ registryPath, vaultSkillsDir, archiveConfigPath,
//   legacyAppDataDirs }) 供 smoke 用夹具路径调用（见 scripts/smoke.mjs 用例 41/42）。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// DevHub DB 门面（尊重 DEVHUB_HOME；首次 getDatabase 会自动跑完 migration 001–003）。
const dbUrl = new URL('../src/main/db/index.ts', import.meta.url)
const { getDatabase, closeDatabase } = await import(dbUrl.href)

// ---------------------------------------------------------------------------
// 路径解析（env 可覆盖，便于夹具测试）
// ---------------------------------------------------------------------------

function defaultLegacyPaths() {
  const appData = process.env.APPDATA ?? ''
  return {
    registryPath: process.env.DEVHUB_LEGACY_REGISTRY ?? 'C:\\Users\\sakuya\\SkillVault\\registry.json',
    vaultSkillsDir: process.env.DEVHUB_LEGACY_VAULT_SKILLS ?? 'C:\\Users\\sakuya\\SkillVault\\skills',
    archiveConfigPath:
      process.env.DEVHUB_LEGACY_ARCHIVE_CONFIG ?? (appData ? join(appData, 'project-archiver', 'config.json') : ''),
    // 老 Skill-Manager userData 实测目录名为 SkillVault（productName）；候选并列探测。
    legacyAppDataDirs:
      appData
        ? ['SkillVault', 'skill-manager', 'skill-vault'].map((name) => join(appData, name))
        : []
  }
}

// ---------------------------------------------------------------------------
// 纯解析（无 IO；移植自老 src/shared，语义一致）
// ---------------------------------------------------------------------------

/** registry.json v2 解析（v1 兼容读、归一化 v2；与老 parseRegistry 同语义的精简移植） */
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
    if (a.platform !== 'windows' && a.platform !== 'linux') {
      return { ok: false, error: `agent ${a.name} platform 必须为 windows|linux` }
    }
    if (typeof a.skillsDir !== 'string' || !a.skillsDir.trim()) {
      return { ok: false, error: `agent ${a.name} skillsDir 必须是非空字符串` }
    }
    if (!Array.isArray(a.include) || a.include.length === 0 || !a.include.every((x) => typeof x === 'string' && x.trim())) {
      return { ok: false, error: `agent ${a.name} include 必须是非空字符串数组` }
    }
    let agentsDir = null
    if (a.agentsDir !== undefined) {
      if (typeof a.agentsDir !== 'string' || !a.agentsDir.trim()) {
        return { ok: false, error: `agent ${a.name} agentsDir 必须是非空字符串或缺省` }
      }
      agentsDir = a.agentsDir
    }
    agents.push({ name: a.name, platform: a.platform, skillsDir: a.skillsDir, include: a.include, agentsDir })
  }
  return { ok: true, registry: { version: 2, agents } }
}

/** SKILL.md frontmatter 解析（name/description；块标量折叠/保留；malformed → {}） */
export function parseFrontmatter(mdText) {
  const text = String(mdText ?? '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i >= lines.length || lines[i].trim() !== '---') return {}
  i++
  const out = {}
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') return out
    const m = line.match(/^(name|description)[ \t]*:[ \t]*(.*)$/)
    if (m === null) continue
    const key = m[1]
    if (out[key] !== undefined) continue
    const raw = m[2].trim()
    if (/^[|>][+-]?$/.test(raw)) {
      // 块标量：收集缩进/空行，`>` 折叠为空格、`|` 保留换行
      const folded = raw[0] === '>'
      const parts = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === '---') break
        if (l.trim() === '') {
          parts.push('')
          continue
        }
        if (/^[ \t]/.test(l)) {
          parts.push(l.trim())
          continue
        }
        break
      }
      while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
      let block = ''
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) block += folded && parts[k] !== '' && parts[k - 1] !== '' ? ' ' : '\n'
        block += parts[k]
      }
      block = block.trim()
      if (block) out[key] = block
      i = j - 1
    } else {
      let v = raw
      if (v.length >= 2) {
        const first = v[0]
        const last = v[v.length - 1]
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) v = v.slice(1, -1)
      }
      const hash = v.indexOf(' #')
      v = (hash >= 0 ? v.slice(0, hash) : v).trim()
      if (v) out[key] = v
    }
  }
  return {} // 未闭合 → malformed，保守视为无键
}

/** Windows 路径归一（比较用）：小写 + 反斜杠 + 去尾分隔符 */
export function normalizeWinPath(p) {
  return String(p ?? '')
    .trim()
    .replace(/\//g, '\\')
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function readJsonFile(file) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------------------
// 导入域 1a：registry agents → skill_agents
// ---------------------------------------------------------------------------

export function importRegistryAgents(db, registry, now) {
  const report = { inserted: 0, updated: 0, agents: [] }
  const selectByName = db.prepare('SELECT id FROM skill_agents WHERE name = ?')
  const insert = db.prepare(
    'INSERT INTO skill_agents (name, platform, skills_dir, agents_dir, include_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
  )
  const update = db.prepare(
    'UPDATE skill_agents SET platform = ?, skills_dir = ?, agents_dir = ?, include_json = ?, updated_at = ? WHERE id = ?',
  )
  for (const a of registry.agents) {
    const includeJson = JSON.stringify(a.include)
    const existing = selectByName.get(a.name)
    if (existing === undefined) {
      insert.run(a.name, a.platform, a.skillsDir, a.agentsDir, includeJson, now(), now())
      report.inserted += 1
    } else {
      update.run(a.platform, a.skillsDir, a.agentsDir, includeJson, now(), existing.id)
      report.updated += 1
    }
    report.agents.push(a.name)
  }
  return report
}

// ---------------------------------------------------------------------------
// 导入域 1b：vault skills/ 目录 → skills 镜像
// ---------------------------------------------------------------------------

export function importVaultSkills(db, vaultSkillsDir, now) {
  const report = { inserted: 0, updated: 0, skills: [], skipped: [] }
  if (!existsSync(vaultSkillsDir)) {
    report.skipped.push(`vault skills 目录不存在: ${vaultSkillsDir}`)
    return report
  }
  let entries
  try {
    entries = readdirSync(vaultSkillsDir, { withFileTypes: true })
  } catch (e) {
    report.skipped.push(`vault skills 目录不可读: ${String(e)}`)
    return report
  }
  const selectByName = db.prepare('SELECT id FROM skills WHERE name = ?')
  const insert = db.prepare(
    'INSERT INTO skills (name, source_path, vault_rel_path, frontmatter_json, description, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
  )
  const update = db.prepare(
    'UPDATE skills SET vault_rel_path = ?, frontmatter_json = ?, description = ?, updated_at = ? WHERE id = ?',
  )
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const skillDir = join(vaultSkillsDir, e.name)
    const skillMdPath = join(skillDir, 'SKILL.md')
    let frontmatter = {}
    let hasSkillMd = false
    if (existsSync(skillMdPath)) {
      hasSkillMd = true
      try {
        frontmatter = parseFrontmatter(readFileSync(skillMdPath, 'utf8'))
      } catch {
        frontmatter = {} // 不可读按无 frontmatter 处理，不中止导入
      }
    }
    const vaultRelPath = `skills/${e.name}`
    const frontmatterJson = Object.keys(frontmatter).length > 0 ? JSON.stringify(frontmatter) : null
    const description = typeof frontmatter.description === 'string' ? frontmatter.description : ''
    const existing = selectByName.get(e.name)
    if (existing === undefined) {
      insert.run(e.name, vaultRelPath, frontmatterJson, description, now(), now())
      report.inserted += 1
    } else {
      update.run(vaultRelPath, frontmatterJson, description, now(), existing.id)
      report.updated += 1
    }
    report.skills.push({ name: e.name, hasSkillMd })
  }
  return report
}

// ---------------------------------------------------------------------------
// 导入域 1c：老 ApiHub 档案 → apihub_profiles 占位（needs_rekey=1，绝不解密）
// ---------------------------------------------------------------------------

/** kimi-profiles.json（旧「Kimi 接口」页）字段 → hub fields 平铺（同老 kimiProfileToHub） */
function kimiProfileFields(p) {
  return {
    providerId: String(p.providerId ?? ''),
    type: String(p.type ?? 'openai'),
    baseUrl: String(p.baseUrl ?? ''),
    modelId: String(p.modelId ?? ''),
    modelDisplay: String(p.modelDisplay ?? ''),
    maxContext: String(p.maxContext ?? ''),
    capabilities: Array.isArray(p.capabilities) ? p.capabilities.join(', ') : String(p.capabilities ?? ''),
    thinkingEnabled: p.thinkingEnabled === true ? 'true' : 'false'
  }
}

/** 从一个老 userData 目录收集 (provider, 档案) 元组；只登记，绝不解密 */
function collectLegacyApihubProfiles(dir) {
  const found = []
  const hubFile = join(dir, 'api-hub-profiles.json')
  if (existsSync(hubFile)) {
    const parsed = readJsonFile(hubFile)
    if (parsed.ok && parsed.data && typeof parsed.data.byAdapter === 'object' && parsed.data.byAdapter !== null) {
      for (const [provider, list] of Object.entries(parsed.data.byAdapter)) {
        if (!Array.isArray(list)) continue
        for (const p of list) {
          if (typeof p !== 'object' || p === null) continue
          if (typeof p.apiKeySealed !== 'string' || !p.apiKeySealed) continue
          found.push({
            provider,
            name: String(p.name ?? ''),
            sealed: p.apiKeySealed,
            fields: typeof p.fields === 'object' && p.fields !== null ? { ...p.fields } : {},
            plainStore: p.plainStore === true
          })
        }
      }
    }
  }
  const kimiFile = join(dir, 'kimi-profiles.json')
  if (existsSync(kimiFile)) {
    const parsed = readJsonFile(kimiFile)
    if (parsed.ok && parsed.data && Array.isArray(parsed.data.profiles)) {
      for (const p of parsed.data.profiles) {
        if (typeof p !== 'object' || p === null) continue
        if (typeof p.apiKeySealed !== 'string' || !p.apiKeySealed) continue
        found.push({
          provider: 'kimi',
          name: String(p.name ?? ''),
          sealed: p.apiKeySealed,
          fields: kimiProfileFields(p),
          plainStore: p.plainStore === true
        })
      }
    }
  }
  return found
}

export function importApihubPlaceholders(db, legacyAppDataDirs, now) {
  const report = { inserted: 0, updated: 0, skipped: 0, profiles: [], scannedDirs: [] }
  const existingRows = db
    .prepare('SELECT id, name, provider, encrypted_blob, needs_rekey FROM apihub_profiles')
    .all()
  const insert = db.prepare(
    'INSERT INTO apihub_profiles (name, provider, encrypted_blob, needs_rekey, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
  const updateBlob = db.prepare(
    'UPDATE apihub_profiles SET provider = ?, encrypted_blob = ?, needs_rekey = 1, updated_at = ? WHERE id = ?',
  )
  const usedNames = new Set(existingRows.map((r) => r.name))
  // 以 (provider, sealed) 为幂等键：重复运行时同一老档案必须命中既有行原地刷新，
  // 而不是因 name 冲突改名后再插一行（node:sqlite BLOB 读出为 Uint8Array，经 Buffer 解码）
  const bySealed = new Map()
  for (const r of existingRows) {
    try {
      const env = JSON.parse(Buffer.from(r.encrypted_blob).toString('utf8'))
      if (env !== null && typeof env === 'object' && typeof env.sealed === 'string') {
        bySealed.set(`${r.provider}::${env.sealed}`, r)
      }
    } catch {
      // 非 envelope 形态的既有行（如 S3 重加密后的私有格式）：不参与 sealed 索引，
      // 该档案若再出现会走 name 冲突改名路径（保持 needs_rekey=0 行不受影响）
    }
  }
  const seenIds = new Set() // 同一档案可能同时出现在多个候选目录，按 sealed 内容去重
  for (const dir of legacyAppDataDirs) {
    report.scannedDirs.push({ dir, exists: existsSync(dir) })
    if (!existsSync(dir)) continue
    for (const item of collectLegacyApihubProfiles(dir)) {
      const dedupeKey = `${item.provider}::${item.sealed}`
      if (seenIds.has(dedupeKey)) continue
      seenIds.add(dedupeKey)
      // envelope 原样封存（sealed 为老 DPAPI 密文或 plainStore base64）；此处绝不调用任何解密
      const blob = Buffer.from(
        JSON.stringify({ v: 1, sealed: item.sealed, fields: item.fields, ...(item.plainStore ? { plainStore: true } : {}) }),
        'utf8',
      )
      const existing = bySealed.get(dedupeKey)
      if (existing !== undefined) {
        if (Number(existing.needs_rekey) === 1) {
          updateBlob.run(item.provider, blob, now(), existing.id)
          report.updated += 1
          report.profiles.push({ name: existing.name, provider: item.provider })
        } else {
          report.skipped += 1 // 已在 DevHub 内完成重加密（needs_rekey=0）：不降级不改名
        }
        continue
      }
      let name = item.name.trim() || `${item.provider}-profile`
      if (usedNames.has(name)) name = `${item.provider}/${name}`
      let n = 2
      while (usedNames.has(name)) {
        name = `${item.provider}/${item.name || `${item.provider}-profile`}#${n}`
        n += 1
      }
      usedNames.add(name)
      insert.run(name, item.provider, blob, now(), now())
      report.inserted += 1
      report.profiles.push({ name, provider: item.provider })
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// 导入域 2：project-archiver config.json → archive_runs + archive_dest_root
// ---------------------------------------------------------------------------

export function importArchiveConfig(db, config, now) {
  const report = { runsInserted: 0, runsSkipped: 0, destRootSet: false, destRootKept: '', unmatched: 0, matchedProjects: [] }

  // settings.lastDestRoot → archive_dest_root（仅当目标为空/缺省；不覆盖用户已设值）
  const projectsArr = Array.isArray(config.projects) ? config.projects : []
  const historyArr = Array.isArray(config.history) ? config.history : []
  const lastDestRoot =
    config.settings && typeof config.settings.lastDestRoot === 'string' ? config.settings.lastDestRoot.trim() : ''
  const currentDest = db.prepare("SELECT value FROM settings WHERE key = 'archive_dest_root'").get()
  if (lastDestRoot !== '' && (currentDest === undefined || currentDest.value === '')) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('archive_dest_root', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      lastDestRoot,
    )
    report.destRootSet = true
    report.destRootKept = lastDestRoot
  }

  // DevHub projects 路径索引（win_path 归一 → id）；归一匹配，匹配不上不造 projects 行
  const pathIndex = new Map()
  for (const row of db.prepare('SELECT id, win_path FROM projects WHERE win_path IS NOT NULL').all()) {
    pathIndex.set(normalizeWinPath(row.win_path), row.id)
  }
  const matchProjectId = (...candidates) => {
    for (const c of candidates) {
      if (typeof c !== 'string' || !c.trim()) continue
      const hit = pathIndex.get(normalizeWinPath(c))
      if (hit !== undefined) return hit
    }
    return null
  }

  // config.projects[] 只做关联报告（已登记未归档 ≠ 归档历史，绝不伪造成 archive_runs）
  for (const p of projectsArr) {
    const projectId = matchProjectId(typeof p === 'object' && p !== null ? p.path : undefined)
    if (projectId !== null) report.matchedProjects.push({ name: String(p.name ?? ''), projectId })
  }

  const selectRun = db.prepare('SELECT id FROM archive_runs WHERE old_path = ? AND started_at = ?')
  const insertRun = db.prepare(
    'INSERT INTO archive_runs (project_id, project_name, old_path, new_path, status, fixed_files, external_files, residual_hits, stripped_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
  )
  for (const h of historyArr) {
    if (typeof h !== 'object' || h === null) {
      report.runsSkipped += 1
      continue
    }
    const startedAt = Number.isFinite(h.at) ? Math.floor(Number(h.at) / 1000) : null
    const oldPath = String(h.oldPath ?? '')
    if (oldPath === '' || startedAt === null) {
      report.runsSkipped += 1
      continue
    }
    if (selectRun.get(oldPath, startedAt) !== undefined) {
      report.runsSkipped += 1
      continue
    }
    const projectId = matchProjectId(oldPath, h.newPath)
    if (projectId === null) report.unmatched += 1
    insertRun.run(
      projectId,
      String(h.projectName ?? ''),
      oldPath,
      String(h.newPath ?? ''),
      h.status === 'rolled-back' ? 'rolled-back' : 'done',
      Number.isFinite(h.fixedFiles) ? Number(h.fixedFiles) : 0,
      Number.isFinite(h.externalFiles) ? Number(h.externalFiles) : 0,
      Number.isFinite(h.residualHits) ? Number(h.residualHits) : 0,
      startedAt,
      startedAt, // 老数据只有 at 一个时间点：started_at = finished_at
    )
    report.runsInserted += 1
  }
  return report
}

// ---------------------------------------------------------------------------
// 总编排
// ---------------------------------------------------------------------------

/**
 * 运行一次导入，返回结构化报告。幂等：重复运行 inserted 归零、内容不变。
 * options 全部可选；缺省走真实机器路径（受 DEVHUB_LEGACY_* 环境变量覆盖）。
 */
export async function runLegacyMigration(options = {}) {
  const defaults = defaultLegacyPaths()
  const registryPath = options.registryPath ?? defaults.registryPath
  const vaultSkillsDir = options.vaultSkillsDir ?? defaults.vaultSkillsDir
  const archiveConfigPath = options.archiveConfigPath ?? defaults.archiveConfigPath
  const legacyAppDataDirs = options.legacyAppDataDirs ?? defaults.legacyAppDataDirs
  const now = options.now ?? nowSec

  const report = {
    sources: {
      registry: { path: registryPath, exists: existsSync(registryPath), ok: false, error: null },
      vaultSkills: { path: vaultSkillsDir, exists: existsSync(vaultSkillsDir) },
      archiveConfig: { path: archiveConfigPath, exists: archiveConfigPath !== '' && existsSync(archiveConfigPath), ok: false, error: null },
      legacyAppDataDirs
    },
    skillAgents: null,
    skills: null,
    apihub: null,
    archive: null
  }

  const db = getDatabase()

  // 1) registry.json → skill_agents
  if (report.sources.registry.exists) {
    const parsed = parseRegistry(readFileSync(registryPath, 'utf8'))
    if (parsed.ok) {
      report.sources.registry.ok = true
      report.skillAgents = importRegistryAgents(db, parsed.registry, now)
    } else {
      report.sources.registry.error = parsed.error
    }
  }

  // 2) vault skills/ → skills 镜像
  if (report.sources.vaultSkills.exists) {
    report.skills = importVaultSkills(db, vaultSkillsDir, now)
  }

  // 3) 老 ApiHub userData → apihub_profiles 占位（needs_rekey=1）
  report.apihub = importApihubPlaceholders(db, legacyAppDataDirs, now)

  // 4) project-archiver config.json → archive_runs / archive_dest_root
  if (report.sources.archiveConfig.exists) {
    const parsed = readJsonFile(archiveConfigPath)
    if (parsed.ok && typeof parsed.data === 'object' && parsed.data !== null) {
      report.sources.archiveConfig.ok = true
      report.archive = importArchiveConfig(db, parsed.data, now)
    } else {
      report.sources.archiveConfig.error = parsed.ok ? 'config.json 根节点不是对象' : parsed.error
    }
  }

  return report
}

function printReport(report) {
  const s = report.sources
  console.log('=== DevHub legacy import report ===')
  console.log(`[registry] ${s.registry.path}`)
  console.log(`  exists=${s.registry.exists} parsed=${s.registry.ok}${s.registry.error ? ` error=${s.registry.error}` : ''}`)
  if (report.skillAgents) {
    console.log(`  skill_agents: inserted=${report.skillAgents.inserted} updated=${report.skillAgents.updated} [${report.skillAgents.agents.join(', ')}]`)
  }
  console.log(`[vault skills] ${s.vaultSkills.path} exists=${s.vaultSkills.exists}`)
  if (report.skills) {
    console.log(`  skills: inserted=${report.skills.inserted} updated=${report.skills.updated}`)
    for (const sk of report.skills.skills) console.log(`    - ${sk.name} (SKILL.md=${sk.hasSkillMd})`)
    for (const note of report.skills.skipped) console.log(`    skip: ${note}`)
  }
  console.log('[apihub legacy blobs] (只登记，不解密)')
  for (const d of report.apihub.scannedDirs) console.log(`  scan ${d.dir}: exists=${d.exists}`)
  console.log(
    `  apihub_profiles: inserted=${report.apihub.inserted} updated=${report.apihub.updated} skipped(already-rekeyed)=${report.apihub.skipped}` +
      (report.apihub.profiles.length > 0 ? ` [${report.apihub.profiles.map((p) => `${p.provider}:${p.name}`).join(', ')}]` : ' (no legacy profiles found)'),
  )
  console.log(`[archive config] ${s.archiveConfig.path}`)
  console.log(`  exists=${s.archiveConfig.exists} parsed=${s.archiveConfig.ok}${s.archiveConfig.error ? ` error=${s.archiveConfig.error}` : ''}`)
  if (report.archive) {
    console.log(
      `  archive_runs: inserted=${report.archive.runsInserted} skipped(dup/invalid)=${report.archive.runsSkipped} unmatched(project_id NULL)=${report.archive.unmatched}`,
    )
    console.log(`  archive_dest_root: ${report.archive.destRootSet ? `set from lastDestRoot -> ${report.archive.destRootKept}` : 'kept (already set or empty source)'} `)
    for (const m of report.archive.matchedProjects) console.log(`  matched project: ${m.name} -> projects.id=${m.projectId}`)
  }
  console.log('legacy dirs untouched: read-only access only (no writes to legacy files)')
}

function isEntrypoint() {
  if (!process.argv[1]) return false
  return import.meta.url === pathToFileURL(process.argv[1]).href
}

// CLI 入口（smoke 经 import 复用 runLegacyMigration，不会触发本分支）
if (isEntrypoint()) {
  try {
    const report = await runLegacyMigration()
    printReport(report)
  } finally {
    closeDatabase()
  }
}
