/**
 * transport.ts — 传输抽象（docs/08 §11）。
 *
 * server 组装（tools/resources/prompts 注册）与传输解耦：未来 HTTP /
 * Streamable HTTP 只新增 HttpTransport 实现类与 run-mcp 的 --http 分支，
 * 不动 server.ts 的注册逻辑。transport 层不做任何业务校验（校验归 §9/§10 的
 * server 侧管线）。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** 传输抽象：server 组装（tools/resources/prompts 注册）与传输解耦。 */
export interface DevhubTransport {
  /** 建立通道、把已组装的 server 接上去，resolve 后保持运行直至通道关闭。 */
  start(server: McpServer): Promise<void>
}

/** 本期唯一实现：stdio（包 @modelcontextprotocol/sdk 的 StdioServerTransport）。 */
export class StdioTransport implements DevhubTransport {
  async start(server: McpServer): Promise<void> {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }
}
