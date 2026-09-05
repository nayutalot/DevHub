/**
 * wsClient.ts — ECS Relay host 腿 WS **客户端**编解码（M2-R1，docs/19 §4.1/§4.2）。
 *
 * 蓝本 = gateway/ws.ts 服务端编解码（docs/18 §1.3「帧编解码蓝本」行）：解析/分片/
 * close 回显/ping-pong/1MB 上限/1002/1009/1003 语义镜像复用，**唯一对称差异点 =
 * 掩码方向**（RFC 6455 §5.1：客户端发送帧必带掩码，服务端帧必不带——本模块
 * encode 必掩码、parse 拒绝带掩码的服务端帧）。协议面 = docs/18 §3 16 帧的
 * host 腿子集 + host 腿控制帧（fixture meta.conventions.hostControlFrames）。
 *
 * R2 裁定对拍（ecs-relay/README.md 偏离单 1-5，M2-R2 已实现面为准）：
 * ① event 帧判别 `type:'event'`，事件类型承载于 `eventType` 字段（fixture 裁定，
 *    docs/18 §3.6 示例的 JSON 重复键非法）；② token_rotation 必携 `deviceId`
 *    （Windows 侧 remote_devices.id，R2 以 win_device_id 定位 relay_devices 行）；
 * ③ register_pairing / register_pairing_ack 为 host 腿控制帧（16 帧之外）；
 * ④ requestId 由 ECS 内部重写路由，客户端契约 = 「响应帧原样回显 request 帧
 *    requestId」不变；⑤ 离线命令 queued:true 是 ECS→device 语义，host 腿不可见。
 *
 * electron-free（node:crypto / node:http / node:stream 类型）；零写库；本模块
 * 不做重连（状态机在 index.ts），不解析业务语义（帧路由在各桥模块）。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequestFn, type ClientRequestArgs } from 'node:http'
import { request as httpsRequestFn, type RequestOptions as HttpsRequestOptions } from 'node:https'
import type { Duplex } from 'node:stream'

// ---------------------------------------------------------------------------
// 帧编解码原语（RFC 6455；掩码方向 = 客户端）
// ---------------------------------------------------------------------------

const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** 单帧/单消息上限（1MB；与 gateway/ws.ts 同值，docs/18 §1.3 通用帧规则 1）。 */
export const WS_MAX_MESSAGE_BYTES = 1024 * 1024

/**
 * 客户端发送帧编码（**必掩码**，RFC 6455 §5.1）：FIN + opcode + MASK +
 * 7/16/64 bit 长度 + 4 字节掩码键（每帧 randomBytes 新鲜生成）+ 掩码载荷。
 */
export function encodeClientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const maskKey = randomBytes(4)
  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([firstByte, 0x80 | len])
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = firstByte
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = firstByte
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) {
    masked[i] ^= maskKey[i % 4]
  }
  return Buffer.concat([header, maskKey, masked])
}

/** encodeClientFrame 的 JSON 文本帧快捷（host → ECS 协议帧一律 JSON 文本）。 */
export function encodeClientTextFrame(frame: HostToEcsFrame): Buffer {
  return encodeClientFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(frame), 'utf8'))
}

/** Sec-WebSocket-Key（客户端握手，RFC 6455 §4.1：16 字节随机 base64）。 */
export function generateSecWebSocketKey(): string {
  return randomBytes(16).toString('base64')
}

// ---------------------------------------------------------------------------
// 协议帧类型（docs/18 §3 host 腿子集；字段面以 fixture + R2 实现为准）
// ---------------------------------------------------------------------------

/** register_pairing 的 expiresAt 等共用别名（可读性）。 */
export type UnixSec = number

/**
 * relayClient → ECS（H→E）。字段语义见各桥模块；此处只锁帧形状（「绝不猜」：
 * 未知字段不构造、可选字段缺省不伪造）。
 */
