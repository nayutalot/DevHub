import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const cfg = await import(new URL('file:///F:/Active_Project/DevHub/worktrees/dm-dsh-managed/src/main/services/agentControl/providers/deepseekManagedConfig.ts').href)
const dir = join(mkdtempSync(join(tmpdir(), 'dsh-wire2-')), 'deepseek-managed')
mkdirSync(dir, { recursive: true })
const configPath = join(dir, 'cordis.yml')
const ws = join(dir, 'ws')
mkdirSync(ws, { recursive: true })
writeFileSync(configPath, cfg.renderDeepseekCordisYml({ workspacePath: ws }))
cfg.ensureNodeModulesJunction(dir, 'D:/Apps/deepseek-harness')
const bin = 'D:/Apps/deepseek-harness/packages/examples/jsonrpc-demo/lib/bin.js'
const env2 = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }
const child = spawn(process.execPath, [bin, configPath], { cwd: ws, env: env2, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
let events = 0
child.stdout.on('data', (d) => {
  buf += String(d)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      const f = JSON.parse(line)
      if (f.method === 'session.event') {
        events++
        const ev = f.params?.event ?? {}
        console.log(`[evt ${events}] ${ev.type} seq=${ev.seq} ${JSON.stringify(ev.data).slice(0, 200)}`)
      } else if (f.method === 'session.status') {
        console.log('[status]', JSON.stringify(f.params))
      } else {
        console.log('[frame]', line.slice(0, 160))
      }
    } catch { console.log('[raw]', line.slice(0, 160)) }
  }
})
child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.log('[stderr]', s.split('\n').slice(-1)[0].slice(0, 300)) })
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
setTimeout(() => send({ jsonrpc: '2.0', id: 'req_1', method: 'initialize', params: { cwd: ws, provider: 'deepseek-official', model: 'deepseek-v4-flash' } }), 3000)
setTimeout(() => send({ jsonrpc: '2.0', id: 'req_2', method: 'session/prompt', params: { sessionId: 'session-wireprobe-' + Date.now(), contentBlocks: [{ type: 'text', text: '请直接回复：收到' }] } }), 5000)
setTimeout(() => { console.log('--- shutdown ---'); send({ jsonrpc: '2.0', id: 'req_3', method: 'shutdown' }); setTimeout(() => process.exit(0), 5000) }, 150000)
