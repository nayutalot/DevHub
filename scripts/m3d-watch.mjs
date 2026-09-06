#!/usr/bin/env node
/**
 * m3d-watch.mjs — M3-D 72h 稳定期巡检工具（单周期/自循环只读探测，零新依赖）。
 *
 * 定位：scripts/ 独立运维脚本（与 smoke.mjs / mcp-acceptance.mjs 同级 tooling），
 * 不是应用代码——不触碰 src/main spawn 架构约束（exec.ts 唯一 spawn 是应用内约束）。
 * 纪律：只读 GET 零副作用、不监听端口、不杀进程；凭据三零（本脚本零密钥零 token，
 * 不读 %LOCALAPPDATA%\DevHub\relay\credential 内容，只做存在性判断）。
 *
 * ── 源码研究结论（M3-D 启动批直接可用；2026-09-06 对照 main@0b2f19c）────────────
 *
 * 1. 本地网关健康：GET http://127.0.0.1:8746/v1/health（无鉴权活性，防重放豁免；
 *    src/main/services/agentControl/gateway/httpServer.ts:609-613，返回
 *    {ok:true,name,version,uptimeSec}）。端口 = settings gateway_port 默认 8746，
 *    占用顺延 8747-8755（httpServer.ts:6）——本脚本默认探测 8746，--gateway-port 可覆盖。
 *
 * 2. relay host 腿「本地查询面」研究结论：
 *    - 本地网关 REST **没有** relay 状态路由：route() 全集 = /v1/health、
 *      /v1/pairing/{create,claim}、/v1/diagnostics、/v1/devices、/v1/agents、
 *      /v1/sessions（httpServer.ts:609-730）；含状态面的端点全部 requireDevice
 *      （Bearer 设备 token，本脚本按凭据三零不持有）。
 *    - settings relay_enabled 存 SQLite：路径 %LOCALAPPDATA%\DevHub\devhub.db，
 *      表 settings key='relay_enabled'（'1'=启用，默认 '0'）——settingsService.ts:31-44。
 *      无 REST 读法；本脚本用 node:sqlite（Node ≥22.5 内置）以 readOnly 打开只读
 *      单键 SELECT，DB 缺席/锁死 → null（绝不写、绝不 busy-wait）。
 *    - **"relayClient connected" 日志标记不存在**：relayClient 状态机只经内存投影
 *      setRelayRuntimeView（relayClient/index.ts:166-186 setStatus → statusProjector
 *      内存镜像）回报，不经 logger；src/main 全量 grep 仅一条启动失败行
 *      "relay client startup failed"（src/main/index.ts:299）。故扫
 *      %LOCALAPPDATA%\DevHub\logs\devhub.log 判连通态不可行（本脚本不依赖它）。
 *    - **host 腿连通态的权威外部真值 = 公网 relay /v1/health 的 upstream.connected**
 *      （ecs-relay/src/rest.ts:118-129：health 返回 upstream:{connected:
 *      forwarder.hostOnline}；forwarder.ts:111 hostOnline = host WS 腿在线）。
 *
 *    → relay.connected 判定表（本脚本实现）：
 *      网关 down（常驻不在）           → connected:null，status:'degraded'（brief §1.2 null 语义）
 *      网关 up + relay_enabled='0'     → connected:false，status:'degraded'（默认零连接设计态，72h 窗口内属偏离）
 *      网关 up + relay_enabled='1'/null → connected = 公网 health upstream.connected
 *                                        （source:'ecs-upstream'），true→ok / false→degraded
 *
 * 3. 公网 relay 健康路径：GET https://59.110.149.11/v1/health。
 *    Caddy（ecs-relay/deploy/Caddyfile:17-31）443 反代 /v1/* → 127.0.0.1:8443
 *    （devhub-relay），/relay/* 是 WS 腿，其余 404；relay rest.ts:119-129 health
 *    无鉴权。TLS：ca 选项指定 %LOCALAPPDATA%\DevHub\relay\ca.pem（自签根 CA，
 *    config.ts:190-198 权威路径；**绝不用 rejectUnauthorized:false**）。证书为自签
 *    IP 证书（SAN 含 IP:59.110.149.11），Node 默认 checkServerIdentity 可过。
 *    附加 SPKI pin 校验（对齐应用 M3-C1b 指纹 pinning）：peer 证书公钥 SPKI
 *    sha256 对比 %LOCALAPPDATA%\DevHub\relay\fingerprints（每行 sha256/{hex}，
 *    公开物料；当前基线 sha256/a07f7ab7…50d0）。不匹配 → cert 检查 degraded。
 *
 * 4. 证书余量：TLS 握手 peer cert valid_to（socket.getPeerCertificate()），剩余
 *    天数 <14 → degraded（与 ecs-relay selfcheck 证书日历同口径，selfcheck.mjs
 *    "证书剩余有效期 ≥14 天"；RELAY_CERT_PATH 默认 /etc/devhub-relay/tls/server.crt）。
 *    当前基线约 89 天（notAfter 2026-12-04）。
 *
 * 5. --deep（可选，SSH 只读零改动）：ssh -i ~/.ssh/devhub_ecs root@59.110.149.11
 *    journalctl -u devhub-relay 近 N 小时 -p err 行计数。只读；密钥路径不是凭据值，
 *    但输出仍零密钥（JSON 只含计数与状态，不含命令行/密钥）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node scripts/m3d-watch.mjs                  单周期：一行 JSON 到 stdout + 追加 ndjson
 *   node scripts/m3d-watch.mjs --loop <分钟>    自循环（每 N 分钟一周期；SIGINT 干净退出码 0）
 *   node scripts/m3d-watch.mjs --t0             写 T0 标记文件（ISO 时间）+ 打印（可与单周期/loop 同用）
 *   node scripts/m3d-watch.mjs --summary <ndjson[.gz]>  汇总：周期数/ok 率/首末错误/网关 down 时段数/证书最小余量
 *   node scripts/m3d-watch.mjs --out <file>     覆盖 ndjson 落点（默认见下）
 *   node scripts/m3d-watch.mjs --deep [--deep-hours <N=24>]   单周期附加 SSH 只读 journalctl err 计数
 *   node scripts/m3d-watch.mjs --gateway-port <P>             网关端口覆盖（默认 8746）
 *
 *   ndjson 默认落点（仓外，零仓库污染）：%LOCALAPPDATA%\DevHub\m3d-watch\watch.ndjson
 *   T0 标记文件：%LOCALAPPDATA%\DevHub\m3d-watch\t0.txt
 *   退出码：全 ok=0；任一 degraded/down=1；用法/IO 错误=2；--loop SIGINT 干净停=0。
 */

import { spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import http from 'node:http'
import https from 'node:https'

/** node:sqlite 为内置模块（Node ≥22.5，零新依赖）；readRelayEnabledSetting 同步读用 require 缝。 */
const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// 常量（公网面 IP/路径按 brief 可硬编码；零密钥零 token）
// ---------------------------------------------------------------------------

const ECS_IP = '59.110.149.11'
const PUBLIC_HEALTH_PATH = '/v1/health' // Caddyfile /v1/* → 127.0.0.1:8443；rest.ts 无鉴权 health
const GATEWAY_DEFAULT_PORT = 8746 // httpServer.ts GATEWAY_DEFAULT_PORT
const GATEWAY_TIMEOUT_MS = 5_000
const PUBLIC_TIMEOUT_MS = 10_000
const CERT_MIN_DAYS = 14 // selfcheck 证书日历同口径：≥14 天 ok

function localAppDataDir() {
  const raw = process.env.LOCALAPPDATA
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  // 非 Windows 开发面回落（与 config.ts XDG 惯例对齐的观测面，仅用于探测路径）
  return process.platform === 'win32' ? join(homedir(), 'AppData', 'Local') : join(homedir(), '.local', 'share')
}

const DEVHUB_DATA_DIR = join(localAppDataDir(), 'DevHub')
const RELAY_CA_PATH = join(DEVHUB_DATA_DIR, 'relay', 'ca.pem') // config.ts:198 权威路径
const RELAY_FINGERPRINTS_PATH = join(DEVHUB_DATA_DIR, 'relay', 'fingerprints') // config.ts:186
const RELAY_CREDENTIAL_PATH = join(DEVHUB_DATA_DIR, 'relay', 'credential') // 只存在性判断，绝不读内容
const SETTINGS_DB_PATH = join(DEVHUB_DATA_DIR, 'devhub.db') // settingsService → db/index.ts 数据面
const WATCH_DIR = join(DEVHUB_DATA_DIR, 'm3d-watch')
const DEFAULT_NDJSON = join(WATCH_DIR, 'watch.ndjson')
const T0_MARKER = join(WATCH_DIR, 't0.txt')
const ECS_SSH_KEY = join(homedir(), '.ssh', 'devhub_ecs')

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

function usage() {
  console.error(
    'usage: node scripts/m3d-watch.mjs [--loop <minutes>] [--t0] [--summary <ndjson>] ' +
      '[--out <file>] [--deep] [--deep-hours <N>] [--gateway-port <P>]',
  )
}

function parseFlags(argv) {
  const flags = {
    loopMinutes: null,
    t0: false,
    summaryPath: null,
    out: null,
    deep: false,
    deepHours: 24,
    gatewayPort: GATEWAY_DEFAULT_PORT,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case '--loop': {
        i += 1
        const n = Number.parseInt(argv[i], 10)
        if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError('--loop requires a positive integer (minutes)')
        flags.loopMinutes = n
        break
      }
      case '--t0':
        flags.t0 = true
        break
      case '--summary':
        i += 1
        if (typeof argv[i] !== 'string' || argv[i].length === 0) throw new UsageError('--summary requires a file path')
        flags.summaryPath = argv[i]
        break
      case '--out':
        i += 1
        if (typeof argv[i] !== 'string' || argv[i].length === 0) throw new UsageError('--out requires a file path')
        flags.out = argv[i]
        break
      case '--deep':
        flags.deep = true
        break
      case '--deep-hours': {
        i += 1
        const n = Number.parseInt(argv[i], 10)
        if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError('--deep-hours requires a positive integer')
        flags.deepHours = n
        break
      }
      case '--gateway-port': {
        i += 1
        const n = Number.parseInt(argv[i], 10)
        if (!Number.isSafeInteger(n) || n <= 0 || n > 65535) throw new UsageError('--gateway-port requires a port 1-65535')
        flags.gatewayPort = n
        break
      }
      case '--help':
      case '-h':
        usage()
        process.exit(0)
        break
      default:
        throw new UsageError(`unknown flag: ${a}`)
    }
  }
  if (flags.summaryPath !== null && (flags.loopMinutes !== null || flags.t0 || flags.deep)) {
    throw new UsageError('--summary is a standalone read-only mode (no cycle is run)')
  }
  return flags
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// 探测原语（全部只读；短超时；零重试风暴）
// ---------------------------------------------------------------------------

/** HTTP GET（node:http；返回 {status, body, error}）。 */
function httpGet(url, timeoutMs) {
  return new Promise((resolvePromise) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size <= 1_000_000) chunks.push(c)
      })
      res.on('end', () => {
        resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), error: null })
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    req.on('error', (err) => {
      resolvePromise({ status: 0, body: '', error: err.message })
    })
  })
}

