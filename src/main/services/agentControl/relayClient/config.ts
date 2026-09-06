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
 * 5. TLS 信任物料（M3-C1b，docs/19 §10 注入式指纹 pinning + 自签 IP CA）：
 *    指纹文件 `%LOCALAPPDATA%\DevHub\relay\fingerprints`（每行一枚 `sha256/{hex}`
 *    或 base64(32B)，注释/空行跳过，归一化小写 hex，格式错 fail-fast）+ CA 文件
 *    `%LOCALAPPDATA%\DevHub\relay\ca.pem`（自签根 CA；缺失→结构化错误提示补放，
 *    **不采用**仅 pin 绕默认链验证）。指纹是公开物料可入配置/日志；ca.pem 属部署
 *    物料非私钥（私钥只在 ECS，docs/ecs-relay-deploy/README.md §6）。
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
 * （实现移至下方 TLS 信任物料段的 relayBaseDir 基座，行为逐字节不变。）
 */

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
// TLS 信任物料（M3-C1b，docs/19 §10：指纹 pinning + 自签 IP CA，注入式）
// ---------------------------------------------------------------------------

/** relay 信任物料目录基座（凭据/指纹/CA 同级保管，docs/19 §10.3）。 */
function relayBaseDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (typeof localAppData === 'string' && localAppData.trim().length > 0) {
      return join(localAppData.trim(), 'DevHub', 'relay')
    }
  }
  return join(homedir(), '.local', 'share', 'DevHub', 'relay')
}

/** relay 凭据文件路径（M2-R1 权威值不变）：env 缝 → Windows 权威 → XDG 回落。 */
export function getRelayCredentialPath(): string {
  const override = process.env.DEVHUB_RELAY_CREDENTIAL_FILE
  if (typeof override === 'string' && override.trim().length > 0) {
    return resolve(override.trim())
  }
  return join(relayBaseDir(), 'credential')
}

/**
 * SPKI 指纹文件路径（C1 约定名 `fingerprints`，M3-C1b 权威值）：
 * env 覆盖（测试/夹具缝）→ `%LOCALAPPDATA%\DevHub\relay\fingerprints` → XDG 回落。
 * 指纹是公开物料（docs/19 §10.1），路径可入错误信息/投影。
 */
export function getRelayFingerprintsPath(): string {
  const override = process.env.DEVHUB_RELAY_FINGERPRINTS_FILE
  if (typeof override === 'string' && override.trim().length > 0) {
    return resolve(override.trim())
  }
  return join(relayBaseDir(), 'fingerprints')
}

/**
 * 自签根 CA 文件路径（`ca.pem`，与 docs/ecs-relay-deploy/gen-ip-cert.sh 产出的
 * ca.crt 同物——部署批落盘时以 ca.pem 命名）：env 覆盖 → 权威路径 → XDG 回落。
 */
export function getRelayCaPath(): string {
  const override = process.env.DEVHUB_RELAY_CA_FILE
  if (typeof override === 'string' && override.trim().length > 0) {
    return resolve(override.trim())
  }
  return join(relayBaseDir(), 'ca.pem')
}

/**
 * 单枚 SPKI 指纹归一化（docs/19 §10.2 形态 + docs/ecs-relay-deploy/README.md §2）：
 * 接受 `sha256/{64 hex}`（大小写不敏感 → 小写）、裸 64 hex、`sha256/{base64}` 与
 * 裸 base64（解码后必须恰为 32 字节）；其余格式 fail-fast 抛错（与 Android :core
 * TlsPinningConfig 构造即校验同语义——绝不静默跳过半枚指纹）。
 */
export function normalizeRelayFingerprint(raw: string): string {
  const body = raw.trim().startsWith('sha256/') ? raw.trim().slice('sha256/'.length) : raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(body)) return body.toLowerCase()
  // base64(32B)：标准/URL-safe 字母表，长度 43/44（含 padding），解码恰 32 字节
  if (/^[A-Za-z0-9+/_-]{43}={0,2}$/.test(body)) {
    const buf = Buffer.from(body, 'base64')
    if (buf.length === 32) return buf.toString('hex')
  }
  throw new Error(`invalid relay SPKI fingerprint (expected sha256/<64 hex> or base64 of 32 bytes): ${raw.trim().slice(0, 80)}`)
}

/**
 * 指纹文件解析：每行一枚，`#` 注释行/空行跳过（CRLF/首尾空白容忍），逐行归一化
 * （格式错 fail-fast 抛带行内容错误——调用方折叠为带路径的结构化错误）。全注释/
 * 空文件返回 []（由 loadRelayTlsTrust 折叠为 empty——pin 集必须 ≥1，docs/19 §10.3）。
 */
export function parseRelayFingerprintFile(content: string): string[] {
  const pins: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    pins.push(normalizeRelayFingerprint(line))
  }
  return pins
}

