/**
 * github.ts — GitHub Releases 通道（DeepSeek Harness，老 versionCenter/github.ts 移植）。
 *
 * 上游实况：github.com/deepseek-ai/deepseek-harness 的 Releases 全部为 prerelease
 * （/releases/latest 恒空）→ 必须 list ?per_page=10 后用 compareSemver 自选最高。
 * 网络走 Node 内建 fetch（docs/09 §7「下载走 Node fetch（无新依赖）」，不落凭据）；
 * 解包用 Windows 自带 tar.exe、staging 内 npm 重建复用 npm 通道的路径解析 ——
 * 全部外部命令经 core/exec.run()。
 *
 * 更新流水线（仅用户点击触发）：查询 → 下载源码包 → 解包 staging → npm install 重建
 * → 校验入口 → 原子换目录（旧目录自动备份，~/.dsh 不动）→ 版本校验（失败回滚换名）。
 * 前置缺失（无本地安装目录 / npm 不可用 / GitHub 不可达）一律结构化降级并说明。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../../core/exec.ts'
import { resolveNpmCmdPath, runViaCmd } from './npm.ts'
import { compareSemver, isSafeTag, parseSemver, semverFromTag } from './versionCompare.ts'

export const GITHUB_REPO = 'deepseek-ai/deepseek-harness'
/** unauthenticated /releases 列表：latest 端点对全 prerelease 仓库返回 404，故列 10 条自选最高 */
export const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases?per_page=10'
export const GITHUB_TARBALL_URL_PREFIX = 'https://github.com/' + GITHUB_REPO + '/archive/refs/tags/'

/** Releases 查询超时（fetch AbortSignal 30s，整体 35s 硬顶） */
export const GITHUB_RELEASE_TIMEOUT_MS = 35_000
/** 下载超时（fetch 流式落盘，5 分钟硬顶） */
export const GITHUB_DOWNLOAD_TIMEOUT_MS = 330_000
/** tar 解包超时 */
export const GITHUB_EXTRACT_TIMEOUT_MS = 120_000
/** staging 内 npm 重建超时（docs/09 §7：重建 30min） */
export const GITHUB_REBUILD_TIMEOUT_MS = 30 * 60_000

/** DeepSeek 本体安装目录默认值（settings.deepseekHarnessRoot 缺省；检测绝不写入此目录） */
export const DEEPSEEK_DEFAULT_ROOT = 'D:\\Apps\\deepseek-harness'
/** ARP 注册表里的展示名（installRoot 缺失时回退展示版本用） */
export const DEEPSEEK_ARP_DISPLAY_NAME = 'DeepSeek Harness'

// ---------------------------------------------------------------------------
// 本地安装版本
// ---------------------------------------------------------------------------

export type LocalVersionResult = { version: string } | { missing: true } | { error: string }

/** 读 <installRoot>/package.json 的 version；目录不存在 → missing（调用方回落 ARP 展示） */
export function readLocalPackageVersion(installRoot: string): LocalVersionResult {
  let rootOk = false
  try {
    rootOk = fs.statSync(installRoot).isDirectory()
  } catch {
    rootOk = false
  }
  if (!rootOk) return { missing: true }
  let raw: string
  try {
    raw = fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8')
  } catch (e) {
    return { error: '读取 package.json 失败: ' + String(e instanceof Error ? e.message : e).slice(0, 120) }
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) return { version: parsed.version.trim() }
    return { error: 'package.json 缺少 version 字段: ' + installRoot }
  } catch {
    return { error: 'package.json 不是有效 JSON: ' + installRoot }
  }
}

// ---------------------------------------------------------------------------
// Releases 查询（Node fetch）
// ---------------------------------------------------------------------------

export interface GithubReleaseInfo {
  tag: string
  version: string
  publishedAt: string
}
export type GithubFetchResult = { ok: true; tag: string; version: string; publishedAt: string } | { ok: false; error: string }

