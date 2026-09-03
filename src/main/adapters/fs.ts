/**
 * fs.ts — 项目发现只读 adapter（docs/02 §1，docs/01 §2.2，约束 #19）。
 *
 * 扫描根目录（默认 F:\\Active_Project）的**一级**子目录，目录内含任一项目标记
 * （.git / package.json / pyproject.toml / … / *.sln / *.csproj）即为候选项目；
 * 多标记同目录只算一个项目，runtimeHint 取优先级最高的标记；
 * 跳过 node_modules、隐藏目录（.mimosa 属隐藏目录）；name = 目录名；
 * 附 wslPath = wslPathForWinPath(winPath)。
 *
 * 只读：仅 readdir，不写任何文件；目录不存在/无权限 → readDirSafe 容错为空。
 */

import { readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { wslPathForWinPath } from './wsl.ts'
import type { DiscoveredProject } from '../../shared/types.ts'

// ---------------------------------------------------------------------------
// 标记表（数组顺序即 runtimeHint 优先级：.git → package.json → pyproject → …）
// ---------------------------------------------------------------------------

interface MarkerSpec {
  /** 目录内的确切文件/目录名。 */
  file: string
  /** 命中时写入 runtimeHint 的运行时提示。 */
  hint: string
}

const MARKERS: readonly MarkerSpec[] = [
  { file: '.git', hint: 'git' },
  { file: 'package.json', hint: 'node' },
  { file: 'pyproject.toml', hint: 'python' },
  { file: 'requirements.txt', hint: 'python' },
  { file: 'Cargo.toml', hint: 'rust' },
  { file: 'go.mod', hint: 'go' },
  { file: 'pom.xml', hint: 'java' },
  { file: 'build.gradle', hint: 'java' },
  { file: 'composer.json', hint: 'php' },
  { file: 'Gemfile', hint: 'ruby' },
  { file: 'deno.json', hint: 'deno' },
  { file: 'CMakeLists.txt', hint: 'cmake' },
]

/** 扩展名类标记（*.sln / *.csproj），优先级排在确切名标记之后。 */
const DOTNET_EXTENSIONS = ['.sln', '.csproj']
const DOTNET_HINT = 'dotnet'
const DOTNET_MARKER_LABEL = '*.sln|*.csproj'

/** 无条件跳过的目录名。 */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules'])

// ---------------------------------------------------------------------------
// 容错目录读取
// ---------------------------------------------------------------------------

/** 目录条目读取；不存在 / 无权限 / 其他 I/O 错误 → 空数组。 */
export function readDirSafe(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 项目发现
// ---------------------------------------------------------------------------

/** 单目录标记检测结果（discoverProjects 与 Service 层手动添加项目共用）。 */
export interface DetectedMarkers {
  /** 该目录命中的全部标记文件名（*.sln/*.csproj 以扩展名组合形式记录）。 */
  markers: string[]
  /** 命中的最高优先级标记对应的运行时提示。 */
  runtimeHint: string
}

/**
 * 检测单个目录内的项目标记（.git / package.json / pyproject.toml / … / *.sln）。
 * 无任何标记 → null；目录不存在/无权限 → readDirSafe 容错为空 → null。
 */
export function detectProjectMarkers(dirPath: string): DetectedMarkers | null {
  const children = readDirSafe(dirPath)

  const markers: string[] = []
  let runtimeHint: string | undefined
  for (const marker of MARKERS) {
    if (children.some((c) => c.name === marker.file)) {
      markers.push(marker.file)
      if (runtimeHint === undefined) runtimeHint = marker.hint
    }
  }
  if (runtimeHint === undefined) {
    const hasDotnet = children.some((c) => {
      const lower = c.name.toLowerCase()
      return DOTNET_EXTENSIONS.some((ext) => lower.endsWith(ext))
    })
    if (hasDotnet) {
      markers.push(DOTNET_MARKER_LABEL)
      runtimeHint = DOTNET_HINT
    }
  }
  return runtimeHint === undefined ? null : { markers, runtimeHint }
}

/**
 * 扫描根目录一层，返回候选项目列表（按目录名排序，结果确定）。
 * 根目录本身不存在 / 无权限 → 空数组。
 */
export async function discoverProjects(rootPath: string): Promise<DiscoveredProject[]> {
  const projects: DiscoveredProject[] = []
  for (const entry of readDirSafe(rootPath)) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue

    const winPath = join(rootPath, name)
    const detected = detectProjectMarkers(winPath)
    if (detected === null) continue // 无任何标记，非候选

    projects.push({
      name,
      winPath,
      wslPath: wslPathForWinPath(winPath),
      runtimeHint: detected.runtimeHint,
      markers: detected.markers,
    })
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name))
}