/**
 * HTTPS GET + TLS 旁路观测（node:https；ca 指定自签根 CA，绝不用
 * rejectUnauthorized:false）。返回 {status, body, error, cert}，cert =
 * {validTo, spkiSha256}（握手失败时为 null）。
 */
function httpsGetObserve(url, timeoutMs, caPem) {
  return new Promise((resolvePromise) => {
    // 专用一次性 agent（keepAlive:false）：全局 agent 的 keepAlive 会话复用会导致
    // getPeerCertificate() 返回空对象，证书余量/SPKI pin 观测必须走全新握手
    const agent = new https.Agent({ keepAlive: false, ca: caPem })
    const req = https.get(url, { timeout: timeoutMs, agent }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size <= 1_000_000) chunks.push(c)
      })
      res.on('end', () => {
        let cert = null
        try {
          const peer = res.socket.getPeerCertificate()
          if (peer && Object.keys(peer).length > 0) {
            cert = { validTo: peer.valid_to, raw: peer.raw }
          }
        } catch {
          /* 旁路观测失败不影响响应判定 */
        }
        agent.destroy()
        resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), error: null, cert })
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    req.on('error', (err) => {
      agent.destroy()
      resolvePromise({ status: 0, body: '', error: err.message, cert: null })
    })
  })
}

