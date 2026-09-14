/**
 * ws.ts — 自研轻量 WebSocket 服务端（零新依赖，docs/12 §9 裁决默认自研；
 * RFC 6455 服务端子集，docs/14 §B.2 协议）。
 *
 * 握手（node:http upgrade 事件挂载，docs/14 §B.2 连接鉴权行）：
 * - 仅接受 Sec-WebSocket-Key + Sec-WebSocket-Version: 13；
 * - Sec-WebSocket-Accept = base64(sha1(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))；
 * - 鉴权 = upgrade 头 Authorization: Bearer <deviceToken>（authenticate 管道）；
 *   无效/撤销 → 以 HTTP 401 结构化错误响应后拒绝升级（socket 销毁）。
 *
 * 帧编解码（RFC 6455）：
 * - 解析：FIN/RSV/opcode、MASK、长度 7/16/64 bit、掩码键、分片续帧（opcode 0 =
 *   continuation，FIN=1 收口）；客户端帧必带掩码（无掩码 → 1002 关闭）；
 *   opcode：1 text / 2 binary / 8 close / 9 ping / 10 pong；RSV ≠ 0 → 1002；
 *   帧上限 1MB、消息上限 1MB（超限 1009）；close 回显后断开；ping → pong 回显。
 * - 编码：服务端发送一律不掩码（RFC 6455 §5.1）。
 *
 * 协议（docs/14 §B.2）：
 * - hello 首帧：{ type:'hello', sequence, device, heartbeatSec }；
 * - sync：客户端 { type:'sync', after } → 服务端把 sequence > after 且对该设备
 *   未 ack 的事件按序补发（eventsSince；未确认不删——裁决 5）；
 * - event 帧：{ type:'event', seq, eventId, eventType, sessionId?, summary?, payload, createdAt }；
 * - ack：客户端 { type:'ack', seqs:number[] } → markEventAcked（批量，只前进；
 *   REST POST /v1/events/{id}/ack 等效）；
 * - 心跳：服务端每 heartbeatSec（默认 30s）发 ping，pongTimeoutSec（默认 10s）
 *   内无 pong → 服务端关闭；客户端 ping 一律回 pong；
 * - 命令帧（X-L 批，docs/18 §5.3.2）：客户端 { type:'command', requestId?,
 *   idempotencyKey, action:'workspace_link', payload:{} } → 本地命令下行
 *   （localCommand.ts；与 relay 同一 L3 台账，ack/result 结构化回声——绝不静默）；
 * - 预留帧 token_rotation：仅类型定义（ServerFrame 联合），v1 绝不发送（docs/15 §3；
 *   与本地命令面零夹带——红线 docs/18 §5.3.2）；
 * - 撤销断连：closeDeviceConnections(deviceId) 由 L3 撤销路径经注入缝触发
 *   （docs/15 §4：已建立连接服务端立即关闭）。
 *
 * 投递语义（docs/12 §6 裁决 5）：event 帧写 socket 成功 → markEventDelivered
 * （pending → delivered，只前进）；投递失败不回滚 DB（重连 sync 补发兜底）。
 * electron-free：node:crypto / node:http 类型 / node:stream 类型；本模块零写库
 * 之外还经 L3 touchDeviceLastSeen 节流更新 last_seen（写路径全部经 L3 函数）。
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { logger } from '../../../core/logger.ts'
import { ServiceError } from '../../internal.ts'
import { authenticateBearerToken, readBearerHeaderValue, type AuthenticatedDevice } from './auth.ts'
import { handleLocalCommand } from './localCommand.ts'
import {
  currentGlobalSequence,
  eventsSince,
  markEventAcked,
  markEventDelivered,
  EVENTS_SINCE_DEFAULT_LIMIT,
} from '../eventPipeline.ts'
import { touchDeviceLastSeen } from '../agentControlService.ts'

/** last_seen 触达（节流写在 L3 touchDeviceLastSeen；失败不影响连接面）。 */
function touchDevice(deviceId: number): void {
  try {
    touchDeviceLastSeen(deviceId)
  } catch {
    /* last_seen 更新失败不影响连接面 */
  }
}

