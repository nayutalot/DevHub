/** resume 语义 wire 级精查：新 runtime + 同 sessionId + 同 cwd → 全通知打印 */
import { writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

process.env['NODE_USE_ENV_PROXY'] = '1'
process.env['HTTPS_PROXY'] = process.env['HTTPS_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['HTTP_PROXY'] = process.env['HTTP_PROXY'] ?? 'http://127.0.0.1:7897'

const cfg = await import(new URL('../../src/main/services/agentControl/providers/deepseekManagedConfig.ts', import.meta.url).href)
const dir = join(mkdtempSync(join(tmpdir(), 'dsh-resume-probe-')), 'deepseek-managed')
mkdirSync(dir, { recursive: true })
const configPath = join(dir, 'cordis.yml')
const ws = join(process.env['USERPROFILE']) // 同生产：workspace=home
mkdirSync(join(dir, 'ws'), { recursive: true })
writeFileSync(configPath, cfg.renderDeepseekCordisYml({ workspacePath: ws }))
cfg.ensureNodeModulesJunction(dir, 'D:/Apps/deepseek-harness')

// 找一个已持久化的 dsh session id（DM 批真机验证留下的）
const sessionsRoot = join(process.env['USERPROFILE'], '.dsh', 'sessions')
let persistedSid = null
for (const wsp of readdirSync(sessionsRoot)) {
  for (const s of readdirSync(join(sessionsRoot, wsp))) {
    if (s.startsWith('session-')) { persistedSid = s; break }
  }
  if (persistedSid) break
}
console.log('using persisted sid:', persistedSid, 'initialize cwd:', ws)

const bin = 'D:/Apps/deepseek-harness/packages/examples/jsonrpc-demo/lib/bin.js'
const env2 = { ...process.env }
const child = spawn(process.execPath, [bin, configPath], { cwd: ws, env: env2, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
let n = 0
child.stdout.on('data', (d) => {
  buf += String(d)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      const f = JSON.parse(line)
      if (f.method === 'session.event') {
        n++
        const ev = f.params?.event ?? {}
        console.log(`[evt ${n}] ${f.params?.sessionId} ${ev.type} seq=${ev.seq} ${JSON.stringify(ev.data).slice(0, 180)}`)
      } else if (f.method === 'session.status') {
        console.log('[status]', JSON.stringify(f.params))
      } else {
        console.log('[frame]', line.slice(0, 200))
      }
    } catch { console.log('[raw]', line.slice(0, 200)) }
  }
})
child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.log('[stderr]', s.split('\n').slice(-1)[0].slice(0, 250)) })
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
setTimeout(() => send({ jsonrpc: '2.0', id: 'r1', method: 'initialize', params: { cwd: ws, provider: 'deepseek-official', model: 'deepseek-v4-flash' } }), 3000)
setTimeout(() => send({ jsonrpc: '2.0', id: 'r2', method: 'session/prompt', params: { sessionId: persistedSid, contentBlocks: [{ type: 'text', text: '回复两个字：好的。' }] } }), 5500)
setTimeout(() => { console.log('--- shutdown ---'); send({ jsonrpc: '2.0', id: 'r3', method: 'shutdown' }); setTimeout(() => process.exit(0), 5000) }, 90000)
