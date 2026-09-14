/**
 * updateFeed.ts — 更新 feed 纯函数层（X-U 批，docs/briefs/xu-updater.md §1）。
 *
 * electron-updater 启用（ECS caddy 静态 generic feed，`/updates/` 路径）的纯侧：
 *   1. compareVersions / isNewerVersion —— semver X.Y.Z 三元组数值比较（降级
 *      防护栏：candidate ≤ current 一律视为「最新」，绝不降级安装）；
 *   2. parseLatestYml —— latest.yml 最小行解析（electron-builder 固有扁平形
 *      状：version/path/sha512/releaseDate 顶层键 + files[] 数组块），供
 *      scripts/build-updates-feed.mjs 装配断言与 smoke 夹具复用（同一实现，
 *      零 YAML 依赖，约束 #23 同风格自研）；
 *   3. resolveAssetFileName —— latest.yml path/files[].url 与 dist 实际文件名
 *      的一致性核对（HANDOFF 注记：electron-builder 把产物名中的空格改写为
 *      连字符，如实际 `DevHub Setup 0.1.0.exe` vs path `DevHub-Setup-0.1.0.exe`；
 *      另存在点分隔形态 `DevHub.Setup.0.1.0.exe`。归一化匹配 = 分隔符
 *      [空格 . _ -] 全部折叠后比较；精确同名优先）；
 *   4. projectReleaseNotes —— UpdateInfo.releaseNotes（string |
 *      ReleaseNoteInfo[] | null）→ 人话字符串投影（设置卡更新说明位）。
 *
 * 纯 Node 模块：零 electron / 零 electron-updater import，可被 smoke 在系统
 * Node 下直接加载（handlers.ts 同一约束风格）。
 */

/** latest.yml 解析产物（electron-builder latest.yml 固有键的最小子集）。 */
export interface LatestYmlFile {
  url: string
  sha512: string | null
  size: number | null
}

export interface LatestYmlInfo {
  version: string
  /** 顶层 path 字段（electron-updater 以 <feed>/<path> 拼 URL 拉取安装包）。 */
  path: string
  sha512: string | null
  releaseDate: string | null
  files: LatestYmlFile[]
}

/**
 * semver 三元组比较（X.Y[Z[.n…]]，逐段数值，缺段按 0）。任何一段非纯数字 →
 * throw（调用方应捕获；feed 数据一律走 isNewerVersion 的防御包装）。
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.trim().split('.').map((s) => Number.parseInt(s, 10))
  const pb = b.trim().split('.').map((s) => Number.parseInt(s, 10))
  if (pa.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`malformed version string: ${a}`)
  if (pb.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`malformed version string: ${b}`)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va < vb) return -1
    if (va > vb) return 1
  }
  return 0
}

/**
 * candidate 是否比 current 更新（feed 数据防御版）：任一版本串 malformed →
 * false（绝不因 feed 脏数据崩溃；降级/平版一律 false = 按「最新」处理）。
 */
export function isNewerVersion(current: string, candidate: string): boolean {
  try {
    return compareVersions(candidate, current) > 0
  } catch {
    return false
  }
}

