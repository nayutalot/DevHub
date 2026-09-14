/**
 * hostLegRequests.ts — host 腿只读投影请求处理器（M3-C7b 修 ①，docs/18 §7.1 G5）。
 *
 * 缺口（C2d 实证，任务书 §1 #1）：relayClient routeFrame 自 git 全史以来无
 * agent_list/session_list/message 三分支 → App 经 Relay 的 REST 数据面请求
 * （/v1/agents、/v1/sessions、/v1/sessions/{id}/messages 的帧承载，docs/18 §7.1）
 * 全部 10s 超时。协议面 docs/18 §3.4/§3.5/§3.7 早已冻结（fixture #4/#5/#7），
 * 纯实现缺口，本模块补齐。
 *
 * 语义对齐本地 REST 面（gateway/httpServer.ts 同款投影，docs/14 §B.1 逐字段）：
 * - agent_list  → listAgentProviders + REST /v1/agents 四字段投影
 *                 （id/displayName/health/capabilities，绝不附带 exePath 等本机面）；
 * - session_list→ listAgentSessions（query 语义 = REST：providerId/status/limit/
 *                 parentId/includeArchived；providerId 受理数字 id 或业务键——
 *                 docs/14 §B.1 POST providers 先例的读镜像）；响应 stale 恒 false
 *                 （host 在线应答为真值；stale:true 仅 ECS 缓存降级时由 ECS 改写）；
 * - message     → listAgentMessages（after/last/before 互斥由 L3 结构化拒绝，
 *                 ux A R10 同参）；items 投影 = REST messages 同款
 *                 （contentRedacted + 可选 segments/occurredAt；**绝无 sourceRef**，
 *                 本地源指针不出本机，docs/15 §6）。
 *
 * 鉴权（任务书 §1 #1 裁决）：只读投影类请求，鉴权沿用 host 腿已建立的信任——
 * upgrade 时 Relay 凭据（docs/18 §2 host leg 行）已认证该连接，ECS 按连接态转发，
 * 帧级不再携带设备凭据（docs/18 §7.4「ECS 中继不重放鉴权头」同语义）；写面命令
 * 的端到端校验仍归 commandDownlink（docs/18 §3.8），两面互不影响。
 *
 * 绝不抛（逐帧隔离纪律）：结构校验失败 → error BAD_PAYLOAD；业务失败（NOT_FOUND/
 * BAD_PAYLOAD 互斥等）→ ServiceError 原码 error 帧；其余 → INTERNAL。零凭据
 * 零堆栈（约束 #14）。响应帧 requestId 原样回显（R2 裁定④客户端契约）。
 *
 * electron-free；只读 L3 投影（listAgentProviders/listAgentSessions/
 * listAgentMessages/resolveAgentProviderRef 读豁免，约束 #20）。
 */

import {
  AGENT_LIST_LIMIT_MAX,
  AGENT_SESSION_STATUSES,
  listAgentMessages,
  listAgentProviders,
  listAgentSessions,
  readProviderCapabilitySet,
  resolveAgentProviderRef,
  type AgentMessagesQuery,
  type AgentSessionsFilter,
} from '../agentControlService.ts'
import { ServiceError } from '../../internal.ts'
import type { HostToEcsFrame } from './wsClient.ts'

// ---------------------------------------------------------------------------
// 宿主接口（relayClient/index.ts wireSeams 构造并经 Safe 包装显式传参；
// smoke 可自建捕获数组宿主直调处理器）
// ---------------------------------------------------------------------------

/** host 腿只读投影请求宿主接口（H→E 帧出口）。 */
export interface HostLegRequestHost {
  /** 发送 agent_list 响应帧（docs/18 §3.4 H→E）。 */
  sendAgentList(frame: HostToEcsFrame): boolean
  /** 发送 session_list 响应帧（docs/18 §3.5 H→E）。 */
  sendSessionList(frame: HostToEcsFrame): boolean
  /** 发送 message 响应帧（docs/18 §3.7 H→E）。 */
  sendMessage(frame: HostToEcsFrame): boolean
  /** 发送 error 帧（结构/业务校验失败，docs/18 §3.16）。 */
  sendError(frame: HostToEcsFrame): boolean
}