/** peer 证书公钥 SPKI sha256（对齐应用指纹 pinning 口径：sha256/{hex}）。 */
function spkiSha256Hex(certRaw) {
  // X509Certificate 接受 DER（peer cert.raw）；SPKI DER 的 sha256 = 应用侧 pin 口径
  const x509 = new X509Certificate(certRaw)
  const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spkiDer).digest('hex')
}

/** 读 fingerprints 文件第一枚 sha256/{hex} pin（公开物料；缺失/空 → null）。 */
function readExpectedPin() {
  try {
    if (!existsSync(RELAY_FINGERPRINTS_PATH)) return { pin: null, error: `fingerprints file missing (${RELAY_FINGERPRINTS_PATH})` }
    const raw = readFileSync(RELAY_FINGERPRINTS_PATH, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (t.length === 0 || t.startsWith('#')) continue
      const m = /^sha256\/([0-9a-fA-F]{64})$/.exec(t)
      if (m !== null) return { pin: m[1].toLowerCase(), error: null }
      return { pin: null, error: 'fingerprints line malformed (expected sha256/{64 hex})' }
    }
    return { pin: null, error: 'fingerprints file empty' }
  } catch (err) {
    return { pin: null, error: `fingerprints unreadable: ${err.message}` }
  }
}

/**
 * settings relay_enabled 只读单键（node:sqlite readOnly；零写入零锁等待）。
 * 返回 '1'/'0'/null（DB 缺席/不可读 → null，结构化而非异常）。
 */
function readRelayEnabledSetting() {
  try {
    if (!existsSync(SETTINGS_DB_PATH)) return { value: null, error: `settings db missing (${SETTINGS_DB_PATH}; resident never ran here)` }
    // node:sqlite（Node ≥22.5 内置，零新依赖）；readOnly 打开：零写入零锁等待
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(SETTINGS_DB_PATH, { readOnly: true })
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'relay_enabled'").get()
      return { value: typeof row?.value === 'string' ? row.value : null, error: null }
    } finally {
      db.close()
    }
  } catch (err) {
    return { value: null, error: `settings db unreadable: ${err.message}` }
  }
}

