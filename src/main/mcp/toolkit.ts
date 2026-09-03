/**
 * toolkit.ts — MCP tool / resource / prompt 定义的共享形态与构造助手（docs/08 §5-§8）。
 *
 * - defineTool：入参 raw shape 统一包成 zod `.strict()` 对象（拒绝未知键，docs/08 §10.1），
 *   handler 收到解析后的强类型 args；run 内部再 safeParse 一次属防御纵深
 *   （SDK 先行校验，正常情况下不会触发）；
 * - defineNoArgTool：零入参 tool 不注册 inputSchema（SDK 对 tools/list 输出
 *   空 object schema；arguments 缺省时不会误报校验错误）；
 * - ResourceDefinition / PromptDefinition：server.ts 对传输零感知地集中注册。
 */

import { z } from 'zod'

/** tool handler 的统一出参：data 进 structuredContent，summary 为人类可读文本。 */
export interface ToolResult {
  data: unknown
  summary: string
}

export interface ToolDefinition {
  name: string
  description: string
  /** zod strict object schema；零入参 tool 为 undefined。 */
  schema: z.ZodType | undefined
  /** args 已由 defineTool 内部解析；no-arg 工具忽略入参。 */
  run: (args: unknown) => Promise<ToolResult>
}

/** 显式入参 tool：shape 自动包 z.strictObject（.strict() 语义，拒绝未知键）。 */
export function defineTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: { [K in keyof S]: z.output<S[K]> }) => Promise<ToolResult>,
): ToolDefinition {
  const schema = z.strictObject(shape)
  return {
    name,
    description,
    schema,
    run: (raw: unknown) => {
      const parsed = schema.parse(raw)
      return run(parsed as { [K in keyof S]: z.output<S[K]> })
    },
  }
}

/** 零入参 tool。 */
export function defineNoArgTool(name: string, description: string, run: () => Promise<ToolResult>): ToolDefinition {
  return { name, description, schema: undefined, run: () => run() }
}

/** resource 定义：URI 恒定，render 产出面向 LLM 的 Markdown（docs/08 §7）。 */
export interface ResourceDefinition {
  name: string
  uri: string
  description: string
  render: () => string | Promise<string>
}

/** prompt 定义：指令文本 + 参数模板（docs/08 §8）。 */
export interface PromptDefinition {
  name: string
  description: string
  /** MCP prompt 入参恒为字符串。 */
  argsSchema?: z.ZodRawShape
  render: (args: Record<string, string>) => string
}