/** TLS 信任物料（指纹已归一化小写 hex + 自签根 CA PEM 文本）。 */
export interface RelayTlsTrust {
  fingerprints: string[]
  ca: string
}

export type RelayTlsTrustLoadFailure =
  | 'fingerprints-missing'
  | 'fingerprints-unreadable'
  | 'fingerprints-empty'
  | 'fingerprints-malformed'
  | 'ca-missing'
  | 'ca-unreadable'
  | 'ca-empty'

export interface RelayTlsTrustLoad {
  ok: boolean
  /** ok 时为就绪信任物料（指纹小写 hex ≥1 + CA PEM）。 */
  trust?: RelayTlsTrust
  /** !ok 结构化原因（statusProjector 告警面/状态机消费；零凭据）。 */
  reason?: RelayTlsTrustLoadFailure
  /** !ok 结构化错误（含建议补放路径；指纹/CA 是公开物料可入投影）。 */
  error?: string
}

/**
 * 装载 TLS 信任物料（结构化结果，绝不抛——状态机/投影消费面禁止异常路径）：
 * 指纹文件缺失/不可读/空/格式错 → 结构化失败（格式错保留 fail-fast 语义：错误携带
 * 路径与行内容，绝不产出半枚 pin 集）；ca.pem 缺失 → 结构化错误提示补放——**不采用**
 * 「仅 pin 绕默认链验证」（无 CA 时链校验无法完成，docs/19 §10 信任模型 = 默认规则
 * + SPKI pin 双保险，SAN 与指纹缺一不可）。
 */
export function loadRelayTlsTrust(): RelayTlsTrustLoad {
  const fingerprintsPath = getRelayFingerprintsPath()
  if (!existsSync(fingerprintsPath)) {
    return {
      ok: false,
      reason: 'fingerprints-missing',
      error: `relay TLS fingerprints file not found (provision ${fingerprintsPath}, docs/19 §10)`,
    }
  }
  let raw: string
  try {
    raw = readFileSync(fingerprintsPath, 'utf8')
  } catch {
    return { ok: false, reason: 'fingerprints-unreadable', error: `relay TLS fingerprints file unreadable: ${fingerprintsPath}` }
  }
  let pins: string[]
  try {
    pins = parseRelayFingerprintFile(raw)
  } catch (err) {
    return {
      ok: false,
      reason: 'fingerprints-malformed',
      error: `relay TLS fingerprints file has an invalid line (fail-fast): ${fingerprintsPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (pins.length === 0) {
    return { ok: false, reason: 'fingerprints-empty', error: `relay TLS fingerprints file carries no fingerprint (need >=1 SPKI pin): ${fingerprintsPath}` }
  }
  const caPath = getRelayCaPath()
  if (!existsSync(caPath)) {
    return {
      ok: false,
      reason: 'ca-missing',
      error: `relay CA file not found (provision ${caPath}; pin-only bypass of chain verification is not adopted, docs/19 §10)`,
    }
  }
  let ca: string
  try {
    ca = readFileSync(caPath, 'utf8').trim()
  } catch {
    return { ok: false, reason: 'ca-unreadable', error: `relay CA file unreadable: ${caPath}` }
  }
  if (ca.length === 0 || !ca.includes('-----BEGIN')) {
    return { ok: false, reason: 'ca-empty', error: `relay CA file is empty or not PEM (expected a certificate): ${caPath}` }
  }
  return { ok: true, trust: { fingerprints: pins, ca } }
}

/** 指纹来源文件名（只读展示用；如 `fingerprints`）。 */
export function relayFingerprintsSourceName(): string {
  const path = getRelayFingerprintsPath()
  const base = path.includes('\\') ? path.split('\\').pop() : path.split('/').pop()
  return typeof base === 'string' && base.length > 0 ? base : path
}

/**
 * TLS 信任物料投影（statusProjector/设置 UI 指纹状态行数据源；只读，零凭据）：
 * ok → { ok:true, pins, source }；!ok → { ok:false, pins:0, source, error }。
 */
export interface RelayTlsTrustStatusData {
  ok: boolean
  /** 归一化后指纹枚数（双指纹窗口 = 2）。 */
  pins: number
  /** 来源文件名（如 fingerprints）。 */
  source: string
  /** !ok 结构化原因与建议（零凭据）。 */
  error?: string
}

export function readRelayTlsTrustStatus(): RelayTlsTrustStatusData {
  const source = relayFingerprintsSourceName()
  const load = loadRelayTlsTrust()
  if (load.ok && load.trust !== undefined) {
    return { ok: true, pins: load.trust.fingerprints.length, source }
  }
  return {
    ok: false,
    pins: 0,
    source,
    ...(load.error !== undefined ? { error: load.error } : {}),
  }
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
