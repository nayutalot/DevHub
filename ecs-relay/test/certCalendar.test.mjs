/**
 * test/certCalendar.test.mjs — 证书日历检查三档断言（A⑥ 修 3 / P0a）：
 * 1 天 FAIL / 13 天 FAIL / 30 天 PASS（openssl 临时生成，用后清理）+ 文件不存在 SKIP。
 * 边界语义：13.x 天 floor=13 <14 FAIL；≥14 整数天 PASS（CERT_WARN_DAYS=14）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCertificateExpiry, CERT_WARN_DAYS } from '../src/certCheck.mjs'

/** openssl 生成自签证书（-days N；返回 PEM 路径）。 */
function generateCert(dir, name, days) {
  const certPath = join(dir, `${name}.crt`)
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(dir, `${name}.key`),
    '-out', certPath,
    '-days', String(days),
    '-subj', '/CN=cert-calendar-test',
  ], { stdio: 'pipe' })
  assert.equal(existsSync(certPath), true, `openssl 应生成 ${name}.crt`)
  return certPath
}

test('证书剩余 1 天 → FAIL（message 含剩余天数与到期日）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cert-test-'))
  try {
    const certPath = generateCert(dir, 'expire-1d', 1)
    const result = checkCertificateExpiry(certPath, Date.now())
    assert.equal(result.status, 'fail')
    assert.equal(result.daysRemaining < CERT_WARN_DAYS, true, `剩余 ${result.daysRemaining} 天应 <${CERT_WARN_DAYS}`)
    assert.match(result.message, /到期/)
    assert.notEqual(result.notAfter, null)
  } finally {
    cleanup(dir)
  }
})

test('证书剩余 13 天 → FAIL（<14 天告警线边界下侧）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cert-test-'))
  try {
    const certPath = generateCert(dir, 'expire-13d', 13)
    const result = checkCertificateExpiry(certPath, Date.now())
    assert.equal(result.status, 'fail', `13 天生成证书实测剩余 ${result.daysRemaining} 天`)
    assert.equal(result.daysRemaining <= 13, true)
  } finally {
    cleanup(dir)
  }
})

test('证书剩余 30 天 → PASS（输出剩余天数）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-cert-test-'))
  try {
    const certPath = generateCert(dir, 'valid-30d', 30)
    const result = checkCertificateExpiry(certPath, Date.now())
    assert.equal(result.status, 'pass')
    assert.equal(result.daysRemaining >= CERT_WARN_DAYS && result.daysRemaining <= 30, true, `剩余 ${result.daysRemaining} 天应在 [14,30]`)
    assert.match(result.message, /剩余有效期 \d+ 天/)
  } finally {
    cleanup(dir)
  }
})

test('证书文件不存在 → SKIP（不算失败）', () => {
  const result = checkCertificateExpiry(join(tmpdir(), 'no-such-cert-dir', 'no-such.crt'), Date.now())
  assert.equal(result.status, 'skip')
  assert.equal(result.daysRemaining, null)
  assert.match(result.message, /跳过/)
})

function cleanup(dir) {
  // openssl 临时证书用后清理（force：Windows 句柄延迟不阻塞测试进程）
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch { /* 留给系统临时目录清理 */ }
}
