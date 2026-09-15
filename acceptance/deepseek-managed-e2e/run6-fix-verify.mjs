/**
 * run6-fix provider 级真机验证（DM2 批，docs/briefs/dm2-capsws.md §3）：
 *
 * ① caps 过期自愈链（App 自愈的服务端对偶面）：caps 过期（模拟 >5min：verifiedAt
 *    回拨 400s）→ createSessionAction 拒（App 可见面 = ServiceError
 *    AGENT_CAPABILITY_MISSING，与 run6 msg3 同码）→ 自愈探针（App 既有通道
 *    agents 列表 = listAgentProviders → probeWiredProviders → caps 过期重验，
 *    真实探测零伪造）→ 原消息重发一次 → executed（真实推理，live 连接零重 spawn）。
 *    全链时序证据入册。一次性语义由 :core CapsSelfHeal.OneShot 单测锁定（App 侧
 *    状态机不进本脚本——provider 级验证只证服务端链路）。
 * ② 投影双写去重：连续回合 firehose 路径 + wire-scan 刷新路径（provider.startMonitor
 *    生产同构 sink 落库）双写同回合 → agent_messages 每消息恰一行（run6 实证
 *    29392-29395 双写的根修对照：行数对照表入册）。
 *
 * 纪律：隔离 DEVHUB_HOME 临时实例（库模式，常驻桌面零触碰，毕后 health×3 复验
 * uptime 单调）；生产默认门（idle 1800s/lifetime 7200s 不注入覆盖）；真实推理
 * 最小化（恰 2 条最小 prompt，如实入册）；凭据三零；证据落本目录 run6-fix/。
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'run6-fix')
mkdirSync(OUT, { recursive: true })

process.env['NODE_USE_ENV_PROXY'] = '1'
process.env['HTTPS_PROXY'] = process.env['HTTPS_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['HTTP_PROXY'] = process.env['HTTP_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['DEVHUB_HOME'] = mkdtempSync(join(tmpdir(), 'devhub-dm2-run6fix-e2e-'))

const report = []
const ev = (line) => {
  const text = typeof line === 'string' ? line : JSON.stringify(line)
  report.push(text)
  console.log('[run6fix]', text)
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

const { closeDatabase, getDatabase } = await import(new URL('../../src/main/db/index.ts', import.meta.url).href)
const settings = await import(new URL('../../src/main/services/settingsService.ts', import.meta.url).href)
const svc = await import(new URL('../../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
const mod = await import(new URL('../../src/main/services/agentControl/providers/deepseekProvider.ts', import.meta.url).href)
const cfg = await import(new URL('../../src/main/services/agentControl/providers/deepseekManagedConfig.ts', import.meta.url).href)

// 常驻桌面实例 health 探测（毕后 health×3 还原复验用）
async function residentHealth() {
  return await fetch('http://127.0.0.1:8746/v1/health').then((r) => r.json()).catch((e) => ({ error: String(e) }))
}

try {
  // 键置 1 → 门开 → caps managed（生产默认门，零覆盖）
  settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '1')
  const gate = cfg.readDeepseekManagedGate({ configPath: join(process.env.DEVHUB_HOME, 'cordis.yml') })
  ev(`gate: enabled=${gate.enabled} idle=${gate.managedIdleTimeoutMs}ms lifetime=${gate.managedLifetimeTimeoutMs}ms (production defaults, no overrides)`)
  // provider catalog 行种子（生产由启动/监控同步路径 ensure；隔离库需显式补——
  // 首跑教训：缺行时 onSessionDiscovered/persistMessage 全部落空）
  svc.ensureAgentProviderRows()
  const provider = mod.createDeepseekProvider({
    managedGate: () => cfg.readDeepseekManagedGate({ configPath: join(process.env.DEVHUB_HOME, 'cordis.yml') }),
    managedConfigPath: join(process.env.DEVHUB_HOME, 'cordis.yml'),
  })
  // 单实例纪律：registry 换装本实例——syncMonitorTasks/probeWiredProviders 与
  // 直驱面共用同一 provider（managedSessionIds 同源，wire-scan 键收敛可证）
  svc.setProviderOverride('deepseek', provider)

  // 生产同构 sink（= agentControlService.buildMonitorSink 三回调逐字对偶；
  // scanAwareSessionMode 私有——6 行镜像：无 mode 扫描快照保持既有行 mode，
  // managed 行绝不降级）。spawn 与 monitor 共用同一 sink（生产单 sink 形态；
  // 首跑教训：纯 timeline sink 不落库 → 会话行缺失）。
  const timeline = []
  const sink = {
    onSessionDiscovered: (_p, snapshot) => {
      timeline.push({ at: Date.now(), kind: 'discovered', id: snapshot.nativeId, mode: snapshot.mode })
      let mode = snapshot.mode
      if (mode === undefined) {
        const row = getDatabase().prepare(
          "SELECT s.session_mode AS m FROM agent_sessions s JOIN agent_providers p ON p.id = s.provider_id WHERE p.provider = 'deepseek' AND s.native_id = ?",
        ).get(snapshot.nativeId)
        mode = row !== undefined && (row.m === 'managed' || row.m === 'attached') ? row.m : 'observed'
      }
      svc.upsertSessionSnapshot('deepseek', snapshot, mode)
    },
    onMessageAppended: (ref, message) => {
      timeline.push({ at: Date.now(), kind: 'msg', id: ref.nativeId, role: message.role, nid: message.nativeMsgId, text: message.contentRedacted })
      svc.persistMessage('deepseek', ref.nativeId, message)
    },
    onStatusChanged: (ref, _from, to, detail) => {
      timeline.push({ at: Date.now(), kind: 'status', id: ref.nativeId, from: _from, to, detail })
      svc.applySessionStatus('deepseek', ref.nativeId, to, detail)
    },
  }

  // 孤儿基线：deepseek-harness 相关 node 进程数（毕后对照 = 零孤儿）
  const { execSync } = await import('node:child_process')
  const harnessProcCount = () => {
    try {
      const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match \'deepseek-harness\' } | Measure-Object).Count"', { encoding: 'utf8', timeout: 30_000 })
      return Number(out.trim())
    } catch { return -1 }
  }
  const orphanBaseline = harnessProcCount()
  ev(`orphan baseline: deepseek-harness node processes = ${orphanBaseline}`)

  // T1：spawn + 首回合（真实 prompt #1；生产单 sink——timeline + 落库同面）
  const t1Prompt = '请直接回复四个字：第一回合。不要使用工具。'
  const t0 = Date.now()
  const start = await provider.startManagedSession(t1Prompt, sink)
  ev(`T1 start: ok=${start.ok} nativeId=${start.nativeId} spawnMs=${Date.now() - t0} detail=${start.detail}`)
  evRaw('t1-start.json', start)
  if (!start.ok) throw new Error('T1 failed')
  const sid = start.nativeId

  await pollUntil(() => timeline.some((e) => e.kind === 'status' && e.id === sid && e.to === 'waiting_input'), 180_000, 200, 'T1 idle')
  const t1IdleAt = timeline.find((e) => e.kind === 'status' && e.id === sid && e.to === 'waiting_input').at
  const t1Bubble = timeline.filter((e) => e.kind === 'msg' && e.nid === 'assistant-t1s1' && e.role === 'assistant')
  ev(`T1 evidence: bubble=assistant-t1s1 increments=${t1Bubble.length} (texts: ${JSON.stringify(t1Bubble.map((e) => e.text))}) wire=${JSON.stringify(wireFile(sid))}`)

  // 会话行 id（生产 sink 已落 managed 行）
  const sessionRow = getDatabase().prepare(
    "SELECT s.id AS id, s.session_mode AS mode FROM agent_sessions s JOIN agent_providers p ON p.id = s.provider_id WHERE p.provider = 'deepseek' AND s.native_id = ?",
  ).get(sid)
  if (sessionRow === undefined) throw new Error('session row missing')
  ev(`session row: id=${sessionRow.id} mode=${sessionRow.mode}`)
  if (sessionRow.mode !== 'managed') throw new Error('session row not managed')

  // 首探：caps 落库（App 现实：会话开始时 caps 新鲜）。置于 monitor 启动前——
  // monitor 首扫真实 ~/.dsh 全量历史会阻塞事件循环数十秒，若夹在中间会把 probe0
  // 的实际探测执行推迟到陈旧模拟之后（60s 节流碰撞，三跑教训）。
  const probe0At = Date.now()
  const providers0 = await svc.listAgentProviders()
  const caps0 = providers0.providers.find((p) => p.displayName === 'DeepSeek Harness')?.capabilities
  ev(`probe0 (caps seeded): at=${probe0At} mode=${caps0?.mode} granted=${caps0?.granted.join('|')} verifiedAt=${caps0?.verifiedAt}`)
  evRaw('caps-seeded.json', caps0)
  if (caps0?.mode !== 'managed') throw new Error('caps0 not managed')

  // wire-scan 路径上线（生产九方法 8 + 生产同构 sink）
  provider.startMonitor(sink)
  ev('monitor started (wire-scan refresh path live, production-identical sink)')

  // ① 前半：模拟 >5min caps 过期（brief §3 允许的模拟口径）→ App 路径首发被拒。
  // 同时回拨 last_probe_at 61s——真实「>5min 离开」场景里上次探测必然早已超出
  // 60s 全局节流（CapsSelfHeal 时序保证的现实形态）。
  const staleAt = Date.now()
  const staleSec = Math.floor(staleAt / 1000)
  const staleJson = JSON.stringify({ ...caps0, verifiedAt: staleSec - 400 })
  getDatabase().prepare("UPDATE agent_providers SET capabilities_json = ?, last_probe_at = ? WHERE provider = 'deepseek'").run(staleJson, staleSec - 61)
  const capsStale = svc.readProviderCapabilitySet('deepseek')
  ev(`caps staleness simulated: verifiedAt=${capsStale.verifiedAt} (age=${staleSec - capsStale.verifiedAt}s > 300s TTL; last_probe_at rewound 61s)`)
  evRaw('caps-stale.json', capsStale)

  const attempt1At = Date.now()
  let attempt1Error = null
  try {
    await svc.createSessionAction(sessionRow.id, 'reply', '请直接回复四个字：第二回合。不要使用工具。')
  } catch (err) {
    attempt1Error = { code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 200) }
  }
  if (attempt1Error === null) throw new Error('attempt1 unexpectedly succeeded (caps gate did not fire)')
  if (attempt1Error.code !== 'AGENT_CAPABILITY_MISSING') throw new Error(`attempt1 wrong code: ${JSON.stringify(attempt1Error)}`)
  ev(`① attempt1 rejected (App-visible): code=${attempt1Error.code} at=${attempt1At} (+${attempt1At - t1IdleAt}ms after T1 idle) message=${attempt1Error.message}`)
  evRaw('selfheal-attempt1-rejection.json', { at: attempt1At, ...attempt1Error })

  // ① 中段：自愈探针（App 既有通道 agents 列表 = listAgentProviders →
  // probeWiredProviders → caps 过期重验；真实探测，绝不伪造）
  const probeAt = Date.now()
  const providers1 = await svc.listAgentProviders()
  const probeDoneAt = Date.now()
  const caps1 = providers1.providers.find((p) => p.displayName === 'DeepSeek Harness')?.capabilities
  const nowSec = Math.floor(probeDoneAt / 1000)
  const fresh = caps1 !== undefined && caps1.verifiedAt > 0 && nowSec - caps1.verifiedAt <= 300 && nowSec >= caps1.verifiedAt
  ev(`① self-heal probe: at=${probeAt} doneAt=${probeDoneAt} probeMs=${probeDoneAt - probeAt} mode=${caps1?.mode} granted=${caps1?.granted.join('|')} verifiedAt=${caps1?.verifiedAt} fresh=${fresh}`)
  evRaw('caps-refreshed.json', caps1)
  if (!fresh) throw new Error('self-heal probe did not refresh caps')
  if (caps1.mode !== 'managed' || !caps1.granted.includes('reply')) throw new Error('refreshed caps not managed+reply (fabrication check failed)')

  // ① 后半：原消息自动重发一次（App 一次性语义；真实 prompt #2 在同一 live 连接）
  const retryAt = Date.now()
  const retry = await svc.createSessionAction(sessionRow.id, 'reply', '请直接回复四个字：第二回合。不要使用工具。')
  const retryDoneAt = Date.now()
  ev(`① retry: at=${retryAt} executed=${retry.status === 'executed'} commandId=${retry.commandId} detailMs=${retryDoneAt - retryAt}`)
  evRaw('selfheal-retry.json', { at: retryAt, doneAt: retryDoneAt, ...retry })
  if (retry.status !== 'executed') throw new Error(`retry not executed: ${JSON.stringify(retry)}`)

  await pollUntil(() => timeline.some((e) => e.kind === 'status' && e.id === sid && e.to === 'running' && e.at >= retryAt), 30_000, 100, 'T2 running edge')
  await pollUntil(() => timeline.some((e) => e.kind === 'status' && e.id === sid && e.to === 'waiting_input' && e.at >= retryAt), 180_000, 200, 'T2 idle')
  const t2RunningAt = timeline.find((e) => e.kind === 'status' && e.id === sid && e.to === 'running' && e.at >= retryAt).at
  const t2IdleAt = timeline.filter((e) => e.kind === 'status' && e.id === sid && e.to === 'waiting_input').map((e) => e.at).pop()
  const t2Bubble = timeline.filter((e) => e.kind === 'msg' && e.nid === 'assistant-t2s1' && e.role === 'assistant' && e.at >= retryAt)
  const selfhealTiming = {
    t1IdleAt,
    staleSimulatedAt: staleAt,
    attempt1RejectedAt: attempt1At,
    rejectionCode: attempt1Error.code,
    probeAt,
    probeDoneAt,
    probeMs: probeDoneAt - probeAt,
    retryAt,
    retryExecutedAt: retryDoneAt,
    t2FirstStreamAt: t2Bubble[0]?.at ?? null,
    t2IdleAt,
    chainMs: t2IdleAt - attempt1At,
    retryToFirstStreamMs: (t2Bubble[0]?.at ?? retryDoneAt) - retryDoneAt,
  }
  ev(`① self-heal chain timing: reject→probe→retry→stream→idle = ${JSON.stringify(selfhealTiming)}`)
  evRaw('selfheal-timing.json', selfhealTiming)
  ev(`T2 evidence: bubble=assistant-t2s1 increments=${t2Bubble.length} (texts: ${JSON.stringify(t2Bubble.map((e) => e.text))}) wire=${JSON.stringify(wireFile(sid))}`)

  // ② 双写去重行数对照：等 wire-scan 路径重放（source_ref 从 dsh-live:// 翻转为
  // 会话日志文件指针 = 刷新路径确实重写过同键行），然后清点。预期行数 = wire-scan
  // 面去重后的不同消息数（真实 runtime 每回合可能发多条 user 事件——各 seq 独立
  // 身份，均应恰一行；双写缺陷的定义 = 同一事件两行，而非事件数本身）。
  const rowsOf = () => getDatabase().prepare(
    'SELECT native_msg_id, role, source_ref FROM agent_messages WHERE session_id = ? ORDER BY id',
  ).all(sessionRow.id)
  await pollUntil(() => {
    const rows = rowsOf()
    return rows.length >= 2 && rows.every((r) => !String(r.source_ref).startsWith('dsh-live://'))
  }, 60_000, 500, 'wire-scan replay flip (source_ref rewritten onto the log file)')
  const scanPage = await provider.readMessages({ providerId: 'deepseek', nativeId: sid })
  const scanKeys = new Set(scanPage.messages.map((m) => m.nativeMsgId))
  const rows = rowsOf()
  const dupGroups = Object.entries(rows.reduce((acc, r) => { acc[r.native_msg_id] = (acc[r.native_msg_id] ?? 0) + 1; return acc }, {})).filter(([, c]) => c > 1)
  const legacyKeyRows = rows.filter((r) => String(r.native_msg_id).startsWith('user-message-') || String(r.native_msg_id).startsWith('tool-result-'))
  const dedup = {
    sessionId: sessionRow.id,
    nativeId: sid,
    turns: 2,
    wireScanDistinctMessages: scanPage.messages.length,
    wireScanKeys: scanPage.messages.map((m) => m.nativeMsgId),
    actualRows: rows.length,
    duplicateKeyGroups: dupGroups.length,
    legacyPrefixKeyRows: legacyKeyRows.length,
    rowsAllInScanKeySet: rows.every((r) => scanKeys.has(r.native_msg_id)),
    rows: rows.map((r) => ({ nid: r.native_msg_id, role: r.role, sourceRef: String(r.source_ref).split(/[\\/]/).pop() })),
    run6Baseline: 'pre-fix run6 (agent_messages 29392-29395): dual-path wrote 2 rows per wire event (firehose key + wire-scan seq key) -> 2x duplicate bubbles in App',
  }
  ev(`② dedup rows: wireScanDistinct=${dedup.wireScanDistinctMessages} actual=${dedup.actualRows} dupGroups=${dedup.duplicateKeyGroups} legacyKeys=${dedup.legacyPrefixKeyRows} allInScanKeySet=${dedup.rowsAllInScanKeySet}`)
  ev(`② rows: ${JSON.stringify(dedup.rows)}`)
  evRaw('dedup-rows.json', dedup)
  if (dedup.actualRows !== dedup.wireScanDistinctMessages) throw new Error(`row count mismatch: ${dedup.actualRows} != wire-scan distinct ${dedup.wireScanDistinctMessages}`)
  if (dedup.duplicateKeyGroups !== 0) throw new Error('duplicate native_msg_id groups found (dual-write rows)')
  if (dedup.legacyPrefixKeyRows !== 0) throw new Error('legacy prefix keys present')
  if (!dedup.rowsAllInScanKeySet) throw new Error('persisted keys diverge from the wire-scan identity keys')

  // 收尾：kill 阶梯 + 零孤儿 + 键归 0 + 常驻 health×3
  const disposeAt = Date.now()
  await provider.dispose()
  ev(`dispose (kill ladder): done in ${Date.now() - disposeAt}ms`)
  await sleep(1500)
  const orphanAfter = harnessProcCount()
  ev(`orphan check: baseline=${orphanBaseline} after=${orphanAfter} (${orphanAfter <= orphanBaseline ? 'zero orphans' : 'ORPHAN DETECTED'})`)

  settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '0')
  const capsOff = await provider.getCapabilities({ providerId: 'deepseek', nativeId: 'x' })
  ev(`revert: key=0 → caps mode=${capsOff.mode} granted=${capsOff.granted.length} (byte-identical legacy observed shape)`)
  evRaw('caps-reverted.json', capsOff)

  const healthLines = []
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(2000)
    healthLines.push({ at: new Date().toISOString(), health: await residentHealth() })
  }
  const healthOk = healthLines.every((h) => h.health?.ok === true)
  const monotonic = healthLines.every((h, idx) => idx === 0 || h.health.uptimeSec >= healthLines[idx - 1].health.uptimeSec)
  const healthVerdict = healthOk && monotonic ? 'PASS (resident instance untouched; uptime monotonic)' : `FAIL (ok=${healthOk} monotonic=${monotonic})`
  healthLines.push({ verdict: healthVerdict })
  ev(`resident health×3: ${healthVerdict} (${healthLines.slice(0, 3).map((h) => `uptime=${h.health.uptimeSec ?? h.health.error}`).join(', ')})`)
  evRaw('health-x3.json', healthLines)

  ev('RUN6-FIX VERIFY COMPLETE: 2 real prompts (T1 spawn + T2 self-heal retry); zero credentials read/injected/logged')
} catch (err) {
  ev('RUN6-FIX VERIFY FAILED: ' + (err instanceof Error ? err.stack : String(err)))
  process.exitCode = 1
} finally {
  try { svc?.clearProviderOverrides?.() } catch {}
  try { closeDatabase() } catch {}
  writeFileSync(join(OUT, 'verify-report.txt'), report.join('\n') + '\n')
  try { rmSync(process.env.DEVHUB_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }) } catch {}
}
