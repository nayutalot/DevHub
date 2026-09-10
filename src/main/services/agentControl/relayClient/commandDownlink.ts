/**
 * commandDownlink.ts — 命令下行桥（M2-R1 模块 5/8，docs/19 §4.4）。
 *
 * 流水（docs/19 §4.4 逐行；执行入口 = L3 submitRemoteCommand，与 Gateway REST
 * 同一底层，docs/18 §9.2 时序）：
 *   1) auth 校验：gateway/auth.ts 同源函数（authenticateBearerToken：sha256 +
 *      timingSafeEqual + 撤销即拒）+ checkReplayHeaders（±300s 窗口 / nonce LRU
 *      10min，docs/14 §B.4 同参——帧内 auth{ts,nonce} 即 X-DevHub-* 语义）。
 *      失败 → error{AUTH_INVALID_TOKEN|AUTH_REPLAYED|DEVICE_REVOKED}（不触达 L3）。
 *   2) action 翻译：send_message→reply（≡ 改名映射，docs/18 §5.1）；pause/resume
 *      原样；approve/interrupt → 结构化拒绝 AGENT_CAPABILITY_MISSING（G6 默认
 *      恒不授予，docs/19 §6.1——能力验证函数骨架属后续批次）；未知值 → 拒绝
 *      BAD_PAYLOAD。
 *      M3-E（docs/18 §5.3，用户裁决 2026-09-07 #9=B）追加两 action：
 *      - spawn_session：帧校验（providerId 非空 + task 非空 ≤4000 → BAD_PAYLOAD）→
 *        授权矩阵预分类（caps.mode ≠ managed → COMMAND_NOT_EXECUTABLE）→ L3 既有
 *        spawn 托管通道（幂等/能力门/双上限全复用）；spawn 特有拒绝（无托管通道/
 *        并发上限/启动失败）→ SPAWN_REJECTED（§8.2 新码，WS 专属）。
 *      - revoke_device：目标 = auth Token 对应 deviceId（自指；payload 不解释），
 *        两段式 beginDeviceSelfRevoke（受理行）→ ack → executeDeviceSelfRevoke
 *        （L3 revoke → §3.15 撤销链自动接管）；无能力门且豁免 gateway 前提
 *        （安全自助操作）；终态收口 = disconnect(revoked) 而非 command_result。
 *      两值即 §5.1 五值之外唯一追加面（N-R3：action 全集终点）。
 *      S 批（docs/18 §5.3 注记）追加查询 action workspace_link：ZCode 移动遥控链接
 *      磁盘重建（zcodeLinkProvider）→ command_result.result{provider,url,deviceName}
 *      内存过境回流（result_json/审计只记 {provider}，URL 零落库——任务书红线）。
 *   3) 执行：submitRemoteCommand（能力门二次校验 resolveCommandGate + 幂等 +
 *      TTL 300s + 审计全部在 L3，绝不复刻）；本地 Gateway 未启用 → GATEWAY_DISABLED
 *      （docs/19 §4.8 relay 模式前提）。
 *   4) 回帧：受理 → command_ack{accepted|rejected, errorCode}（docs/18 §3.9）；
 *      终态 → command_result（docs/18 §3.10；与 command.result 事件双通道，
 *      Android 按 commandId 去重）。同幂等键重试命中已终态命令 → ack + 原
 *      command_result 重放（L3 getRemoteCommandResultView，docs/14 §B.5 语义）。
 *
 * 幂等键在调用 submitRemoteCommand **之前**登记（终态监听按 idempotencyKey 路由）：
 * executeRemoteCommand 的终态通知是 submitRemoteCommand 返回前已排队的微任务，
 * 若在返回后才登记会漏掉同步完成的指令（fixture provider 即此形态）。
 *
 * M3-C7b 修 ③ —— docs/18 空白点标注（不扩帧面的最小回程，任务书 §1 #3）：
 * docs/18 §3.0 #16 error 帧「中继 = 否」——error 帧只在单腿内有语义，ECS 不跨腿
 * 转发；§3.16 定义了帧形（requestId 可关联）却**未定义 Windows 生成的 error 如何
 * 到达设备**（H→E→D 回程通道 = 协议空白）。后果：命令被桌面拒（auth 失败等不
 * 触达 L3 的错误）时设备收不到任何回帧，只能等自身超时（C2d 实测 90s 挂起）。
 * 协议既未冻结回程帧形，本实现按任务书取最小面：**复用 §3.9
 * command_ack{status:'rejected', errorCode}（中继 = 是，C2d 实证 ECS 会向设备
 * 转发该帧）承载错误码回程**，errorCode 取同一命名域（docs/18 §8.2）；H→E
 * error 帧保留发送（主机腿诊断语义不丢）。16 帧集之外零新帧、既有帧形零扩展。
 * 若后续按 docs/20 §2.4 契约修订流程定义了 error 跨腿回程，应迁移至该帧形并
 * 撤除本处 command_ack 回程。
 *
 * electron-free；零直接写库（L3 submitRemoteCommand / getRemoteCommandResultView
 * 只读豁免；gateway/auth 读豁免——约束 #20）。
 */

