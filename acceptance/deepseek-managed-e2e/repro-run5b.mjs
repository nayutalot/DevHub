/** T3 场景精查：resume 连接全通知流打印（idle 杀后 sendReply 假成功根因） */
import { writeFileSync, mkdtempSync, mkdirSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['NODE_USE_ENV_PROXY'] = '1'
process.env['HTTPS_PROXY'] = process.env['HTTPS_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['HTTP_PROXY'] = process.env['HTTP_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['DEVHUB_HOME'] = mkdtempSync(join(tmpdir(), 'devhub-dsh-run5fix2-'))

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
function wireDir(sid) {
  const root = join(process.env['USERPROFILE'] ?? process.env['HOME'], '.dsh', 'sessions')
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws, sid)
    if (existsSync(dir)) return dir
  }
  return null
}

settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '1')
const configPath = join(process.env.DEVHUB_HOME, 'cordis.yml')
const timeline = []
const sink = {
  onStatusChanged: (ref, from, to, detail) => timeline.push({ at: Date.now(), kind: 'status', id: ref.nativeId, to, detail }),
  onMessageAppended: (ref, m) => timeline.push({ at: Date.now(), kind: 'msg', id: ref.nativeId, role: m.role, text: m.contentRedacted.slice(0, 40) }),
}
const provider = mod.createDeepseekProvider({
  managedGate: () => ({ ...cfg.readDeepseekManagedGate({ configPath }), managedIdleTimeoutMs: 15_000, managedLifetimeTimeoutMs: 300_000 }),
  managedConfigPath: configPath,
})

const start = await provider.startManagedSession('请直接回复三个字：收到了。', sink)
const sid = start.nativeId
console.log('T1 ok:', start.ok, sid)
await pollUntil(async () => timeline.some((e) => e.kind === 'status' && e.id === sid && e.to === 'waiting_input'), 180_000, 200, 'msg1 idle')
console.log('msg1 done; wire dir:', wireDir(sid))
await sleep(25_000) // idle-timeout 树杀
const r = await provider.sendReply({ providerId: 'deepseek', nativeId: sid }, '回复两个字：好的。')
console.log('reply:', JSON.stringify(r))
await sleep(3000)
console.log('wire dir after reply:', wireDir(sid))
await provider.dispose()
closeDatabase()