// ---------------------------------------------------------------------------
// 处理器（routeFrame 三分支入口；宿主由 relayClient/index.ts wireSeams 注入并经
// Safe 包装显式传参；单帧异常绝不杀伤连接——调用方逐帧隔离）
// ---------------------------------------------------------------------------

/** agent_list（docs/18 §3.4 E→H）：provider 列表只读投影。 */
export function handleAgentListFrame(frame: unknown, host: HostLegRequestHost): void {
  const requestId = requestIdOf(frame)
  if (requestId === null) {
    host.sendError(errorFrame(frameRequestId(frame), 'BAD_PAYLOAD', 'agent_list.requestId must be a non-empty string (docs/18 §3.4)'))
    return
  }
  // docs/18 §7.1：/v1/agents 中继为 agent_list 帧 → host 原样回传（REST 四字段投影）
  void listAgentProviders()
    .then(({ providers }) => {
      host.sendAgentList({
        type: 'agent_list',
        requestId,
        providers: providers.map(
          (p) =>
            ({ id: p.id, displayName: p.displayName, health: p.health, capabilities: p.capabilities }) as Record<string, unknown>,
        ),
      })
    })
    .catch((err: unknown) => {
      host.sendError(errorFrame(requestId, errorCodeOf(err), errorMessageOf(err)))
    })
}

/** session_list（docs/18 §3.5 E→H）：会话列表只读投影（query 语义 = REST GET /v1/sessions）。 */
export function handleSessionListFrame(frame: unknown, host: HostLegRequestHost): void {
  const requestId = requestIdOf(frame)
  if (requestId === null) {
    host.sendError(errorFrame(frameRequestId(frame), 'BAD_PAYLOAD', 'session_list.requestId must be a non-empty string (docs/18 §3.5)'))
    return
  }
  try {
    const filter = parseSessionQuery(isObject(frame) ? frame.query : undefined)
    const result = listAgentSessions(filter)
    // RD-mobile-chat run2 投影缺口修复：ECS GET /v1/sessions/{id} 复用本帧承载
    // detail（docs/18 §7 rest.ts：取 sessions[0] + field(response,'capabilities')
    // ?? null），而本帧此前不带该 query/字段 → ECS 恒答 capabilities:null → App
    // 空能力缺省（ControlGate.reply 恒 false）→ relay 模式详情页回复输入门恒死。
    // query.sessionId 在场 = detail 语义：按 id 收窄（消除 sessions[0] 碰巧命中
    // 最新会话的脆弱依赖）+ 附该会话 provider 能力投影（与本地 REST detail 同源
    // 语义，docs/12 §5）；纯列表查询（无 sessionId）路径行为逐字节不变。
    const rawQuery = isObject(frame) ? frame.query : undefined
    const detailId = isObject(rawQuery) ? rawQuery['sessionId'] : undefined
    const sessions =
      typeof detailId === 'number' && Number.isSafeInteger(detailId) && detailId > 0
        ? result.sessions.filter((s) => s.id === detailId)
        : result.sessions
    const firstSession =
      typeof detailId === 'number' && Number.isSafeInteger(detailId) && detailId > 0
        ? result.sessions.find((s) => s.id === detailId)
        : undefined
    const caps =
      firstSession !== undefined && firstSession.providerKey !== undefined
        ? readProviderCapabilitySet(firstSession.providerKey)
        : null
    host.sendSessionList({
      type: 'session_list',
      requestId,
      stale: false,
      // SessionView 投影对象 → 协议 JSON 形态（无字段增删，docs/14 §B.1 原样内嵌）
      sessions: sessions.map((s) => ({ ...s }) as Record<string, unknown>),
      ...(caps !== null ? { capabilities: caps as unknown as Record<string, unknown> } : {}),
    })
  } catch (err) {
    host.sendError(errorFrame(requestId, errorCodeOf(err), errorMessageOf(err)))
  }
}

