/**
 * permissions.ts — MCP 工具权限框架（docs/08 §9，M2 建框架、Phase B 启用分级）。
 *
 * 四级分类：READ_ONLY（放行）/ SAFE（放行，Phase B 起才出现此类 tool）/
 * CONFIRM_REQUIRED（本期拒绝并说明 Phase B 待启用）/ BLOCKED（直接拒绝）。
 *
 * - 分类表静态覆盖 docs/08 §6 的 12 个 tool + docs/09 §10 追加的 4 个只读
 *   tool（skills.list / versions.list / archives.list / docker.images），全 READ_ONLY；
 * - 表外名称一律拒绝（等价 BLOCKED，防注册漂移，docs/08 §9.2）；
 * - server.ts 的 safeHandler 在一切业务逻辑之前调用 assertPermission(toolName)；
 * - registerPermission / unregisterPermission 是 Phase B action tool 的注册接口
 *   （具名、最小授权、可枚举；docs/08 §9.4 红线：永不提供 execute_command 类万能接口）。
 */

import { ServiceError } from '../services/internal.ts'

/** 权限四级（字符串字面量 union）。 */
export type Permission = 'READ_ONLY' | 'SAFE' | 'CONFIRM_REQUIRED' | 'BLOCKED'

/** M2 权限分类表：docs/08 §6 的 12 个 tool + docs/09 §10 的 4 个只读扩展，值全为 READ_ONLY。 */
export const TOOL_PERMISSIONS: Record<string, Permission> = {
  'devhub.environment.detect': 'READ_ONLY',
  'devhub.environment.doctor': 'READ_ONLY',
  'devhub.projects.list': 'READ_ONLY',
  'devhub.projects.get': 'READ_ONLY',
  'devhub.services.list': 'READ_ONLY',
  'devhub.services.inspect': 'READ_ONLY',
  'devhub.docker.status': 'READ_ONLY',
  'devhub.docker.containers': 'READ_ONLY',
  'devhub.docker.images': 'READ_ONLY',
  'devhub.wsl.status': 'READ_ONLY',
  'devhub.wsl.distributions': 'READ_ONLY',
  'devhub.git.status': 'READ_ONLY',
  'devhub.dashboard.summary': 'READ_ONLY',
  'devhub.skills.list': 'READ_ONLY',
  'devhub.versions.list': 'READ_ONLY',
  'devhub.archives.list': 'READ_ONLY',
}

/** 查询 tool 权限；表外名称 → BLOCKED（docs/08 §9.2）。 */
export function permissionFor(toolName: string): Permission {
  if (!Object.hasOwn(TOOL_PERMISSIONS, toolName)) return 'BLOCKED'
  return TOOL_PERMISSIONS[toolName]
}

/**
 * dispatch 前统一校验（safeHandler 的首个动作，先于 zod 之外的一切业务逻辑）：
 * - READ_ONLY / SAFE → 放行；
 * - CONFIRM_REQUIRED → 拒绝（结构化 CONFIRM_REQUIRED 错误，说明 Phase B 待启用）；
 * - BLOCKED / 表外 → 结构化 PERMISSION_DENIED 错误。
 */
export function assertPermission(toolName: string): void {
  const level = permissionFor(toolName)
  if (level === 'READ_ONLY' || level === 'SAFE') return
  if (level === 'CONFIRM_REQUIRED') {
    throw new ServiceError(
      'CONFIRM_REQUIRED',
      `tool "${toolName}" requires user confirmation — the confirmation flow is a Phase B capability and is not enabled yet`,
    )
  }
  throw new ServiceError('PERMISSION_DENIED', `tool "${toolName}" is not allowed (not in the READ_ONLY tool registry)`)
}

/**
 * Phase B 预留：注册一个 action tool 的权限级别（具名、可枚举）。
 * 仅影响 assertPermission 的判定；本表 16 个 READ_ONLY tool 不经此入口。
 */
export function registerPermission(toolName: string, level: Permission): void {
  TOOL_PERMISSIONS[toolName] = level
}

/** Phase B 预留：移除注册（smoke 测试的清理也走这里）。 */
export function unregisterPermission(toolName: string): void {
  delete TOOL_PERMISSIONS[toolName]
}