import {
  isGatewayEnabled,
  submitRemoteCommand,
  getRemoteCommandResultView,
  setRemoteCommandCompleteListener,
  startProviderManagedSession,
  MANAGED_SESSION_TASK_MAX_CHARS,
  beginDeviceSelfRevoke,
  executeDeviceSelfRevoke,
  beginWorkspaceLink,
  completeWorkspaceLink,
  readProviderCapabilityMode,
  type RemoteCommandTerminalEvent,
} from '../agentControlService.ts'
import { authenticateBearerToken, checkReplayHeaders } from '../gateway/auth.ts'
import { buildZcodeWorkspaceLinkDefault, ZCODE_LINK_UNAVAILABLE } from '../zcodeLinkProvider.ts'
import type { HostToEcsFrame } from './wsClient.ts'

// ---------------------------------------------------------------------------
// 回帧宿主（relayClient/index.ts 注入；smoke 以捕获数组注入）
// ---------------------------------------------------------------------------

/** 命令下行宿主接口（H→E 帧出口）。 */
export interface CommandDownlinkHost {
  /** 发送 command_ack 帧（受理/拒绝回执）。 */
  sendAck(frame: HostToEcsFrame): boolean
  /** 发送 command_result 帧（终态回执）。 */
  sendResult(frame: HostToEcsFrame): boolean
  /** 发送 error 帧（auth 失败等不触达 L3 的错误，docs/19 §4.4）。 */
  sendError(frame: HostToEcsFrame): boolean
}

// ---------------------------------------------------------------------------
// action 翻译（docs/18 §5.1 映射表；集中一处防漂移）
// ---------------------------------------------------------------------------

/** Relay action → 内部 AgentCapability（docs/18 §5.1：send_message ≡ reply）。 */
export function relayActionToInternal(action: string): 'reply' | 'pause' | 'resume' | null {
  if (action === 'send_message') return 'reply'
  if (action === 'pause') return 'pause'
  if (action === 'resume') return 'resume'
  return null
}

/** 内部 action → Relay action（command_result 帧回投影；command_result 帧形用 Relay 名）。 */
export function internalActionToRelay(action: string): string {
  if (action === 'reply') return 'send_message'
  return action
}

/** approve/interrupt：协议帧面接收，执行面恒结构化拒绝（docs/19 §6.1 默认态）。 */
const NEVER_GRANTED_ACTIONS: readonly string[] = ['approve', 'interrupt']

/**
 * M3-E 设备自管理两 action（docs/18 §5.3，用户裁决 2026-09-07 #9=B）：
 * - spawn_session：managed 会话启动，接 L3 既有 spawn 托管通道（startProviderManagedSession
 *   幂等行/能力门/双上限全复用，绝不旁路）；
 * - revoke_device：设备自撤销，目标 = auth Token 对应 deviceId（帧无目标字段天然自指，
 *   payload 一概不解释——禁止任何「代撤销他设备」语义承载面）。
 * 两值即 §5.1 五值之外的唯一 M3-E 追加面（N-R3：action 全集终点）。
 */
