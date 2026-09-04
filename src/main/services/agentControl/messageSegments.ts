/**
 * messageSegments.ts — R1 消息分段投影 + R8 引用 URI 标签化（ux 整改批 A）。
 *
 * 纯函数模块（electron-free、零 IO、零 DB），smoke 可直载断言。
 *
 * R1 红线：分段只在转录源有明确结构时产生（provider 把各自转录的消息类型映射为
 * RawSegmentBlock——zcode part.type reasoning/tool/text、claude content[].type
 * thinking/tool_use/text、kimi part.type think/text 等实测结构）；无结构时 provider
 * 不构造 blocks → buildSegments 返回 undefined → 投影整段 contentRedacted，绝不猜。
 *
 * R8：text/thinking 段内容中 `plugin://`、`skill://`、`mcp://` 三类引用替换为
 * 「[插件] 名称」式短标签（markdown 链接形态 [label](uri) 保留 label、裸 URI 保留
 * authority 原文，绝不裁剪语义）；原始 URI 只保留在 contentRedacted 兼容字段
 * （segments 是展示路径，绝不出原始 URI）。http/https/ws/file 等其余 scheme 一律
 * 不动；替换在 redactText 之后（两模式互不干扰）。
 *
 * 安全：段内容一律过 redactText（redact.ts 全覆盖红线）并逐段截断；总数封顶
 * （MAX_SEGMENTS_PER_MESSAGE）防单消息膨胀。
 */

import { redactText } from './redact.ts'
import type { AgentMessageSegment } from '../../../shared/types.ts'

/** R8 标签化白名单 scheme → 展示前缀（绝无 http/https/ws/file 等其余 scheme）。 */
export const SEGMENT_URI_LABELS: Readonly<Record<string, string>> = {
  plugin: '插件',
  skill: '技能',
  mcp: 'MCP',
} as const

/** 单条消息分段总数上限（防御性封顶；超出丢弃剩余段，绝不无限膨胀）。 */
export const MAX_SEGMENTS_PER_MESSAGE = 32

/** provider 侧原始结构块（未脱敏；由各 provider 从转录结构显式映射）。 */
export interface RawSegmentBlock {
  kind: AgentMessageSegment['kind']
  /** 结构化标签（如 toolInvocation 的工具名；原样透传，调用方保证无凭据）。 */
  label?: string
  /** 原文（未脱敏；本模块统一 redactText）。 */
  content: string
}

/**
 * R8：段内容展示文本的引用 URI 标签化。
 * 1. markdown 链接形态 `[label](scheme://...)`（含 `\[...\]\(...\)` 转义形态）
 *    → `[前缀] label`（label 原文保留）；
 * 2. 裸形态 `scheme://authority` → `[前缀] authority`（authority 原文保留到空白/
 *    引号/反括号等终止符，绝不裁剪）。
 * 仅处理 plugin/skill/mcp 三 scheme；其余（http/ws/file/...）零改动。
 */
export function labelReferenceUris(text: string): string {
  const schemes = Object.keys(SEGMENT_URI_LABELS)
  // 1) markdown 链接形态（容忍 \[ \] \( \) 转义）
  const linkPattern = new RegExp(
    `\\\\?\\[([^\\]\\n]{1,200})\\\\?\\]\\\\?\\((${schemes.join('|')})://[^)\\s]+\\\\?\\)`,
    'g',
  )
  let out = text.replace(linkPattern, (_m, label: string, scheme: string) => `[${SEGMENT_URI_LABELS[scheme]}] ${label}`)
  // 2) 裸 URI 形态（authority 到空白/引号/反引号/右括号/方括号/反斜杠终止）
  const barePattern = new RegExp(`(${schemes.join('|')})://[^\\s)"'` + '`' + `\\\\]+`, 'g')
  out = out.replace(barePattern, (uri: string) => {
    const scheme = uri.slice(0, uri.indexOf('://'))
    const authority = uri.slice(scheme.length + 3)
    return `[${SEGMENT_URI_LABELS[scheme]}] ${authority}`
  })
  return out
}

/** 单段内容长度上限（与消息正文投影同量级；调用方传入 provider 的 messageTextCap）。 */
function clampContent(content: string, textCap: number): string {
  return content.length > textCap ? content.slice(0, textCap) : content
}

/**
 * R1：原始结构块 → 展示分段（每段 redactText + R8 标签化 + 截断；空段丢弃；
 * 总数封顶）。无任何有效段 → undefined（投影整段 text，绝不造空分段冒充结构）。
 */
export function buildSegments(blocks: readonly RawSegmentBlock[], textCap: number): AgentMessageSegment[] | undefined {
  const segments: AgentMessageSegment[] = []
  for (const block of blocks) {
    if (segments.length >= MAX_SEGMENTS_PER_MESSAGE) break
    if (block.kind !== 'text' && block.kind !== 'thinking' && block.kind !== 'toolInvocation') continue
    const redacted = redactText(block.content)
    if (redacted.trim().length === 0) continue
    const content = clampContent(labelReferenceUris(redacted), textCap)
    if (content.trim().length === 0) continue
    segments.push({
      kind: block.kind,
      ...(block.label !== undefined && block.label.length > 0 ? { label: block.label } : {}),
      content,
    })
  }
  return segments.length > 0 ? segments : undefined
}

/** segments_json 解析（库值损坏/形态不符 → undefined，宁缺毋滥绝不猜）。 */
export function parseSegmentsJson(json: string | null): AgentMessageSegment[] | undefined {
  if (json === null || json.trim().length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return undefined
    const segments: AgentMessageSegment[] = []
    for (const item of parsed) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
      const seg = item as { kind?: unknown; label?: unknown; content?: unknown }
      if (seg.kind !== 'text' && seg.kind !== 'thinking' && seg.kind !== 'toolInvocation') return undefined
      if (typeof seg.content !== 'string') return undefined
      segments.push({
        kind: seg.kind,
        ...(typeof seg.label === 'string' && seg.label.length > 0 ? { label: seg.label } : {}),
        content: seg.content,
      })
    }
    return segments.length > 0 ? segments : undefined
  } catch {
    return undefined
  }
}
