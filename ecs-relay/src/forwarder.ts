/**
 * forwarder.ts — 中继编排（docs/19 §5.2：帧路由、扇出、command 排队/投递、ack 中继、错误映射）。
 *
 * 路由纪律（docs/18 §3.0）：
 * - ECS 不解释业务语义（command.payload/approve/auth 一律透传；ECS 不校验 auth——
 *   防重放/Token 校验/能力门/幂等/过期全部在 Windows，docs/18 §3.8）；
 * - 仅补路由字段（event.deviceId 扇出填充、session_list.stale 注入）与落审计/缓存；
 * - 未知 type / 字段类型错 → 结构化 error 帧 + 关闭（1002，docs/18 §3.16 协议级违规）；
 *   业务级错误只回 error/*_ack 帧不断连。
 *
 * 凭据红线（docs/19 §3.2 问2/§8）：命令帧内嵌端到端 auth 只在内存瞬时过境
 * （排队投递用），绝不落盘/落日志/落审计；排队持久层只存脱敏 payload + 幂等状态，
 * host 重连后按 requested_at 序投递内存帧；进程重启后的恢复 = 排队状态行仍在
 * （重启侧）+ Android QueueReplay 同 key 重发（docs/18 §3.8，幂等去重兜底）。
 */
import { randomUUID } from 'node:crypto'
import type { RelayConnection } from './ws.ts'
import type { Store } from './store.ts'
import type { Audit } from './audit.ts'
import type { EventCache } from './cache.ts'
import type { RelayConfig } from './config.ts'
import { RelayError, errorFrame } from './errors.ts'
import { sha256Hex } from './auth.ts'
import type { RateLimits } from './auth.ts'
import { claimPairing, registerPairing, findPendingDevice } from './pairing.ts'

// M3-E（docs/18 §5.3，用户裁决 2026-09-07 #9=B）：值域追加 spawn_session/revoke_device
// 两值——设备自管理通道。仅值域扩展：ECS 仍不解释语义（命令纯透传给 host 腿，
// §5.3「Windows 执行通道」列），帧形零扩展、零新逻辑分支（N-R3：两值即 action 全集终点）。
export const RELAY_ACTIONS = ['send_message', 'approve', 'pause', 'resume', 'interrupt', 'spawn_session', 'revoke_device'] as const

type Frame = { type: string; [key: string]: unknown }

interface PendingHostRequest {
  requestId: string
  /** 响应回宿：设备连接（原 requestId 回显）或 REST resolver。 */
  respond: (response: Frame | null, error: RelayError | null) => void
  timer: NodeJS.Timeout
}

interface QueuedCommandMemory {
  /** 完整原始帧（含 auth——仅内存，绝不落盘）。 */
  frame: Frame
  deviceId: number
  requestedAt: number
}

/** 必填字符串帧字段（缺失/类型错 → BAD_PAYLOAD，绝不猜）。 */
function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new RelayError('BAD_PAYLOAD', `frame field ${field} is required (string, 1-4096 chars)`)
  }
  return value
}

/** 必填整数帧字段。 */
function asNumber(value: unknown, field: string, options: { min?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || (options.min !== undefined && value < options.min)) {
    throw new RelayError('BAD_PAYLOAD', `frame field ${field} is required (integer${options.min !== undefined ? ` >= ${options.min}` : ''})`)
  }
  return value
}

/** 可选整数帧字段；缺省 → null。 */
function asOptionalNumber(value: unknown, field: string, options: { min?: number } = {}): number | null {
  if (value === undefined || value === null) return null
  return asNumber(value, field, options)
}

export class Forwarder {
  private readonly store: Store
  private readonly audit: Audit
  readonly cache: EventCache
  private readonly config: RelayConfig
  private readonly rateLimits: RateLimits

  /** device leg 已鉴权连接（同设备多连接，docs/18 §2）。 */
  private readonly deviceConns = new Map<number, Set<RelayConnection>>()
  /** device leg 以 rotation 宽限凭据准入的连接（窗口过期由清扫关闭，docs/18 §3.14）。 */
  private readonly graceAuthedConns = new Map<number, Set<RelayConnection>>()
  /** device leg 裸 pair 连接（未鉴权，首帧必须 pair）。 */
  private readonly bareConns = new Set<RelayConnection>()
  /**
   * 裸 pair 窗冲刷注册表（M3-C7a 修①，row id → 裸连接 + 到期 timer）：pair_accepted
   * 发出后裸连接不再即刻关闭，保留 pairRotationFlushMs 短窗——同秒到达的 token_rotation
   * 在关闭前冲刷投递（App 侧 PairLegFrameRouter 已就位接帧；docs/18 §3.14 精神：
   * 轮换帧允许投递于该设备任一活跃 device-leg 连接）。
   */
  private readonly pairWindowConns = new Map<number, { conn: RelayConnection; timer: NodeJS.Timeout }>()
  /**
   * 漏投 token_rotation 补偿表（M3-C7a 修②，row id → 完整帧；安全网语义）：轮换发生时
   * 该设备无任何可投连接（pair 窗已收口/无已鉴权连接）→ 完整帧（含明文 Token）仅存内存
   * （绝不落盘/落日志/落审计），grace 窗内旧凭据重连即补投；窗外 auth 层 401
   * （token_rotation_grace_expired）路径不动摇。设备以新凭据准入/撤销/窗过期即清。
   */
  private readonly pendingRotations = new Map<number, { frame: Frame; tokenVersion: number; expiresAtSec: number }>()
  /** host leg 连接（同主机多连接，滚动重启不互踢）。 */
  private readonly hostConns: RelayConnection[] = []
  /** host leg 请求-响应挂起表（ECS 内部 requestId → 宿）。 */
  private readonly pendingHostRequests = new Map<string, PendingHostRequest>()
  /** 排队命令的内存完整帧（含 auth；重启即失，状态行仍在 DB）。 */
  private readonly queuedMemory = new Map<number, QueuedCommandMemory>()
  /** 周期 timer（淘汰/排队过期清扫）。 */
  private timers: NodeJS.Timeout[] = []

  constructor(deps: { store: Store; audit: Audit; cache: EventCache; config: RelayConfig; rateLimits: RateLimits }) {
    this.store = deps.store
    this.audit = deps.audit
    this.cache = deps.cache
    this.config = deps.config
    this.rateLimits = deps.rateLimits
    const sweepMs = Math.min(30000, Math.max(1000, Math.floor((deps.config.commandTtlSec * 1000) / 10)))
    this.timers.push(setInterval(() => this.sweepExpiredQueued(), sweepMs))
    // 宽限清扫节奏：窗口的 1/4（下限 500ms 供测试短窗，上限 30s——docs/18 §3.14 300s → 7.5s）
    const graceSweepMs = Math.min(30000, Math.max(500, Math.floor((deps.config.rotationGraceSec * 1000) / 4)))
    this.timers.push(setInterval(() => this.sweepExpiredGrace(), graceSweepMs))
    this.timers.push(setInterval(() => {
      this.cache.evict(Math.floor(Date.now() / 1000), (stage, count) => {
        this.audit.write({ category: 'relay', action: 'relay_cache_evicted', outcome: 'success', detail: { stage, count } })
      })
    }, deps.config.evictionIntervalMs))
  }

  // -------------------------------------------------------------------------
  // 连接生命周期
  // -------------------------------------------------------------------------

  get hostOnline(): boolean {
    return this.hostConns.length > 0
  }

  get connectionCount(): number {
    return this.deviceConns.size + this.bareConns.size + this.hostConns.length
  }