const SELF_MANAGED_ACTIONS: readonly string[] = ['spawn_session', 'revoke_device']

/** reply 文本上限（docs/14 §A.1 #6 同源 ≤4000；commandDownlink 复刻同一校验值）。 */
export const RELAY_REPLY_TEXT_MAX_CHARS = 4000

/**
 * S 批查询 action（docs/18 §5.3 注记）：workspace_link——ZCode 移动遥控链接查询。
 * sessionId 缺省合法（无会话语义）；READ 类能力门（任何已配对设备可查询，auth 在
 * 本文件统一校验）；执行 = 桌面磁盘三文件重建 URL（zcodeLinkProvider），URL 仅经
 * command_result 帧内存过境（result_json/审计只记 {provider}，零落库——任务书红线）。
 */
const QUERY_ACTIONS: readonly string[] = ['workspace_link']

// ---------------------------------------------------------------------------
// 下行处理（帧路由入口；单帧异常绝不杀伤连接——调用方逐帧隔离）
// ---------------------------------------------------------------------------

/** 终态待路由表容量上限（防内存放大；极端积压下最旧键让位——设备重试幂等兜底）。 */
const PENDING_KEYS_MAX = 1_000

interface PendingKeyRoute {
  /** 终态 command_result 帧的 action 用 Relay 名。 */
  relayAction: string
}

/** 幂等键 → 终态路由（提交前登记；终态后删除）。 */
const pendingKeys = new Map<string, PendingKeyRoute>()

/** 宿主接线（setCommandDownlinkHost 幂等覆盖；smoke 重置用 clearCommandDownlinkState）。 */
let downlinkHost: CommandDownlinkHost | null = null

/** smoke/测试复位（进程内多次隔离场景；生产不调用）。 */
export function clearCommandDownlinkState(): void {
  pendingKeys.clear()
  downlinkHost = null
  setRemoteCommandCompleteListener(null)
}

/**
 * 接线（relayClient/index.ts start 路径）：宿主注入 + L3 终态监听注册。
 * 监听按 idempotencyKey 过滤（只有经 relay 下达的指令在 pendingKeys 中——
 * Gateway/IPC 来源指令的终态由 command.result 事件承载，不在 relay 面回帧，
 * agentControlService 缝注释同口径）。
 */
export function setCommandDownlinkHost(host: CommandDownlinkHost): void {
  downlinkHost = host
  setRemoteCommandCompleteListener(onRemoteCommandTerminal)
}

/** L3 终态监听（command_result 回帧；异常绝不影响 L3 状态机——notify 侧已隔离）。 */
function onRemoteCommandTerminal(event: RemoteCommandTerminalEvent): void {
  if (downlinkHost === null) return
  const route = pendingKeys.get(event.idempotencyKey)
  if (route === undefined) return
  pendingKeys.delete(event.idempotencyKey)
  downlinkHost.sendResult({
    type: 'command_result',
    commandId: event.commandId,
    idempotencyKey: event.idempotencyKey,
    ...(event.sessionId > 0 ? { sessionId: event.sessionId } : {}),
    action: internalActionToRelay(event.action),
    status: event.status,
    errorCode: event.errorCode,
    timestamp: Math.floor(Date.now() / 1000),
  })
}

/** 结构校验失败的 error 帧（协议级；BAD_PAYLOAD——docs/18 §3.16）。 */
function badPayloadError(requestId: unknown, message: string): HostToEcsFrame {
  return {
    type: 'error',
    ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
    code: 'BAD_PAYLOAD',
    message,
  }
}

/**
 * 设备向错误回程（M3-C7b 修 ③，docs/18 空白点最小实现——见文件头标注）：
 * 同一拒绝同时走 (a) H→E error 帧（主机腿诊断语义，中继=否不到设备）与
 * (b) command_ack{rejected, errorCode}（中继=是，设备实际收到的回程帧）。
 * 仅当幂等键为可用非空字符串时才发 (b)——ECS 以 (deviceId, idempotencyKey) 定位
 * 命令上下文，键缺失时回程帧无处可路由（error 帧原样保留 requestId 诊断）。
 */