interface RawRelease {
  tag_name?: unknown
  published_at?: unknown
  draft?: unknown
}

/** 从 releases 数组选 compareSemver 最高者；全部不可解析 → null */
export function selectLatestTag(tags: string[]): string | null {
  let best: string | null = null
  for (const t of tags) {
    if (typeof t !== 'string' || t.trim().length === 0 || parseSemver(t) === null) continue
    if (best === null || (compareSemver(t, best) ?? 0) > 0) best = t
  }
  return best
}

/**
 * 解析 releases JSON（取 tag_name + published_at，跳过 draft）。
 * 非数组（限流/错误对象）→ ok:false；message 含 rate limit → 明确提示限流。
 */
export function parseReleasesJson(stdout: string): { ok: true; items: GithubReleaseInfo[] } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(stdout ?? ''))
  } catch {
    return { ok: false, error: 'GitHub Releases 响应不是有效 JSON: ' + String(stdout ?? '').slice(0, 120) }
  }
  if (!Array.isArray(parsed)) {
    const msg = typeof (parsed as { message?: unknown })?.message === 'string' ? String((parsed as { message?: unknown }).message) : ''
    if (msg.toLowerCase().includes('rate limit')) {
      return { ok: false, error: 'GitHub API 限流，稍后再试（' + msg.slice(0, 120) + '）' }
    }
    return { ok: false, error: 'GitHub Releases 响应异常: ' + (msg.length > 0 ? msg : String(stdout ?? '').slice(0, 120)) }
  }
  const items: GithubReleaseInfo[] = []
  for (const r of parsed as RawRelease[]) {
    if (typeof r !== 'object' || r === null) continue
    if (r.draft === true) continue
    if (typeof r.tag_name !== 'string' || r.tag_name.length === 0) continue
    items.push({
      tag: r.tag_name,
      version: semverFromTag(r.tag_name),
      publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
    })
  }
  return { ok: true, items }
}

/** 查询最新 release（含 prerelease）：Node fetch + AbortSignal 30s；限流/网络失败如实透出 */
export async function fetchLatestRelease(deps: { timeoutMs?: number } = {}): Promise<GithubFetchResult> {
  let text: string
  try {
    const res = await fetch(GITHUB_RELEASES_API_URL, {
      headers: { 'User-Agent': 'DevHub-VersionCenter' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? GITHUB_RELEASE_TIMEOUT_MS),
    })
    text = await res.text()
    if (!res.ok && text.trim().length === 0) {
      return { ok: false, error: `GitHub Releases 查询失败: HTTP ${res.status}` }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: 'GitHub Releases 查询失败: ' + msg.slice(0, 200) }
  }
  const parsed = parseReleasesJson(text)
  if (!parsed.ok) return parsed
  const tag = selectLatestTag(parsed.items.map((x) => x.tag))
  if (tag === null) return { ok: false, error: 'Releases 列表为空或无可比较的版本 tag' }
  const hit = parsed.items.find((x) => x.tag === tag)
  return { ok: true, tag, version: semverFromTag(tag), publishedAt: hit?.publishedAt ?? '' }
}

// ---------------------------------------------------------------------------
// 下载与解包
// ---------------------------------------------------------------------------

export type GithubFileResult = { ok: true; path: string } | { ok: false; error: string }

function defaultFileStat(p: string): { size: number } | null {
  try {
    const st = fs.statSync(p)
    return st.isFile() ? { size: st.size } : null
  } catch {
    return null
  }
}

/**
 * 由 tag 派生 tarball 落盘路径（守卫 → join 关系显式化，双保险）：
 * tag 先过 isSafeTag 白名单（首字符字母数字，其余仅 [0-9A-Za-z._-]，无路径分隔符），
 * join 后 path.resolve 再校验仍严格 contained 在 tmpDir 内——即使未来白名单放宽
 * 也不会写出 tmpDir。两道守卫均为既有语义，行为不变；不合法 → null。
 */