/** message（docs/18 §3.7 E→H）：消息分页只读投影（取数语义 = REST messages，R10 同参）。 */
export function handleMessageFrame(frame: unknown, host: HostLegRequestHost): void {
  const requestId = requestIdOf(frame)
  if (requestId === null) {
    host.sendError(errorFrame(frameRequestId(frame), 'BAD_PAYLOAD', 'message.requestId must be a non-empty string (docs/18 §3.7)'))
    return
  }
  const f = isObject(frame) ? frame : {}
  const sessionId = f.sessionId
  if (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
    host.sendError(errorFrame(requestId, 'BAD_PAYLOAD', 'message.sessionId must be a positive integer (docs/18 §3.7)'))
    return
  }
  try {
    const query = parseMessageQuery(f)
    const page = listAgentMessages(query)
    host.sendMessage({
      type: 'message',
      requestId,
      // REST messages 投影（httpServer 同款映射）：contentRedacted + 可选
      // occurredAt/segments；绝无 sourceRef（本地源指针不出本机，docs/15 §6）
      items: page.items.map((m) => {
        const projection: Record<string, unknown> = { id: m.id, role: m.role, contentRedacted: m.contentRedacted }
        if (m.occurredAt !== undefined) projection['occurredAt'] = m.occurredAt
        if (m.segments !== undefined) projection['segments'] = m.segments
        return projection
      }),
      ...(page.prevAfter !== undefined ? { prevAfter: page.prevAfter } : {}),
    })
  } catch (err) {
    host.sendError(errorFrame(requestId, errorCodeOf(err), errorMessageOf(err)))
  }
}

// ---------------------------------------------------------------------------
// query 解析（严格校验，违例 → ServiceError BAD_PAYLOAD——httpServer 同纪律）
// ---------------------------------------------------------------------------

/** session_list.query → L3 filter（缺字段 = REST 缺省语义；未知形态绝不猜）。 */
function parseSessionQuery(raw: unknown): AgentSessionsFilter {
  if (raw === undefined) return {}
  if (!isObject(raw)) {
    throw new ServiceError('BAD_PAYLOAD', 'session_list.query must be an object (docs/18 §3.5)')
  }
  const filter: AgentSessionsFilter = {}
  const providerId = raw['providerId']
  if (providerId !== undefined) {
    if (typeof providerId === 'number') {
      if (!Number.isSafeInteger(providerId) || providerId <= 0) {
        throw new ServiceError('BAD_PAYLOAD', 'session_list.query.providerId must be a positive integer')
      }
      filter.providerId = providerId
    } else if (typeof providerId === 'string') {
      // 业务键形态（fixture #5 样本 'codex'；docs/14 §B.1「数字 id 或业务键」先例）：
      // 未知引用 → NOT_FOUND（绝不猜空结果）
      if (providerId.length === 0 || providerId.length > 64) {
        throw new ServiceError('BAD_PAYLOAD', 'session_list.query.providerId business key must be 1..64 chars')
      }
      const resolved = resolveAgentProviderRef(providerId)
      if (resolved === null) {
        throw new ServiceError('NOT_FOUND', `session_list: provider "${providerId}" not found`)
      }
      filter.providerId = resolved
    } else {
      throw new ServiceError('BAD_PAYLOAD', 'session_list.query.providerId must be a positive integer or a provider business key')
    }
  }
  const status = raw['status']
  if (status !== undefined) {
    if (typeof status !== 'string' || !(AGENT_SESSION_STATUSES as readonly string[]).includes(status)) {
      throw new ServiceError('BAD_PAYLOAD', `session_list.query.status must be one of: ${AGENT_SESSION_STATUSES.join(' | ')}`)
    }
    filter.status = status as AgentSessionsFilter['status']
  }
  const limit = raw['limit']
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new ServiceError('BAD_PAYLOAD', 'session_list.query.limit must be a positive integer')
    }
    if (limit > AGENT_LIST_LIMIT_MAX) {
      throw new ServiceError('BAD_PAYLOAD', `session_list.query.limit must be ≤ ${AGENT_LIST_LIMIT_MAX}`)
    }
    filter.limit = limit
  }
  const parentId = raw['parentId']
  if (parentId !== undefined) {
    if (typeof parentId !== 'number' || !Number.isSafeInteger(parentId) || parentId <= 0) {
      throw new ServiceError('BAD_PAYLOAD', 'session_list.query.parentId must be a positive integer')
    }
    filter.parentId = parentId
  }
  const includeArchived = raw['includeArchived']
  if (includeArchived !== undefined) {
    // 帧面 JSON 自然形态 = 布尔（REST query '1'/'true' 的帧面等价，ux A R3 同语义）
    if (typeof includeArchived !== 'boolean') {
      throw new ServiceError('BAD_PAYLOAD', 'session_list.query.includeArchived must be a boolean')
    }
    filter.includeArchived = includeArchived
  }
  return filter
}