function rejectWithDeviceReturn(
  host: CommandDownlinkHost,
  requestId: unknown,
  idempotencyKey: string | undefined,
  code: string,
  message: string,
): void {
  host.sendError({
    type: 'error',
    ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
    code,
    message,
  })
  if (typeof idempotencyKey === 'string' && idempotencyKey.length > 0) {
    host.sendAck({
      type: 'command_ack',
      ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
      idempotencyKey,
      status: 'rejected',
      errorCode: code,
    })
  }
}

/**
 * command 帧处理（E→H；docs/18 §3.8 D→E 原样中继形态）。绝不抛：所有失败
 * 折叠为 error / command_ack 帧回执（业务级错误不断连，docs/18 §3.16）。
 */
export function handleCommandFrame(frame: unknown, host: CommandDownlinkHost): void {
  if (!isObject(frame)) return
  const requestId = (frame as { requestId?: unknown }).requestId
  // 1) 结构校验（协议级）——字段缺失/类型错 → error BAD_PAYLOAD；幂等键可用时
  //    同步走 command_ack{rejected,BAD_PAYLOAD} 设备向回程（M3-C7b 修 ③）
  const idempotencyKey = (frame as { idempotencyKey?: unknown }).idempotencyKey
  const sessionId = (frame as { sessionId?: unknown }).sessionId
  const action = (frame as { action?: unknown }).action
  const auth = (frame as { auth?: unknown }).auth
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    host.sendError(badPayloadError(requestId, 'command.idempotencyKey must be a non-empty string (docs/18 §3.8)'))
    return
  }
  if (typeof action !== 'string' || action.length === 0) {
    rejectWithDeviceReturn(host, requestId, idempotencyKey, 'BAD_PAYLOAD', 'command.action must be a non-empty string (docs/18 §3.8)')
    return
  }
  // M3-E（docs/18 §5.3）：spawn_session（尚无会话）/ revoke_device（自指无目标）与
  // S 批 workspace_link（查询无会话语义）三 action 的 sessionId 缺省为合法帧形——
  // 仅当携带时要求正整数；§5.1 五值维持必带（原语义零变化）。
  if ((SELF_MANAGED_ACTIONS as readonly string[]).includes(action) || (QUERY_ACTIONS as readonly string[]).includes(action)) {
    if (sessionId !== undefined && sessionId !== null && (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId <= 0)) {
      rejectWithDeviceReturn(host, requestId, idempotencyKey, 'BAD_PAYLOAD', 'command.sessionId must be a positive integer when present (docs/18 §5.3)')
      return
    }
  } else if (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
    rejectWithDeviceReturn(host, requestId, idempotencyKey, 'BAD_PAYLOAD', 'command.sessionId must be a positive integer (docs/18 §3.8)')
    return
  }
  if (!isObject(auth)) {
    rejectWithDeviceReturn(host, requestId, idempotencyKey, 'BAD_PAYLOAD', 'command.auth {token, ts, nonce} is required (docs/18 §3.8)')
    return
  }
  const token = (auth as { token?: unknown }).token
  const ts = (auth as { ts?: unknown }).ts
  const nonce = (auth as { nonce?: unknown }).nonce
  if (typeof token !== 'string' || token.length === 0 || typeof ts !== 'number' || typeof nonce !== 'string') {
    rejectWithDeviceReturn(host, requestId, idempotencyKey, 'BAD_PAYLOAD', 'command.auth fields token/ts/nonce are malformed (docs/18 §3.8)')
    return
  }
  const payload = (frame as { payload?: unknown }).payload

  // 2) auth 校验（docs/19 §4.4 第 1 步；失败 → error + command_ack rejected 回程，
  //    不触达 L3——M3-C7b 修 ③：设备不再 90s 空等）
  let authedDeviceId: number
  try {
    const authed = authenticateBearerToken(token)
    authedDeviceId = authed.id
    // ts/nonce 防重放（gateway/auth.ts 同源：±300s 窗口 + nonce LRU 10min；
    // auth.ts 数字时间戳 → String 形态复用同一校验函数，docs/19 §4.4「同参」）
    checkReplayHeaders({ timestamp: String(ts), nonce }, Date.now())
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
    rejectWithDeviceReturn(
      host,
      requestId,
      idempotencyKey,
      code,
      err instanceof Error ? err.message : 'command authentication failed',
    )
    return
  }

  const reject = (errorCode: string, commandId?: string): void => {
    host.sendAck({
      type: 'command_ack',
      ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
      idempotencyKey,
      ...(commandId !== undefined ? { commandId } : {}),
      status: 'rejected',
      errorCode,
    })
  }

  // 3) 本地 Gateway 前提（docs/19 §4.4/§4.8：relay 模式要求 gateway_enabled=1）
  //    M3-E 例外：revoke_device 置于此前提之外（§5.3 门控列「无能力门」——设备自撤销是
  //    安全自助操作，绝不因 gateway 禁用态被阻断而失去自我保护路径）。
  if (action !== 'revoke_device' && !isGatewayEnabled()) {
    reject('GATEWAY_DISABLED')
    return
  }

  // 3.5) M3-E revoke_device（docs/18 §5.3）：目标 = auth Token 对应 deviceId（帧无目标
  //      字段天然自指）；payload 一概不解释。两段式受理/执行——ack 先于执行段出帧，
  //      wire 序保证设备先收 command_ack(accepted) 再收 disconnect(revoked)（§5.3：
  //      终态收口 = disconnect(revoked)，commandId 终态照常落库，回帧不保证送达）。
  if (action === 'revoke_device') {
    let begun: ReturnType<typeof beginDeviceSelfRevoke>
    try {
      begun = beginDeviceSelfRevoke({ deviceId: authedDeviceId, idempotencyKey })
    } catch (err) {
      // 幂等键被他用（跨 action 冲突等）→ 结构化拒绝，绝不出帧执行撤销
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
      reject(code)
      return
    }
    // 终态路由登记（执行段 notify → command_result 回帧尝试；设备被踢后投递失败属预期）
    if (!begun.replayed) pendingKeys.set(idempotencyKey, { relayAction: action })
    host.sendAck({
      type: 'command_ack',
      ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
      idempotencyKey,
      commandId: begun.commandId,
      status: 'accepted',
    })
    if (!begun.replayed) {
      void executeDeviceSelfRevoke({ commandId: begun.commandId, deviceId: authedDeviceId, idempotencyKey })
    }
    return
  }

  // 4) action 翻译（docs/18 §5.1）+ 门控拒绝
  if ((NEVER_GRANTED_ACTIONS as readonly string[]).includes(action)) {
    // G6：approve/interrupt 默认恒不授予（docs/19 §6.1）；结构化拒绝，绝不触达 L3
    reject('AGENT_CAPABILITY_MISSING')
    return
  }

  // 4.5) M3-E spawn_session（docs/18 §5.3）：managed 会话启动——帧校验 → 授权矩阵
  //      预分类 → L3 既有 spawn 托管通道（幂等行/能力门/双上限全复用，绝不旁路）。
  if (action === 'spawn_session') {
    // 帧校验（任务书 §2.2.1：payload.providerId 非空 + task 非空 ≤4000，违反 → BAD_PAYLOAD；
    // 与本地 REST BAD_PAYLOAD 边界同源，MANAGED_SESSION_TASK_MAX_CHARS = 4000）
    const payloadObj = isObject(payload) ? payload : null
    const providerId = payloadObj === null ? undefined : payloadObj.providerId
    const task = payloadObj === null ? undefined : payloadObj.task
    if (
      typeof providerId !== 'string' || providerId.trim().length === 0 ||
      typeof task !== 'string' || task.trim().length === 0 || task.length > MANAGED_SESSION_TASK_MAX_CHARS
    ) {
      reject('BAD_PAYLOAD')
      return
    }
    // 拒绝码分类（§2.2.2）：授权矩阵不允许（caps.mode ≠ managed）→ COMMAND_NOT_EXECUTABLE。
    // readProviderCapabilityMode 为只读投影（provider 未知 → null 放行，L3 折 NOT_FOUND）；
    // L3 在执行路径重新权威校验，此处仅决定错误码命名域（绝不旁路任何既有校验）。
    const capsMode = readProviderCapabilityMode(providerId)
    if (capsMode !== null && capsMode !== 'managed') {
      reject('COMMAND_NOT_EXECUTABLE')
      return
    }
    // startProviderManagedSession 同步执行至终态：resolve = 受理结果（executed 含
    // sessionId/nativeId 还原）；throw = 业务拒绝（幂等行已在 L3 内处理）。
    void startProviderManagedSession({ deviceId: authedDeviceId, provider: providerId, task, idempotencyKey })
      .then((result) => {
        // 受理回执先行（§5.2 时序 command → command_ack → command_result；spawn 的
        // L3 通道同步执行至终态——与本地 REST「202 executed 同步响应」同语义，延迟由
        // 幂等键兜底），终态帧随后：§2.2.4 —— command_result(action='spawn_session',
        // status='executed', sessionId=新会话 id)；nativeId 不入帧（经 command.result
        // 事件 payload 回流）。幂等重试命中已终态命令 → 原结果重放（docs/14 §B.5）。
        host.sendAck({
          type: 'command_ack',
          ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
          idempotencyKey,
          commandId: result.commandId,
          status: result.status === 'rejected' ? 'rejected' : 'accepted',
        })
        const terminal = result.status !== 'accepted'
        if (terminal) {
          host.sendResult({
            type: 'command_result',
            commandId: result.commandId,
            idempotencyKey,
            ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
            action: 'spawn_session',
            status: result.status === 'rejected' ? 'rejected' : 'executed',
            errorCode: null,
            timestamp: Math.floor(Date.now() / 1000),
          })
        }
      })
      .catch((err: unknown) => {
        const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
        // 拒绝映射（§2.2.2）：mode 分类已前置拦截非 managed → 此处剩余 COMMAND_NOT_EXECUTABLE
        // 均为 spawn 特有拒绝（provider 无托管通道/并发上限/启动失败）→ SPAWN_REJECTED
        // （docs/18 §8.2 新码，WS 专属）；其余码（NOT_FOUND/BAD_PAYLOAD/COMMAND_KEY_CONFLICT/
        // COMMAND_EXPIRED/AGENT_CAPABILITY_MISSING/AGENT_PROVIDER_UNAVAILABLE）同码透传。
        reject(code === 'COMMAND_NOT_EXECUTABLE' ? 'SPAWN_REJECTED' : code)
      })
    return
  }

  // 4.6) S 批 workspace_link（docs/18 §5.3 注记；任务书 §1 #1/#2）：ZCode 移动遥控
  //      链接查询——payload {} 不解释；磁盘三文件重建（zcodeLinkProvider 注入缝，
  //      smoke 绝不触真实 ~/.zcode）→ URL 仅 command_result 帧 result 内存过境。
  //      **审计/落库红线**：remote_commands.result_json 与桌面审计只记 {provider}
  //      （completeWorkspaceLink 内保证）；本文件绝不把 URL 写进任何日志/error 帧。
  if ((QUERY_ACTIONS as readonly string[]).includes(action)) {
    let begun: ReturnType<typeof beginWorkspaceLink>
    try {
      begun = beginWorkspaceLink({ deviceId: authedDeviceId, idempotencyKey })
    } catch (err) {
      // 幂等键被他用（跨 action 冲突等）→ 结构化拒绝，绝不执行查询
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
      reject(code)
      return
    }
    // 受理回执先行（§5.2 时序：command → command_ack → command_result）；查询为
    // 本地磁盘同步面，结果帧随后同连接回程。同 key 重试（replayed）= 拉取模型下
    // 重新取最新链接（旧 URL 零持久化、无从重放——重建即最忠实的「原结果」）。
    host.sendAck({
      type: 'command_ack',
      ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
      idempotencyKey,
      commandId: begun.commandId,
      status: 'accepted',
    })
    const link = buildZcodeWorkspaceLinkDefault()
    if (link.ok) {
      completeWorkspaceLink({ commandId: begun.commandId, deviceId: authedDeviceId, idempotencyKey, ok: true })
      host.sendResult({
        type: 'command_result',
        commandId: begun.commandId,
        idempotencyKey,
        action: 'workspace_link',
        status: 'executed',
        errorCode: null,
        result: { provider: 'zcode', url: link.url, deviceName: link.deviceName },
        timestamp: Math.floor(Date.now() / 1000),
      })
    } else {
      // 三文件缺失/解密失败 → 结构化 ZCODE_LINK_UNAVAILABLE（reason 只进桌面
      // result_json/审计静态字面量；帧面 errorCode 承载——绝不 partial URL）
      completeWorkspaceLink({ commandId: begun.commandId, deviceId: authedDeviceId, idempotencyKey, ok: false, reason: link.reason })
      host.sendResult({
        type: 'command_result',
        commandId: begun.commandId,
        idempotencyKey,
        action: 'workspace_link',
        status: 'failed',
        errorCode: ZCODE_LINK_UNAVAILABLE,
        timestamp: Math.floor(Date.now() / 1000),
      })
    }
    return
  }

  const internalAction = relayActionToInternal(action)
  if (internalAction === null) {
    reject('BAD_PAYLOAD')
    return
  }
  let text: string | undefined
  if (internalAction === 'reply') {
    // 载荷校验（docs/14 §A.1 #6 同源：send_message 必带非空 ≤4000 文本；
    // D4 选型注记：handler 层载荷校验在 commandDownlink 复刻同一校验值）
    const raw = isObject(payload) ? (payload as { text?: unknown }).text : undefined
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > RELAY_REPLY_TEXT_MAX_CHARS) {
      reject('BAD_PAYLOAD')
      return
    }
    text = raw
  }

  // 5) 终态路由登记（先于 submitRemoteCommand——见文件头时序注记）
  if (!pendingKeys.has(idempotencyKey)) {
    while (pendingKeys.size >= PENDING_KEYS_MAX) {
      const oldest = pendingKeys.keys().next()
      if (oldest.done === true) break
      pendingKeys.delete(oldest.value)
    }
  }
  pendingKeys.set(idempotencyKey, { relayAction: action })

  // 6) 执行（L3 submitRemoteCommand：能力门二次校验 + 幂等 + TTL + 审计）
  //    （sessionRef：§5.1 路径的 sessionId 已在步骤 1 校验为正整数——此处显式收窄）
  const sessionRef = sessionId as number
  void submitRemoteCommand({
    deviceId: authedDeviceId,
    sessionId: sessionRef,
    action: internalAction,
    ...(text !== undefined ? { text } : {}),
    idempotencyKey,
  })
    .then((accepted) => {
      if (accepted.status === 'accepted') return // 终态稍后经监听回流
      // 幂等重试命中已终态命令：回执原结果（docs/14 §B.5「同 key 重试返回原结果」）
      pendingKeys.delete(idempotencyKey)
      const prior = getRemoteCommandResultView(accepted.commandId)
      if (prior !== null) {
        host.sendResult({
          type: 'command_result',
          commandId: prior.commandId,
          idempotencyKey: prior.idempotencyKey,
          ...(prior.sessionId > 0 ? { sessionId: prior.sessionId } : {}),
          action: internalActionToRelay(prior.action),
          status: prior.status,
          errorCode: prior.errorCode,
          timestamp: Math.floor(Date.now() / 1000),
        })
      }
      host.sendAck({
        type: 'command_ack',
        ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
        idempotencyKey,
        commandId: accepted.commandId,
        status: accepted.status === 'rejected' ? 'rejected' : 'accepted',
        ...(prior?.errorCode !== undefined && prior.errorCode !== null && accepted.status === 'rejected'
          ? { errorCode: prior.errorCode }
          : {}),
      })
    })
    .catch((err: unknown) => {
      // 业务级拒绝（NOT_FOUND/BAD_PAYLOAD/COMMAND_EXPIRED/COMMAND_KEY_CONFLICT/
      // AGENT_CAPABILITY_MISSING/…）→ command_ack rejected（docs/18 §3.9 形态）
      pendingKeys.delete(idempotencyKey)
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
      reject(code)
    })
}

/** 窄化助手（frame 形态校验专用）。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
