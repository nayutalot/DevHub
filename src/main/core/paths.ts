/**
 * paths.ts — 用户数据 / DB / 日志路径解析（docs/02 §1.1 paths 策略）。
 *
 * 模块顶层禁止 import 'electron'（smoke 在系统 Node 下直接加载本模块），
 * Electron 的 app.getPath('userData') 经动态 require + try/catch 获取。
 *
 * home 四级策略（跨进程 DB 对齐，M1 批次修复）：
 *  1. process.env.DEVHUB_HOME 覆盖（测试 / 便携模式）；
 *  2. Electron main 进程内 app.getPath('userData')；
 *  3. 纯 Node 进程回落（MCP server / smoke 等系统 Node 场景）：与 Electron
 *     userData 指向同一目录 —— Windows 取 %APPDATA%/<应用数据目录名>，
 *     非 Windows 取 ~/.config/<应用数据目录名>。应用数据目录名取 package.json
 *     的 productName（缺省 name），与 Electron app.getName() 的推导规则一致；
 *  4. 极端兜底（环境变量缺失 / package.json 不可读）：<项目根>/data。
 *
 * 第 3 级是 MCP 集成的关键前置：MCP Server 是独立 Node 进程（stdio transport），
 * 不依赖 Electron 运行；若回落到项目内 data 会打开另一个空库。对齐后 MCP 与
 * Electron 主进程共享同一 SQLite 文件（WAL + busy_timeout=5000，docs/08 §2）。
 *
 * 项目根经 import.meta.url 向上查找 package.json 定位，不依赖 cwd。
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const nodeRequire = createRequire(import.meta.url)

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

let cachedProjectRoot: string | null = null

/** 从本模块位置向上查找最近的 package.json 所在目录，即项目根（与 cwd 无关）。 */
export function getProjectRoot(): string {
  if (cachedProjectRoot !== null) return cachedProjectRoot
  let dir = MODULE_DIR
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      cachedProjectRoot = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 兜底：找不到 package.json 时退回模块所在目录
  cachedProjectRoot = MODULE_DIR
  return cachedProjectRoot
}

/** Electron main 里的 app 对象形态（仅在运行时鸭子类型检测）。 */
interface ElectronAppLike {
  app?: {
    getPath?: (name: string) => string
  }
}

interface PackageJsonLike {
  name?: unknown
  productName?: unknown
}

/**
 * 应用数据目录名（Electron userData 的 basename）：productName 优先，缺省 name，
 * 与 Electron app.getName() 的推导规则一致；均不可用时回退 'devhub'。
 */
function resolveAppDataDirName(): string {
  try {
    const pkg = nodeRequire(join(getProjectRoot(), 'package.json')) as PackageJsonLike
    const productName = typeof pkg.productName === 'string' && pkg.productName.length > 0 ? pkg.productName : undefined
    const name = typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : undefined
    const resolved = productName ?? name
    if (resolved !== undefined) return resolved
  } catch {
    // package.json 不可读（极端打包形态）时走字面量回退
  }
  return 'devhub'
}

/**
 * 第 3 级回落：纯 Node 进程下与 Electron userData 同目录。
 * Windows：%APPDATA%/<应用数据目录名>；非 Windows：~/.config/<应用数据目录名>。
 * 环境变量不可用时返回 null，交给第 4 级兜底。
 */
function resolvePlatformAppDataDir(): string | null {
  const appDirName = resolveAppDataDirName()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (typeof appData === 'string' && appData.trim().length > 0) {
      return join(appData, appDirName)
    }
    return null
  }
  return join(homedir(), '.config', appDirName)
}

function resolveHomeDir(): string {
  const override = process.env.DEVHUB_HOME
  if (typeof override === 'string' && override.trim().length > 0) {
    return resolve(override)
  }
  try {
    // 系统 Node 下 require('electron') 返回字符串（二进制路径），走不进 app 分支；
    // Electron main 下返回含 app 的 API 对象。
    const electron = nodeRequire('electron') as unknown
    if (electron !== null && typeof electron === 'object' && 'app' in electron) {
      const userPath = (electron as ElectronAppLike).app?.getPath?.('userData')
      if (typeof userPath === 'string' && userPath.length > 0) return userPath
    }
  } catch {
    // 非 Electron 环境（系统 Node / MCP server / smoke），继续第 3 级回落
  }
  const platformDir = resolvePlatformAppDataDir()
  if (platformDir !== null) return platformDir
  return join(getProjectRoot(), 'data')
}

/** 数据目录（DB 与日志的根）。 */
export function getDataDir(): string {
  return resolveHomeDir()
}

/** SQLite 数据库文件路径。 */
export function getDbPath(): string {
  return join(getDataDir(), 'devhub.db')
}

/** 日志目录：<data>/logs。 */
export function getLogDir(): string {
  return join(getDataDir(), 'logs')
}