// ---------------------------------------------------------------------------
// 帧编解码原语
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** 单帧/单消息上限（1MB；防滥用，docs/14 Part B 的 JSON 面远小于此）。 */
export const WS_MAX_MESSAGE_BYTES = 1024 * 1024

const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** 服务端发送帧编码（不掩码）：FIN + opcode + 7/16/64 bit 长度。 */
function encodeServerFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  const len = payload.length
  if (len < 126) {
    return Buffer.concat([Buffer.from([firstByte, len]), payload])
  }
  if (len <= 0xffff) {
    const header = Buffer.alloc(4)
    header[0] = firstByte
    header[1] = 126
    header.writeUInt16BE(len, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = firstByte
  header[1] = 127
  header.writeBigUInt64BE(BigInt(len), 2)
  return Buffer.concat([header, payload])
}

/** Sec-WebSocket-Accept 派生（RFC 6455 §4.2.2）。 */
export function computeAcceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID, 'utf8').digest('base64')
}

// ---------------------------------------------------------------------------
// 协议帧类型（docs/14 §B.2）
// ---------------------------------------------------------------------------

/** 客户端 → 服务端帧（sync / ack / command；token_rotation 的回 ack 属预留，v1 不出现）。 */
export type ClientFrame =
  | { type: 'sync'; after: number }
  | { type: 'ack'; seqs: number[] }
  /**
   * 本地命令帧（X-L 批，docs/18 §5.3.2）：v1 唯一 action='workspace_link'。
   * 零 auth 块——连接 upgrade 时已 Bearer 鉴权（本文件头），deviceId 即发起设备。
   */
  | {
      type: 'command'
      requestId?: string
      idempotencyKey: string
      action: string
      sessionId?: number
      payload?: Record<string, unknown>
    }
  | { type: string; [key: string]: unknown }

/** 服务端 → 客户端帧（hello / event / command_ack / command_result / token_rotation 预留）。 */
export type ServerFrame =
  | { type: 'hello'; sequence: number; device: number; heartbeatSec: number }
  | {
      type: 'event'
      seq: number
      eventId: string
      eventType: string
      sessionId?: number
      summary?: string
      payload: Record<string, unknown>
      createdAt: number
    }
  /** 本地命令受理回执（docs/18 §5.3.2；§3.9 同域语义本地形态）。 */
  | {
      type: 'command_ack'
      requestId?: string
      idempotencyKey?: string
      commandId?: string
      status: 'accepted' | 'rejected'
      errorCode?: string
    }
  /**
   * 本地命令终态（docs/18 §5.3.2；§3.10 同域语义本地形态）。result 仅
   * workspace_link executed 携带——URL 帧面内存过境（零落库零日志红线）。
   */
  | {
      type: 'command_result'
      requestId?: string
      commandId: string
      idempotencyKey: string
      action: string
      status: 'executed' | 'failed'
      errorCode: string | null
      result?: { provider: string; url: string; deviceName: string }
      timestamp: number
    }
  /** 协议预留帧（docs/14 §B.2 / docs/15 §3）：v1 绝不发送，仅锁类型形状。 */
  | { type: 'token_rotation'; newToken: string; tokenVersion: number }

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

export interface WsConnectionHooks {
  onText(connection: GatewayWsConnection, text: string): void
  onClosed(connection: GatewayWsConnection): void
}

export class GatewayWsConnection {
  /** 关闭握手已启动；此后不再发送任何帧。 */
  closed = false
  /** 服务端主动关闭原因（日志用，零凭据）。 */
  closeReason: string | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: { chunks: Buffer[]; total: number } | null = null
  private awaitingPong = false
  private lastPingAt = 0

  // 显式字段赋值（不用 TS 参数属性——Node strip-only 模式不支持
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，smoke 系统 Node 直载 .ts 必须 strip-only 可加载）
  readonly deviceId: number
  readonly deviceName: string
  private readonly socket: Duplex
  private readonly hooks: WsConnectionHooks
  private readonly pongTimeoutMs: number

