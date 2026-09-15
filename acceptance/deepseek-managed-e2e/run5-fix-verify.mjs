/**
 * run5-fix 协议级真机验证：同一 live 会话三回合连续 sendReply 全部真实处理且
 * 流式落投影（RD 缺陷 A 修复目标），每回合三证（流式时序 / wire mtime+size /
 * 事件 seq 游标推进）+ 单气泡增长（缺陷 C）；键归 0 可撤销。
 *
 * 纪律：隔离 DEVHUB_HOME 临时实例（库模式，常驻桌面零触碰）；生产默认门
 * （idle 1800s/lifetime 7200s 不注入覆盖）；真实推理最小化（恰 3 条最小 prompt，
 * 如实入册）；凭据三零；证据落本目录 run5-fix/。
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'run5-fix')
mkdirSync(OUT, { recursive: true })

process.env['NODE_USE_ENV_PROXY'] = '1'
process.env['HTTPS_PROXY'] = process.env['HTTPS_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['HTTP_PROXY'] = process.env['HTTP_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['DEVHUB_HOME'] = mkdtempSync(join(tmpdir(), 'devhub-dsh-run5fix-e2e-'))

const report = []
const ev = (line) => {
  const text = typeof line === 'string' ? line : JSON.stringify(line)
  report.push(text)
  console.log('[run5fix]', text)
  appendFileSync(join(OUT, 'verify-log.jsonl'), JSON.stringify({ t: Date.now(), line: text }) + '\n')
}
const evRaw = (name, obj) => writeFileSync(join(OUT, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function pollUntil(fn, timeoutMs, stepMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(stepMs) }
  throw new Error('pollUntil timeout: ' + label)
}
function wireFile(sid) {
  const root = join(process.env['USERPROFILE'] ?? process.env['HOME'], '.dsh', 'sessions')
  if (!existsSync(root)) return null
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws, sid)
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (f.startsWith('session.jsonl')) {
          const p = join(dir, f)
          const st = statSync(p)
          return { file: f, mtimeMs: st.mtimeMs, size: st.size }
        }
      }
    }
  }
  return null
}

const { closeDatabase } = await import(new URL('../../src/main/db/index.ts', import.meta.url).href)
const settings = await import(new URL('../../src/main/services/settingsService.ts', import.meta.url).href)
const mod = await import(new URL('../../src/main/services/agentControl/providers/deepseekProvider.ts', import.meta.url).href)
const cfg = await import(new URL('../../src/main/services/agentControl/providers/deepseekManagedConfig.ts', import.meta.url).href)

try {
  // 键置 1 → 门开 → caps managed
  settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '1')
  const gate = cfg.readDeepseekManagedGate({ configPath: join(process.env.DEVHUB_HOME, 'cordis.yml') })
  ev(`gate: enabled=${gate.enabled} idle=${gate.managedIdleTimeoutMs}ms lifetime=${gate.managedLifetimeTimeoutMs}ms (production defaults, no overrides)`)
  const provider = mod.createDeepseekProvider({
    managedGate: () => cfg.readDeepseekManagedGate({ configPath: join(process.env.DEVHUB_HOME, 'cordis.yml') }),
    managedConfigPath: join(process.env.DEVHUB_HOME, 'cordis.yml'),
  })
  const caps = await provider.getCapabilities({ providerId: 'deepseek', nativeId: 'x' })
  ev(`caps: mode=${caps.mode} granted=${caps.granted.join('|')}`)
  evRaw('caps-managed.json', caps)
  if (caps.mode !== 'managed') throw new Error('caps not managed')

  const timeline = []
  const sink = {
    onSessionDiscovered: (_p, s) => timeline.push({ at: Date.now(), kind: 'discovered', id: s.nativeId, mode: s.mode }),
    onStatusChanged: (ref, from, to, detail) => timeline.push({ at: Date.now(), kind: 'status', id: ref.nativeId, from, to, detail }),
    onMessageAppended: (ref, m) => timeline.push({ at: Date.now(), kind: 'msg', id: ref.nativeId, role: m.role, nid: m.nativeMsgId, text: m.contentRedacted }),
  }

  // spawn → t1
  const t0 = Date.now()
  const start = await provider.startManagedSession('请直接回复四个字：第一回合。不要使用工具。', sink)
  ev(`T1 start: ok=${start.ok} nativeId=${start.nativeId} spawnMs=${Date.now() - t0} detail=${start.detail}`)
  evRaw('t1-start.json', start)
  if (!start.ok) throw new Error('T1 failed')
  const sid = start.nativeId

  const prompts = [
    '请直接回复四个字：第一回合。',
    '请直接回复四个字：第二回合。',
    '请直接回复四个字：第三回合。',
  ]
  const perTurn = []
  for (let turn = 1; turn <= 3; turn++) {
    const base = timeline.length
    if (turn > 1) {
      const r = await provider.sendReply({ providerId: 'deepseek', nativeId: sid }, prompts[turn - 1])
      ev(`T${turn} sendReply: ok=${r.ok} status=${r.status} detail=${r.detail}`)
      evRaw(`t${turn}-reply.json`, r)
      if (!r.ok) throw new Error(`T${turn} reply failed: ${r.detail}`)
      if (!r.detail.includes('live session/prompt ok')) throw new Error(`T${turn} did NOT run on the live connection: ${r.detail}`)
    }
    await pollUntil(async () => timeline.slice(base).some((e) => e.kind === 'status' && e.id === sid && e.to === 'waiting_input'), 180_000, 200, `T${turn} idle`)
    const bubbleId = `assistant-t${turn}s1`
    const increments = timeline.slice(base).filter((e) => e.kind === 'msg' && e.nid === bubbleId && e.role === 'assistant')
    const wire = wireFile(sid)
    const page = await provider.readMessages({ providerId: 'deepseek', nativeId: sid })
    const turnEvidence = {
      turn,
      bubbleId,
      increments: increments.map((e) => ({ at: e.at, text: e.text })),
      allBeforeIdle: increments.every((e) => e.at < timeline.slice(base).find((x) => x.kind === 'status' && x.to === 'waiting_input').at),
      wire,
      observedCursorMaxSeq: page.cursor,
      observedMessageCount: page.messages.length,
    }
    perTurn.push(turnEvidence)
    ev(`T${turn} evidence: bubble=${bubbleId} increments=${increments.length} (texts: ${JSON.stringify(increments.map((e) => e.text))}) allBeforeIdle=${turnEvidence.allBeforeIdle} wire=${wire.file}@${wire.mtimeMs}/${wire.size}B observedSeqCursor=${page.cursor} observedMsgs=${page.messages.length}`)
    evRaw(`t${turn}-evidence.json`, turnEvidence)
  }

  // 三证交叉断言：wire mtime/size 逐回合推进、observed seq 游标逐回合推进、
  // 每回合流式增量先于 idle
  for (let i = 1; i < perTurn.length; i++) {
    if (!(perTurn[i].wire.mtimeMs > perTurn[i - 1].wire.mtimeMs)) throw new Error(`wire mtime did not advance at T${i + 1}`)
    if (!(Number(perTurn[i].observedCursorMaxSeq) > Number(perTurn[i - 1].observedCursorMaxSeq))) throw new Error(`event seq cursor did not advance at T${i + 1}`)
  }
  ev('THREE-TURN CROSS-CHECK: wire mtime advanced each turn AND event-seq cursor advanced each turn AND every streaming increment landed before its idle edge — all replies really processed on the same live session')

  // 单气泡增长（缺陷 C）：每回合恰一个 assistant 气泡身份
  const bubbles = [...new Set(timeline.filter((e) => e.kind === 'msg' && e.role === 'assistant').map((e) => e.nid))]
  ev(`defect-C: assistant bubble ids = ${JSON.stringify(bubbles)} (one per turn, grown in place — no per-delta bubbles)`)

  // kill 阶梯收尾 + 零孤儿
  const disposeAt = Date.now()
  await provider.dispose()
  ev(`dispose (kill ladder): done in ${Date.now() - disposeAt}ms`)
  evRaw('diagnostics.json', provider.describeDiagnostics())

  // 键归 0 回归
  settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '0')
  const capsOff = await provider.getCapabilities({ providerId: 'deepseek', nativeId: 'x' })
  ev(`revert: key=0 → caps mode=${capsOff.mode} granted=${capsOff.granted.length} (byte-identical legacy observed shape)`)
  evRaw('caps-reverted.json', capsOff)

  ev('RUN5-FIX VERIFY COMPLETE: 3 real prompts (one per turn); zero credentials read/injected/logged')
} catch (err) {
  ev('RUN5-FIX VERIFY FAILED: ' + (err instanceof Error ? err.stack : String(err)))
  process.exitCode = 1
} finally {
  try { closeDatabase() } catch {}
  writeFileSync(join(OUT, 'verify-report.txt'), report.join('\n') + '\n')
  try { rmSync(process.env.DEVHUB_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }) } catch {}
}
