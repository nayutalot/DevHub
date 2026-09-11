/**
 * zcodeLinkProvider.ts — ZCode 移动遥控链接磁盘重建（S 批，任务书 §1 #2）。
 *
 * 事实链（R 批侦察 acceptance/agents-mobile/zcode-url-source-20260911-0415/，
 * docs/18 §5.3 注记）：
 * - URL 形态：`<origin>/remote/v4?sid=<deviceSid>&hash=<passHash>&t=<ms>&mid=<deviceMid>`
 *   `&name=<deviceName>&app_version=3.11.2`（buildWebRemoteControlExternalQrUrl 同序）；
 * - 三来源（全部只读）：`~/.zcode/v2/setting.json` →
 *   `webRemoteControlExternalRelayDevice.deviceSid`（明文）；`~/.zcode/v2/credentials.json`
 *   → 键 `web-remote-control:external-relay:pass_hash` = 信封
 *   `enc:v1:<iv_b64url>.<tag_b64url>.<ct_b64url>`（AES-256-GCM，**tag 在中间**）；
 *   `~/.zcode/v2/telemetry-state.json` → `deviceMid`（明文）；
 * - 密钥：`sha256(credentialSecret)`；credentialSecret = env `ZCODE_CREDENTIAL_SECRET`
 *   **优先**，缺省回退 `"zcode-credential-fallback:" + platform + ":" + homedir + ":" + username`；
 * - 拉取模型：`t = Date.now()` 毫秒 nonce（动态项从不落盘）——App 需要时取，永远新鲜。
 *
 * 红线（任务书 §0/§1）：
 * - **令牌三零**：sid/hash/mid/完整 URL 绝不入日志/审计/错误信息——本模块零日志、
 *   零副作用写盘（URL 仅内存构造即发）；失败原因（reason）一律静态字面量 + 字段名，
 *   绝不内嵌任何文件内容/信封串/解密产物，绝不 partial URL；
 * - **零持久化**：不写 settings/DB（remote_commands.result_json 与审计面只记 {provider}，
 *   由调用方 agentControlService/commandDownlink 保证）。
 *
 * electron-free 纯函数；fs 读取器注入式（smoke fake fs 直测，绝不触真实 ~/.zcode）。
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { homedir, hostname as osHostname, platform, userInfo } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

/** ZCode app_version（R 批证据：asar 元数据 3.11.2 ≥ 3.4.0 → /remote/v4）。
 *  TODO(S 批注)：ZCode 本地无可读版本查询面（0 LISTEN / asar 内常量）；ZCode 若提供
 *  可读版本源再改读取，常量升版即可（v4 阈值 3.4.0 远低于任何现实版本）。 */
export const ZCODE_LINK_APP_VERSION = '3.11.2'

/** 生产默认 origin（asar 反混淆主默认=zcode.z.ai；2026-09-11 实测：z.ai 直连
 *  /remote/v4=HTTP 200，chatglm.site DNS→私网死址、直连/代理/ECS 四面不通；
 *  endpoint 对话框 placeholder=chatglm.site 曾致 R 批误读）。 */
export const ZCODE_LINK_ORIGIN = 'https://zcode.z.ai'

/** credentials.json 中 pass_hash 信封的键名（R 批证据 [B]）。 */
export const ZCODE_PASS_HASH_CREDENTIAL_KEY = 'web-remote-control:external-relay:pass_hash'

/** 结构化不可用错误码（任务书 §1 #2；docs/18 §8.2 同一命名域新增，WS 专属）。 */
export const ZCODE_LINK_UNAVAILABLE = 'ZCODE_LINK_UNAVAILABLE'

/** 注入面（smoke 全 fake；生产缺省 = 真实 fs/os）。 */
export interface ZcodeLinkDeps {
  /** 文本文件读取（不存在/不可读 → throw，由本模块折叠为结构化 reason）。 */
  readFile?(path: string): string
  /** 密钥环境（缺省 process.env）。 */
  env?: Record<string, string | undefined>
  /** 毫秒时间戳源（缺省 Date.now）。 */
  nowMs?(): number
  /** 设备名（缺省 os.hostname）。 */
  deviceName?(): string
  /** 回退密钥派生域（缺省 os 三元组；smoke 锁定派生输入）。 */
  platform?(): string
  homedir?(): string
  username?(): string
  /** ~/.zcode 根（缺省 os.homedir() + '/.zcode'；smoke 指向临时目录）。 */
  zcodeRoot?(): string
}

export type ZcodeLinkResult =
  | { ok: true; url: string; deviceName: string }
  | { ok: false; code: typeof ZCODE_LINK_UNAVAILABLE; reason: string }

const DEFAULT: Required<Pick<ZcodeLinkDeps, 'readFile' | 'nowMs' | 'deviceName' | 'platform' | 'homedir' | 'username' | 'zcodeRoot'>> = {
  readFile: (p) => readFileSync(p, 'utf8'),
  nowMs: () => Date.now(),
  deviceName: () => osHostname(),
  platform: () => platform(),
  homedir: () => homedir(),
  username: () => userInfo().username,
  zcodeRoot: () => join(homedir(), '.zcode'),
}

