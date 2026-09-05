/**
 * config.ts — relayClient 配置面（M2-R1 模块 1/8，docs/19 §4.1 config 行 + §4.7 设置键）。
 *
 * 职责（docs/20 §2.1 R1 范围行）：
 * 1. settings 两键读取：`relay_enabled`（'1' → 启用，默认 '0' = 零连接）、
 *    `relay_endpoint`（如 wss://59.110.149.11——U1 已裁决 IP 直连无域名，docs/21 §1）。
 *    读取走 settingsService 白名单键（getSetting；key 不在白名单 → ServiceError，
 *    本模块只消费已白名单键）。附带水位键 `relay_last_sent_seq` 的白名单消费
 *    （docs/19 §4.3 明文指定的普通键值非凭据键；写侧在 eventUplink）。
 * 2. 凭据文件（docs/19 §2.2 红线）：Relay 凭据 = 每部署一份 256-bit（ECS 签发），
 *    仅存 `%LOCALAPPDATA%\DevHub\relay\credential` 机器本地文件——**不入仓库、不入
 *    settings 表、不入 DB、不入日志**（先例 = frp token 的 frpc.toml 形态 +
 *    docs/15 §8 凭据外置红线）。本模块只承载「读逻辑 + 0600 等效写缝（供注册
 *    换发/夹具装配）」；一次性注册码换发本身是部署面操作（ecs-relay/README.md
 *    偏离单 4：POST /relay/host 属部署步骤，不在客户端自动化面）。
 * 3. 结构化注册投影（「缺失 → 结构化未注册投影」）：凭据缺失/端点未配置绝不是
 *    异常，而是 'unregistered' / 'misconfigured' 状态投影（statusProjector 消费），
 *    状态机对两者同样零连接（docs/19 §4.7 结构化而非错误纪律）。
 * 4. endpoint 校验：必须可解析（wsClient.parseRelayEndpoint）；**wss 强制**
 *    （docs/18 §2「客户端代码层必须拒绝非 wss:// endpoint」/D7）；`ws://` 仅
 *    loopback 例外（wsClient.parseRelayEndpoint 注释裁定的校验归属点=本模块；
 *    明文联调时间盒 docs/19 §11 不承载真实配对）。
 *
 * electron-free（node:fs/node:os/node:path）；零写库（settings 读写经 settingsService）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getSetting } from '../../settingsService.ts'
import { parseRelayEndpoint } from './wsClient.ts'

// ---------------------------------------------------------------------------
// settings 两键（docs/19 §4.7：ALLOWED_KEYS 10→12 由 settingsService 承载）
// ---------------------------------------------------------------------------

/** relay_enabled settings 真值（'1' → true；缺省/其他一律 false——默认零连接）。 */
export function relayEnabledSetting(): boolean {
  return getSetting('relay_enabled') === '1'
}

/** relay_endpoint 原样（trim 后；未配置为空串）。 */
export function relayEndpointSetting(): string {
  const raw = getSetting('relay_endpoint')
  return typeof raw === 'string' ? raw.trim() : ''
}