export type HostToEcsFrame =
  /** docs/19 §4.5 / fixture hostControlFrames：配对码同步（host 腿控制帧，16 帧之外）。 */
  | { type: 'register_pairing'; requestId: string; pairingId: string; codeHash: string; expiresAt: UnixSec }
  /** docs/18 §3.3：Token 由 Windows 签发，device.deviceId = remote_devices.id。 */
  | {
      type: 'pair_accepted'
      requestId: string
      ecsDeviceId: number
      device: { deviceId: number; deviceName: string; platform: string; tokenVersion: number }
      deviceToken: string
      gatewayName: string
    }
  /** fixture 裁定：判别 type='event'，事件类型在 eventType（R2 裁定①）。 */
  | {
      type: 'event'
      sequence: number
      eventId: string
      eventType: string
      timestamp: UnixSec
      provider?: string
      sessionId?: number
      summary?: string
      payload: Record<string, unknown>
      requiresUserAction: boolean
    }
  /** docs/18 §3.9：受理回执（requestId 原样回显 ECS 路由键）。 */
  | {
      type: 'command_ack'
      requestId?: string
      idempotencyKey: string
      commandId?: string
      status: 'accepted' | 'rejected'
      errorCode?: string
    }
  /** docs/18 §3.10：终态回执（与 command.result 事件双通道，Android 按 commandId 去重）。 */
  | {
      type: 'command_result'
      commandId: string
      idempotencyKey: string
      sessionId?: number
      action: string
      status: 'executed' | 'rejected' | 'expired' | 'failed'
      errorCode: string | null
      timestamp: UnixSec
    }
  /** docs/18 §3.13：host 上行进度（lastSentSeq = 已交 ECS 的最高 sequence）。 */
  | { type: 'heartbeat'; ts: UnixSec; lastSentSeq: number }
  /** docs/18 §3.14 + R2 裁定②：必携 deviceId（Windows 侧 remote_devices.id）。 */
  | {
      type: 'token_rotation'
      requestId: string
      deviceId: number
      newToken: string
      tokenVersion: number
      reason: 'post-pairing' | 'manual' | 'periodic'
    }
  /** docs/18 §3.15：撤销定点踢线（deviceId = Windows 侧 remote_devices.id）。 */
  | { type: 'disconnect'; deviceId: number; reason: 'revoked' }
  /**
   * docs/18 §3.16：error 帧为双向 × 两腿——H→E 形态（commandDownlink auth 失败
   * docs/19 §4.4、pair 复核失败 docs/18 §3.3 失败路径、sync_request 未知设备）。
   * 零凭据零堆栈（约束 #14）。
   */
  | { type: 'error'; requestId?: string; code: string; message: string; retryable?: boolean; retryAfterSec?: number }

/**
 * ECS → relayClient（E→H）。hello 的 sequence = ECS 缓存水位（断线回填起点判定，
 * docs/19 §4.3）；pair 为 ECS 已完成码校验的中继帧（无 code 字段）。
 */
