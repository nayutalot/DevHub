/**
 * localCommand.ts — 本地网关命令下行（X-L 批，docs/18 §5.3.2）。
 *
 * 背景（U4 实证 + Z3 结论 B）：本地网关 ws.ts 对未知帧型静默忽略 → App 侧
 * workspace_link 帧永无回程 → T1 卡结构性恒 Queued。本模块为 ws.ts 的 `command`
 * 帧路由：受理 → 与 relay 面同一 L3 台账（beginWorkspaceLink /
 * completeWorkspaceLink）→ zcodeLinkProvider 磁盘三文件重建 → ack/result 帧。
 *
 * 协议（docs/18 §5.3.2；docs/14 §B.2 ndjson 最小扩展，零新 REST）：
 * - 请求（App → 网关）：{ type:'command', requestId?, idempotencyKey,
 *   action:'workspace_link', payload:{} }——零 auth 块（连接 upgrade 时已
 *   Bearer 鉴权，connection.deviceId 即发起设备；§3.8 内嵌 auth 是 relay 腿
 *   防重放构造，本地回环不照搬）；
 * - 受理：{ type:'command_ack', requestId?, idempotencyKey, commandId,
 *   status:'accepted' | 'rejected', errorCode? }（§3.9 同域语义）；
 * - 终态：{ type:'command_result', requestId?, commandId, idempotencyKey,
 *   action:'workspace_link', status:'executed'|'failed', errorCode,
 *   result?, timestamp }（§3.10 同域语义；result 仅 executed 携带，URL 帧面
 *   内存过境）；
 * - 结构化拒绝：幂等键缺失 / action 非 workspace_link（本地面 v1 唯一命令值）/
 *   sessionId 非法 / payload 形态非法 → command_ack{rejected,'BAD_PAYLOAD'}
 *   ——绝不再静默忽略（U4 根因反例）；未知 type 帧仍静默（ws.ts 现状保持）。
 *
 * 红线（docs/18 §5.3.2，任务书 §0）：
 * - 令牌三零：URL 及其任何子串（sid/hash/mid）零日志零落库零审计——
 *   result_json/审计只记 {provider}（completeWorkspaceLink 保证）；本模块
 *   绝不把 URL 写进任何日志/错误帧；失败 reason 只用 provider 静态字面量；
 * - 链来源 = 桌面磁盘三文件重建（与 relay 同源），绝不伪造、绝不 fabricate；
 * - 审计 source = 'local-gateway'（relay 面缺省 'relay-command' 原文零变化）；
 * - 事件/执行零夹带：token_rotation/event 帧与本命令面零交集。
 *
 * electron-free；异常折叠为结构化帧（单帧异常绝不杀伤连接——ws.ts 逐帧隔离
 * 之外，本模块自行兜底执行段异常 → command_result failed INTERNAL，绝不假成功）。
 */

import type { GatewayWsConnection } from './ws.ts'
import { beginWorkspaceLink, completeWorkspaceLink } from '../agentControlService.ts'
import { buildZcodeWorkspaceLinkDefault, ZCODE_LINK_UNAVAILABLE } from '../zcodeLinkProvider.ts'

/** 本地面支持的命令 action 全集（v1 唯一值；封闭枚举纪律同 N-R3）。 */
export const LOCAL_COMMAND_ACTIONS: readonly string[] = ['workspace_link']

/**
 * `command` 帧处理（ws.ts hooks.onText 路由入口）。绝不抛：所有失败折叠为
 * command_ack{rejected} / command_result{failed} 结构化回声（业务级错误不断连）。
 */