  constructor(
    deviceId: number,
    deviceName: string,
    socket: Duplex,
    hooks: WsConnectionHooks,
    heartbeatIntervalMs: number,
    pongTimeoutMs: number,
  ) {
    this.deviceId = deviceId
    this.deviceName = deviceName
    this.socket = socket
    this.hooks = hooks
    this.pongTimeoutMs = pongTimeoutMs
    // heartbeatIntervalMs 由注册表侧 setInterval 驱动（connection.heartbeatTick），
    // 连接自身只消费 pongTimeoutMs（docs/14 §B.2 心跳行）。
    void heartbeatIntervalMs
  }

  /**
   * 服务端文本帧（JSON 协议帧）。写失败（连接已关闭 / write 抛异常）返回 false，不抛
   * （投递失败不回滚 DB）。夜间#1 修复（ux-final-report §4.3/§8）：socket.write 返回
   * false 表示数据已接受进用户态缓冲、随后必然冲刷（TCP 背压），并非失败 —— 旧实现
   * 把 false 当"未发出"会漏掉 markEventDelivered（慢链路/隧道场景投递标记缺失）。
   * 现在「写调用未抛异常」即视为已发出（docs/12 §6「event 帧写 socket 成功 →
   * markEventDelivered」语义）。
   */
  sendFrame(frame: ServerFrame): boolean {
    if (this.closed) return false
    try {
      this.socket.write(encodeServerFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(frame), 'utf8')))
      return true
    } catch {
      return false
    }
  }

  ping(): void {
    if (this.closed) return
    try {
      this.socket.write(encodeServerFrame(OPCODE_PING, Buffer.from(randomUUID().slice(0, 8), 'utf8')))
      this.awaitingPong = true
      this.lastPingAt = Date.now()
    } catch {
      /* socket 已死 → 等待 close 回调清理 */
    }
  }

  /** 服务端关闭握手（close 帧携带状态码 → 短冲刷窗口后销毁）。 */
  close(code = 1000, reason = 'server close'): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    try {
      const codeBuf = Buffer.alloc(2)
      codeBuf.writeUInt16BE(code & 0xffff, 0)
      this.socket.write(encodeServerFrame(OPCODE_CLOSE, codeBuf))
    } catch {
      /* 忽略写失败 */
    }
    const socket = this.socket
    setTimeout(() => {
      socket.destroy()
    }, 50)
  }

  /** 心跳节拍（连接级 timer 由注册表驱动）：上次 ping 无 pong 且超时 → 关闭。 */
  heartbeatTick(): void {
    if (this.closed) return
    const now = Date.now()
    if (this.awaitingPong && now - this.lastPingAt >= this.pongTimeoutMs) {
      this.close(1000, 'heartbeat timeout (no pong within window, docs/14 B.2)')
      return
    }
    this.ping()
  }

  /** socket 数据入口：增量缓冲 + 帧解析循环。 */
  feed(data: Buffer): void {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data])
    while (true) {
      const frame = this.tryParseFrame()
      if (frame === null) break
      if (frame === 'protocol-error') {
        this.close(1002, 'protocol error (unmasked client frame / bad RSV)')
        return
      }
      if (frame === 'too-large') {
        this.close(1009, 'frame exceeds 1MB limit')
        return
      }
      this.handleFrame(frame.opcode, frame.payload, frame.fin)
      if (this.closed) return
    }
  }

  /** 解析一帧；数据不足 → null；协议违规 → 'protocol-error'；超限 → 'too-large'。 */
  private tryParseFrame():
    | null
    | 'protocol-error'
    | 'too-large'
    | { opcode: number; payload: Buffer; fin: boolean } {
    const buf = this.buffer
    if (buf.length < 2) return null
    const fin = (buf[0] & 0x80) !== 0
    const rsv = buf[0] & 0x70
    const opcode = buf[0] & 0x0f
    let length = buf[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < offset + 2) return null
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return null
      const big = buf.readBigUInt64BE(offset)
      if (big > BigInt(WS_MAX_MESSAGE_BYTES)) return 'too-large'
      length = Number(big)
      offset += 8
    }
    if (length > WS_MAX_MESSAGE_BYTES) return 'too-large'
    if ((buf[1] & 0x80) === 0) return 'protocol-error' // 客户端帧必带掩码（RFC 6455 §5.1）
    if (rsv !== 0) return 'protocol-error'
    if (buf.length < offset + 4) return null
    const maskKey = buf.subarray(offset, offset + 4)
    offset += 4
    if (buf.length < offset + length) return null
    const payload = Buffer.from(buf.subarray(offset, offset + length))
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= maskKey[i % 4]
    }
    this.buffer = buf.subarray(offset + length)
    return { opcode, payload, fin }
  }

  private handleFrame(opcode: number, payload: Buffer, fin: boolean): void {
    switch (opcode) {
      case OPCODE_CLOSE: {
        // 回显 close（客户端 code）后断开；teardown 由 socket close 事件驱动
        this.closed = true
        try {
          const echo = Buffer.alloc(2)
          if (payload.length >= 2) echo.writeUInt16BE(payload.readUInt16BE(0), 0)
          this.socket.write(encodeServerFrame(OPCODE_CLOSE, echo))
        } catch {
          /* 忽略 */
        }
        this.socket.destroy()
        return
      }
      case OPCODE_PING:
        if (!fin) {
          this.close(1002, 'fragmented control frame')
          return
        }
        try {
          this.socket.write(encodeServerFrame(OPCODE_PONG, payload))
        } catch {
          /* 忽略 */
        }
        return
      case OPCODE_PONG:
        this.awaitingPong = false
        return
      case OPCODE_TEXT:
      case OPCODE_BINARY: {
        const acc = this.fragments ?? { chunks: [], total: 0 }
        acc.chunks.push(payload)
        acc.total += payload.length
        if (acc.total > WS_MAX_MESSAGE_BYTES) {
          this.fragments = null
          this.close(1009, 'message exceeds 1MB limit')
          return
        }
        if (!fin) {
          this.fragments = acc
          return
        }
        this.fragments = null
        const whole = Buffer.concat(acc.chunks)
        if (opcode === OPCODE_BINARY) {
          if (whole.length > 0) this.close(1003, 'binary protocol frames unsupported (JSON text only)')
          return
        }
        try {
          this.hooks.onText(this, whole.toString('utf8'))
        } catch {
          /* 协议处理异常不杀伤连接循环（逐帧隔离） */
        }
        return
      }
      case OPCODE_CONTINUATION: {
        if (this.fragments === null) {
          this.close(1002, 'continuation frame without started fragment')
          return
        }
        this.fragments.chunks.push(payload)
        this.fragments.total += payload.length
        if (this.fragments.total > WS_MAX_MESSAGE_BYTES) {
          this.fragments = null
          this.close(1009, 'message exceeds 1MB limit')
          return
        }
        if (fin) {
          const whole = Buffer.concat(this.fragments.chunks)
          this.fragments = null
          try {
            this.hooks.onText(this, whole.toString('utf8'))
          } catch {
            /* 逐帧隔离 */
          }
        }
        return
      }
      default:
        this.close(1002, `unknown opcode ${opcode}`)
    }
  }

  /** smoke/测试探针：服务端感知到的关闭原因（零凭据）。 */
  debugCloseReason(): string | null {
    return this.closeReason
  }

  /** socket 关闭清理入口（注册表回收 + 心跳 timer 停止）。 */
  teardown(): void {
    this.closed = true
    this.hooks.onClosed(this)
  }
}