/** --deep：SSH 只读 journalctl -p err 行计数（零改动；输出零密钥零命令行）。 */
function sshDeepErrorCount(hours) {
  return new Promise((resolvePromise) => {
    const remote = `journalctl -u devhub-relay --since -${hours}h -p err --no-pager 2>/dev/null | wc -l`
    const child = spawn(
      'ssh',
      ['-i', ECS_SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', `root@${ECS_IP}`, remote],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', (c) => {
      out += c.toString()
    })
    child.on('error', (err) => {
      resolvePromise({ status: 'skip', count: null, detail: `ssh spawn failed: ${err.message}` })
    })
    child.on('close', (code) => {
      const n = Number.parseInt(out.trim(), 10)
      if (code === 0 && Number.isSafeInteger(n) && n >= 0) {
        resolvePromise({ status: n === 0 ? 'ok' : 'degraded', count: n, detail: `journalctl -p err lines in last ${hours}h (read-only)` })
      } else {
        resolvePromise({ status: 'skip', count: null, detail: `ssh exit code ${code} (key/网络不可用即跳过，零副作用)` })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// 单周期检查
// ---------------------------------------------------------------------------

function severityRank(s) {
  return s === 'down' ? 2 : s === 'degraded' ? 1 : 0
}

async function runCycle(cycleNo, flags) {
  const ts = new Date().toISOString()
  const checks = {}

  // ── 1. 本地网关 ──────────────────────────────────────────────────────────
  const gw = await httpGet(`http://127.0.0.1:${flags.gatewayPort}/v1/health`, GATEWAY_TIMEOUT_MS)
  let gatewayUp = false
  if (gw.error !== null) {
    checks.gateway = { status: 'down', http: null, detail: `GET /v1/health error: ${gw.error}` }
  } else if (gw.status !== 200) {
    checks.gateway = { status: 'down', http: gw.status, detail: `GET /v1/health http ${gw.status}（预期 200）` }
  } else {
    let body = null
    try {
      body = JSON.parse(gw.body)
    } catch {
      /* body 非 JSON → 判 down */
    }
    if (body === null || body.ok !== true) {
      checks.gateway = { status: 'down', http: gw.status, detail: 'GET /v1/health 200 但 body.ok!==true' }
    } else {
      gatewayUp = true
      checks.gateway = { status: 'ok', http: 200, detail: `name=${body.name} version=${body.version} uptimeSec=${body.uptimeSec}` }
    }
  }

  // ── 3+4. 公网 relay 健康 + 证书余量（一次握手两查）────────────────────────
  let upstreamConnected = null
  let caOk = true
  let caPem = ''
  if (existsSync(RELAY_CA_PATH)) {
    try {
      caPem = readFileSync(RELAY_CA_PATH, 'utf8')
    } catch (err) {
      caOk = false
      checks.publicRelay = { status: 'degraded', http: null, detail: `ca.pem unreadable: ${err.message}（不关证书校验，探测拒绝进行）` }
      checks.cert = { status: 'degraded', daysLeft: null, detail: 'ca.pem unreadable → TLS 探测跳过' }
    }
  } else {
    caOk = false
    checks.publicRelay = { status: 'degraded', http: null, detail: `ca.pem missing (${RELAY_CA_PATH})（不关证书校验，探测拒绝进行）` }
    checks.cert = { status: 'degraded', daysLeft: null, detail: 'ca.pem missing → TLS 探测跳过' }
  }

  if (caOk) {
    const pub = await httpsGetObserve(`https://${ECS_IP}${PUBLIC_HEALTH_PATH}`, PUBLIC_TIMEOUT_MS, caPem)
    if (pub.error !== null) {
      checks.publicRelay = { status: 'down', http: null, detail: `GET ${PUBLIC_HEALTH_PATH} error: ${pub.error}` }
      checks.cert = { status: 'down', daysLeft: null, detail: `TLS 握手失败: ${pub.error}` }
    } else {
      let body = null
      try {
        body = JSON.parse(pub.body)
      } catch {
        /* 非 JSON */
      }
      if (pub.status !== 200 || body === null || body.ok !== true || body.name !== 'devhub-relay') {
        checks.publicRelay = { status: 'down', http: pub.status, detail: `公网 health 非 200/非 devhub-relay body` }
      } else {
        upstreamConnected = body.upstream?.connected === true
        checks.publicRelay = {
          status: 'ok',
          http: 200,
          detail: `name=devhub-relay uptimeSec=${body.uptimeSec} upstream.connected=${body.upstream?.connected}`,
        }
      }
      // 证书余量（peer cert valid_to；<14 天 degraded）
      if (pub.cert === null) {
        checks.cert = { status: 'down', daysLeft: null, detail: 'peer cert 不可得（会话复用或旁路观测失败）' }
      } else {
        const validToMs = Date.parse(pub.cert.validTo)
        if (!Number.isFinite(validToMs)) {
          checks.cert = { status: 'down', daysLeft: null, detail: `valid_to 不可解析: ${pub.cert.validTo}` }
        } else {
          const daysLeft = Math.round(((validToMs - Date.now()) / 86_400_000) * 10) / 10
          // SPKI pin（公开物料指纹；对齐应用 M3-C1b pinning）
          let pinOk = null
          let pinDetail = ''
          const expected = readExpectedPin()
          if (expected.pin === null) {
            pinDetail = `; pin ${expected.error}`
          } else {
            try {
              const actual = spkiSha256Hex(pub.cert.raw)
              pinOk = actual === expected.pin
              pinDetail = pinOk ? '; SPKI pin match' : `; SPKI PIN MISMATCH (actual sha256/${actual.slice(0, 8)}…)`
            } catch (err) {
              pinDetail = `; pin 计算失败: ${err.message}`
            }
          }
          checks.cert = {
            status: daysLeft < CERT_MIN_DAYS || pinOk === false ? 'degraded' : 'ok',
            daysLeft,
            validTo: pub.cert.validTo,
            pinOk,
            detail: `notAfter=${pub.cert.validTo} 余量 ${daysLeft} 天（阈值 ${CERT_MIN_DAYS}）${pinDetail}`,
          }
        }
      }
    }
  }

  // ── 2. relay host 腿（判定表见头注释）───────────────────────────────────
  if (!gatewayUp) {
    checks.relay = {
      status: 'degraded',
      connected: null,
      source: null,
      detail: '常驻不在（gateway /v1/health down）→ 本地 relay 面不可查，connected=null（brief §1.2 语义）',
    }
  } else {
    const setting = readRelayEnabledSetting()
    const credentialPresent = existsSync(RELAY_CREDENTIAL_PATH) // 只存在性，绝不读内容
    if (setting.value === '0') {
      checks.relay = {
        status: 'degraded',
        connected: false,
        source: 'settings',
        detail: `relay_enabled='0'（默认零连接设计态）credential present=${credentialPresent}${setting.error !== null ? `; ${setting.error}` : ''}`,
      }
    } else if (upstreamConnected === null) {
      checks.relay = {
        status: 'degraded',
        connected: null,
        source: null,
        detail: `公网 health 不可得，host 腿真值未知${setting.error !== null ? `; ${setting.error}` : ''}`,
      }
    } else {
      checks.relay = {
        status: upstreamConnected ? 'ok' : 'degraded',
        connected: upstreamConnected,
        source: 'ecs-upstream',
        detail: upstreamConnected
          ? `relay_enabled=${setting.value ?? 'unknown'}，ECS forwarder.hostOnline=true（host 腿在线）`
          : `relay_enabled=${setting.value ?? 'unknown'}，ECS forwarder.hostOnline=false（host 腿离线）`,
      }
    }
  }

  // ── 5. --deep（可选 SSH 只读）──────────────────────────────────────────
  if (flags.deep) {
    checks.ecsDeep = await sshDeepErrorCount(flags.deepHours)
  }

  const statuses = Object.values(checks).map((c) => c.status)
  const worst = statuses.reduce((acc, s) => (severityRank(s) > severityRank(acc) ? s : acc), 'ok')
  return {
    kind: 'cycle',
    ts,
    cycle: cycleNo,
    overall: worst,
    gateway: checks.gateway,
    relay: checks.relay,
    publicRelay: checks.publicRelay,
    cert: checks.cert,
    ...(checks.ecsDeep !== undefined ? { ecsDeep: checks.ecsDeep } : {}),
  }
}

// ---------------------------------------------------------------------------
// 落盘 + T0 + summary
// ---------------------------------------------------------------------------

function ensureWatchDir(file) {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function appendNdjson(file, obj) {
  ensureWatchDir(file)
  appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8')
}

function writeT0() {
  ensureWatchDir(T0_MARKER)
  const iso = new Date().toISOString()
  writeFileSync(T0_MARKER, `${iso}\n`, 'utf8')
  return { kind: 't0', ts: iso, file: T0_MARKER }
}

/** --summary：读 ndjson（支持 .gz）→ 周期数/ok 率/首末错误/网关 down 时段数/证书最小余量。 */
async function summarize(file) {
  let raw
  if (file.endsWith('.gz')) {
    const { gunzipSync } = await import('node:zlib')
    raw = gunzipSync(readFileSync(file)).toString('utf8')
  } else {
    raw = readFileSync(file, 'utf8')
  }
  let malformed = 0
  const cycles = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const obj = JSON.parse(line)
      if (obj.kind === 'cycle') cycles.push(obj)
    } catch {
      /* 半行/损坏行跳过（计数进 malformed） */
      malformed += 1
    }
  }
  const total = cycles.length
  const okCycles = cycles.filter((c) => c.overall === 'ok').length
  const bad = cycles.filter((c) => c.overall !== 'ok')
  const badReason = (c) =>
    Object.entries({ gateway: c.gateway, relay: c.relay, publicRelay: c.publicRelay, cert: c.cert, ...(c.ecsDeep ? { ecsDeep: c.ecsDeep } : {}) })
      .filter(([, v]) => v && v.status !== 'ok')
      .map(([k, v]) => `${k}:${v.status}`)
      .join(',')
  const downPeriods = cycles.reduce((acc, c) => {
    const down = c.gateway?.status === 'down'
    if (down && !acc.inPeriod) acc.count += 1
    acc.inPeriod = down
    return acc
  }, { count: 0, inPeriod: false }).count
  const certDays = cycles.map((c) => c.cert?.daysLeft).filter((d) => typeof d === 'number')
  return {
    kind: 'summary',
    file: resolve(file),
    cycles: total,
    malformedLines: malformed,
    okCycles,
    okRate: total === 0 ? null : Math.round((okCycles / total) * 10_000) / 10_000,
    span: total === 0 ? null : { first: cycles[0].ts, last: cycles[total - 1].ts },
    firstError: bad.length === 0 ? null : { ts: bad[0].ts, cycle: bad[0].cycle, checks: badReason(bad[0]) },
    lastError: bad.length === 0 ? null : { ts: bad[bad.length - 1].ts, cycle: bad[bad.length - 1].cycle, checks: badReason(bad[bad.length - 1]) },
    gatewayDownCycles: cycles.filter((c) => c.gateway?.status === 'down').length,
    gatewayDownPeriods: downPeriods,
    certMinDaysLeft: certDays.length === 0 ? null : Math.min(...certDays),
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let flags
  try {
    flags = parseFlags(process.argv.slice(2))
  } catch (err) {
    console.error(`error: ${err.message}`)
    usage()
    process.exit(2)
  }

  // --summary：只读分析，不跑周期、不追加
  if (flags.summaryPath !== null) {
    const file = isAbsolute(flags.summaryPath) ? flags.summaryPath : resolve(flags.summaryPath)
    if (!existsSync(file)) {
      console.error(`error: ndjson not found: ${file}`)
      process.exit(2)
    }
    const summary = await summarize(file)
    console.log(JSON.stringify(summary))
    process.exit(0)
  }

  const outFile = flags.out !== null ? (isAbsolute(flags.out) ? flags.out : resolve(flags.out)) : DEFAULT_NDJSON

  // --t0：写标记 + 打印（可叠加单周期/loop）
  if (flags.t0) {
    console.log(JSON.stringify(writeT0()))
  }

  let cycleNo = 0
  const onSigint = () => {
    console.error('m3d-watch: loop stopped by SIGINT')
    process.exit(0)
  }
  if (flags.loopMinutes !== null) process.on('SIGINT', onSigint)

  const oneCycle = async () => {
    cycleNo += 1
    let record
    try {
      record = await runCycle(cycleNo, flags)
    } catch (err) {
      // 巡检自身崩溃也要落一条结构化行（错误路径要能跑通，绝不抛栈裸崩）
      record = { kind: 'cycle', ts: new Date().toISOString(), cycle: cycleNo, overall: 'down', error: `watch internal error: ${err.message}` }
    }
    console.log(JSON.stringify(record))
    try {
      appendNdjson(outFile, record)
    } catch (err) {
      console.error(`error: ndjson append failed (${outFile}): ${err.message}`)
      process.exitCode = 2
    }
    return record
  }

  if (flags.loopMinutes === null) {
    const record = await oneCycle()
    process.exit(record.overall === 'ok' ? 0 : 1)
  }

  // --loop：先跑一周期再定时；SIGINT 干净停（退出码 0）
  console.error(`m3d-watch: loop mode, every ${flags.loopMinutes} min, ndjson=${outFile}（SIGINT 干净停止）`)
  await oneCycle()
  const timer = setInterval(() => {
    oneCycle().catch(() => {})
  }, flags.loopMinutes * 60_000)
  process.on('exit', () => clearInterval(timer))
}

main().catch((err) => {
  console.error(`error: ${err?.stack ?? err}`)
  process.exit(2)
})
