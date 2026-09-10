// codex app-server 诊断探针 —— NO_PROXY 变量判别实验变体
// 与 ../codex-appserver-diag-20260910-153714/appserver-probe.mjs 逐行一致，
// 唯一差异（标记 DIFF）：child env 剥离全部代理键（NO_PROXY/HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，大小写不敏感），
// 并在 timeline 记录 ambient 代理变量名（仅名字，不含值）与子进程 env 断言结果。
// 用法: node appserver-probe-noproxy-var.mjs <codexExePath> <outPrefix> <workCwd>
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const exe = process.argv[2]
const prefix = process.argv[3]
const workCwd = process.argv[4] ?? process.cwd()
const t0 = Date.now()
const now = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`

const REDACT = [
  [/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer [REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{10,}/g, 'eyJ[REDACTED-JWT]'],
  [/(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[REDACTED]'],
]
const clean = (s) => REDACT.reduce((acc, [re, rep]) => acc.replace(re, rep), s)

const timeline = []
const mark = (event, detail = '') => {
  timeline.push({ t: now(), event, detail: clean(String(detail)).slice(0, 500) })
  console.error(`[${now()}] ${event} ${clean(String(detail)).slice(0, 300)}`)
}

const stdoutPath = `${prefix}.stdout.jsonl`
const stderrPath = `${prefix}.stderr.log`
writeFileSync(stdoutPath, '')
writeFileSync(stderrPath, '')

// --- DIFF: 剥离代理环境变量并断言 ---
const PROXY_KEYS = /^(no_proxy|http_proxy|https_proxy|all_proxy)$/
const ambientProxyVarNames = Object.keys(process.env).filter((k) => PROXY_KEYS.test(k))
const childEnv = { ...process.env }
for (const k of Object.keys(childEnv)) {
  if (PROXY_KEYS.test(k)) delete childEnv[k]
}
const leakedProxyKeys = Object.keys(childEnv).filter((k) => PROXY_KEYS.test(k))
mark('ambient-proxy-var-names', ambientProxyVarNames.length ? ambientProxyVarNames.join(',') : '(none)')
mark(
  'child-env-assert',
  leakedProxyKeys.length === 0
    ? 'PASS child env has no NO_PROXY/HTTP_PROXY/HTTPS_PROXY/ALL_PROXY'
    : `FAIL leaked keys: ${leakedProxyKeys.join(',')}`,
)

mark('spawn', `${exe} app-server (cwd=${workCwd}, proxy env CLEARED, registry proxy untouched)`)
const child = spawn(exe, ['app-server'], {
  cwd: workCwd,
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
mark('spawned', `pid=${child.pid}`)

const pending = new Map()
let nextId = 1
let turnCompleted = false
let exitInfo = null

child.stdout.setEncoding('utf8')
let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line.length === 0) continue
    appendFileSync(stdoutPath, JSON.stringify({ t: now(), raw: clean(line) }) + '\n')
    let msg = null
    try {
      msg = JSON.parse(line)
    } catch {
      mark('stdout-unparseable', line.slice(0, 120))
      continue
    }
    const { id, method } = msg
    if (typeof id === 'number' && pending.has(id)) {
      const entry = pending.get(id)
      pending.delete(id)
      clearTimeout(entry.timer)
      entry.resolve(msg)
    } else if (typeof method === 'string') {
      const type = msg?.params?.type ?? msg?.params?.msg?.type ?? ''
      mark('notify', `${method}${type ? ` type=${type}` : ''}`)
      if (/turn\/completed|task_complete/i.test(method) || /task_complete|turn\.completed/i.test(String(type))) {
        turnCompleted = true
      }
    } else {
      mark('notify-unknown-frame', line.slice(0, 120))
    }
  }
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  appendFileSync(stderrPath, clean(chunk))
})

child.on('error', (err) => mark('spawn-error', err.message))
child.on('exit', (code, signal) => {
  exitInfo = { code, signal, at: now() }
  mark('exit', `code=${code} signal=${signal}`)
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.resolve(null)
  }
  pending.clear()
})

function request(method, params, timeoutMs) {
  const id = nextId++
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      mark('request-timeout', method)
      resolve(null)
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    appendFileSync(stdoutPath, JSON.stringify({ t: now(), sent: clean(frame) }) + '\n')
    child.stdin.write(frame + '\n')
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- 序列（照抄 codexProvider.ts L613/L858/L874，与原探针一致） ---
const initResp = await request('initialize', { clientInfo: { name: 'devhub', title: 'DevHub', version: '0.1.0' } }, 20000)
if (initResp === null) mark('initialize', 'NO RESPONSE (timeout or process died)')
else if (initResp.error) mark('initialize', `JSON-RPC error ${initResp.error.code}: ${initResp.error.message}`)
else mark('initialize', 'OK')

const startResp = await request('thread/start', {}, 20000)
let threadId
if (startResp === null) mark('thread/start', 'NO RESPONSE (timeout or process died)')
else if (startResp.error) mark('thread/start', `JSON-RPC error ${startResp.error.code}: ${startResp.error.message}`)
else {
  threadId = startResp.result?.thread?.id
  mark('thread/start', `OK threadId=${threadId ?? '(missing)'}`)
}

if (threadId) {
  const turnResp = await request(
    'turn/start',
    { threadId, input: [{ type: 'text', text: 'Reply with just OK' }] },
    90000,
  )
  if (turnResp === null) mark('turn/start', 'NO RESPONSE (timeout or process died)')
  else if (turnResp.error) mark('turn/start', `JSON-RPC error ${turnResp.error.code}: ${turnResp.error.message}`)
  else mark('turn/start', 'accepted (turn in flight)')

  // turn 后观察窗：等 turn/completed / 进程退出 / 90s 上限
  const deadline = Date.now() + 90000
  while (Date.now() < deadline && exitInfo === null && !turnCompleted) await sleep(500)
  mark(turnCompleted ? 'turn-completed-observed' : 'observation-window-ended', `exitInfo=${JSON.stringify(exitInfo)}`)
}

if (exitInfo === null) {
  try {
    child.kill()
    mark('teardown', 'SIGTERM sent')
  } catch (e) {
    mark('teardown-error', e.message)
  }
}
await sleep(1500)
if (exitInfo === null) {
  try {
    child.kill('SIGKILL')
    mark('teardown', 'SIGKILL sent (still alive)')
  } catch {
    /* already gone */
  }
}

console.log(
  JSON.stringify(
    {
      exe,
      pid: child.pid,
      exitInfo,
      turnCompleted,
      ambientProxyVarNames,
      childEnvAssert: leakedProxyKeys.length === 0 ? 'PASS' : `FAIL:${leakedProxyKeys.join(',')}`,
      timeline,
    },
    null,
    2,
  ),
)
process.exit(0)
