/**
 * feedTrustProc.ts — updater feed TLS 信任纯逻辑层（CERT 批 Phase B，docs/23 §2.3/§3.3）。
 *
 * 背景：electron-updater@6.6.4（package-lock 锁版）全部 HTTP——latest.yml 检查
 * （AppUpdater.js:626 downloadToBuffer）、blockmap 差分（:653）、安装包下载——
 * 恒走 ElectronHttpExecutor（AppUpdater.js:196 生产分支）= Electron net + 独立分区
 * session：out/electronHttpExecutor.js:6 `NET_SESSION_NAME = "electron-updater"`、
 * :8 `session.fromPartition("electron-updater", { cache: false })`、:54-56
 * `net.request({ ...options, session: this.cachedSession })`。Chromium net 栈不信任
 * 私有 CA——自签 IP feed（X11 实证 net::ERR_CERT_AUTHORITY_INVALID）静默检查即撞墙。
 *
 * 解法（docs/23 决策点 D3=A 裁决 2026-09-14）：**仅**对 `electron-updater` 分区
 * session 挂 setCertificateVerifyProc（defaultSession/renderer 零触碰），按 hostname
 * 分流：非 feed host 原样回放默认 errorCode（零干预）；feed host 信任锚 =
 * 叶证书 SPKI sha256 ∈ pin 集（与 host-leg fingerprints 文件同源同解析
 * ——relayClient/config.ts parseRelayFingerprintFile，多行 pin = 双指纹窗口任一
 * 匹配，docs/19 §10.4）+ 有效期窗复核（过期/未生效拒 = 验收三拒「过期证书被拒」
 * 同语义）。链验证不在此做：pin 即信任锚（App PinTrustManager 同语义，docs/19
 * §10.2——SPKI 哈希非秘密，零凭据面）。
 *
 * Electron 官方回调语义（node_modules/electron/electron.d.ts:13338-13345）：
 * `callback(0)` 接受、`callback(-2)` 拒绝；**透传 = callback(request.errorCode)**
 * 重放 Chromium 默认码（成功 0 回放 0 / 失败码原样回放——不依赖未文档化的 -3）。
 * NOTE（d.ts 同页）：proc 结果被 network service 缓存——pin 集热装载对新验证连接
 * 生效（host-leg 重连热装载同精神）。
 *
 * 纯 Node 模块：零 electron / 零 electron-updater import，可被 smoke 在系统 Node
 * 下直接加载（updateFeed.ts 同一约束风格；Node strip-only——不用 enum/namespace/
 * 参数属性）。装点在 updaterWire（打包态 dev 禁用门之后）。
 */

import { createHash, X509Certificate } from 'node:crypto'

/** verify-proc 接受（electron.d.ts:13340 官方语义）。 */
export const FEED_CERT_ACCEPT = 0
/** verify-proc 拒绝（electron.d.ts:13340 官方语义）。 */
export const FEED_CERT_REJECT = -2

/**
 * Electron `session.Request` 的最小结构投影（零 electron import——updaterWire 以
 * 结构化适配传入；字段名与 electron.d.ts:23417-23436 / 6672-6712 逐字对齐：
 * certificate.data = PEM 文本，validStart/validExpiry = epoch 秒）。
 */
export interface FeedCertVerifyRequest {
  hostname?: string
  errorCode?: number
  certificate?: {
    data?: string
    validStart?: number
    validExpiry?: number
  }
}

/**
 * pin 集装载结果（结构化，绝不抛——verifier 消费面禁止异常路径）。
 * pins = 归一化小写 hex（bare，无 `sha256/` 前缀——normalizeRelayFingerprint 同款）。
 * ok=false = 物料缺失/不可读/格式错（fail-closed：feed host 一律拒绝）。
 */
export interface FeedPinSet {
  ok: boolean
  pins: string[]
}

/** pin 集装载缝（生产 = 每次验证现读 fingerprints 文件；测试 = 注入 fake）。 */
export type FeedPinLoader = () => FeedPinSet