export type EcsToHostFrame =
  | {
      type: 'hello'
      sequence: number
      hostId: number
      heartbeatSec: number
      relayVersion?: string
      upstream?: 'connected' | 'disconnected'
    }
  | { type: 'register_pairing_ack'; requestId: string; pairingId: string; accepted: boolean; expiresAt: UnixSec }
  | {
      type: 'pair'
      requestId: string
      ecsDeviceId: number
      pairingId: string
      deviceName: string
      platform: string
    }
  /** E→H 仅 ACK 部分中继（docs/18 §3.11）：deviceId = ECS 注册表 id（R2 实现面）。 */
  | { type: 'sync_request'; requestId: string; after: number; deviceId: number }
  | { type: 'heartbeat'; ts: UnixSec; lastAckedSeq?: number }
  | { type: 'error'; requestId?: string; code: string; message: string; retryable?: boolean; retryAfterSec?: number }
  | { type: 'disconnect'; reason: string; deviceId?: number }
  | { type: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// 客户端连接（镜像 GatewayWsConnection 的解析/控制帧处理，掩码方向翻转）
// ---------------------------------------------------------------------------

export interface RelayClientConnectionHooks {
  /** 完整 JSON 文本消息（分片收口后）。协议处理异常由调用方逐帧隔离。 */
  onText(connection: RelayClientConnection, text: string): void
  /** 连接终止（close 回显完成 / socket 关闭 / 协议违规关闭）。 */
  onClosed(connection: RelayClientConnection): void
}

export class RelayClientConnection {
  /** 关闭握手已启动；此后不再发送任何帧。 */
  closed = false
  /** 本端感知的关闭原因（诊断投影用，零凭据）。 */
  closeReason: string | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: { chunks: Buffer[]; total: number } | null = null
  private awaitingPong = false
  private lastPingAt = 0

  // 显式字段赋值（不用 TS 参数属性——Node strip-only 模式不支持
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，smoke 系统 Node 直载 .ts 必须 strip-only 可加载）
  private readonly socket: Duplex
  private readonly hooks: RelayClientConnectionHooks

  constructor(socket: Duplex, hooks: RelayClientConnectionHooks) {
    this.socket = socket
    this.hooks = hooks
  }

  /**
   * 客户端文本帧（JSON 协议帧，必掩码）。写调用未抛异常即视为已发出（write 返回
   * false = 已接受进用户态缓冲、随后必然冲刷——gateway/ws.ts 夜间#1 同款语义，
   * host 腿「写成功即 delivered」的判定基础）。
   */
  sendFrame(frame: HostToEcsFrame): boolean {
    if (this.closed) return false
    try {
      this.socket.write(encodeClientFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(frame), 'utf8')))
      return true
    } catch {
      return false
    }
  }

  /** 传输层 ping（客户端主动；对端 10s 无 pong 由对端自查，本端对称跟踪）。 */
  ping(): void {
    if (this.closed) return
    try {
      this.socket.write(encodeClientFrame(OPCODE_PING, Buffer.from(randomUUID().slice(0, 8), 'utf8')))
      this.awaitingPong = true
      this.lastPingAt = Date.now()
    } catch {
      /* socket 已死 → 等待 close 回调清理 */
    }
  }

  /** 客户端关闭握手（close 帧携带状态码 → 短冲刷窗口后销毁）。 */
  close(code = 1000, reason = 'client close'): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    try {
      const codeBuf = Buffer.alloc(2)
      codeBuf.writeUInt16BE(code & 0xffff, 0)
      if (reason.length > 0) {
        const reasonBuf = Buffer.from(reason, 'utf8').subarray(0, 123) // RFC 6455 §5.5.1 ≤123B
        this.socket.write(encodeClientFrame(OPCODE_CLOSE, Buffer.concat([codeBuf, reasonBuf])))
      } else {
        this.socket.write(encodeClientFrame(OPCODE_CLOSE, codeBuf))
      }
    } catch {
      /* 忽略写失败 */
    }
    const socket = this.socket
    setTimeout(() => {
      socket.destroy()
    }, 50)
  }

  /** 传输层 pong 超时自查（调用方 heartbeat 节拍驱动；参数同 ws.ts 30s/10s）。 */
  heartbeatTick(pongTimeoutMs: number): void {
    if (this.closed) return
    const now = Date.now()
    if (this.awaitingPong && now - this.lastPingAt >= pongTimeoutMs) {
      this.close(1000, 'heartbeat timeout (no pong within window)')
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
        this.close(1002, 'protocol error (masked server frame / bad RSV)')
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

  /**
   * 解析一帧；数据不足 → null；协议违规 → 'protocol-error'；超限 → 'too-large'。
   * 与 ws.ts 服务端解析唯一差异：服务端帧**必不带掩码**（RFC 6455 §5.1 对称面），
   * 带掩码 → protocol-error（1002）。
   */
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
    if ((buf[1] & 0x80) !== 0) return 'protocol-error' // 服务端帧必不带掩码（RFC 6455 §5.1）
    if (rsv !== 0) return 'protocol-error'
    if (buf.length < offset + length) return null
    this.buffer = buf.subarray(offset + length)
    return { opcode, payload: Buffer.from(buf.subarray(offset, offset + length)), fin }
  }

  private handleFrame(opcode: number, payload: Buffer, fin: boolean): void {
    switch (opcode) {
      case OPCODE_CLOSE: {
        // 回显 close（服务端 code）后断开；teardown 由 socket close 事件驱动
        this.closed = true
        try {
          const echo = Buffer.alloc(2)
          if (payload.length >= 2) echo.writeUInt16BE(payload.readUInt16BE(0), 0)
          this.socket.write(encodeClientFrame(OPCODE_CLOSE, echo))
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
          this.socket.write(encodeClientFrame(OPCODE_PONG, payload))
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
          /* 协议处理异常不杀伤连接循环（逐帧隔离，蓝本同款） */
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

  /** socket 关闭清理入口（状态机回收 + 心跳 timer 停止）。 */
  teardown(): void {
    this.closed = true
    this.hooks.onClosed(this)
  }
}

// ---------------------------------------------------------------------------
// 出站握手（upgrade；Bearer Relay 凭据鉴权，docs/18 §2 host leg 行）
// ---------------------------------------------------------------------------

export interface RelayEndpointParts {
  secure: boolean
  host: string
  port: number
  path: string
}

/** 解析 wss://host[:port][/path]（ws:// 仅 loopback 例外，校验归 config.ts）。 */
export function parseRelayEndpoint(endpoint: string): RelayEndpointParts | null {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return null
  }
  const secure = url.protocol === 'wss:'
  const insecure = url.protocol === 'ws:'
  if (!secure && !insecure) return null
  const host = url.hostname
  if (host.length === 0) return null
  const explicitPort = url.port !== '' ? Number.parseInt(url.port, 10) : null
  const port = explicitPort !== null && Number.isSafeInteger(explicitPort) && explicitPort > 0 ? explicitPort : secure ? 443 : 80
  let path = url.pathname
  if (!path.startsWith('/')) path = `/${path}`
  if (path === '/') path = '/relay/host'
  return { secure, host, port, path }
}

export interface OpenRelayConnectionOptions {
  endpoint: string
  /** Relay 凭据（每部署一份 256-bit；upgrade 头 Authorization: Bearer，docs/18 §2）。 */
  credential: string
  /**
   * TLS 校验缝（docs/19 §10 指纹 pinning 的注入位）：缺省 = 默认 CA 校验
   * （rejectUnauthorized 语义不变）；部署面装载自签 IP SAN CA / spki 指纹时经此
   * 传入（M2-R1 只留缝，指纹物料属部署批）。
   */
  tls?: { ca?: string; checkServerIdentity?: (host: string, cert: { fingerprint256?: string }) => Error | undefined }
  /** http.request 附加参数（测试缝：本地 stub 注入自定 socket 超时等）。 */
  requestOptions?: ClientRequestArgs
  openTimeoutMs?: number
}

export type OpenRelayConnectionResult =
  | { upgraded: true; connection: RelayClientConnection; socket: Duplex }
  | { upgraded: false; status?: number; code?: string; message?: string; error?: string }

/**
 * 出站 WS 握手（wss/wss over node:https；Bearer 凭据在 upgrade 头）。
 * 4xx 拒绝 → 结构化 {upgraded:false,status,code,message}（错误 JSON 形态同
 * docs/14 §B.2）；网络失败 → {upgraded:false,error}。绝不抛（状态机消费结构化结果）。
 */
export function openRelayConnection(
  options: OpenRelayConnectionOptions,
  hooks: RelayClientConnectionHooks,
): Promise<OpenRelayConnectionResult> {
  const parts = parseRelayEndpoint(options.endpoint)
  if (parts === null) {
    return Promise.resolve({ upgraded: false, error: 'malformed relay endpoint (expected wss://host[:port][/path], docs/18 §2)' })
  }
  const openTimeoutMs = options.openTimeoutMs ?? 10_000
  return new Promise<OpenRelayConnectionResult>((resolve) => {
    let settled = false
    const settle = (result: OpenRelayConnectionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      settle({ upgraded: false, error: `relay upgrade timeout (${openTimeoutMs}ms)` })
    }, openTimeoutMs)

    const headers: Record<string, string> = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': generateSecWebSocketKey(),
      // Relay 凭据（红线：仅 upgrade 头承载；绝不入日志/错误信息）
      Authorization: `Bearer ${options.credential}`,
    }
    const args: ClientRequestArgs = {
      ...options.requestOptions,
      host: parts.host,
      port: parts.port,
      path: parts.path,
      headers,
    }
    let request: ReturnType<typeof httpRequestFn> | ReturnType<typeof httpsRequestFn>
    try {
      if (parts.secure) {
        const tlsOptions: HttpsRequestOptions = { ...args }
        if (options.tls?.ca !== undefined) tlsOptions.ca = options.tls.ca
        if (options.tls?.checkServerIdentity !== undefined) {
          tlsOptions.checkServerIdentity = options.tls.checkServerIdentity
        }
        request = httpsRequestFn(tlsOptions)
      } else {
        request = httpRequestFn(args)
      }
    } catch (err) {
      settle({ upgraded: false, error: err instanceof Error ? err.message : String(err) })
      return
    }

    request.on('upgrade', (res, socket, head) => {
      if (res.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.destroy()
        settle({ upgraded: false, status: res.statusCode, message: 'upgrade response without websocket upgrade header' })
        return
      }
      const connection = new RelayClientConnection(socket, hooks)
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
      settle({ upgraded: true, connection, socket })
    })
    request.on('response', (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        raw += chunk
      })
      res.on('end', () => {
        let code: string | undefined
        let message: string | undefined
        try {
          const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } }
          code = parsed.error?.code
          message = parsed.error?.message
        } catch {
          /* 非 JSON 拒绝体：仅透传 status */
        }
        settle({ upgraded: false, status: res.statusCode, code, message })
      })
      res.socket?.on('error', () => {})
    })
    request.on('error', (err) => {
      settle({ upgraded: false, error: err.message })
    })
    request.end()
  })
}