// ---------------------------------------------------------------------------
// WS 服务端（upgrade 挂载 + 连接注册表 + 协议处理）
// ---------------------------------------------------------------------------

export interface GatewayWsOptions {
  heartbeatIntervalMs?: number
  pongTimeoutMs?: number
}

export interface GatewayWsHandle {
  /** 连接中设备数（去重）。 */
  connectedDevices(): number
  /** 活跃连接数（同设备多连接分别计）。 */
  activeConnections(): number
  /** 撤销/停机：立即服务端关闭该设备全部连接（docs/15 §4）。 */
  closeDeviceConnections(deviceId: number, reason: string): void
  /** 事件推送（eventPipeline 投递回调接线）；发送成功 → markEventDelivered。 */
  pushEvent(event: {
    sequence: number
    eventId: string
    eventType: string
    payload: Record<string, unknown>
    sessionId: number | null
    summary?: string | null
    createdAt: number
  }): void
  closeAll(reason: string): void
}

const WS_PATH = '/v1/events'

/**
 * 挂载到 node:http server 的 upgrade 事件（docs/12 §9：自研轻量 WS）。
 * 鉴权失败/版本不匹配 → HTTP 401/400 结构化错误 + 拒绝升级；成功 → 101 切换
 * 协议、注册连接、发 hello 首帧并启动心跳 timer。
 */
