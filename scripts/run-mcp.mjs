#!/usr/bin/env node
// DevHub MCP Server 进程入口（docs/08 §3）。
//
// 纯 Node 加载 TS 源码（系统 Node ≥ 23.6 原生类型剥离，与 smoke 相同机制，
// 不引入 tsx/ts-node）：logger 切 stderr → 动态 import server.ts → stdio 启动。
//
// stdout 纪律（docs/08 §3，M2 必办）：stdio transport 下 stdout 是 JSON-RPC 专用
// 通道。本入口在加载任何业务模块之前把 logger 的 console 镜像改道 stderr
// （setConsoleStream('stderr')；logger 自身还会因 DEVHUB_MCP_STDIO=1 兜底切换），
// 因此 MCP 进程 stdout 只允许出现 JSON-RPC 帧。
//
// 环境变量：DEVHUB_HOME（可选覆盖数据目录）、DEVHUB_LOG_LEVEL（logger 阈值）。

import { setConsoleStream } from '../src/main/core/logger.ts'

setConsoleStream('stderr')
process.env.DEVHUB_MCP_STDIO = '1'

// 环境补种（M3 验收发现，docs/08 §3 env 职责）：MCP Client（SDK StdioClientTransport /
// Claude Code / ZCode 等）普遍以精简 env 启动 stdio server，往往不带 PATHEXT。
// where.exe 依赖 PATHEXT 追加扩展名匹配（node → node.exe），缺失时只按字面名匹配，
// environment.detect / doctor 的工具链探测会静默退化为大面积 missing（M3-A05 实测）。
// 与 cmd.exe 自行补默认值的行为对齐，在入口处补种一次，adapter 层零改动。
if (process.platform === 'win32' && !process.env.PATHEXT) {
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
}

const [{ createDevhubMcpServer }, { StdioTransport }] = await Promise.all([
  import('../src/main/mcp/server.ts'),
  import('../src/main/mcp/transport.ts'),
])

const server = createDevhubMcpServer()
await new StdioTransport().start(server)

// stdin 关闭（Client 断开）→ server 正常收尾 → 进程退出码 0（docs/08 §3）。
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

console.error('DevHub MCP server ready')
