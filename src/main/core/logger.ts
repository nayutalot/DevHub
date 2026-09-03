/**
 * logger.ts — 分级日志（docs/02 §1，约束 #13）。
 *
 * 整行写入 <logDir>/devhub.log 并镜像到 console（文件日志行为恒定）。
 *
 * console 镜像分流（docs/08 §3 stdout 纪律，M2 必办）：
 *  - 默认行为不变：info/debug → console.log（stdout），warn/error → console.error；
 *  - `setConsoleStream('stderr')` 后全部级别改走 console.error —— stdio transport
 *    下 stdout 是 JSON-RPC 专用通道，MCP 进程（run-mcp.mjs）启动时立即切换，
 *    违反会直接损坏协议流；
 *  - 兜底：环境变量 DEVHUB_MCP_STDIO=1 时模块加载即切 stderr（双保险），
 *    Electron 主进程 / smoke 不受影响（不设该变量）。
 *
 * 脱敏（密钥 / token / 敏感路径截断）在后续 Step 记录敏感命令行时补充。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getLogDir } from './paths.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** console 镜像的目标流：'stdout' = 默认可读行为；'stderr' = MCP stdio 模式。 */
export type ConsoleStream = 'stdout' | 'stderr'

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

let consoleStream: ConsoleStream = process.env.DEVHUB_MCP_STDIO === '1' ? 'stderr' : 'stdout'

/**
 * 切换 console 镜像流。MCP 进程入口（scripts/run-mcp.mjs）启动时第一时间调用
 * `setConsoleStream('stderr')`；其余进程不调用，保持默认行为不变。
 */
export function setConsoleStream(target: ConsoleStream): void {
  consoleStream = target
}

/** 当前 console 镜像流（stdout 纯净性审计 / 测试用）。 */
export function getConsoleStream(): ConsoleStream {
  return consoleStream
}

function threshold(): number {
  const raw = process.env.DEVHUB_LOG_LEVEL
  if (typeof raw === 'string' && raw in LEVEL_WEIGHT) {
    return LEVEL_WEIGHT[raw as LogLevel]
  }
  return LEVEL_WEIGHT.info
}

function write(level: LogLevel, message: string): void {
  if (LEVEL_WEIGHT[level] < threshold()) return
  const line = `${new Date().toISOString()} [${level.toUpperCase().padEnd(5)}] ${message}`
  if (consoleStream === 'stderr' || level === 'warn' || level === 'error') {
    console.error(line)
  } else {
    console.log(line)
  }
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'devhub.log'), `${line}\n`, 'utf8')
  } catch {
    // 日志系统故障不得影响业务流程
  }
}

export const logger = {
  debug(message: string): void {
    write('debug', message)
  },
  info(message: string): void {
    write('info', message)
  },
  warn(message: string): void {
    write('warn', message)
  },
  error(message: string): void {
    write('error', message)
  },
}