/** message 帧取数字段 → L3 query（last 封顶对齐 REST Math.min；互斥由 L3 结构化拒绝）。 */
function parseMessageQuery(frame: Record<string, unknown>): AgentMessagesQuery {
  const query: AgentMessagesQuery = { sessionId: frame['sessionId'] as number }
  const after = frame['after']
  if (after !== undefined) {
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after <= 0) {
      throw new ServiceError('BAD_PAYLOAD', 'message.after must be a positive integer (docs/14 §B.1)')
    }
    query.after = after
  }
  const before = frame['before']
  if (before !== undefined) {
    if (typeof before !== 'number' || !Number.isSafeInteger(before) || before <= 0) {
      throw new ServiceError('BAD_PAYLOAD', 'message.before must be a positive integer (docs/14 §B.1 / ux A R10)')
    }
    query.before = before
  }
  const last = frame['last']
  if (last !== undefined) {
    if (typeof last !== 'number' || !Number.isSafeInteger(last) || last <= 0) {
      throw new ServiceError('BAD_PAYLOAD', 'message.last must be a positive integer (docs/14 §B.1 / ux A R10)')
    }
    // REST 同款封顶（httpServer：last = Math.min(lastRaw, AGENT_LIST_LIMIT_MAX)）
    query.last = Math.min(last, AGENT_LIST_LIMIT_MAX)
  }
  const limit = frame['limit']
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new ServiceError('BAD_PAYLOAD', 'message.limit must be a positive integer (docs/14 §B.1)')
    }
    if (limit > AGENT_LIST_LIMIT_MAX) {
      throw new ServiceError('BAD_PAYLOAD', `message.limit must be ≤ ${AGENT_LIST_LIMIT_MAX}`)
    }
    query.limit = limit
  }
  return query
}

// ---------------------------------------------------------------------------
// 窄化/折叠助手（commandDownlink 同款）
// ---------------------------------------------------------------------------

/** 帧 requestId 提取（非空字符串 → 原样；其余 → null）。 */
function requestIdOf(frame: unknown): string | null {
  const value = isObject(frame) ? frame['requestId'] : undefined
  return typeof value === 'string' && value.length > 0 ? value : null
}

function frameRequestId(frame: unknown): string | undefined {
  const value = isObject(frame) ? frame['requestId'] : undefined
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 结构化 error 帧（协议级 BAD_PAYLOAD / 业务原码；零凭据零堆栈）。 */
function errorFrame(requestId: string | undefined, code: string, message: string): HostToEcsFrame {
  return {
    type: 'error',
    ...(requestId !== undefined ? { requestId } : {}),
    code,
    message,
  }
}

function errorCodeOf(err: unknown): string {
  return err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'host leg projection failed'
}

/** 窄化助手（frame 形态校验专用）。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