/** lastSentSeq 水位键（docs/19 §4.3：普通键值非凭据；eventUplink 写，本模块读）。 */
export function relayLastSentSeqSetting(): number {
  const raw = getSetting('relay_last_sent_seq')
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

// ---------------------------------------------------------------------------
// endpoint 校验（wss 强制 + ws:// 仅 loopback 例外）
// ---------------------------------------------------------------------------

export interface RelayEndpointValidation {
  ok: boolean
  /** 校验失败的结构化原因（零凭据；'not configured' 覆盖空串）。 */
  error?: string
}

/** loopback 主机名（ws:// 例外面；URL hostname 形态，::1 已去方括号）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '[::1]'
}

/**
 * relay endpoint 校验（docs/18 §2 D7）：可解析（parseRelayEndpoint）+ wss 强制 +
 * ws:// 仅 loopback。返回结构化结果，绝不抛（配置面禁止异常路径）。
 */
export function validateRelayEndpoint(endpoint: string): RelayEndpointValidation {
  if (endpoint.length === 0) {
    return { ok: false, error: 'relay endpoint not configured (settings relay_endpoint is empty)' }
  }
  const parts = parseRelayEndpoint(endpoint)
  if (parts === null) {
    return { ok: false, error: 'malformed relay endpoint (expected wss://host[:port][/path], docs/18 §2)' }
  }
  if (!parts.secure && !isLoopbackHost(parts.host)) {
    return {
      ok: false,
      error: 'relay endpoint must be wss:// (cleartext ws:// is loopback-only, docs/18 §2 / docs/19 §11)',
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 凭据文件（docs/19 §2.2：机器本地文件，0600 权限位等效）
// ---------------------------------------------------------------------------

/**
 * Relay 凭据文件路径：
 * 1. `DEVHUB_RELAY_CREDENTIAL_FILE` env 覆盖（测试/夹具缝；与 DEVHUB_HOME 同款先例）；
 * 2. Windows = `%LOCALAPPDATA%\DevHub\relay\credential`（docs/19 §2.2 权威值）；
 * 3. 非 Windows 开发面回落 = `~/.local/share/DevHub/relay/credential`（XDG data 惯例）。
 */
export function getRelayCredentialPath(): string {
  const override = process.env.DEVHUB_RELAY_CREDENTIAL_FILE
  if (typeof override === 'string' && override.trim().length > 0) {
    return resolve(override.trim())
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (typeof localAppData === 'string' && localAppData.trim().length > 0) {
      return join(localAppData.trim(), 'DevHub', 'relay', 'credential')
    }
  }
  return join(homedir(), '.local', 'share', 'DevHub', 'relay', 'credential')
}

export interface RelayCredentialRead {
  ok: boolean
  /** ok 时为凭据明文（仅在进程内存流转；绝不入日志/DB/投影）。 */
  credential?: string
  /** !ok 时结构化原因（零凭据零路径泄露用户名以外的内容）。 */
  reason?: 'missing' | 'empty' | 'unreadable'
}

/**
 * 读凭据（缺失 → 结构化 missing，绝不抛——未注册是常态投影不是异常）。
 * 读失败折叠 unreadable；空文件折叠 empty。内容 trim 后原样返回（256-bit
 * base64url 由 ECS 签发面保证；此处不做格式强校验以免部署形态分叉）。
 */
export function loadRelayCredential(): RelayCredentialRead {
  const path = getRelayCredentialPath()
  if (!existsSync(path)) {
    return { ok: false, reason: 'missing' }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const credential = raw.trim()
  if (credential.length === 0) {
    return { ok: false, reason: 'empty' }
  }
  return { ok: true, credential }
}

/**
 * 凭据写缝（0600 等效：目录 0700 + 文件 0600；Windows NTFS 下 mode 位为 best-effort，
 * 文件落在用户 profile 下受 ACL 保护——docs/19 §2.2「0600 权限位等效」语义）。
 * 供注册换发落盘与夹具装配使用；调用方保证不入日志（明文只在参数与文件中流转）。
 */
export function saveRelayCredential(credential: string): void {
  const path = getRelayCredentialPath()
  const dir = join(path, '..')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${credential.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
}

// ---------------------------------------------------------------------------
// 结构化注册投影（缺失 → 未注册，非错误）
// ---------------------------------------------------------------------------

export type RelayRegistrationStateName = 'disabled' | 'ready' | 'unregistered' | 'misconfigured'

export interface RelayRegistrationState {
  /** settings relay_enabled 真值。 */
  enabled: boolean
  /** settings relay_endpoint 原样（trim 后；未配置为空串）。 */
  endpoint: string
  /** endpoint 校验通过（wss/loopback-ws 可解析）。 */
  endpointOk: boolean
  /** 凭据文件已装配且非空。 */
  hasCredential: boolean
  /** 结构化状态名：disabled 压倒一切；unregistered = 启用+端点好+缺凭据；
   *  misconfigured = 启用+端点坏；ready = 三者齐（可连接）。 */
  state: RelayRegistrationStateName
}

/**
 * 注册态投影（docs/19 §4.7「结构化而非错误」纪律的 config 落点）：
 * disabled → enabled:false（其余字段仍如实投影）；unregistered/misconfigured →
 * 状态机零连接 + statusProjector 结构化可见；ready → 允许 connecting。
 */
export function readRelayRegistrationState(): RelayRegistrationState {
  const enabled = relayEnabledSetting()
  const endpoint = relayEndpointSetting()
  const validation = validateRelayEndpoint(endpoint)
  const hasCredential = loadRelayCredential().ok
  let state: RelayRegistrationStateName
  if (!enabled) {
    state = 'disabled'
  } else if (!validation.ok) {
    state = 'misconfigured'
  } else if (!hasCredential) {
    state = 'unregistered'
  } else {
    state = 'ready'
  }
  return { enabled, endpoint, endpointOk: validation.ok, hasCredential, state }
}

/** 校验失败原因透出（statusProjector.lastError 数据源；零凭据）。 */
export function relayEndpointError(endpoint: string): string | undefined {
  return validateRelayEndpoint(endpoint).error
}