/**
 * 构造 ZCode 移动遥控 URL（同步；磁盘三文件 + 本地解密，亚秒级）。
 * 任何失败 → { ok:false, code:'ZCODE_LINK_UNAVAILABLE', reason: 静态字面量 }，
 * 绝不抛出、绝不 partial URL（半成品链接比失败更危险——任务书 §1 #2）。
 */
export function buildZcodeWorkspaceLink(deps: ZcodeLinkDeps = {}): ZcodeLinkResult {
  const d = { ...DEFAULT, ...deps }
  const v2 = join(d.zcodeRoot(), 'v2')
  try {
    // [A] deviceSid（明文）
    const sid = readStringField(d, join(v2, 'setting.json'), 'webRemoteControlExternalRelayDevice.deviceSid')
    if (sid === null) return unavailable('device_sid_missing')

    // [B] passHash（enc:v1 信封解密）
    const envelope = readStringField(d, join(v2, 'credentials.json'), ZCODE_PASS_HASH_CREDENTIAL_KEY)
    if (envelope === null) return unavailable('pass_hash_missing')
    const passHash = decryptCredentialEnvelope(envelope, d)
    if (passHash === null) return unavailable('pass_hash_decrypt_failed')

    // [C] deviceMid（明文）
    const mid = readStringField(d, join(v2, 'telemetry-state.json'), 'deviceMid')
    if (typeof mid !== 'string' || mid.trim().length === 0) return unavailable('device_mid_missing')

    const name = (d.deviceName() || 'windows').trim()
    const url = new URL('/remote/v4', ZCODE_LINK_ORIGIN)
    url.searchParams.set('sid', sid.trim())
    url.searchParams.set('hash', passHash)
    url.searchParams.set('t', String(d.nowMs()))
    url.searchParams.set('mid', mid.trim())
    url.searchParams.set('name', name)
    url.searchParams.set('app_version', ZCODE_LINK_APP_VERSION)
    return { ok: true, url: url.toString(), deviceName: name }
  } catch {
    // 读文件 I/O 失败 / JSON 解析失败 → 统一结构化不可用（绝不向上抛裸异常）
    return unavailable('sources_unreadable')
  }
}

/** 读取 JSON 文件中「顶层对象 → 点路径」字符串字段；任何缺失/类型不符 → null。 */
function readStringField(
  d: { readFile(path: string): string },
  path: string,
  dotPath: string,
): string | null {
  let root: unknown
  try {
    root = JSON.parse(d.readFile(path))
  } catch {
    return null
  }
  let node: unknown = root
  for (const key of dotPath.split('.')) {
    if (node === null || typeof node !== 'object') return null
    node = (node as Record<string, unknown>)[key]
  }
  if (typeof node !== 'string' || node.length === 0) return null
  return node
}

/**
 * enc:v1 信封解密（R 批证据 §5：`enc:v1:` + b64url(iv12) + '.' + b64url(tag16) + '.' +
 * b64url(ct)；AES-256-GCM，key = sha256(secret)，无 AAD）。任何形态偏差/校验失败
 * → null（调用方折 ZCODE_LINK_UNAVAILABLE；信封串绝不入 reason）。
 */
export function decryptCredentialEnvelope(envelope: string, deps: ZcodeLinkDeps = {}): string | null {
  const d = { ...DEFAULT, ...deps }
  if (!envelope.startsWith('enc:v1:')) return null
  const parts = envelope.slice('enc:v1:'.length).split('.')
  if (parts.length !== 3) return null
  let iv: Buffer
  let tag: Buffer
  let ct: Buffer
  try {
    iv = Buffer.from(parts[0], 'base64url')
    tag = Buffer.from(parts[1], 'base64url')
    ct = Buffer.from(parts[2], 'base64url')
  } catch {
    return null
  }
  if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) return null
  const key = credentialKey(d)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return null // GCM auth 校验失败 / 密钥不匹配
  }
}

/**
 * 凭据密钥派生（R 批证据 §5）：env `ZCODE_CREDENTIAL_SECRET` **优先**，缺省回退
 * `zcode-credential-fallback:<platform>:<homedir>:<username>`；key = sha256(secret)。
 */
export function credentialKey(deps: ZcodeLinkDeps = {}): Buffer {
  const d = { ...DEFAULT, ...deps }
  const fromEnv = deps.env?.ZCODE_CREDENTIAL_SECRET
  const secret =
    fromEnv !== undefined && fromEnv.length > 0
      ? fromEnv
      : `zcode-credential-fallback:${d.platform()}:${d.homedir()}:${d.username()}`
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** smoke 注入缝：命令下行默认 deps 覆盖（真实 ~/.zcode 绝不进测试；生产不调用）。 */
let smokeDeps: ZcodeLinkDeps | null = null

/** smoke 专用（scripts/smoke.mjs）：注入 fake deps / null = 还原生产缺省。 */
export function setZcodeLinkDepsForSmoke(deps: ZcodeLinkDeps | null): void {
  smokeDeps = deps
}

/** commandDownlink 调用面：生产缺省 + smoke 注入叠加。 */
export function buildZcodeWorkspaceLinkDefault(): ZcodeLinkResult {
  return buildZcodeWorkspaceLink(smokeDeps ?? {})
}

function unavailable(reason: string): ZcodeLinkResult {
  return { ok: false, code: ZCODE_LINK_UNAVAILABLE, reason }
}