function safeTarballPath(tmpDir: string, tag: string): string | null {
  if (!isSafeTag(tag)) return null
  const root = path.resolve(tmpDir)
  const out = path.resolve(path.join(root, 'dsh-' + tag + '.tar.gz'))
  if (!out.startsWith(root + path.sep)) return null
  return out
}

/** 下载 tag 源码包到 tmp（Node fetch 流式落盘，docs/09 §7）；校验存在且 >1KB */
export async function downloadReleaseTarball(tag: string, deps: { tmpDir?: string } = {}): Promise<GithubFileResult> {
  const out = safeTarballPath(deps.tmpDir ?? os.tmpdir(), tag)
  if (out === null) return { ok: false, error: 'tag 含不安全字符，拒绝下载: ' + String(tag).slice(0, 60) }
  const url = GITHUB_TARBALL_URL_PREFIX + tag + '.tar.gz'
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'DevHub-VersionCenter' },
      redirect: 'follow',
      signal: AbortSignal.timeout(GITHUB_DOWNLOAD_TIMEOUT_MS),
    })
    if (!res.ok || res.body === null) {
      return { ok: false, error: `源码包下载失败: HTTP ${res.status} ${res.statusText}`.slice(0, 300) }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(out, buf)
  } catch (e) {
    return { ok: false, error: '源码包下载失败: ' + String(e instanceof Error ? e.message : e).slice(0, 300) }
  }
  const stat = defaultFileStat(out)
  if (stat === null) return { ok: false, error: '下载后未找到源码包: ' + out }
  if (stat.size <= 1024) return { ok: false, error: '下载的源码包过小（' + stat.size + ' 字节），疑似失败响应: ' + out }
  return { ok: true, path: out }
}

/** 解包 tar.gz 到 staging：Windows 自带 tar.exe（经 core/exec）；GitHub 包有单层顶层目录 → 自动展平到 staging 根 */
export async function extractTarball(tarball: string, stagingRoot: string, deps: { timeoutMs?: number } = {}): Promise<GithubFileResult> {
  try {
    fs.mkdirSync(stagingRoot, { recursive: true })
  } catch (e) {
    return { ok: false, error: '无法创建解包目录: ' + String(e instanceof Error ? e.message : e).slice(0, 120) }
  }
  const r = await run('tar.exe', ['-xzf', tarball, '-C', stagingRoot], { timeoutMs: deps.timeoutMs ?? GITHUB_EXTRACT_TIMEOUT_MS })
  if (r.code !== 0 || r.timedOut) {
    return { ok: false, error: `tar 解包失败（退出码 ${r.code}）: ` + (r.stderr || r.stdout || '无输出').slice(-300) }
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true })
  } catch (e) {
    return { ok: false, error: '解包目录不可读: ' + String(e instanceof Error ? e.message : e).slice(0, 120) }
  }
  if (entries.length === 0) return { ok: false, error: '解包结果为空（tar 未产出内容）: ' + stagingRoot }
  if (entries.length === 1 && entries[0].isDirectory()) {
    const wrapper = path.join(stagingRoot, entries[0].name)
    let inner: fs.Dirent[]
    try {
      inner = fs.readdirSync(wrapper, { withFileTypes: true })
    } catch (e) {
      return { ok: false, error: '顶层目录不可读: ' + String(e instanceof Error ? e.message : e).slice(0, 120) }
    }
    try {
      for (const d of inner) {
        const dest = path.join(stagingRoot, d.name)
        if (fs.existsSync(dest)) return { ok: false, error: '展平时目标已存在，拒绝覆盖: ' + dest }
        fs.renameSync(path.join(wrapper, d.name), dest)
      }
      fs.rmSync(wrapper, { recursive: true, force: true })
    } catch (e) {
      return { ok: false, error: '展平顶层目录失败: ' + String(e instanceof Error ? e.message : e).slice(0, 160) }
    }
  }
  return { ok: true, path: stagingRoot }
}

