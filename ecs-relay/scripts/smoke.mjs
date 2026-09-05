#!/usr/bin/env node
/**
 * scripts/smoke.mjs — 启动冒烟（docs/20 §2.2 门禁：裸进程起服务 → health → 优雅停机）。
 *
 * 与门禁的关系：node --test 全绿 + tsc --noEmit 之外的最小运行面验证——
 * 真实裸进程（非 in-process import）以生产默认形态启动，/v1/health 200，SIGTERM 优雅退出 0。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const tempDir = mkdtempSync(join(tmpdir(), 'devhub-relay-smoke-'))
const port = 10000 + Math.floor(Math.random() * 40000) // 段外随机高端口（绝不占 8746-8755）

const child = spawn(process.execPath, ['--experimental-strip-types', join(HERE, '..', 'src', 'server.ts')], {
  env: { ...process.env, RELAY_BIND: '127.0.0.1', RELAY_PORT: String(port), RELAY_DB_PATH: join(tempDir, 'relay.db') },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', (d) => {
  output += d.toString('utf8')
})
child.stderr.on('data', (d) => {
  output += d.toString('utf8')
})

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`)
  if (!child.killed) child.kill('SIGKILL')
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch { /* 忽略 */ }
  process.exit(1)
}

async function main() {
  // ① 等待监听
  const deadline = Date.now() + 10000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
      if (res.status === 200) {
        ready = true
        const json = await res.json()
        if (json.name !== 'devhub-relay' || json.ok !== true) fail(`health 形状异常: ${JSON.stringify(json)}`)
        break
      }
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!ready) fail(`服务未在 10s 内就绪（端口 ${port}）；输出:\n${output}`)
  console.log(`[smoke] ① 裸进程启动 OK（127.0.0.1:${port} 段外随机端口），/v1/health 200`)

  // ② 优雅停机（POSIX: SIGTERM / Windows: stdin 'shutdown' 指令缝——同一优雅停机路径）
  const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  if (process.platform === 'win32') {
    child.stdin.write('shutdown\n')
  } else {
    child.kill('SIGTERM')
  }
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 5000)
    exitPromise.then((c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })
  if (code !== 0) fail(`优雅停机后退出码 ${code}（预期 0）；输出:\n${output}`)
  console.log(`[smoke] ② 优雅停机 OK（exit 0，${process.platform === 'win32' ? 'stdin shutdown 指令缝' : 'SIGTERM'}）`)

  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch { /* 忽略 */ }
  console.log('[smoke] ALL GREEN')
}

main().catch((err) => fail(err.message))
