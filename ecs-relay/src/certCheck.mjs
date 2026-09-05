/**
 * certCheck.mjs — Relay TLS 证书剩余有效期检查（A⑥ 修 3 / P0a 证书日历）。
 *
 * 部署面 TLS 在 Caddy 反代终结（docs/19 §5.1），Relay 自身不装载证书——本检查是
 * 部署自检（selfcheck）的日历项：证书路径 env RELAY_CERT_PATH（默认
 * /etc/devhub-relay/tls/server.crt，即 ECS 反代证书落盘位）：
 * - 文件不存在 → SKIP（开发机无证书；输出注明，不算失败）；
 * - 剩余 <14 天 → FAIL（自检退出码非 0，醒目输出到期日）；
 * - 剩余 ≥14 天 → PASS（输出剩余天数与到期日）。
 *
 * 独立纯函数（无进程副作用）：selfcheck.mjs 与 node --test（openssl 临时证书三档
 * 断言）共用同一实现，杜绝检查逻辑双份漂移。
 */
import { readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'

/** 剩余有效期告警线（天；<14 → FAIL，docs/19 §5.7 P0a）。 */
export const CERT_WARN_DAYS = 14

/** 默认证书路径（ECS 反代证书落盘位；env RELAY_CERT_PATH 可覆盖）。 */
export const DEFAULT_CERT_PATH = '/etc/devhub-relay/tls/server.crt'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 检查证书剩余有效期。
 * @param certPath 证书 PEM 路径（缺省 = env RELAY_CERT_PATH ?? /etc/devhub-relay/tls/server.crt）
 * @param nowMs 当前时刻 ms（测试注入；缺省 Date.now()）
 * @returns {status:'pass'|'fail'|'skip', daysRemaining:number|null, notAfter:string|null, message:string}
 */
export function checkCertificateExpiry(certPath = process.env.RELAY_CERT_PATH ?? DEFAULT_CERT_PATH, nowMs = Date.now()) {
  let pem
  try {
    pem = readFileSync(certPath)
  } catch {
    return {
      status: 'skip',
      daysRemaining: null,
      notAfter: null,
      message: `证书文件不存在（${certPath}）——该项跳过（开发机无证书，不算失败）`,
    }
  }
  let notAfter
  try {
    notAfter = parseNotAfter(pem)
  } catch (err) {
    return {
      status: 'fail',
      daysRemaining: null,
      notAfter: null,
      message: `证书解析失败（${certPath}）：${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const daysRemaining = Math.floor((notAfter.getTime() - nowMs) / DAY_MS)
  const notAfterText = notAfter.toISOString()
  if (daysRemaining < CERT_WARN_DAYS) {
    return {
      status: 'fail',
      daysRemaining,
      notAfter: notAfterText,
      message: `证书剩余有效期不足 ${CERT_WARN_DAYS} 天：剩余 ${daysRemaining} 天，到期 ${notAfterText}——请立即续签（P0a 证书日历）`,
    }
  }
  return {
    status: 'pass',
    daysRemaining,
    notAfter: notAfterText,
    message: `证书剩余有效期 ${daysRemaining} 天（≥${CERT_WARN_DAYS}），到期 ${notAfterText}`,
  }
}

/** X.509 notAfter 解析（validTo 形如 'Dec  4 12:00:00 2026 GMT'——规整空白后交给 Date）。 */
function parseNotAfter(pem) {
  const cert = new X509Certificate(pem)
  const normalized = cert.validTo.replace(/\s+/g, ' ').trim()
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`unparseable notAfter: ${JSON.stringify(cert.validTo)}`)
  }
  return parsed
}