// ---------------------------------------------------------------------------
// 一键更新流水线（仅用户点击触发；每步超时经 core/exec，进度经 onLine 进 job 日志）
// ---------------------------------------------------------------------------

export interface GithubUpdateDeps {
  /** 时间戳后缀（<root>.bak-<ts> / <root>.update-<ts>；测试注入保证确定性） */
  nowMs?: () => number
  /** 下载输出目录（默认 os.tmpdir()；测试注入） */
  tmpDir?: string
  /** 每步进度回调（空行不回调） */
  onLine?: (line: string) => void
  /** 合作式取消旗标（夜间#1：versions:cancel；每个流水线步开始前检查，真值即中止） */
  shouldAbort?: () => boolean
}

export interface GithubUpdateOutcome {
  ok: boolean
  error?: string
}

function compactTs(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => (n < 10 ? '0' + String(n) : String(n))
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/**
 * 多步更新流水线：查询 → 下载 → 解包 → npm install 重建 → 入口校验 → 换目录 → 版本校验。
 * - 任何前置缺失（无本地安装目录 / npm 不可用 / GitHub 不可达）结构化失败并说明（不写入安装目录）；
 * - 换目录后版本校验失败 → 回滚换名（保留 staging-failed 供排查）；
 * - 非换目录阶段失败：保留 staging 供排查。
 */
export async function runGithubUpdate(installRoot: string, deps: GithubUpdateDeps = {}): Promise<GithubUpdateOutcome> {
  const emit = (line: string): void => deps.onLine?.(line)
  /** 步间合作式取消检查（夜间#1 versions:cancel）：真值 → 结构化中止，绝不继续下一步。 */
  const aborted = (): boolean => deps.shouldAbort?.() === true
  let staging = ''
  try {
    if (aborted()) return { ok: false, error: '更新已被用户取消（第一步前中止）' }
    emit('[1/6] 查询 GitHub Releases（' + GITHUB_REPO + '）…')
    const rel = await fetchLatestRelease()
    if (!rel.ok) return { ok: false, error: rel.error }
    const target = semverFromTag(rel.tag)
    emit('    最新 ' + rel.tag + '（' + rel.version + (rel.publishedAt.length > 0 ? '，发布于 ' + rel.publishedAt : '') + '）')
    if (!isSafeTag(rel.tag)) return { ok: false, error: 'tag 含不安全字符，拒绝更新: ' + rel.tag.slice(0, 60) }
    if (!fs.existsSync(installRoot)) {
      return { ok: false, error: '未找到本地安装目录: ' + installRoot + '（可在设置中指定 deepseekHarnessRoot）；本次更新未做任何改动' }
    }

    const ts = compactTs((deps.nowMs ?? Date.now)())
    staging = installRoot + '.update-' + ts
    const bak = installRoot + '.bak-' + ts

    if (aborted()) return { ok: false, error: '更新已被用户取消（下载前中止；安装目录未做任何改动）' }
    emit('[2/6] 下载源码包 dsh-' + rel.tag + '.tar.gz …')
    const dl = await downloadReleaseTarball(rel.tag, { tmpDir: deps.tmpDir })
    if (!dl.ok) return { ok: false, error: dl.error }
    emit('    已下载 ' + dl.path)

    if (aborted()) return { ok: false, error: '更新已被用户取消（解包前中止；安装目录未做任何改动）' }
    emit('[3/6] 解包到 ' + staging)
    const ex = await extractTarball(dl.path, staging)
    if (!ex.ok) return { ok: false, error: ex.error }

    if (aborted()) return { ok: false, error: '更新已被用户取消（重建前中止；staging 保留，安装目录未做任何改动）' }
    emit('[4/6] npm install --no-audit --no-fund（staging 内重建依赖，约需数分钟）')
    const npmPath = await resolveNpmCmdPath()
    if (npmPath === null) {
      return { ok: false, error: '未找到 npm.cmd，无法在 staging 内重建依赖（staging 已保留供排查: ' + staging + '）' }
    }
    const install = await runViaCmd([npmPath, 'install', '--no-audit', '--no-fund'], GITHUB_REBUILD_TIMEOUT_MS, staging)
    if (install.code !== 0 || install.timedOut) {
      return {
        ok: false,
        error:
          'npm install 失败（退出码 ' + install.code + '）: ' + (install.stderr || install.stdout || '无输出').slice(-400) +
          '（staging 已保留供排查: ' + staging + '）',
      }
    }

    const binJs = path.join(staging, 'apps', 'cli', 'lib', 'bin.js')
    if (!fs.existsSync(binJs)) {
      emit('    staging 缺少 apps/cli/lib/bin.js，执行 npm run build:lib 兜底…')
      const build = await runViaCmd([npmPath, 'run', 'build:lib'], GITHUB_REBUILD_TIMEOUT_MS, staging)
      if (build.code !== 0 || build.timedOut) {
        return {
          ok: false,
          error:
            'npm run build:lib 失败（退出码 ' + build.code + '）: ' + (build.stderr || build.stdout || '无输出').slice(-400) +
            '（staging 已保留供排查: ' + staging + '）',
        }
      }
      if (!fs.existsSync(binJs)) {
        return { ok: false, error: '构建后仍未找到 apps/cli/lib/bin.js（staging 已保留供排查: ' + staging + '）' }
      }
    }

    // 换目录是不可逆原子段：取消检查只放到它之前（一旦开始必须完成或回滚，绝不中断半途）
    if (aborted()) return { ok: false, error: '更新已被用户取消（换目录前中止；staging 保留，安装目录未做任何改动）' }
    emit('[5/6] 换目录：旧目录备份为 ' + bak + '（数据目录 ~/.dsh 不受影响）')
    try {
      fs.renameSync(installRoot, bak)
    } catch (e) {
      return { ok: false, error: '旧目录改名失败（' + bak + '）: ' + String(e instanceof Error ? e.message : e).slice(0, 160) }
    }
    try {
      fs.renameSync(staging, installRoot)
    } catch (e) {
      try {
        fs.renameSync(bak, installRoot)
      } catch {
        /* 回滚失败只能如实报告两个路径 */
      }
      return { ok: false, error: '新目录就位失败，已回滚: ' + String(e instanceof Error ? e.message : e).slice(0, 160) }
    }

    emit('[6/6] 校验新目录版本（期望 ' + target + '）…')
    const v = readLocalPackageVersion(installRoot)
    const actual = 'version' in v ? v.version : ''
    const same = 'version' in v && (compareSemver(v.version, target) ?? null) === 0
    if (!same) {
      try {
        fs.renameSync(installRoot, staging + '-failed')
      } catch {
        /* 保留失败目录失败则只能报告 */
      }
      try {
        fs.renameSync(bak, installRoot)
        emit('    版本不符，已回滚到旧目录')
      } catch {
        emit('    警告：回滚换名失败，请人工检查 ' + bak)
      }
      const detail = 'version' in v ? v.version : ('error' in v ? v.error : '未知')
      return { ok: false, error: '更新后版本校验失败（期望 ' + target + '，实际 ' + (actual.length > 0 ? actual : detail) + '），已回滚' }
    }
    emit('✓ 更新完成：' + installRoot + ' → ' + actual + '（旧目录备份: ' + bak + '）')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 1200) }
  }
}

/** 更新命令展示文本（job 日志首行；实际是多步流水线，非单条外部命令）。 */
export const GITHUB_UPDATE_COMMAND_TEXT = 'GitHub Releases 更新（' + GITHUB_REPO + '）：下载源码包 → 解包 → npm install → 换目录'
