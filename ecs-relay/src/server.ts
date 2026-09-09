/**
 * server.ts — node:http 装配 + upgrade 分路（/relay/device | /relay/host）+ 优雅停机
 * （docs/19 §5.2/§5.6）。
 *
 * - 只绑 127.0.0.1:8443（RELAY_BIND/RELAY_PORT 可覆盖；测试用随机高端口）；
 *   TLS 永远在反代终结，Relay 不感知（docs/19 §5.1）；
 * - host 首装注册（docs/19 §2.2）：POST /relay/host + Authorization: Bearer <一次性注册码>
 *   → relay_hosts 建行 + 签发 256-bit Relay 凭据（明文仅此响应一次；ECS 只存 sha256）；
 *   未配置注册码 → 注册面关闭（404）。注册码绝不入日志/审计（约束 #13）。
 * - device leg 未带 Authorization → 裸 pair 连接（首帧必须 pair ≤10s，docs/18 §2）；
 * - 优雅停机：SIGTERM/SIGINT → disconnect{server_shutdown} → close 全部连接 → DB checkpoint。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { loadConfig } from './config.ts'
import { Store, ensureSchema, SCHEMA_DIR } from './store.ts'
import { Audit } from './audit.ts'
import { EventCache } from './cache.ts'
import { Forwarder } from './forwarder.ts'
import { RateLimits, ReplayGuard, authenticateDeviceToken, authenticateHostCredential, constantTimeEquals, generateHostCredential, readBearerHeaderValue, sha256Hex } from './auth.ts'
import { RelayError, errorBody } from './errors.ts'
import { RelayConnection, computeAcceptKey, validateUpgradeHeaders } from './ws.ts'
import { handleRestRequest } from './rest.ts'
import { WakeExecutor, type WakeRunner } from './wake.ts'

export interface RelayServerHandle {
  server: Server
  port: number
  close(): Promise<void>
  forwarder: Forwarder
}

export function startRelayServer(options: { config?: ReturnType<typeof loadConfig>; dbPath?: string; wakeRunner?: WakeRunner } = {}): RelayServerHandle {
  const config = options.config ?? loadConfig()
  const store = new Store({ path: options.dbPath ?? config.dbPath })
  const applied = ensureSchema(store, SCHEMA_DIR)
  if (applied.length > 0) {
    console.log(`[relay] applied migrations: ${applied.join(', ')}`)
  }
  const audit = new Audit(store, config.auditRetentionSec)
  const cache = new EventCache(store, config)
  const rateLimits = new RateLimits()
  const replayGuard = new ReplayGuard()
  const wake = new WakeExecutor({ config, audit, runner: options.wakeRunner })
  const forwarder = new Forwarder({ store, audit, cache, config, rateLimits, wake })
  const startedAtMs = Date.now()

  audit.write({ category: 'relay', action: 'relay_started', outcome: 'success', detail: { version: config.relayVersion, bind: config.bind, port: config.port } })

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res)
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.internal').pathname
    } catch {
      sendJson(res, 400, errorBody('BAD_PAYLOAD', 'malformed request URL'))
      return
    }
    // host 首装注册（docs/19 §2.2；部署面操作——不属于 docs/18 §7.1 设备 REST 五端点）
    if (req.method === 'POST' && pathname === '/relay/host') {
      handleHostEnrollment(req, res)
      return
    }
    if (pathname.startsWith('/v1/')) {
      await handleRestRequest(req, res, {
        store,
        audit,
        cache,
        config,
        forwarder,
        rateLimits,
        replayGuard,
        startedAtMs,
        version: config.relayVersion,
      })
      return
    }
    sendJson(res, 404, errorBody('NOT_FOUND', 'no such endpoint'))
  }

  /** 一次性注册码 → Relay 凭据换发（同构配对「短时效凭据换长期身份」，docs/19 §2.2）。 */
  function handleHostEnrollment(req: IncomingMessage, res: ServerResponse): void {
    const sourceKey = rateLimits.sourceKey(req.socket.remoteAddress)
    const nowMs = Date.now()
    if (config.registrationCode === null) {
      sendJson(res, 404, errorBody('NOT_FOUND', 'host enrollment is closed (no registration code configured)'))
      return
    }
    if (rateLimits.isAuthFailureLimited(sourceKey, nowMs)) {
      const retryAfterSec = Math.max(1, rateLimits.authFailureRetryAfterSec(sourceKey, nowMs))
      audit.write({ category: 'auth', action: 'rate_limited', outcome: 'denied', detail: { scope: 'host_enrollment' } })
      sendJson(res, 429, errorBody('AUTH_RATE_LIMITED', 'enrollment rate limited; retry later'), { 'Retry-After': String(retryAfterSec) })
      return
    }
    const presented = readBearerHeaderValue(req.headers.authorization)
    const matches = presented !== null && constantTimeEquals(sha256Hex(presented), sha256Hex(config.registrationCode))
    if (!matches) {
      rateLimits.recordAuthFailure(sourceKey, nowMs)
      audit.write({ category: 'auth', action: 'auth_failed', outcome: 'denied', detail: { scope: 'host_enrollment' } })
      sendJson(res, 401, errorBody('AUTH_INVALID_TOKEN', 'invalid registration code'))
      return
    }
    let bodyRaw = ''
    req.on('data', (chunk: Buffer) => {
      bodyRaw += chunk.toString('utf8')
      if (bodyRaw.length > 65536) req.destroy()
    })
    req.on('end', () => {
      let hostName: string | null = null
      try {
        const parsed = bodyRaw.length > 0 ? (JSON.parse(bodyRaw) as { hostName?: unknown }) : {}
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.hostName === 'string' && parsed.hostName.trim().length > 0) {
          hostName = parsed.hostName.trim().slice(0, 100)
        }
      } catch {
        /* 空/非 JSON body 允许（hostName 可选） */
      }
      const credential = generateHostCredential()
      const nowSec = Math.floor(Date.now() / 1000)
      const result = store.run(
        "INSERT INTO relay_hosts (host_name, credential_hash, status, enrolled_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
        hostName,
        sha256Hex(credential),
        nowSec,
        nowSec,
      )
      const hostId = Number(result.lastInsertRowid)
      audit.write({ category: 'relay', action: 'host_enrolled', outcome: 'success', hostId, detail: { hostName } })
      sendJson(res, 201, { hostId, credential, hostName })
    })
  }

  function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
    // upgrade 被拒 socket 无默认 error 处理（gateway ws.ts AC6 修复同款——防 uncaughtException）
    socket.on('error', () => {
      socket.destroy()
    })
    const body = JSON.stringify(errorBody(code, message))
    socket.end(
      `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Bad Request'}\r\n` +
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

  function completeUpgrade(socket: Duplex, clientKey: string, identity: ConstructorParameters<typeof RelayConnection>[0]): RelayConnection {
    const accept = computeAcceptKey(clientKey)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    )
    // TCP keepalive（initialDelay 5s；A⑥ 修 2，M3-A⑤ 根因①）：host socket 死亡（RST/
    // 半开）后内核秒级探测迫使 error→close 浮出 → hostOnline 翻转，不再依赖应用层
    // 事件循环活跃度（修复前空闲循环 ≥15s 不处理 close，僵尸窗口内 hostOnline 恒真）。
    // Linux 默认探测间隔/次数即秒级；两腿同参（device 腿死连接同样早回收，预算护栏受益）。
    const tcpSocket = socket as import('node:net').Socket
    if (typeof tcpSocket.setKeepAlive === 'function') {
      tcpSocket.setKeepAlive(true, 5000)
    }
    const connection = new RelayConnection(
      identity,
      socket,
      {
        onText: (conn, text) => {
          if (conn.identity.side === 'device') forwarder.onDeviceText(conn, text)
          else forwarder.onHostText(conn, text)
        },
        onClosed: (conn) => {
          forwarder.removeConnection(conn)
        },
      },
      config.heartbeatIntervalMs,
      config.pongTimeoutMs,
    )
    socket.on('data', (chunk: Buffer) => {
      connection.feed(chunk)
    })
    socket.on('error', () => {
      socket.destroy()
    })
    // upgrade socket allowHalfOpen=true：对端 FIN 只触发 'end' 不触发 'close'
    // （半开连接假活，W-R8）——收到 end 立即销毁，驱动 close→teardown→registry 回收
    socket.on('end', () => {
      socket.destroy()
    })
    socket.on('close', () => {
      connection.teardown()
    })
    return connection
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://relay.internal').pathname
    } catch {
      rejectUpgrade(socket, 400, 'BAD_PAYLOAD', 'relay ws: malformed upgrade URL')
      return
    }
    const check = validateUpgradeHeaders(req)
    if (!check.ok) {
      rejectUpgrade(socket, check.status, check.code, check.message)
      return
    }
    const remoteIp = req.socket.remoteAddress ?? 'unknown'

    if (pathname === '/relay/device') {
      const bearer = readBearerHeaderValue(req.headers.authorization)
      if (bearer === null) {
        // 裸 pair 连接（docs/18 §2：未配对例外）
        const conn = completeUpgrade(socket, check.clientKey, { side: 'device', bare: true, remoteIp })
        forwarder.admitBareDeviceConnection(conn)
        if (head.length > 0) conn.feed(head)
        return
      }
      try {
        const device = authenticateDeviceToken(store, bearer, audit)
        const conn = completeUpgrade(socket, check.clientKey, { side: 'device', bare: false, deviceId: device.id, remoteIp })
        forwarder.admitDeviceConnection(conn, device.id, device.viaGrace)
        if (head.length > 0) conn.feed(head)
      } catch (err) {
        const code = err instanceof RelayError ? err.code : 'AUTH_INVALID_TOKEN'
        const message = err instanceof RelayError ? err.message : 'relay ws: authentication failed'
        rejectUpgrade(socket, 401, code, message)
      }
      return
    }

    if (pathname === '/relay/host') {
      try {
        const host = authenticateHostCredential(store, readBearerHeaderValue(req.headers.authorization))
        const conn = completeUpgrade(socket, check.clientKey, { side: 'host', bare: false, hostId: host.id, remoteIp })
        forwarder.admitHostConnection(conn, host.id)
        if (head.length > 0) conn.feed(head)
      } catch (err) {
        const code = err instanceof RelayError ? err.code : 'AUTH_INVALID_TOKEN'
        const message = err instanceof RelayError ? err.message : 'relay ws: authentication failed'
        rejectUpgrade(socket, 401, code, message)
      }
      return
    }

    rejectUpgrade(socket, 404, 'NOT_FOUND', `relay ws: unknown upgrade path ${pathname} (expected /relay/device | /relay/host)`)
  })

  server.listen(config.port, config.bind, () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : config.port
    handleHolder.port = port
    console.log(`[relay] devhub-relay ${config.relayVersion} listening on ${config.bind}:${port} (db: ${options.dbPath ?? config.dbPath})`)
  })

  const openSockets = new Set<Duplex>()
  server.on('connection', (socket: Duplex) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  async function close(): Promise<void> {
    forwarder.shutdown()
    audit.write({ category: 'relay', action: 'relay_stopped', outcome: 'success', detail: { version: config.relayVersion } })
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // 冲刷窗口后强制清尾（优雅停机零帧丢失：disconnect 帧已先行发出）
      setTimeout(() => {
        for (const socket of openSockets) socket.destroy()
        resolve()
      }, 500).unref()
    })
    store.close()
  }

  let shuttingDown = false
  let closed = false
  async function closeOnce(): Promise<void> {
    if (closed) return
    closed = true
    await close()
  }
  function onSignal(): void {
    if (shuttingDown) return
    shuttingDown = true
    console.log('[relay] shutdown signal received; draining connections')
    void closeOnce().then(() => {
      process.exit(0)
    })
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const addressAtReturn = server.address()
  const handleHolder: RelayServerHandle = {
    server,
    port: typeof addressAtReturn === 'object' && addressAtReturn !== null ? addressAtReturn.port : config.port,
    close: closeOnce,
    forwarder,
  }
  return handleHolder
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

// 直接执行（node src/server.ts）时启动；被测试/selfcheck import 时不自动启动
import { pathToFileURL } from 'node:url'
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = startRelayServer()
  // stdin 'shutdown' 指令缝：Windows 无 SIGTERM 投递（TerminateProcess 绕过 handler），
  // 冒烟/自检经 stdin 触发同一优雅停机路径；POSIX 仍以 SIGTERM 为准（systemd）；
  // systemd 部署 stdin=/dev/null 无 data 事件，交互终端下输入 shutdown 亦可停机（已记录于 README）。
  let stdinBuffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    stdinBuffer += chunk
    if (stdinBuffer.includes('shutdown')) {
      handle.close().then(() => process.exit(0))
    }
  })
  process.stdin.on('error', () => {})
}
