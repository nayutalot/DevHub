/**
 * 缺陷 A 复现（run5-fix）：live 会话多回合 sendReply 两条路径（近距离 live / idle 杀后回退）。
 * 真实 harness + 代理路由；idle 注入 15s 加速复现。
 */
import { writeFileSync, mkdtempSync, mkdirSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['NODE_USE_ENV_PROXY'] = '1'
process.env['HTTPS_PROXY'] = process.env['HTTPS_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['HTTP_PROXY'] = process.env['HTTP_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['DEVHUB_HOME'] = mkdtempSync(join(tmpdir(), 'devhub-dsh-run5fix-'))

const { closeDatabase } = await import(new URL('../../src/main/db/index.ts', import.meta.url).href)
const settings = await import(new URL('../../src/main/services/settingsService.ts', import.meta.url).href)
const mod = await import(new URL('../../src/main/services/agentControl/providers/deepseekProvider.ts', import.meta.url).href)
const cfg = await import(new URL('../../src/main/services/agentControl/providers/deepseekManagedConfig.ts', import.meta.url).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function pollUntil(fn, timeoutMs, stepMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(stepMs) }
  throw new Error('pollUntil timeout: ' + label)
}
function wireMtime(sid) {
  const root = join(process.env['USERPROFILE'] ?? process.env['HOME'], '.dsh', 'sessions')
  if (!existsSync(root)) return 'no-root'
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws, sid)
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (f.startsWith('session.jsonl')) {
          const st = statSync(join(dir, f))
          return `${f} mtime=${st.mtimeMs} size=${st.size}`
        }
      }
      return 'dir-no-log'
    }
  }
  return 'not-found'
}

settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '1')
const configPath = join(process.env.DEVHUB_HOME, 'cordis.yml')
const timeline = []
const sink = {
  onSessionDiscovered: (_p, s) => timeline.push({ at: Date.now(), kind: 'discovered', id: s.nativeId }),
  onStatusChanged: (ref, from, to, detail) => timeline.push({ at: Date.now(), kind: 'status', id: ref.nativeId, to, detail }),
  onMessageAppended: (ref, m) => timeline.push({ at: Date.now(), kind: 'msg', id: ref.nativeId, role: m.role, nid: m.nativeMsgId, text: m.contentRedacted.slice(0, 40) }),
}
const provider = mod.createDeepseekProvider({
  managedGate: () => ({ ...cfg.readDeepseekManagedGate({ configPath }), managedIdleTimeoutMs: 15_000, managedLifetimeTimeoutMs: 300_000 }),
  managedConfigPath: configPath,
})

console.log('=== T1 spawn + msg1 ===')
const t0 = Date.now()
const start = await provider.startManagedSession('请直接回复三个字：收到了。不要使用工具。', sink)
console.log('start:', JSON.stringify(start), 'spawnMs=', Date.now() - t0)
const sid = start.nativeId
await pollUntil(async () => timeline.some((e) => e.kind === 'status' && e.id === sid && e.to === 'waiting_input'), 180_000, 200, 'msg1 idle')
console.log('msg1 wire:', wireMtime(sid))

console.log('=== T2 近距离 sendReply（idle 15s 内立即发，live 路径）===')
const r2 = await provider.sendReply({ providerId: 'deepseek', nativeId: sid }, '再回复两个字：好的。')
console.log('reply2:', JSON.stringify(r2))
const base2 = timeline.length
try {
  await pollUntil(async () => timeline.slice(base2).some((e) => e.kind === 'status' && e.id === sid && e.to === 'waiting_input'), 120_000, 200, 'msg2 idle')
} catch (e) { console.log('msg2 idle wait:', e.message) }
console.log('msg2 wire:', wireMtime(sid))
console.log('msg2 timeline delta:', JSON.stringify(timeline.slice(base2)))

console.log('=== T3 等 idle-timeout（15s→25s）后 sendReply（回退路径）===')
await sleep(25_000)
console.log('post-idle-timeout wire:', wireMtime(sid))
const r3 = await provider.sendReply({ providerId: 'deepseek', nativeId: sid }, '最后回复四个字：完成验证。')
console.log('reply3:', JSON.stringify(r3))
const base3 = timeline.length
try {
  await pollUntil(async () => timeline.slice(base3).some((e) => e.kind === 'status' && e.id === sid && e.to === 'waiting_input'), 150_000, 200, 'msg3 idle')
} catch (e) { console.log('msg3 idle wait:', e.message) }
console.log('msg3 wire:', wireMtime(sid))
console.log('msg3 timeline delta:', JSON.stringify(timeline.slice(base3)))
console.log('diagnostics:', JSON.stringify(provider.describeDiagnostics()))
await provider.dispose()
closeDatabase()