/** 判定码：FEED_CERT_ACCEPT / FEED_CERT_REJECT / 非 feed host 原样回放的 errorCode。 */
export type FeedCertVerifyProc = (request: FeedCertVerifyRequest) => number

/** 可诊断拒绝理由（零凭据零堆栈——SPKI 哈希非秘密；结构化日志面）。 */
export type FeedVerifyLog = (message: string) => void

/**
 * 构造 feed 证书 verify 判定器（纯函数工厂；本函数绝不抛）。
 *
 * 分流规则：
 * - 非 feed host → 原样回放 `errorCode`（缺省防御性拒绝——真实 Electron 恒有值，
 *   类型层已锁；缺值属异常请求，fail-closed 同 docs/19 §10.3 精神）；
 * - feed host → pin 集现读（热装载）：缺失/空/坏 → 拒；certificate.data 缺失或
 *   非 PEM → 拒；叶 SPKI sha256 ∉ pins → 拒（结构化理由）；有效期界任一缺失 → 拒
 *   （生产 wiring 由 electron.d.ts 类型锁定恒有值，缺值只可能来自意外形态——
 *   不带有效期放行会架空「过期拒」，宁拒不放）；窗外（未生效/已过期）→ 拒；
 *   其余 → 接受。
 */
export function createFeedCertVerifyProc(options: {
  feedHost: string
  loadPins: FeedPinLoader
  /** 可诊断日志缝（wire 侧接结构化 logger；缺省静默）。 */
  log?: FeedVerifyLog
  /** 当前时刻（epoch 秒；测试缝，缺省系统钟）。 */
  nowSec?: () => number
}): FeedCertVerifyProc {
  const feedHost = options.feedHost.trim().toLowerCase()
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000))
  const log = options.log ?? (() => {})
  return (request) => {
    const hostname = (request.hostname ?? '').trim().toLowerCase()
    if (hostname !== feedHost) {
      // 透传（零干预）：成功 0 回放 0，失败码原样回放——默认校验行为逐位保持
      const pass = typeof request.errorCode === 'number' ? request.errorCode : FEED_CERT_REJECT
      if (pass !== request.errorCode) log(`passthrough host=${hostname}: errorCode missing, fail-closed reject`)
      return pass
    }
    // ---- feed host：信任锚 = 叶 SPKI ∈ pins（+有效期窗复核）----
    const pinSet = options.loadPins()
    if (!pinSet.ok || pinSet.pins.length === 0) {
      log(`feed host=${hostname}: pin set unavailable/empty — fail-closed reject`)
      return FEED_CERT_REJECT
    }
    const data = request.certificate?.data
    if (typeof data !== 'string' || data.length === 0) {
      log(`feed host=${hostname}: certificate PEM data missing — reject`)
      return FEED_CERT_REJECT
    }
    let spkiHex: string
    try {
      const cert = new X509Certificate(data)
      const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' })
      spkiHex = createHash('sha256').update(spkiDer).digest('hex')
    } catch {
      log(`feed host=${hostname}: certificate PEM unparseable — reject`)
      return FEED_CERT_REJECT
    }
    if (!pinSet.pins.includes(spkiHex)) {
      log(`feed host=${hostname}: SPKI sha256/${spkiHex} not in pins (len=${pinSet.pins.length}) — reject`)
      return FEED_CERT_REJECT
    }
    const validStart = request.certificate?.validStart
    const validExpiry = request.certificate?.validExpiry
    if (typeof validStart !== 'number' || typeof validExpiry !== 'number') {
      log(`feed host=${hostname}: validity bounds missing — reject (fail-closed)`)
      return FEED_CERT_REJECT
    }
    const now = nowSec()
    if (now < validStart) {
      log(`feed host=${hostname}: certificate not yet valid (start=${validStart} > now=${now}) — reject`)
      return FEED_CERT_REJECT
    }
    if (now > validExpiry) {
      log(`feed host=${hostname}: certificate expired (expiry=${validExpiry} < now=${now}) — reject`)
      return FEED_CERT_REJECT
    }
    log(`feed host=${hostname}: SPKI sha256/${spkiHex} pinned — accept`)
    return FEED_CERT_ACCEPT
  }
}
