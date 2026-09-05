/**
 * ws.ts — 自研轻量 WebSocket 服务端（RFC 6455 服务端子集）。
 *
 * 编解码移植蓝本 = src/main/services/agentControl/gateway/ws.ts（只读参考，零 import）：
 * - 握手原语：Sec-WebSocket-Accept = base64(sha1(key + GUID))；
 * - 解析：FIN/RSV/opcode、MASK（客户端帧必掩码 → 否则 1002）、长度 7/16/64 bit、
 *   掩码键、分片续帧（opcode 0 = continuation，FIN=1 收口）；帧/消息上限 1MB（超限 1009）；
 *   close 回显后断开；ping → pong 回显；RSV ≠ 0 / 未知 opcode → 1002；二进制 → 1003；
 * - 编码：服务端发送一律不掩码（RFC 6455 §5.1）；
 * - 心跳：服务端每 30s 发 ping，10s 无 pong 关闭（docs/18 §2 参数同 ws.ts 不动）；
 *   应用层 heartbeat 帧由 forwarder 处理（状态信标），本模块只管传输层。
 * 结构差异（相对蓝本）：连接类自含心跳 timer（蓝本由注册表 setInterval 驱动），
 * 行为语义一致；两腿（device/host）复用同一连接类（docs/19 §5.2）。
 */
import { randomUUID, createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** 单帧/单消息上限（1MB，docs/18 §1.3 与 gateway/ws.ts 一致）。 */
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

export type RelayLeg = 'device' | 'host'

export interface ConnectionIdentity {
  side: RelayLeg
  /** device = relay_devices.id（裸 pair 连接为 null）；host = relay_hosts.id。 */
  deviceId?: number
  hostId?: number
  /** device 腿未鉴权裸连接（首帧必须 pair，docs/18 §2）。 */
  bare: boolean
  remoteIp: string
}

export interface WsConnectionHooks {
  onText(connection: RelayConnection, text: string): void
  onClosed(connection: RelayConnection): void
}

export class RelayConnection {
  /** 关闭握手已启动；此后不再发送任何帧。 */
  closed = false
  /** 服务端主动关闭原因（日志/审计用，零凭据）。 */
  closeReason: string | null = null
  readonly identity: ConnectionIdentity
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: { chunks: Buffer[]; total: number } | null = null
  private awaitingPong = false
  private lastPingAt = 0
  private readonly socket: Duplex
  private readonly hooks: WsConnectionHooks
  private readonly pongTimeoutMs: number
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(
    identity: ConnectionIdentity,
    socket: Duplex,
    hooks: WsConnectionHooks,
    heartbeatIntervalMs: number,
    pongTimeoutMs: number,
  ) {
    this.identity = identity
    this.socket = socket
    this.hooks = hooks
    this.pongTimeoutMs = pongTimeoutMs
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatTick()
    }, heartbeatIntervalMs)
    // unref：连接心跳不阻止进程退出（存活面由 http server 承担；优雅停机路径仍显式清理）
    this.heartbeatTimer.unref?.()
  }

  /** 传输层标识（审计/路由用）。 */
  get deviceId(): number | undefined {
    return this.identity.deviceId
  }

  get hostId(): number | undefined {
    return this.identity.hostId
  }

  /** 裸连接在鉴权后原位转正（配对完成后以 Bearer 重连前的窗口内不再复用，见 forwarder）。 */
  markAuthenticated(deviceId: number): void {
    this.identity.deviceId = deviceId
    this.identity.bare = false
  }

  /**
   * 服务端文本帧（JSON 协议帧）。写失败返回 false 不抛（投递失败不回滚 DB）；
   * 「写调用未抛异常」即视为已发出（TCP 背压语义，gateway ws.ts 夜间#1 修复同款）。
   */
  sendFrame(frame: object): boolean {
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

  /** 服务端关闭握手（close 帧携带状态码 + UTF-8 reason ≤123B，RFC 6455 §5.5.1 → 短冲刷后销毁）。 */
  close(code = 1000, reason = 'server close'): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    this.stopHeartbeatTimer()
    try {
      const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123)
      const payload = Buffer.alloc(2 + reasonBytes.length)
      payload.writeUInt16BE(code & 0xffff, 0)
      reasonBytes.copy(payload, 2)
      this.socket.write(encodeServerFrame(OPCODE_CLOSE, payload))
    } catch {
      /* 忽略写失败 */
    }
    const socket = this.socket
    setTimeout(() => {
      socket.destroy()
    }, 50)
  }

  /** 心跳节拍：上次 ping 无 pong 且超时 → 关闭（docs/18 §2：10s 无 pong）。 */
  heartbeatTick(): void {
    if (this.closed) return
    const now = Date.now()
    if (this.awaitingPong && now - this.lastPingAt >= this.pongTimeoutMs) {
      this.close(1000, 'heartbeat timeout (no pong within window, docs/18 §2)')
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
        this.closed = true
        this.closeReason = 'client close'
        this.stopHeartbeatTimer()
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
          if (whole.length > 0) this.close(1003, 'binary protocol frames unsupported (JSON text only, docs/18 §1.3)')
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

  /** socket 关闭清理入口（registry 回收 + 心跳 timer 停止）。 */
  teardown(): void {
    if (!this.closed) {
      this.closed = true
      this.stopHeartbeatTimer()
    }
    this.hooks.onClosed(this)
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}

/** upgrade 请求基本形状校验（版本 13 + key 存在；路径/鉴权由 server.ts 分路）。 */
export function validateUpgradeHeaders(req: { headers: Record<string, unknown> }): { ok: true; clientKey: string } | { ok: false; status: number; code: string; message: string } {
  if (req.headers['sec-websocket-version'] !== '13') {
    return { ok: false, status: 400, code: 'BAD_PAYLOAD', message: 'relay ws: Sec-WebSocket-Version 13 required' }
  }
  const clientKey = req.headers['sec-websocket-key']
  if (typeof clientKey !== 'string' || clientKey.length === 0) {
    return { ok: false, status: 400, code: 'BAD_PAYLOAD', message: 'relay ws: Sec-WebSocket-Key required' }
  }
  return { ok: true, clientKey }
}
