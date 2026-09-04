/**
 * server.ts — DevHub MCP Server 组装（docs/08 §5-§11）。
 *
 * - createDevhubMcpServer(): McpServer —— 注册 16 个点分名 tools（docs/08 §6 的
 *   12 个 + docs/09 §10 的 4 个只读扩展）、6 个 devhub://* resources、4 个 prompts；
 *   对传输零感知（§11）。
 * - 每个 tool handler 经统一 wrapper（safeHandler 语义，§9.2/§10.4）：
 *     1) assertPermission（首个动作，权限先于一切业务逻辑）；
 *     2) zod strict 入参（SDK 先行校验；wrapper 内 defineTool 再 parse 一次属防御纵深）；
 *     3) try/catch 兜底 —— ServiceError → isError:true + { code, message }；
 *        ZodError → BAD_PAYLOAD；未知异常 → INTERNAL（message 无堆栈无路径细节，
 *        细节仅进日志）。单 tool 失败只影响该请求，server 进程不崩。
 * - 出参同时含 structuredContent（红线后的 JSON）与人类可读摘要文本（§10.5）。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ZodError } from 'zod'
import { errorMessage, ServiceError } from '../services/internal.ts'
import { logger as coreLogger } from '../core/logger.ts'
import { PROMPT_DEFINITIONS } from './prompts/index.ts'
import { RESOURCE_DEFINITIONS } from './resources/index.ts'
import { archiveTools } from './tools/archives.ts'
import { dashboardTools } from './tools/dashboard.ts'
import { dockerTools } from './tools/docker.ts'
import { environmentTools } from './tools/environment.ts'
import { gitTools } from './tools/git.ts'
import { projectTools } from './tools/projects.ts'
import { serviceTools } from './tools/services.ts'
import { skillTools } from './tools/skills.ts'
import { versionTools } from './tools/versions.ts'
import { wslTools } from './tools/wsl.ts'
import { assertPermission } from './permissions.ts'
import { sanitizeDeep, sanitizeFreeText, SUMMARY_TEXT_LIMIT } from './projection.ts'
import type { PromptDefinition, ResourceDefinition, ToolDefinition } from './toolkit.ts'

/** serverInfo 标识（M3-A02 验收项）。version 与 package.json 保持一致。 */
export const MCP_SERVER_NAME = 'devhub'
export const MCP_SERVER_VERSION = '0.1.0'

/** 16 个 tools（点分名）：docs/08 §6 的 12 个 + docs/09 §10 的 4 个只读扩展；注册顺序稳定（tools/list 输出确定）。 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...environmentTools,
  ...projectTools,
  ...serviceTools,
  ...dockerTools,
  ...wslTools,
  ...gitTools,
  ...dashboardTools,
  ...skillTools,
  ...versionTools,
  ...archiveTools,
]

interface TextContent {
  type: 'text'
  text: string
}

/** 结构化领域错误 → isError:true + JSON 文本帧（docs/08 §10.4/§12）。 */
function toolErrorResult(code: string, message: string): { isError: true; content: TextContent[] } {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message: sanitizeFreeText(message) ?? '' }) }],
  }
}

function toolErrorFrom(toolName: string, err: unknown): { isError: true; content: TextContent[] } {
  if (err instanceof ServiceError) {
    coreLogger.warn(`mcp tool ${toolName} failed: ${err.code}: ${err.message}`)
    return toolErrorResult(err.code, err.message)
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0]
    const detail = issue !== undefined ? `${issue.path.join('.')}: ${issue.message}` : 'invalid arguments'
    coreLogger.warn(`mcp tool ${toolName} rejected payload: ${detail}`)
    return toolErrorResult('BAD_PAYLOAD', `invalid arguments for ${toolName}: ${detail}`)
  }
  coreLogger.error(`mcp tool ${toolName} unexpected error: ${errorMessage(err)}`)
  return toolErrorResult('INTERNAL', 'unexpected internal error while executing the tool')
}

function registerDevhubTool(server: McpServer, def: ToolDefinition): void {
  // inputSchema 缺省仅用于零入参 tool（SDK 对 tools/list 输出空 object schema）；
  // 有参 tool 必须显式注册 zod strict schema，SDK 才会先行校验（docs/08 §10.1）。
  const config = {
    description: def.description,
    ...(def.schema !== undefined ? { inputSchema: def.schema } : {}),
  }
  server.registerTool(def.name, config, async (raw: unknown) => {
    try {
      assertPermission(def.name)
      const { data, summary } = await def.run(raw)
      const safe = sanitizeDeep(data)
      return {
        content: [{ type: 'text', text: sanitizeFreeText(summary, SUMMARY_TEXT_LIMIT) ?? '' }],
        structuredContent: safe as { [key: string]: unknown },
      }
    } catch (err) {
      return toolErrorFrom(def.name, err)
    }
  })
}

function registerDevhubResource(server: McpServer, def: ResourceDefinition): void {
  server.registerResource(def.name, def.uri, { description: def.description, mimeType: 'text/markdown' }, async (uri) => {
    let text: string
    try {
      text = await def.render()
    } catch (err) {
      coreLogger.warn(`mcp resource ${def.uri} render failed: ${errorMessage(err)}`)
      text = `# DevHub ${def.name}\n\n[ERROR] failed to render this resource — details are in the DevHub server log.`
    }
    return { contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text }] }
  })
}

function registerDevhubPrompt(server: McpServer, def: PromptDefinition): void {
  const config = {
    description: def.description,
    ...(def.argsSchema !== undefined ? { argsSchema: def.argsSchema } : {}),
  }
  server.registerPrompt(def.name, config, async (args: unknown) => {
    const rendered = def.render((args ?? {}) as Record<string, string>)
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text: rendered } }] }
  })
}

/** 组装 DevHub MCP Server：16 tools + 6 resources + 4 prompts，权限管线就位。 */
export function createDevhubMcpServer(): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION })
  for (const def of TOOL_DEFINITIONS) registerDevhubTool(server, def)
  for (const def of RESOURCE_DEFINITIONS) registerDevhubResource(server, def)
  for (const def of PROMPT_DEFINITIONS) registerDevhubPrompt(server, def)
  return server
}