export function attachWebSocketServer(server: HttpServer, options: GatewayWsOptions = {}): GatewayWsHandle {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000
  const pongTimeoutMs = options.pongTimeoutMs ?? 10_000
  /** deviceId → 连接集合（同设备允许多连接；撤销全断）。 */
  const registry = new Map<number, Set<GatewayWsConnection>>()
  /** 心跳 timer per connection（teardown 时 clear）。 */
  const heartbeatTimers = new Map<GatewayWsConnection, NodeJS.Timeout>()

  function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
    // AC6 修复（崩溃根因）：upgrade 被拒 socket 无默认 error 处理（node:http 的
    // clientError 面只覆盖普通请求，upgrade socket 交给本回调）。对端在读走响应前
    // 重置连接（ECONNRESET/EPIPE）属预期竞争——挂 handler 记结构化日志（零凭据，
    // docs/15 §6），绝不让未处理 'error' 事件以 uncaughtException 带崩 Main 进程。
    socket.on('error', (err: Error) => {
      logger.warn(`gateway ws: rejected-upgrade socket error (${err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : err.message})`)
      socket.destroy()
    })
    const body = JSON.stringify({ error: { code, message } })
    // 先冲刷结构化错误响应再销毁（立即 destroy 会截断响应——客户端只见 ECONNRESET）
    socket.end(
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\n` +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n' +
        '\r\n' +
        body,
      () => {
        socket.destroy()
      },
    )
  }

  function releaseConnection(connection: GatewayWsConnection): void {
    const timer = heartbeatTimers.get(connection)
    if (timer !== undefined) {
      clearInterval(timer)
      heartbeatTimers.delete(connection)
    }
    const set = registry.get(connection.deviceId)
    if (set !== undefined) {
      set.delete(connection)
      if (set.size === 0) registry.delete(connection.deviceId)
    }
  }

  const hooks: WsConnectionHooks = {
    onText(connection, text) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        connection.close(1002, 'frames must be JSON text')
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        connection.close(1002, 'frames must be JSON objects')
        return
      }
      const frame = parsed as ClientFrame
      if (frame.type === 'sync') {
        const after = (frame as { after?: unknown }).after
        if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
          connection.close(1002, 'sync.after must be a non-negative integer')
          return
        }
        const page = eventsSince(after, connection.deviceId, EVENTS_SINCE_DEFAULT_LIMIT)
        for (const row of page.events) {
          const sent = connection.sendFrame({
            type: 'event',
            seq: row.sequence,
            eventId: row.eventId,
            eventType: row.eventType,
            ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
            ...(row.summary !== null ? { summary: row.summary } : {}),
            payload: row.payload,
            createdAt: row.createdAt,
          })
          if (sent) markEventDelivered(row.sequence, connection.deviceId)
        }
        return
      }
      if (frame.type === 'ack') {
        const seqs = (frame as { seqs?: unknown }).seqs
        if (
          !Array.isArray(seqs) ||
          seqs.length > 500 ||
          seqs.some((s) => typeof s !== 'number' || !Number.isSafeInteger(s) || s <= 0)
        ) {
          connection.close(1002, 'ack.seqs must be an array of positive integers (≤500)')
          return
        }
        for (const seq of seqs) {
          try {
            markEventAcked(seq, connection.deviceId)
          } catch {
            // 事件不存在/已 ack：只前进语义下的合法 no-op（不回滚、不断连）
          }
        }
        touchDevice(connection.deviceId)
        return
      }
      if (frame.type === 'command') {
        // 本地命令下行（X-L 批，docs/18 §5.3.2）：结构化受理/拒绝回声绝不再静默忽略
        // （U4 根因反例——workspace_link 帧无声消失致 App 结构性恒 Queued）。处理与
        // 回帧全在 localCommand.ts（单帧异常经 onText 逐帧隔离，不杀伤连接）。
        handleLocalCommand(connection, frame)
        return
      }
      // 未知类型（含 token_rotation 回 ack 等预留）：v1 静默忽略，不断连
    },
    onClosed(connection) {
      releaseConnection(connection)
    },
  }

  function completeUpgrade(socket: Duplex, device: AuthenticatedDevice, clientKey: string): GatewayWsConnection {
    const accept = computeAcceptKey(clientKey)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    )
    const connection = new GatewayWsConnection(device.id, device.deviceName, socket, hooks, heartbeatIntervalMs, pongTimeoutMs)
    let set = registry.get(device.id)
    if (set === undefined) {
      set = new Set<GatewayWsConnection>()
      registry.set(device.id, set)
    }
    set.add(connection)
    const timer = setInterval(() => {
      connection.heartbeatTick()
    }, heartbeatIntervalMs)
    heartbeatTimers.set(connection, timer)
    // hello 首帧（docs/14 §B.2：当前全局 sequence + 设备 + 心跳秒）
    connection.sendFrame({
      type: 'hello',
      sequence: currentGlobalSequence(),
      device: device.id,
      heartbeatSec: Math.round(heartbeatIntervalMs / 1000),
    })
    return connection
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://gateway.internal').pathname
    } catch {
      rejectUpgrade(socket, 400, 'BAD_PAYLOAD', 'gateway ws: malformed upgrade URL')
      return
    }
    if (pathname !== WS_PATH) {
      rejectUpgrade(socket, 400, 'NOT_FOUND', `gateway ws: unknown upgrade path ${pathname} (expected ${WS_PATH})`)
      return
    }
    if (req.headers['sec-websocket-version'] !== '13') {
      rejectUpgrade(socket, 400, 'BAD_PAYLOAD', 'gateway ws: Sec-WebSocket-Version 13 required')
      return
    }
    const clientKey = req.headers['sec-websocket-key']
    if (typeof clientKey !== 'string' || clientKey.length === 0) {
      rejectUpgrade(socket, 400, 'BAD_PAYLOAD', 'gateway ws: Sec-WebSocket-Key required')
      return
    }
    // 连接鉴权（docs/14 §B.2）：Bearer 设备 Token；无效/撤销 → 401 拒绝升级
    let device: AuthenticatedDevice
    try {
      device = authenticateBearerToken(readBearerHeaderValue(req.headers.authorization))
    } catch (err) {
      const code = err instanceof ServiceError ? err.code : 'AUTH_INVALID_TOKEN'
      const message = err instanceof ServiceError ? err.message : 'gateway ws: authentication failed'
      rejectUpgrade(socket, 401, code, message)
      return
    }
    const connection = completeUpgrade(socket, device, clientKey)
    touchDevice(device.id)
    socket.on('data', (chunk: Buffer) => {
      connection.feed(chunk)
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.on('close', () => {
      connection.teardown()
    })
    if (head.length > 0) connection.feed(head)
  })

  return {
    connectedDevices() {
      return registry.size
    },
    activeConnections() {
      let total = 0
      for (const set of registry.values()) total += set.size
      return total
    },
    closeDeviceConnections(deviceId, reason) {
      const set = registry.get(deviceId)
      if (set === undefined) return
      for (const connection of [...set]) {
        connection.close(1000, reason)
      }
    },
    pushEvent(event) {
      for (const set of [...registry.values()]) {
        for (const connection of [...set]) {
          const sent = connection.sendFrame({
            type: 'event',
            seq: event.sequence,
            eventId: event.eventId,
            eventType: event.eventType,
            ...(event.sessionId !== null ? { sessionId: event.sessionId } : {}),
            ...(event.summary !== undefined && event.summary !== null ? { summary: event.summary } : {}),
            payload: event.payload,
            createdAt: event.createdAt,
          })
          if (sent) markEventDelivered(event.sequence, connection.deviceId)
        }
      }
    },
    closeAll(reason) {
      for (const deviceId of [...registry.keys()]) {
        this.closeDeviceConnections(deviceId, reason)
      }
    },
  }
}