  /** 注册设备连接（已鉴权）→ 发 hello 首帧。viaGrace = rotation 宽限凭据准入（窗口过期清扫）。 */
  admitDeviceConnection(conn: RelayConnection, deviceId: number, viaGrace = false): void {
    this.guardBudget()
    let set = this.deviceConns.get(deviceId)
    if (set === undefined) {
      set = new Set()
      this.deviceConns.set(deviceId, set)
    }
    set.add(conn)
    if (viaGrace) {
      let graceSet = this.graceAuthedConns.get(deviceId)
      if (graceSet === undefined) {
        graceSet = new Set()
        this.graceAuthedConns.set(deviceId, graceSet)
      }
      graceSet.add(conn)
    }
    this.store.run('UPDATE relay_devices SET last_seen_at = ?, updated_at = ? WHERE id = ?', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), deviceId)
    this.audit.write({ category: 'device', action: 'connection_opened', outcome: 'success', deviceId, detail: { side: 'device', remoteIp: conn.identity.remoteIp, ...(viaGrace ? { viaGrace: true } : {}) } })
    // C7a 修②（重连补偿）：viaGrace = 设备仍持旧凭据（token version < current 且 grace 窗内
    // 准入——窗外 auth 层已 401 token_rotation_grace_expired，补偿绝不越窗）→ 补投漏投的
    // token_rotation(当前 token)；新凭据准入 = 设备已持当前版本 → 撤销补偿登记。
    this.closePairRotationWindow(deviceId, true, 'device reconnected with token; pair leg retired')
    conn.sendFrame(this.helloFrame(deviceId, undefined))
    if (viaGrace) this.compensatePendingRotation(conn, deviceId)
    else this.pendingRotations.delete(deviceId)
  }

  /** 注册裸 pair 连接（未鉴权；10s 内必须 pair，docs/18 §2）。 */
  admitBareDeviceConnection(conn: RelayConnection): void {
    this.guardBudget()
    this.bareConns.add(conn)
    conn.sendFrame(this.helloFrame(undefined, undefined))
    const timer = setTimeout(() => {
      if (!conn.closed && conn.identity.bare) {
        conn.close(1000, 'pair required (first frame must be pair within 10s, docs/18 §2)')
      }
    }, this.config.barePairTimeoutMs)
    timer.unref?.()
  }

  // -------------------------------------------------------------------------
  // M3-C7a：轮换投递两腿（裸 pair 窗冲刷 + 重连补偿，零新帧）
  // -------------------------------------------------------------------------

  /**
   * 开启裸 pair 冲刷窗（C7a 修①）：pair_accepted 已发出 → 裸连接保留
   * pairRotationFlushMs 短窗等待同秒 token_rotation；窗到期无轮换 → 按原语义关闭
   * （「pairing complete; reconnect with device token」，引导 Bearer 重连）。
   */
  private openPairRotationWindow(ecsDeviceId: number, conn: RelayConnection): void {
    this.closePairRotationWindow(ecsDeviceId, true) // 同行重复配对防御：旧窗先收口
    const timer = setTimeout(() => {
      this.closePairRotationWindow(ecsDeviceId, true)
    }, this.config.pairRotationFlushMs)
    timer.unref?.()
    this.pairWindowConns.set(ecsDeviceId, { conn, timer })
  }

  /** 收口 pair 冲刷窗（清 timer；closeBare = 是否顺带关闭裸连接——投递/收口路径传 true）。 */
  private closePairRotationWindow(ecsDeviceId: number, closeBare: boolean, reason = 'pairing complete; reconnect with device token'): void {
    const entry = this.pairWindowConns.get(ecsDeviceId)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.pairWindowConns.delete(ecsDeviceId)
    if (closeBare && !entry.conn.closed) entry.conn.close(1000, reason)
  }

  /**
   * 重连补偿（C7a 修②）：grace 准入连接补投漏投的 token_rotation(当前 token)。
   * 仅窗内生效（expiresAtSec = grace_expires_at 同源；窗外 auth 层已 401，本方法
   * 只可能被窗内准入调用）；补投不删登记——设备确认切换（新凭据准入）前，同一设备
   * 后续 grace 重连仍可取帧（投递不回滚 DB 同款「尽力面」语义，窗过期由清扫收口）。
   */
  private compensatePendingRotation(conn: RelayConnection, deviceId: number): void {
    const pending = this.pendingRotations.get(deviceId)
    if (pending === undefined) return
    const nowSec = Math.floor(Date.now() / 1000)
    if (nowSec >= pending.expiresAtSec) {
      this.pendingRotations.delete(deviceId)
      return
    }
    conn.sendFrame(pending.frame)
    this.audit.write({ category: 'device', action: 'token_rotation_flushed', outcome: 'success', deviceId, detail: { source: 'compensation', tokenVersion: pending.tokenVersion } })
  }

  /** 注册 host 连接 → hello + 三步恢复序之②（排队命令按 requested_at 序投递）。 */
  admitHostConnection(conn: RelayConnection, hostId: number): void {
    this.guardBudget()
    this.hostConns.push(conn)
    this.store.run('UPDATE relay_hosts SET last_seen_at = ?, updated_at = ? WHERE id = ?', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), hostId)
    this.audit.write({ category: 'relay', action: 'connection_opened', outcome: 'success', hostId, detail: { side: 'host', remoteIp: conn.identity.remoteIp } })
    conn.sendFrame(this.helloFrame(undefined, hostId))
    this.deliverQueuedCommands()
  }

  removeConnection(conn: RelayConnection): void {
    this.bareConns.delete(conn)
    // pair 冲刷窗内的裸连接先行关闭（客户端断开）→ 收口登记（timer 一并清）
    for (const [id, entry] of this.pairWindowConns) {
      if (entry.conn === conn) {
        clearTimeout(entry.timer)
        this.pairWindowConns.delete(id)
      }
    }
    const deviceId = conn.deviceId
    if (deviceId !== undefined) {
      const set = this.deviceConns.get(deviceId)
      if (set !== undefined) {
        set.delete(conn)
        if (set.size === 0) this.deviceConns.delete(deviceId)
      }
      const graceSet = this.graceAuthedConns.get(deviceId)
      if (graceSet !== undefined) {
        graceSet.delete(conn)
        if (graceSet.size === 0) this.graceAuthedConns.delete(deviceId)
      }
      this.audit.write({ category: 'device', action: 'connection_closed', outcome: 'success', deviceId, detail: { side: 'device', reason: conn.debugCloseReason() } })
      return
    }
    const hostIndex = this.hostConns.indexOf(conn)
    if (hostIndex >= 0) {
      this.hostConns.splice(hostIndex, 1)
      this.audit.write({ category: 'relay', action: 'connection_closed', outcome: 'success', detail: { side: 'host', reason: conn.debugCloseReason() } })
      // 失联 host 上的挂起请求 → RELAY_UPSTREAM_OFFLINE（不再等超时）
      if (!this.hostOnline) this.failAllPendingHostRequests(new RelayError('RELAY_UPSTREAM_OFFLINE', 'host offline; try again later', 30))
    }
  }

  private guardBudget(): void {
    // 容量预算护栏（docs/19 §5.5：≤64 条；超限告警不拒服务——限流与队列上限兜底）
    if (this.connectionCount > this.config.maxWsConnections) {
      this.audit.write({ category: 'relay', action: 'capacity_budget_exceeded', outcome: 'error', detail: { connections: this.connectionCount, budget: this.config.maxWsConnections } })
    }
  }

  private helloFrame(deviceId: number | undefined, hostId: number | undefined): Frame {
    return {
      type: 'hello',
      sequence: this.cache.maxSequence(),
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(hostId !== undefined ? { hostId } : {}),
      heartbeatSec: Math.round(this.config.heartbeatIntervalMs / 1000),
      relayVersion: this.config.relayVersion,
      upstream: this.hostOnline || hostId !== undefined ? 'connected' : 'disconnected',
    }
  }

  // -------------------------------------------------------------------------
  // device leg 帧处理
  // -------------------------------------------------------------------------

  onDeviceText(conn: RelayConnection, text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      conn.sendFrame(errorFrame('BAD_PAYLOAD', 'frames must be JSON text'))
      conn.close(1002, 'frames must be JSON text')
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      conn.close(1002, 'frames must be JSON objects')
      return
    }
    const frame = parsed as Frame
    const type = typeof frame.type === 'string' ? frame.type : ''
    try {
      if (conn.identity.bare) {
        this.handleBareDeviceFrame(conn, type, frame)
        return
      }
      this.handleDeviceFrame(conn, type, frame)
    } catch (err) {
      this.handleBusinessError(conn, err, typeof frame.requestId === 'string' ? frame.requestId : undefined)
    }
  }

  /** 业务级错误只回 error 帧不断连（docs/18 §3.16；协议级违规在解析层已 close）。 */
  private handleBusinessError(conn: RelayConnection, err: unknown, requestId?: string): void {
    const relayError = err instanceof RelayError ? err : new RelayError('INTERNAL', 'relay internal error')
    conn.sendFrame(errorFrame(relayError.code, relayError.message, { requestId, retryAfterSec: relayError.retryAfterSec }))
  }

  /** 裸连接只允许 pair（docs/18 §2：首帧必须 pair；其余帧 → error + close）。 */
  private handleBareDeviceFrame(conn: RelayConnection, type: string, frame: Frame): void {
    if (type !== 'pair') {
      conn.sendFrame(errorFrame('BAD_PAYLOAD', 'unauthenticated device connections may only send the pair frame (docs/18 §2)'))
      conn.close(1002, 'pair required')
      return
    }
    const requestId = asString(frame.requestId, 'requestId')
    const claimed = claimPairing(
      this.store,
      {
        code: String(frame.code ?? ''),
        deviceName: typeof frame.deviceName === 'string' ? frame.deviceName : '',
        platform: typeof frame.platform === 'string' ? frame.platform : '',
      },
      conn.identity.remoteIp,
      this.rateLimits,
      this.audit,
    )
    // 先登记裸连接（pair_accepted 异步回流定位），再中继 pair 到 host
    // （E→H；明文码不出 device leg——E→H 帧无 code 字段，docs/18 §3.2）
    this.barePairingByEcsDevice.set(claimed.ecsDeviceId, conn)
    const relayed = this.sendToHost({
      type: 'pair',
      requestId: randomUUID(),
      ecsDeviceId: claimed.ecsDeviceId,
      pairingId: claimed.pairingId,
      deviceName: claimed.deviceName,
      platform: claimed.platform,
    })
    if (!relayed) {
      // host 离线：码已消费——设备重连后重新配对（新码）。
      this.barePairingByEcsDevice.delete(claimed.ecsDeviceId)
      this.audit.write({ category: 'pairing', action: 'pairing_failed', outcome: 'error', deviceId: claimed.ecsDeviceId, detail: { reason: 'host_offline_after_claim' } })
      conn.sendFrame(errorFrame('RELAY_UPSTREAM_OFFLINE', 'host offline; pairing code was consumed, request a new code and retry', { requestId, retryAfterSec: 30 }))
      return
    }
    // pair 无响应帧（pair_accepted 经 host 异步回流）；裸连接等待期由 barePairTimeout 兜底
  }

  /** ecsDeviceId → 发起配对的裸连接（pair_accepted 定向回流）。 */
  private readonly barePairingByEcsDevice = new Map<number, RelayConnection>()

  private handleDeviceFrame(conn: RelayConnection, type: string, frame: Frame): void {
    const deviceId = conn.deviceId
    if (deviceId === undefined) {
      conn.close(1002, 'unauthenticated connection')
      return
    }
    switch (type) {
      case 'agent_list':
      case 'session_list':
      case 'message':
        this.relayDataRequest(conn, deviceId, type, frame)
        return
      case 'command':
        this.handleCommand(deviceId, frame)
        return
      case 'sync_request':
        this.handleDeviceSyncRequest(conn, deviceId, frame)
        return
      case 'heartbeat':
        this.handleDeviceHeartbeat(conn, deviceId, frame)
        return
      case 'disconnect':
        // 客户端优雅关闭告知（随后必须紧跟 close 帧，docs/18 §3.15）；服务端等待 close
        return
      case 'pair':
        conn.sendFrame(errorFrame('BAD_PAYLOAD', 'device already authenticated; pair is only for bare connections'))
        return
      default:
        conn.sendFrame(errorFrame('BAD_PAYLOAD', `unknown frame type ${JSON.stringify(type)}`))
        conn.close(1002, `unknown frame type (docs/18 §3.16)`)
        return
    }
  }

  /** agent_list / session_list / message → 中继 host（ECS 内部 requestId 路由，回宿回显原 requestId）。 */
  private relayDataRequest(conn: RelayConnection, deviceId: number, type: string, frame: Frame): void {
    const clientRequestId = asString(frame.requestId, 'requestId')
    this.touchDevice(deviceId)
    let outbound: Frame
    if (type === 'session_list') {
      const query = typeof frame.query === 'object' && frame.query !== null ? frame.query : {}
      outbound = { type, requestId: '', query }
    } else if (type === 'message') {
      outbound = {
        type,
        requestId: '',
        sessionId: asNumber(frame.sessionId, 'sessionId', { min: 0 }),
        ...(frame.after !== undefined ? { after: asOptionalNumber(frame.after, 'after', { min: 0 }) } : {}),
        ...(frame.last !== undefined ? { last: asOptionalNumber(frame.last, 'last', { min: 1 }) } : {}),
        ...(frame.before !== undefined ? { before: asOptionalNumber(frame.before, 'before', { min: 0 }) } : {}),
        ...(frame.limit !== undefined ? { limit: asOptionalNumber(frame.limit, 'limit', { min: 1 }) } : {}),
      }
    } else {
      outbound = { type, requestId: '' }
    }
    void this.requestHost(outbound, this.config.relayResponseTimeoutMs).then(
      (response) => {
        if (conn.closed) return
        if (response === null) {
          conn.sendFrame(errorFrame('INTERNAL', 'host returned an empty response', { requestId: clientRequestId }))
          return
        }
        const payload: Frame = { ...response, requestId: clientRequestId }
        if (type === 'session_list' && payload.stale === undefined) payload.stale = false
        conn.sendFrame(payload)
      },
      (err: unknown) => {
        if (conn.closed) return
        const relayError = err instanceof RelayError ? err : new RelayError('INTERNAL', 'relay internal error')
        conn.sendFrame(errorFrame(relayError.code, relayError.message, { requestId: clientRequestId, retryAfterSec: relayError.retryAfterSec }))
      },
    )
  }

  /**
   * command 帧（docs/18 §3.8/§3.9）：幂等去重 → 排队/中继 → queued:true 或 host 回执回流。
   * ECS 不校验 auth、不理解 approve 语义（纯透传，docs/20 §2.2 范围裁决）。
   */
  private handleCommand(deviceId: number, frame: Frame): void {
    const requestId = asString(frame.requestId, 'requestId')
    const idempotencyKey = asString(frame.idempotencyKey, 'idempotencyKey')
    const action = asString(frame.action, 'action')
    if (!(RELAY_ACTIONS as readonly string[]).includes(action)) {
      throw new RelayError('BAD_PAYLOAD', `command.action must be one of ${RELAY_ACTIONS.join('|')}`)
    }
    const sessionId = asOptionalNumber(frame.sessionId, 'sessionId', { min: 0 })
    const payloadJson = frame.payload === undefined ? null : JSON.stringify(frame.payload)
    const fingerprint = JSON.stringify({ action, sessionId, payloadJson })
    this.touchDevice(deviceId)

    const existing = this.store.get<{ id: number; status: string; payload_fingerprint: string; result_json: string | null; requested_at: number }>(
      'SELECT id, status, payload_fingerprint, result_json, requested_at FROM relay_commands WHERE device_id = ? AND idempotency_key = ?',
      deviceId,
      idempotencyKey,
    )
    if (existing !== undefined) {
      if (existing.payload_fingerprint !== fingerprint) {
        // 同 key 异 payload → COMMAND_KEY_CONFLICT（docs/18 §8.2，command_ack rejected 形态）
        this.ackToDevice(deviceId, { type: 'command_ack', requestId, idempotencyKey, status: 'rejected', errorCode: 'COMMAND_KEY_CONFLICT' })
        this.audit.write({ category: 'command', action: 'command_relayed', outcome: 'denied', deviceId, detail: { idempotencyKey, reason: 'key_conflict' } })
        return
      }
      if (['executed', 'rejected', 'expired', 'failed'].includes(existing.status) && existing.result_json !== null) {
        // 同 key 重试返回原结果（docs/14 §B.5 语义原样）
        try {
          const result = JSON.parse(existing.result_json) as Frame
          this.ackToDevice(deviceId, { ...result, idempotencyKey })
          return
        } catch {
          /* 落库结果损坏 → 走重投递路径 */
        }
      }
      if (existing.status === 'queued') {
        if (!this.hostOnline) {
          // 排队态重复 command → 同一 queued 应答（幂等，docs/18 §3.9）；
          // 设备补发帧（QueueReplay，docs/18 §3.8）刷新内存帧——重启后恢复投递的载体
          this.queuedMemory.set(existing.id, { frame, deviceId, requestedAt: existing.requested_at })
          this.store.run('UPDATE relay_commands SET request_id = ? WHERE id = ?', requestId, existing.id)
          this.ackToDevice(deviceId, { type: 'command_ack', requestId, idempotencyKey, status: 'accepted', queued: true })
          return
        }
        // host 已回线：尝试内存帧投递；无内存帧（重启后）等待设备补发帧重试。
        // A⑥ 修复（M3-A⑤ 根因②）：sendToHost true 只代表写入用户态缓冲——僵尸窗口内
        // （host socket 已死、close 未处理）写入仍同步返回 true。因此：
        // ① 不再删除武装帧——真送达由 host 回执清理（handleHostCommandAck，已有逻辑），
        //    僵尸写后行保持 queued + 内存帧在，host 重连 deliverQueuedCommands 重投；
        // ② 无论投递真假都同步 ackToDevice queued:true——幂等且真实（命令此刻确实处于
        //    排队等待态，docs/18 §3.9 queued:true 语义），设备重发即刻获得回执，不再石沉大海。
        const memory = this.queuedMemory.get(existing.id)
        if (memory !== undefined && this.sendToHost(memory.frame)) {
          this.audit.write({ category: 'command', action: 'command_relayed', outcome: 'success', deviceId, detail: { idempotencyKey, replayed: true, armedFrameKept: true } })
        } else if (memory === undefined && this.sendToHost(frame)) {
          // 设备重发帧（QueueReplay）自带完整 auth → 原样中继（武装帧语义一致：真受理
          // 由 host 回执落行；僵尸写则行仍 queued，设备下次重发走本分支或排队应答）
          this.audit.write({ category: 'command', action: 'command_relayed', outcome: 'success', deviceId, detail: { idempotencyKey, replayed: true, source: 'device_resend' } })
        }
        this.ackToDevice(deviceId, { type: 'command_ack', requestId, idempotencyKey, status: 'accepted', queued: true })
        return
      }
      // acked/accepted 中间态：重发帧到 host（Windows 幂等去重兜底）
      if (this.sendToHost(frame)) {
        this.audit.write({ category: 'command', action: 'command_relayed', outcome: 'success', deviceId, detail: { idempotencyKey, replayed: true } })
      } else {
        this.ackToDevice(deviceId, { type: 'command_ack', requestId, idempotencyKey, status: 'accepted', queued: true })
      }
      return
    }

    // 新命令：排队上限检查（docs/18 §3.9：每设备 100 / 全局 1000）
    const queued = this.queuedCounts(deviceId)
    if (queued.perDevice >= this.config.queueLimitPerDevice || queued.global >= this.config.queueLimitGlobal) {
      this.audit.write({ category: 'command', action: 'command_queued', outcome: 'denied', deviceId, detail: { reason: 'queue_full', perDevice: queued.perDevice, global: queued.global } })
      const err = errorFrame('RELAY_QUEUE_FULL', 'command queue is full (per-device 100 / global 1000, docs/18 §3.9)', { requestId })
      this.ackToDevice(deviceId, err)
      return
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const result = this.store.run(
      "INSERT INTO relay_commands (device_id, idempotency_key, action, payload_json, session_ref, request_id, payload_fingerprint, status, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
      deviceId,
      idempotencyKey,
      action,
      payloadJson,
      sessionId === null ? null : `unknown:${sessionId}`,
      requestId,
      fingerprint,
      nowSec,
    )
    const rowId = Number(result.lastInsertRowid)

    // 先武装内存帧再尝试中继——hostOnline 判定存在写入竞态：host socket 已死（RST 到达）
    // 但 close 事件未处理时 sendToHost 仍会同步返回 true，命令走"等 host 异步回 ack"路径后
    // 永无回执。武装后：host 未回 ack 即死 → 行保持 queued + 内存帧在 → 下次 host 上线
    // deliverQueuedCommands 重投（host 幂等去重），设备 QueueReplay 重发也能取到 queued 应答。
    this.queuedMemory.set(rowId, { frame, deviceId, requestedAt: nowSec })
    if (this.hostOnline && this.sendToHost(frame)) {
      // 原样中继（内嵌 auth 纯过境）；ack 由 host 异步回流（回 ack 时清武装，见 handleHostCommandAck）
      this.audit.write({ category: 'command', action: 'command_relayed', outcome: 'success', deviceId, detail: { idempotencyKey, action } })
      return
    }
    // host 离线 → 排队受理（queued:true；内存持有完整帧待投递）
    this.audit.write({ category: 'command', action: 'command_queued', outcome: 'success', deviceId, detail: { idempotencyKey, action, queuedDepth: queued.global + 1 } })
    this.ackToDevice(deviceId, { type: 'command_ack', requestId, idempotencyKey, status: 'accepted', queued: true })
  }

  private queuedCounts(deviceId: number): { perDevice: number; global: number } {
    const globalRow = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM relay_commands WHERE status = 'queued'")
    const perDeviceRow = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM relay_commands WHERE device_id = ? AND status = 'queued'", deviceId)
    return { perDevice: perDeviceRow?.n ?? 0, global: globalRow?.n ?? 0 }
  }

  /** host 重连恢复序②：排队命令按 requested_at 序投递（内存帧；无内存帧的行等设备补发）。 */
  private deliverQueuedCommands(): void {
    const nowSec = Math.floor(Date.now() / 1000)
    const rows = this.store.all<{ id: number; device_id: number; requested_at: number }>(
      "SELECT id, device_id, requested_at FROM relay_commands WHERE status = 'queued' ORDER BY requested_at ASC LIMIT 1000",
    )
    let delivered = 0
    for (const row of rows) {
      if (row.requested_at + this.config.commandTtlSec <= nowSec) continue // 由 sweep 置 expired
      const memory = this.queuedMemory.get(row.id)
      if (memory === undefined) continue
      if (this.sendToHost(memory.frame)) {
        this.queuedMemory.delete(row.id)
        delivered += 1
      }
    }
    if (delivered > 0) {
      this.audit.write({ category: 'command', action: 'command_relayed', outcome: 'success', detail: { queuedDelivery: delivered } })
    }
  }

  /** 排队过期清扫（docs/19 §5.4：queued TTL 300s，过期置 expired 回流）。 */
  sweepExpiredQueued(nowSec: number = Math.floor(Date.now() / 1000)): void {
    const rows = this.store.all<{ id: number; device_id: number; request_id: string | null; idempotency_key: string }>(
      "SELECT id, device_id, request_id, idempotency_key FROM relay_commands WHERE status = 'queued' AND requested_at + ? <= ?",
      this.config.commandTtlSec,
      nowSec,
    )
    for (const row of rows) {
      this.store.run("UPDATE relay_commands SET status = 'expired', result_at = ? WHERE id = ?", nowSec, row.id)
      this.queuedMemory.delete(row.id)
      this.audit.write({ category: 'command', action: 'command_expired', outcome: 'error', deviceId: row.device_id, detail: { idempotencyKey: row.idempotency_key } })
      // 回流：设备在线则 error 帧（COMMAND_EXPIRED，docs/18 §5.2）
      this.ackToDevice(row.device_id, errorFrame('COMMAND_EXPIRED', 'queued command expired before delivery (TTL 300s)', { requestId: row.request_id ?? undefined }))
    }
  }

  /**
   * 宽限过期清扫（docs/18 §3.14「旧 Token 自帧发出起 300s 后失效」）：窗口过期后，
   * 仍以旧凭据存活的连接先收 disconnect{superseded}（§3.15 E→D 合法 reason，设备按
   * 退避重连 → 旧凭据 401 → 重配对路径）再关闭；注册表行消失/已撤销/宽限列已清同样关闭。
   */
  sweepExpiredGrace(nowSec: number = Math.floor(Date.now() / 1000)): void {
    // C7a 修②配套：漏投补偿登记与 grace 窗同寿命，过期即清（明文帧绝不越过窗界存活）
    for (const [deviceId, pending] of this.pendingRotations) {
      if (nowSec >= pending.expiresAtSec) this.pendingRotations.delete(deviceId)
    }
    for (const [deviceId, conns] of this.graceAuthedConns) {
      if (conns.size === 0) {
        this.graceAuthedConns.delete(deviceId)
        continue
      }
      const row = this.store.get<{ grace_expires_at: number | null }>('SELECT grace_expires_at FROM relay_devices WHERE id = ?', deviceId)
      const expired = row === undefined || row.grace_expires_at === null || nowSec >= row.grace_expires_at
      if (!expired) continue
      this.graceAuthedConns.delete(deviceId)
      for (const conn of [...conns]) {
        conn.sendFrame({ type: 'disconnect', reason: 'superseded' })
        conn.close(1000, 'rotation grace window elapsed (docs/18 §3.14)')
      }
      this.audit.write({ category: 'device', action: 'token_rotation_grace_closed', outcome: 'success', deviceId, detail: { connections: conns.size } })
    }
  }

  // -------------------------------------------------------------------------
  // device leg：sync / heartbeat
  // -------------------------------------------------------------------------

  private handleDeviceSyncRequest(conn: RelayConnection, deviceId: number, frame: Frame): void {
    const requestId = asString(frame.requestId, 'requestId')
    const after = asNumber(frame.after, 'after', { min: 0 })
    this.touchDevice(deviceId)
    // ACK 部分中继（E→H：sync_request {after, deviceId}，docs/18 §3.11）
    this.sendToHost({ type: 'sync_request', requestId: randomUUID(), after, deviceId })
    // 补发页（E→D：sequence > after 升序，页上限 100，docs/18 §3.12）
    const page = this.cache.pageSince(after, this.config.syncPageLimit)
    // 空页时 upTo = 缓存水位（暴露 payload 已淘汰区间的 hasGaps；设备本地游标只前进不受回退影响）
    const upTo = page.length > 0 ? page[page.length - 1].sequence : Math.max(this.cache.maxSequence(), after)
    const hasMore = page.length === this.config.syncPageLimit
    const hasGaps = this.cache.hasGapsBetween(after, upTo)
    const events = page.map((row) => this.cachedRowToEventFrame(row, deviceId))
    conn.sendFrame({ type: 'sync_response', requestId, upTo, hasMore, hasGaps, events })
    // ACK 游标只前进（sync_request 本身即累计 ACK，docs/18 §6.2）
    this.advanceAck(deviceId, after)
  }

  private handleDeviceHeartbeat(conn: RelayConnection, deviceId: number, frame: Frame): void {
    const lastAckedSeq = asOptionalNumber(frame.lastAckedSeq, 'lastAckedSeq', { min: 0 })
    if (lastAckedSeq !== null) this.advanceAck(deviceId, lastAckedSeq)
    const tokenVersion = asOptionalNumber(frame.tokenVersion, 'tokenVersion', { min: 0 })
    if (tokenVersion !== null) this.observeDeviceTokenVersion(deviceId, tokenVersion)
    this.touchDevice(deviceId)
    conn.sendFrame({
      type: 'heartbeat',
      ts: Math.floor(Date.now() / 1000),
      upstream: this.hostOnline ? 'connected' : 'disconnected',
      queuedCommands: this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM relay_commands WHERE device_id = ? AND status = 'queued'", deviceId)?.n ?? 0,
    })
  }

  private observeDeviceTokenVersion(deviceId: number, tokenVersion: number): void {
    const row = this.store.get<{ token_version: number }>('SELECT token_version FROM relay_devices WHERE id = ?', deviceId)
    if (row === undefined) return
    if (tokenVersion > row.token_version) {
      // 设备侧先于注册表更新（异常序）：记录审计，不回退（docs/18 §3.14 确认信道）
      this.audit.write({ category: 'device', action: 'token_version_observed_ahead', outcome: 'error', deviceId, detail: { observed: tokenVersion, stored: row.token_version } })
      return
    }
    if (tokenVersion === row.token_version && row.token_version > 1) {
      this.audit.write({ category: 'device', action: 'token_rotation_confirmed', outcome: 'success', deviceId, detail: { tokenVersion } })
    }
  }

  private advanceAck(deviceId: number, sequence: number): void {
    // 只前进（docs/18 §6.2：relay_event_acks 累计游标）
    this.store.run(
      'INSERT INTO relay_event_acks (device_id, acked_through, updated_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET acked_through = MAX(acked_through, excluded.acked_through), updated_at = excluded.updated_at',
      deviceId,
      sequence,
      Math.floor(Date.now() / 1000),
    )
  }

  private touchDevice(deviceId: number): void {
    try {
      this.store.run('UPDATE relay_devices SET last_seen_at = ? WHERE id = ?', Math.floor(Date.now() / 1000), deviceId)
    } catch {
      /* last_seen 更新失败不影响连接面（蓝本 touchDevice 同款） */
    }
  }

  /** host 腿活性触点：heartbeat 帧刷新 relay_hosts.last_seen_at（对齐 touchDevice 写路径，SQL 绑定）。 */
  private touchHost(hostId: number): void {
    try {
      this.store.run('UPDATE relay_hosts SET last_seen_at = ? WHERE id = ?', Math.floor(Date.now() / 1000), hostId)
    } catch {
      /* last_seen 更新失败不影响连接面（touchDevice 同款） */
    }
  }

  /** 缓存行 → E→D event 帧（docs/18 §3.6 全形态；payload 已淘汰的行不进补发页）。 */
  private cachedRowToEventFrame(row: {
    sequence: number
    event_id: string
    type: string
    provider: string | null
    session_ref: string | null
    summary: string | null
    payload_json: string | null
    requires_user_action: number
    created_at: number
  }, deviceId: number): Frame {
    let payload: unknown = {}
    if (row.payload_json !== null) {
      try {
        payload = JSON.parse(row.payload_json)
      } catch {
        payload = {}
      }
    }
    const sessionId = row.session_ref !== null ? Number.parseInt(row.session_ref.slice(row.session_ref.lastIndexOf(':') + 1), 10) : null
    return {
      type: 'event',
      sequence: row.sequence,
      eventId: row.event_id,
      deviceId,
      provider: row.provider,
      sessionId: Number.isSafeInteger(sessionId) ? sessionId : undefined,
      eventType: row.type,
      timestamp: row.created_at,
      ...(row.summary !== null ? { summary: row.summary } : {}),
      payload,
      requiresUserAction: row.requires_user_action === 1,
    }
  }

  // -------------------------------------------------------------------------
  // host leg 帧处理
  // -------------------------------------------------------------------------

  onHostText(conn: RelayConnection, text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      conn.sendFrame(errorFrame('BAD_PAYLOAD', 'frames must be JSON text'))
      conn.close(1002, 'frames must be JSON text')
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      conn.close(1002, 'frames must be JSON objects')
      return
    }
    const frame = parsed as Frame
    const type = typeof frame.type === 'string' ? frame.type : ''
    try {
      this.handleHostFrame(conn, type, frame)
    } catch (err) {
      const relayError = err instanceof RelayError ? err : new RelayError('INTERNAL', 'relay internal error')
      conn.sendFrame(errorFrame(relayError.code, relayError.message, { requestId: typeof frame.requestId === 'string' ? frame.requestId : undefined }))
      if (relayError.code === 'BAD_PAYLOAD') conn.close(1002, relayError.message)
    }
  }

  private handleHostFrame(conn: RelayConnection, type: string, frame: Frame): void {
    switch (type) {
      case 'register_pairing':
        this.handleRegisterPairing(conn, frame)
        return
      case 'pair_accepted':
        this.handlePairAccepted(frame)
        return
      case 'event':
        this.handleHostEvent(frame)
        return
      case 'command_ack':
        this.handleHostCommandAck(frame)
        return
      case 'command_result':
        this.handleHostCommandResult(frame)
        return
      case 'agent_list':
      case 'session_list':
      case 'message':
        this.resolvePendingHostRequest(frame, null)
        return
      case 'error':
        this.resolvePendingHostRequest(frame, frame)
        return
      case 'sync_response':
        // host 腿对齐探测（host 不消费事件，恒空页，docs/18 §3.12）——记录水位即可
        return
      case 'heartbeat':
        // host 心跳刷新 last_seen（C6b 修：此前仅 admit 写入 → last_seen 龄虚高误导排障）
        if (conn.hostId !== undefined) this.touchHost(conn.hostId)
        conn.sendFrame({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000), lastAckedSeq: this.globalAckedThrough() })
        return
      case 'token_rotation':
        this.handleHostTokenRotation(frame)
        return
      case 'disconnect':
        this.handleHostDisconnect(frame)
        return
      default:
        // host 侧未知帧：audit + error（不断连——host 是受信组件，协议违规才断）
        this.audit.write({ category: 'relay', action: 'unknown_host_frame', outcome: 'denied', detail: { frameType: type } })
        conn.sendFrame(errorFrame('BAD_PAYLOAD', `unknown frame type ${JSON.stringify(type)}`))
        return
    }
  }

  /** register_pairing（docs/19 §4.5 pairingBridge：同步 {pairingId, code_hash, expiresAt} 落表）。 */
  private handleRegisterPairing(conn: RelayConnection, frame: Frame): void {
    const requestId = asString(frame.requestId, 'requestId')
    const registered = registerPairing(
      this.store,
      {
        pairingId: String(frame.pairingId ?? ''),
        codeHash: String(frame.codeHash ?? ''),
        expiresAt: typeof frame.expiresAt === 'number' ? frame.expiresAt : Number.NaN,
      },
      Math.floor(Date.now() / 1000),
      this.config.pairingTtlSec,
    )
    this.audit.write({ category: 'pairing', action: 'pairing_code_registered', outcome: 'success', detail: { pairingId: registered.pairingId, expiresAt: registered.expiresAt } })
    conn.sendFrame({ type: 'register_pairing_ack', requestId, pairingId: registered.pairingId, accepted: true, expiresAt: registered.expiresAt })
  }

  /** pair_accepted（docs/18 §3.3）：绑定 Token（sha256 落库）→ E→D 设备视图。 */
  private handlePairAccepted(frame: Frame): void {
    const ecsDeviceId = asNumber(frame.ecsDeviceId, 'ecsDeviceId', { min: 0 })
    const device = typeof frame.device === 'object' && frame.device !== null ? (frame.device as Record<string, unknown>) : null
    const deviceToken = asString(frame.deviceToken, 'deviceToken')
    const winDeviceId = device !== null ? asOptionalNumber(device.deviceId, 'device.deviceId', { min: 0 }) : null
    const tokenVersion = (device !== null ? asOptionalNumber(device.tokenVersion, 'device.tokenVersion', { min: 0 }) : null) ?? 1
    if (ecsDeviceId === null) throw new RelayError('BAD_PAYLOAD', 'pair_accepted.ecsDeviceId is required')
    const pending = findPendingDevice(this.store, ecsDeviceId)
    if (pending === null) {
      throw new RelayError('NOT_FOUND', `pair_accepted: no pending device row for ecsDeviceId ${ecsDeviceId}`)
    }
    const nowSec = Math.floor(Date.now() / 1000)
    // 红线：deviceToken 明文只进 sha256（不落盘/落日志/落审计，docs/19 §3）
    this.store.run(
      'UPDATE relay_devices SET win_device_id = ?, token_hash = ?, token_version = ?, updated_at = ? WHERE id = ?',
      winDeviceId,
      sha256Hex(deviceToken),
      tokenVersion,
      nowSec,
      ecsDeviceId,
    )
    this.audit.write({ category: 'device', action: 'device_paired', outcome: 'success', deviceId: ecsDeviceId, detail: { winDeviceId, tokenVersion, gatewayName: frame.gatewayName } })
    // E→D 设备视图（docs/18 §3.3：去 ECS 内部字段；deviceId = Windows 侧 id）
    const deviceConn = this.barePairingByEcsDevice.get(ecsDeviceId)
    this.barePairingByEcsDevice.delete(ecsDeviceId)
    const outFrame: Frame = {
      type: 'pair_accepted',
      requestId: typeof frame.requestId === 'string' ? frame.requestId : randomUUID(),
      deviceId: winDeviceId ?? ecsDeviceId,
      deviceToken,
      tokenVersion,
      heartbeatSec: Math.round(this.config.heartbeatIntervalMs / 1000),
    }
    if (deviceConn !== undefined && !deviceConn.closed) {
      deviceConn.sendFrame(outFrame)
      // C7a 修①（裸 pair 窗冲刷）：不即刻关闭裸连接——保留短窗（pairRotationFlushMs），
      // 同秒到达的 token_rotation 在关闭前冲刷投递（App 侧 PairLegFrameRouter 接帧；
      // C2d 定案：即刻关闭 + 不注册 deviceConns 曾致轮换帧结构性不可达，缺口 #10）。
      this.openPairRotationWindow(ecsDeviceId, deviceConn)
    }
  }

  /** event 帧（docs/18 §3.6）：缓存幂等插入 + 扇出（deviceId 填充）。 */
  private handleHostEvent(frame: Frame): void {
    const sequence = asNumber(frame.sequence, 'sequence', { min: 1 })
    const eventId = asString(frame.eventId, 'eventId')
    const eventType = asString(frame.eventType, 'eventType')
    const timestamp = asNumber(frame.timestamp, 'timestamp', { min: 0 })
    if (sequence === null || eventId === null || eventType === null || timestamp === null) {
      throw new RelayError('BAD_PAYLOAD', 'event frame requires sequence/eventId/eventType/timestamp')
    }
    const provider = typeof frame.provider === 'string' && frame.provider.length > 0 ? frame.provider : null
    const sessionId = asOptionalNumber(frame.sessionId, 'sessionId', { min: 0 })
    const summary = typeof frame.summary === 'string' ? frame.summary.slice(0, 120) : null
    const payloadJson = frame.payload === undefined ? null : JSON.stringify(frame.payload)
    const requiresUserAction = frame.requiresUserAction === true
    const { inserted } = this.cache.insert(
      { sequence, eventId, type: eventType, provider, sessionId, summary, payloadJson, requiresUserAction, createdAt: timestamp },
    )
    if (!inserted) return // 幂等去重（host 回填重发零重复扇出，docs/19 §4.3）
    // 扇出（E→D：deviceId 必填 = ECS 设备 id，docs/18 §3.6）
    for (const [deviceId, conns] of this.deviceConns) {
      for (const conn of conns) {
        conn.sendFrame({
          type: 'event',
          sequence,
          eventId,
          deviceId,
          ...(provider !== null ? { provider } : {}),
          ...(sessionId !== null ? { sessionId } : {}),
          eventType,
          timestamp,
          ...(summary !== null ? { summary } : {}),
          ...(frame.payload !== undefined ? { payload: frame.payload } : {}),
          requiresUserAction,
        })
      }
    }
  }

  /** command_ack（docs/18 §3.9）：更新幂等行 + 回流设备。 */
  private handleHostCommandAck(frame: Frame): void {
    const idempotencyKey = asString(frame.idempotencyKey, 'idempotencyKey')
    const status = asString(frame.status, 'status')
    const commandId = typeof frame.commandId === 'string' ? frame.commandId : null
    const row = this.findCommandRow(idempotencyKey, frame.requestId)
    const nowSec = Math.floor(Date.now() / 1000)
    if (row !== undefined) {
      const newStatus = status === 'accepted' ? 'accepted' : status === 'rejected' ? 'rejected' : 'acked'
      this.store.run(
        'UPDATE relay_commands SET status = ?, command_id = COALESCE(?, command_id), acked_at = ? WHERE id = ?',
        newStatus,
        commandId,
        nowSec,
        row.id,
      )
      // host 任一回执（accepted/acked/rejected）都证明已收到——清掉中继前武装的内存帧兜底
      this.queuedMemory.delete(row.id)
      this.audit.write({ category: 'command', action: 'command_relayed', outcome: 'success', deviceId: row.device_id, detail: { idempotencyKey, commandId, status } })
    }
    if (row !== undefined) {
      const out: Frame = { ...frame }
      this.ackToDevice(row.device_id, out)
    }
  }

  /** command_result（docs/18 §3.10）：终态落行 + 回流设备（Android 按 commandId 去重）。 */
  private handleHostCommandResult(frame: Frame): void {
    const idempotencyKey = asString(frame.idempotencyKey, 'idempotencyKey')
    const status = asString(frame.status, 'status')
    const row = this.findCommandRow(idempotencyKey, undefined)
    const nowSec = Math.floor(Date.now() / 1000)
    if (row !== undefined) {
      this.store.run(
        'UPDATE relay_commands SET status = ?, command_id = COALESCE(?, command_id), result_at = ?, result_json = ? WHERE id = ?',
        ['executed', 'rejected', 'expired', 'failed'].includes(status) ? status : 'failed',
        typeof frame.commandId === 'string' ? frame.commandId : null,
        nowSec,
        JSON.stringify(frame),
        row.id,
      )
      this.queuedMemory.delete(row.id)
      this.audit.write({ category: 'command', action: 'command_relayed', outcome: 'success', deviceId: row.device_id, detail: { idempotencyKey, commandId: frame.commandId, finalStatus: status } })
      const out: Frame = { ...frame }
      this.ackToDevice(row.device_id, out)
    }
  }

  private findCommandRow(idempotencyKey: string, requestId: unknown): { id: number; device_id: number } | undefined {
    if (typeof requestId === 'string' && requestId.length > 0) {
      const byRequest = this.store.get<{ id: number; device_id: number }>(
        'SELECT id, device_id FROM relay_commands WHERE request_id = ? ORDER BY id DESC LIMIT 1',
        requestId,
      )
      if (byRequest !== undefined) return byRequest
    }
    // 幂等键跨设备撞名兜底：取最近一行（单 host 部署下实际唯一）
    return this.store.get<{ id: number; device_id: number }>(
      'SELECT id, device_id FROM relay_commands WHERE idempotency_key = ? ORDER BY id DESC LIMIT 1',
      idempotencyKey,
    )
  }

  /**
   * token_rotation（docs/18 §3.14）：注册表同步（sha256(newToken) + token_version）+ E→D 转发
   * + 旧哈希宽限（grace_token_hash/grace_expires_at，帧发出起 rotationGraceSec 内旧凭据仍可
   * 鉴权，窗后 401 → 重配对路径；README 偏离单 #11）。
   * 路由需求：帧必须携带 deviceId（Windows 侧设备 id）——docs/18 §3.14 帧形未含该字段
   * （README 偏离单 #2）。M3-C3b 修2 单一语义：仅 win_device_id 命中才路由；未命中
   * （含与 relay_devices.id 撞号）→ 审计 mismatch + NOT_FOUND，绝不按行 id 兜底错位轮换。
   */
  private handleHostTokenRotation(frame: Frame): void {
    const newToken = asString(frame.newToken, 'newToken')
    const tokenVersion = asNumber(frame.tokenVersion, 'tokenVersion', { min: 1 })
    const winDeviceId = asOptionalNumber(frame.deviceId, 'deviceId', { min: 0 })
    const reason = typeof frame.reason === 'string' ? frame.reason : 'unspecified'
    if (winDeviceId === null) {
      this.audit.write({ category: 'device', action: 'token_rotation_dropped', outcome: 'denied', detail: { reason: 'missing_deviceId' } })
      throw new RelayError('BAD_PAYLOAD', 'token_rotation requires deviceId for registry routing (docs/19 §2.4 两平面凭据同步)')
    }
    const row = this.store.get<{ id: number; token_hash: string }>(
      'SELECT id, token_hash FROM relay_devices WHERE win_device_id = ? AND status = \'active\'',
      winDeviceId,
    )
    if (row === undefined) {
      this.audit.write({ category: 'device', action: 'token_rotation_route_mismatch', outcome: 'denied', detail: { deviceId: winDeviceId, reason: 'no_row_with_win_device_id' } })
      throw new RelayError('NOT_FOUND', `token_rotation: no active device with win_device_id ${winDeviceId}`)
    }
    const nowSec = Math.floor(Date.now() / 1000)
    // 红线：newToken 明文只进 sha256（不落盘/落日志/落审计）；旧哈希原值转入 grace 列（同为 sha256）
    this.store.run(
      'UPDATE relay_devices SET grace_token_hash = ?, grace_expires_at = ?, token_hash = ?, token_version = ?, updated_at = ? WHERE id = ?',
      row.token_hash,
      nowSec + this.config.rotationGraceSec,
      sha256Hex(newToken),
      tokenVersion,
      nowSec,
      row.id,
    )
    this.audit.write({ category: 'device', action: 'token_rotation_applied', outcome: 'success', deviceId: row.id, detail: { tokenVersion, reason, graceSec: this.config.rotationGraceSec } })
    const out: Frame = {
      type: 'token_rotation',
      requestId: typeof frame.requestId === 'string' ? frame.requestId : randomUUID(),
      newToken,
      tokenVersion,
      reason,
    }
    // 投递三路（C7a 定案「零新帧」：轮换帧允许投递于该设备任一活跃 device-leg 连接）：
    // ① 已鉴权连接直投（契约路径）；② pair 冲刷窗内的裸连接关闭前冲刷（C7a 修①）；
    // ③ 两路皆不可达 → 登记内存补偿表（C7a 修②安全网），grace 窗内重连即补投。
    let deliveredToRegistered = false
    const conns = this.deviceConns.get(row.id)
    if (conns !== undefined) {
      for (const conn of conns) {
        if (conn.sendFrame(out)) deliveredToRegistered = true
      }
    }
    if (deliveredToRegistered) {
      // 直投成功 = 契约路径已覆盖；撤销补偿登记（设备已持当前版本的正信号由
      // 新凭据准入再确认，此前残留登记一并清除）
      this.pendingRotations.delete(row.id)
    } else {
      const pairEntry = this.pairWindowConns.get(row.id)
      if (pairEntry !== undefined && !pairEntry.conn.closed && pairEntry.conn.sendFrame(out)) {
        this.closePairRotationWindow(row.id, true, 'token_rotation flushed on pair leg; reconnect with new token')
        this.audit.write({ category: 'device', action: 'token_rotation_flushed', outcome: 'success', deviceId: row.id, detail: { source: 'pair-window', tokenVersion } })
      }
      // 明文帧仅内存（绝不落盘/落日志/落审计）；寿命 = grace 窗（与 grace_expires_at 同源）
      this.pendingRotations.set(row.id, { frame: out, tokenVersion, expiresAtSec: nowSec + this.config.rotationGraceSec })
    }
  }

  /**
   * disconnect（docs/18 §3.15）：撤销定点踢线 + 注册表同步。
   * M3-C3b 修2 单一语义（docs/18 §3.15 撤销链路 + pair_accepted 设备视图「deviceId =
   * Windows 侧 id」）：仅 win_device_id 命中才路由；未命中（含与 relay_devices.id 空间
   * 撞号）→ 丢弃 + 审计 mismatch（C2 #6：行 id 兜底曾致撤销错位 relay_devices.id=1）。
   */
  private handleHostDisconnect(frame: Frame): void {
    const reason = typeof frame.reason === 'string' ? frame.reason : 'revoked'
    const deviceIdRaw = asOptionalNumber(frame.deviceId, 'deviceId', { min: 0 })
    if (deviceIdRaw === null) return
    const row = this.store.get<{ id: number }>('SELECT id FROM relay_devices WHERE win_device_id = ?', deviceIdRaw)
    if (row === undefined) {
      this.audit.write({ category: 'device', action: 'device_disconnect_mismatch', outcome: 'denied', detail: { deviceId: deviceIdRaw, reason: 'no_row_with_win_device_id', frameReason: reason } })
      return
    }
    if (reason === 'revoked') {
      const nowSec = Math.floor(Date.now() / 1000)
      this.store.run("UPDATE relay_devices SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?", nowSec, nowSec, row.id)
      this.audit.write({ category: 'device', action: 'device_revoked', outcome: 'success', deviceId: row.id, detail: { source: 'host_disconnect' } })
      // 撤销即拒（C7a 红线配套）：漏投补偿登记与 pair 冲刷窗一并作废——已撤销设备
      // 绝不在此后经任何路径取得轮换帧
      this.pendingRotations.delete(row.id)
      this.closePairRotationWindow(row.id, true, 'device revoked')
    }
    const conns = this.deviceConns.get(row.id)
    if (conns !== undefined) {
      for (const conn of [...conns]) {
        conn.sendFrame({ type: 'disconnect', reason })
        conn.close(1000, `disconnect (${reason})`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // host 请求-响应原语（REST / 设备数据帧共用）
  // -------------------------------------------------------------------------

  /** 发送帧到 host（取最新连接——滚动重启场景新连接为健康面）。 */
  sendToHost(frame: Frame): boolean {
    const conn = this.hostConns[this.hostConns.length - 1]
    if (conn === undefined) return false
    return conn.sendFrame(frame)
  }

  /**
   * host 请求-响应（agent_list/session_list/message）：内部 requestId 关联，超时
   * RELAY_UPSTREAM_TIMEOUT（docs/18 §3.0 帧超时表），host 离线 RELAY_UPSTREAM_OFFLINE。
   */
  requestHost(frame: Frame, timeoutMs: number): Promise<Frame | null> {
    if (!this.hostOnline) {
      return Promise.reject(new RelayError('RELAY_UPSTREAM_OFFLINE', 'host offline; try again later', 30))
    }
    const requestId = randomUUID()
    return new Promise<Frame | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHostRequests.delete(requestId)
        reject(new RelayError('RELAY_UPSTREAM_TIMEOUT', 'host response timed out (frame timeout table, docs/18 §3.0)', 30))
      }, timeoutMs)
      timer.unref?.()
      this.pendingHostRequests.set(requestId, {
        requestId,
        respond: (response, error) => {
          clearTimeout(timer)
          if (error !== null) reject(error)
          else resolve(response)
        },
        timer,
      })
      const sent = this.sendToHost({ ...frame, requestId })
      if (!sent) {
        this.pendingHostRequests.delete(requestId)
        clearTimeout(timer)
        reject(new RelayError('RELAY_UPSTREAM_OFFLINE', 'host offline; try again later', 30))
      }
    })
  }

  private resolvePendingHostRequest(frame: Frame, errorFrameValue: Frame | null): void {
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : ''
    const pending = this.pendingHostRequests.get(requestId)
    if (pending === undefined) return
    this.pendingHostRequests.delete(requestId)
    if (errorFrameValue !== null) {
      const code = typeof errorFrameValue.code === 'string' ? errorFrameValue.code : 'INTERNAL'
      const message = typeof errorFrameValue.message === 'string' ? errorFrameValue.message : 'host error'
      pending.respond(null, new RelayError(code, message))
      return
    }
    pending.respond(frame, null)
  }

  private failAllPendingHostRequests(error: RelayError): void {
    for (const pending of [...this.pendingHostRequests.values()]) {
      this.pendingHostRequests.delete(pending.requestId)
      pending.respond(null, error)
    }
  }

  private ackToDevice(deviceId: number, frame: Frame): void {
    const conns = this.deviceConns.get(deviceId)
    if (conns === undefined) return
    for (const conn of conns) conn.sendFrame(frame)
  }

  private globalAckedThrough(): number {
    return this.store.get<{ n: number | null }>('SELECT MIN(acked_through) AS n FROM relay_event_acks')?.n ?? 0
  }

  /** 优雅停机：断连告知（server_shutdown）→ 关连接 → 停 timer（docs/18 §3.15）。 */
  shutdown(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    // pair 冲刷窗 timer 一并清（裸连接属 bareConns，由下方循环统一断连告知）
    for (const id of [...this.pairWindowConns.keys()]) this.closePairRotationWindow(id, false)
    for (const [deviceId, conns] of this.deviceConns) {
      for (const conn of conns) {
        conn.sendFrame({ type: 'disconnect', reason: 'server_shutdown' })
        conn.close(1000, 'server shutdown')
      }
      void deviceId
    }
    for (const conn of this.bareConns) {
      conn.sendFrame({ type: 'disconnect', reason: 'server_shutdown' })
      conn.close(1000, 'server shutdown')
    }
    for (const conn of [...this.hostConns]) {
      conn.sendFrame({ type: 'disconnect', reason: 'server_shutdown' })
      conn.close(1000, 'server shutdown')
    }
    this.failAllPendingHostRequests(new RelayError('RELAY_UPSTREAM_OFFLINE', 'relay is shutting down'))
  }

  /** 测试探针：排队命令内存帧数。 */
  debugQueuedMemoryCount(): number {
    return this.queuedMemory.size
  }

  /** 测试探针：漏投轮换补偿登记数（C7a 修②；明文帧内容绝不外泄，仅计数）。 */
  debugPendingRotationCount(): number {
    return this.pendingRotations.size
  }
}