export function handleLocalCommand(connection: GatewayWsConnection, frame: unknown): void {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return
  const obj = frame as Record<string, unknown>
  // requestId 回声（可选；缺省/非法 → 不带，绝不伪造）
  const reqId = obj.requestId
  const echo = typeof reqId === 'string' && reqId.length > 0 ? { requestId: reqId } : {}

  // 1) 结构校验（docs/18 §5.3.2）：幂等键必为非空字符串——缺失时设备无从关联，
  //    仍回 rejected ack（requestId 回声）供诊断，绝不让帧无声消失
  const idempotencyKey = obj.idempotencyKey
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    connection.sendFrame({ type: 'command_ack', ...echo, status: 'rejected', errorCode: 'BAD_PAYLOAD' })
    return
  }
  const action = obj.action
  if (typeof action !== 'string' || !(LOCAL_COMMAND_ACTIONS as readonly string[]).includes(action)) {
    rejectAck(connection, echo, idempotencyKey, 'BAD_PAYLOAD')
    return
  }
  const sessionId = obj.sessionId
  // workspace_link 查询无会话语义：sessionId 缺省合法；携带时必须正整数（§5.3 同形）
  if (
    sessionId !== undefined &&
    sessionId !== null &&
    (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId <= 0)
  ) {
    rejectAck(connection, echo, idempotencyKey, 'BAD_PAYLOAD')
    return
  }
  const payload = obj.payload
  if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
    rejectAck(connection, echo, idempotencyKey, 'BAD_PAYLOAD')
    return
  }

  // 2) 受理段（与 relay 面同一 L3 台账；审计 source='local-gateway' 通道如实入册）
  let begun: ReturnType<typeof beginWorkspaceLink>
  try {
    begun = beginWorkspaceLink({ deviceId: connection.deviceId, idempotencyKey, source: 'local-gateway' })
  } catch (err) {
    // 幂等键被他用（COMMAND_KEY_CONFLICT 等）→ 结构化拒绝，绝不执行查询
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
    rejectAck(connection, echo, idempotencyKey, code)
    return
  }
  connection.sendFrame({
    type: 'command_ack',
    ...echo,
    idempotencyKey,
    commandId: begun.commandId,
    status: 'accepted',
  })

  // 3) 执行段：磁盘三文件重建（同步亚秒；provider 绝不抛）→ 终态帧。拉取模型下
  //    同 key 重试 = 重新取最新链接（§5.3.1 幂等语义原样）。
  let link: ReturnType<typeof buildZcodeWorkspaceLinkDefault>
  try {
    link = buildZcodeWorkspaceLinkDefault()
  } catch {
    link = { ok: false, code: ZCODE_LINK_UNAVAILABLE, reason: 'sources_unreadable' }
  }
  if (link.ok) {
    try {
      completeWorkspaceLink({ commandId: begun.commandId, deviceId: connection.deviceId, idempotencyKey, ok: true })
    } catch {
      /* 台账收口失败不影响终态帧诚实回程（App 侧以帧为准；绝不假成功） */
    }
    connection.sendFrame({
      type: 'command_result',
      ...echo,
      commandId: begun.commandId,
      idempotencyKey,
      action: 'workspace_link',
      status: 'executed',
      errorCode: null,
      result: { provider: 'zcode', url: link.url, deviceName: link.deviceName },
      timestamp: Math.floor(Date.now() / 1000),
    })
    return
  }
  // 三文件缺失/解密失败 → 结构化 ZCODE_LINK_UNAVAILABLE（reason 只进桌面
  // result_json/审计静态字面量；帧面 errorCode 承载——绝不 partial URL）
  try {
    completeWorkspaceLink({
      commandId: begun.commandId,
      deviceId: connection.deviceId,
      idempotencyKey,
      ok: false,
      reason: link.reason,
    })
  } catch {
    /* 同上：台账失败不改帧面诚实终态 */
  }
  connection.sendFrame({
    type: 'command_result',
    ...echo,
    commandId: begun.commandId,
    idempotencyKey,
    action: 'workspace_link',
    status: 'failed',
    errorCode: ZCODE_LINK_UNAVAILABLE,
    timestamp: Math.floor(Date.now() / 1000),
  })
}

/** 结构化拒绝（command_ack rejected；errorCode 同 §8.2 命名域）。 */
function rejectAck(
  connection: GatewayWsConnection,
  echo: { requestId?: string },
  idempotencyKey: string,
  code: string,
): void {
  connection.sendFrame({ type: 'command_ack', ...echo, idempotencyKey, status: 'rejected', errorCode: code })
}