/** 去引号（latest.yml 的 releaseDate 等可能带单/双引号）。 */
function unquote(value: string): string {
  const t = value.trim()
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * latest.yml 最小行解析（electron-builder 固有形状；只认本模块需要的键，
 * 其余行忽略——构建器版本间附加键容忍）。缺 version 或 path → throw。
 * 形状（真实样例，main 仓 dist/latest.yml 2026-09-14）：
 *   version: 0.1.0
 *   files:
 *     - url: DevHub-Setup-0.1.0.exe
 *       sha512: <base64>
 *       size: 129850578
 *   path: DevHub-Setup-0.1.0.exe
 *   sha512: <base64>
 *   releaseDate: '2026-09-14T01:06:05.355Z'
 */
export function parseLatestYml(text: string): LatestYmlInfo {
  const info: LatestYmlInfo = { version: '', path: '', sha512: null, releaseDate: null, files: [] }
  let topLevelSha512Seen = false
  let inFiles = false
  let current: LatestYmlFile | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim().length === 0) continue
    if (/^files:\s*$/.test(rawLine)) {
      inFiles = true
      continue
    }
    // files[] 条目行（"- url: …"）
    const itemMatch = rawLine.match(/^\s*-\s+(\w+):\s*(.*)$/)
    if (inFiles && itemMatch !== null) {
      if (current !== null) info.files.push(current)
      current = { url: '', sha512: null, size: null }
      applyFileField(current, itemMatch[1] ?? '', itemMatch[2] ?? '')
      continue
    }
    // files[] 条目的后续字段行（缩进的 "sha512: …" / "size: …"）
    const fieldMatch = rawLine.match(/^\s+(\w+):\s*(.*)$/)
    if (inFiles && current !== null && fieldMatch !== null && !rawLine.startsWith('    -')) {
      applyFileField(current, fieldMatch[1] ?? '', fieldMatch[2] ?? '')
      continue
    }
    // 顶层键行（version/path/sha512/releaseDate；files 块内的顶层回判：无缩进）
    const topMatch = rawLine.match(/^(\w+):\s*(.*)$/)
    if (topMatch !== null) {
      inFiles = false
      if (current !== null) {
        info.files.push(current)
        current = null
      }
      const key = topMatch[1] ?? ''
      const value = unquote(topMatch[2] ?? '')
      if (key === 'version') info.version = value
      else if (key === 'path') info.path = value
      else if (key === 'sha512') {
        if (!topLevelSha512Seen) {
          info.sha512 = value
          topLevelSha512Seen = true
        }
      } else if (key === 'releaseDate') info.releaseDate = value
    }
  }
  if (current !== null) info.files.push(current)
  if (info.version.length === 0 || info.path.length === 0) {
    throw new Error('latest.yml malformed: required fields "version" and "path" must be present')
  }
  return info
}

function applyFileField(file: LatestYmlFile, key: string, rawValue: string): void {
  const value = unquote(rawValue)
  if (key === 'url') file.url = value
  else if (key === 'sha512') file.sha512 = value
  else if (key === 'size') {
    const n = Number.parseInt(value, 10)
    file.size = Number.isInteger(n) && n >= 0 ? n : null
  }
}

/**
 * 产物名归一化：小写 + 分隔符（空格 . _ -）折叠为单 '-'。用于 latest.yml
 * 引用名与 dist 实际文件名的跨形态匹配：
 *   'DevHub Setup 0.1.0.exe'   → devhub-setup-0-1-0-exe
 *   'DevHub-Setup-0.1.0.exe'   → devhub-setup-0-1-0-exe（连字符形态，electron-builder 固有）
 *   'DevHub.Setup.0.1.0.exe'   → devhub-setup-0-1-0-exe（点形态）
 */
export function normalizeAssetName(name: string): string {
  return name.trim().toLowerCase().replace(/[.\s_-]+/g, '-')
}

/**
 * latest.yml 引用名 → dist 实际文件名核对（一致性断言的匹配核心）：
 * 精确同名优先；否则归一化匹配（连字符/点/空格形态兼容，HANDOFF 注记）。
 * 无匹配 → null（装配脚本必须就此报错退出，绝不带病装配）。
 */
export function resolveAssetFileName(referenced: string, actualFiles: readonly string[]): string | null {
  const exact = actualFiles.find((f) => f === referenced)
  if (exact !== undefined) return exact
  const target = normalizeAssetName(referenced)
  const matched = actualFiles.filter((f) => normalizeAssetName(f) === target)
  // 归一化撞名多份 → 拒绝猜（宁报错不装配错文件）
  if (matched.length !== 1) return null
  return matched[0] ?? null
}

/**
 * UpdateInfo.releaseNotes → 人话字符串投影（设置卡更新说明位，约束 #26 结构
 * 化呈现）。string → 原样（trim 后空 → null）；ReleaseNoteInfo[] → 逐条 note
 * （缺 note 用 version）换行拼接；null/undefined/未知形状 → null。
 */
export function projectReleaseNotes(notes: unknown): string | null {
  if (typeof notes === 'string') {
    const t = notes.trim()
    return t.length > 0 ? t : null
  }
  if (Array.isArray(notes)) {
    const lines: string[] = []
    for (const item of notes) {
      if (typeof item === 'object' && item !== null) {
        const rec = item as { note?: unknown; version?: unknown }
        const note = typeof rec.note === 'string' ? rec.note.trim() : ''
        const version = typeof rec.version === 'string' ? rec.version.trim() : ''
        if (note.length > 0) lines.push(note)
        else if (version.length > 0) lines.push(version)
      }
    }
    return lines.length > 0 ? lines.join('\n') : null
  }
  return null
}
