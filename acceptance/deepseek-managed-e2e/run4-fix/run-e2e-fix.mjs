#!/usr/bin/env node
/**
 * run4-fix — DSN 批真机验证（DeepSeek managed spawn 载体解析链，docs/briefs/dsn-carrier.md §3）。
 *
 * 验证主体：run4 决定性隔离实验（acceptance/mobile-chat-relay-e2e/run4/）的正面修法——
 * electron 内置 node v24.19（ELECTRON_RUN_AS_NODE=1）被 harness cordis loader 拒
 * （failed to apply loader entry include），plain node v24.15 秒答 initialize。
 * 本 runner 逐级留证据：
 *   L2（本机主链）：真实 where.exe node 单源探测 + node --version 哨兵 → level 'system'
 *   L1（显式键）：deepseek_managed_node = 系统 node 路径 → level 'explicit'（真哨兵）
 *   L3（降级演示）：注入 where 失败缝（**非真实缺 node**，如实标注 injected）
 *   M0：用解析链生效命令（系统 node）spawn runtime → initialize 时延微探针（零推理，
 *       对照 run4 = 30000ms 预算耗尽 COMMAND_NOT_EXECUTABLE）
 *   T1：startManagedSession（provider 级全链；真实推理恰 1 条最小 prompt）
 *   R：键归 0 → observed 逐字节形态 + spawn 结构化拒
 *   health×3：常驻桌面实例还原复验（零触碰证明：uptime 连续递增）
 *
 * 纪律：
 * - 隔离 DEVHUB_HOME 临时实例承载 settings DB；常驻实例零触碰（毕后 health×3）；
 * - 凭据三零：零读取 ~/.dsh/.credentials.yaml；spawn env 只增 DSH_CORDIS_CONFIG；
 * - 真实推理最小化：整轮恰 1 条最小 prompt；
 * - 代理路由 env（非凭据，run3-fix 同款）：生产 spawn 透传 process.env，DevHub 零注入。
 *
 * 用法：node run-e2e-fix.mjs（DEVHUB_HOME 由脚本自建临时目录）
 */

import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'evidence')
mkdirSync(OUT, { recursive: true })

const report = []
const ev = (line) => {
  const text = typeof line === 'string' ? line : JSON.stringify(line)
  report.push(text)
  console.log('[run4-fix]', text)
  appendFileSync(join(OUT, 'e2e-log.jsonl'), JSON.stringify({ t: Date.now(), line: text }) + '\n')
}
const evRaw = (name, obj) => {
  writeFileSync(join(OUT, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function pollUntil(fn, timeoutMs, stepMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(stepMs)
  }
  throw new Error(`pollUntil timeout: ${label}`)
}

// 隔离 DEVHUB_HOME（临时实例；单实例锁窗口=库模式，无桌面实例）
const devhubHome = mkdtempSync(join(tmpdir(), 'devhub-dsn-fix-'))
process.env.DEVHUB_HOME = devhubHome
const { closeDatabase } = await import(new URL('../../../src/main/db/index.ts', import.meta.url).href)
const settings = await import(new URL('../../../src/main/services/settingsService.ts', import.meta.url).href)
const mod = await import(new URL('../../../src/main/services/agentControl/providers/deepseekProvider.ts', import.meta.url).href)
const cfg = await import(new URL('../../../src/main/services/agentControl/providers/deepseekManagedConfig.ts', import.meta.url).href)

// 网络路由（验证环境事实，run3-fix 同款）：api.deepseek.com 本机直连超时——
// harness LLM 往返需经用户系统代理（路由非凭据：零 key 值；provider 代码零注入）。
process.env['NODE_USE_ENV_PROXY'] = '1'
process.env['HTTPS_PROXY'] = process.env['HTTPS_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['HTTP_PROXY'] = process.env['HTTP_PROXY'] ?? 'http://127.0.0.1:7897'

try {
  // ------------------------------------------------------------------
  // L2：载体解析链二级（真实 where.exe node 单源 + 真哨兵）——本批主证据
  // ------------------------------------------------------------------
  settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '1') // 门开（L1 解析不依赖门，但整链语境一致）
  const l2At = Date.now()
  const carrier = await cfg.resolveDeepseekSpawnCarrier()
  const l2Ms = Date.now() - l2At
  if (!carrier.ok) throw new Error('carrier resolution refused: ' + carrier.reason)
  ev(`L2 carrier: level=${carrier.level} command=${carrier.command} (${l2Ms}ms where+sentinel)`)
  ev(`L2 detail: ${carrier.detail}`)
  ev(`L2 env: ${JSON.stringify(carrier.env)} (plain node → zero switch)`)
  if (carrier.level !== 'system') throw new Error(`expected level 'system' on this machine, got ${carrier.level}`)
  if ('ELECTRON_RUN_AS_NODE' in carrier.env) throw new Error('system carrier must not carry ELECTRON_RUN_AS_NODE')
  evRaw('carrier-l2.json', { ...carrier, resolutionMs: l2Ms, brief: 'docs/briefs/dsn-carrier.md §1 level 2 (where.exe node single source + node --version sentinel)' })

  // 哨兵成功缓存证明：第二次解析哨兵零重跑（耗时显著下降，命中缓存）
  const l2bAt = Date.now()
  const carrier2 = await cfg.resolveDeepseekSpawnCarrier()
  const l2bMs = Date.now() - l2bAt
  ev(`L2 cache: second resolution ${l2bMs}ms (sentinel cached on first success; where re-probed)`)
  evRaw('carrier-l2-cache.json', { firstResolutionMs: l2Ms, secondResolutionMs: l2bMs, level2: carrier2.level })

  // ------------------------------------------------------------------
  // L1：显式键命中（真哨兵；deepseek_managed_node = 系统 node 路径）
  // ------------------------------------------------------------------
  settings.setSetting(cfg.DEEPSEEK_MANAGED_NODE_SETTING_KEY, carrier.command)
  const l1At = Date.now()
  const carrierExplicit = await cfg.resolveDeepseekSpawnCarrier()
  const l1Ms = Date.now() - l1At
  if (!carrierExplicit.ok || carrierExplicit.level !== 'explicit') throw new Error('explicit key did not hit level 1')
  ev(`L1 carrier: level=${carrierExplicit.level} command=${carrierExplicit.command} (${l1Ms}ms sentinel, cached)`)
  evRaw('carrier-l1.json', { ...carrierExplicit, resolutionMs: l1Ms, settingsKey: cfg.DEEPSEEK_MANAGED_NODE_SETTING_KEY })

  // 缺失文件 → 门读取同步拒（零 spawn；人话点名键名与路径）
  settings.setSetting(cfg.DEEPSEEK_MANAGED_NODE_SETTING_KEY, join(devhubHome, 'no-such-node.exe'))
  const gateMissing = cfg.readDeepseekManagedGate()
  ev(`L1 missing-file: gate enabled=${gateMissing.enabled} reason=${gateMissing.reason ?? ''}`)
  evRaw('carrier-l1-missing.json', { enabled: gateMissing.enabled, reason: gateMissing.reason ?? null })
  if (gateMissing.enabled) throw new Error('missing explicit node path must refuse the gate')
  settings.setSetting(cfg.DEEPSEEK_MANAGED_NODE_SETTING_KEY, '') // 清键：后续走真实二级

  // ------------------------------------------------------------------
  // L3：降级演示（注入 where 失败缝——**非真实缺 node**，如实标注 injected）
  // ------------------------------------------------------------------
  const carrierFallback = await cfg.resolveDeepseekSpawnCarrier({ whereNode: async () => ({ ok: false, detail: 'injected seam: where unavailable (demo)' }) })
  if (!carrierFallback.ok || carrierFallback.level !== 'fallback') throw new Error('fallback demo failed')
  ev(`L3 fallback (injected demo): degradation=${carrierFallback.degradation}`)
  evRaw('carrier-l3-injected.json', { ...carrierFallback, note: 'INJECTED where-seam demo — this machine HAS system node; real absence not forceable without hiding node' })

  // ------------------------------------------------------------------
  // caps：managed + workspace + carrier evidence（本批新面）
  // ------------------------------------------------------------------
  const gate = cfg.readDeepseekManagedGate()
  ev(`gate: enabled=${gate.enabled} provider=${gate.provider} model=${gate.model} spawnCommand=${gate.spawnCommand}`)
  ev(`gate: binPath=${gate.binPath}`)
  if (!gate.enabled) throw new Error('gate not enabled: ' + gate.reason)
  const expectedWs = join(devhubHome, 'dsh-workspace')
  if (gate.workspacePath !== expectedWs) throw new Error('default workspace did not resolve to <DEVHUB_HOME>/dsh-workspace')

  const capsProvider = mod.createDeepseekProvider({ managedGate: () => cfg.readDeepseekManagedGate() })
  const caps = await capsProvider.getCapabilities({ providerId: 'deepseek', nativeId: 'probe' })
  ev(`caps: mode=${caps.mode} granted=${caps.granted.join('|')} workspace=${caps.workspace}`)
  ev(`caps evidence: ${caps.evidence}`)
  evRaw('caps-managed.json', caps)
  if (caps.mode !== 'managed') throw new Error('caps did not flip to managed')
  if (!caps.evidence.includes('spawn carrier: level 2 system node via where.exe')) throw new Error('caps evidence missing the level-2 carrier line')
  if (caps.evidence.includes(cfg.DEEPSEEK_CARRIER_DEGRADATION_NOTE)) throw new Error('degradation note must NOT appear on a system hit')

  // ------------------------------------------------------------------
  // M0：initialize 时延微探针（零推理）——spawn 载体 = 解析链生效命令（系统 node）
  // ------------------------------------------------------------------
  const ensured = cfg.ensureDeepseekCordisConfig({ workspacePath: gate.workspacePath, harnessRoot: gate.harnessRoot })
  if (!ensured.ok) throw new Error('cordis config render failed: ' + ensured.reason)
  const wsEnsure = cfg.ensureDeepseekManagedWorkspaceDir(gate.workspacePath)
  ev(`M0: cordis.yml rendered at ${ensured.path}; workspace dir ok=${wsEnsure.ok} created=${wsEnsure.created}`)
  evRaw('m0-workspace.json', { workspacePath: gate.workspacePath, created: wsEnsure.created, configPath: ensured.path, carrierCommand: carrier.command })

  const child = spawn(carrier.command, [gate.binPath, ensured.path], {
    cwd: gate.workspacePath,
    env: { ...process.env, DSH_CORDIS_CONFIG: ensured.path },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const spawnAt = Date.now()
  let m0buf = ''
  let m0resolve = null
  const m0response = new Promise((res) => { m0resolve = res })
  child.stdout.on('data', (d) => {
    m0buf += String(d)
    let i
    while ((i = m0buf.indexOf('\n')) >= 0) {
      const line = m0buf.slice(0, i)
      m0buf = m0buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        const f = JSON.parse(line)
        if (f.id === 'req_m0') m0resolve({ frame: f, at: Date.now() })
      } catch {}
    }
  })
  const stderrTail = []
  child.stderr.on('data', (d) => {
    const s = String(d).trim()
    if (s) stderrTail.push(s.split('\n').slice(-1)[0].slice(0, 300))
  })
  await sleep(500)
  const initSentAt = Date.now()
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'req_m0', method: 'initialize', params: { cwd: gate.workspacePath, provider: gate.provider, model: gate.model } }) + '\n')
  const m0 = await Promise.race([
    m0response,
    sleep(cfg.DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS).then(() => null),
  ])
  if (m0 === null) {
    ev(`M0: initialize NO response within ${cfg.DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS}ms via the RESOLVED carrier (run4 reproduced — FAIL)`)
    evRaw('m0-initialize.json', { ok: false, carrierCommand: carrier.command, timeoutMs: cfg.DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS, stderrTail: stderrTail.slice(-5) })
    child.kill()
    throw new Error('M0 initialize timed out even on the resolved carrier')
  }
  const totalMs = m0.at - spawnAt
  const rttMs = m0.at - initSentAt
  const sentinel = cfg.verifyDeepseekHandshake(m0.frame.result)
  ev(`M0: initialize answered VIA SYSTEM NODE — spawn→response total ${totalMs}ms, write→response ${rttMs}ms (run4 baseline: 30000ms budget exhausted = COMMAND_NOT_EXECUTABLE, electron runtime rejected by cordis loader)`)
  ev(`M0: serverInfo=${JSON.stringify(m0.frame.result?.serverInfo)} sentinel ok=${sentinel.ok}`)
  evRaw('m0-initialize.json', { ok: true, carrierCommand: carrier.command, spawnToResponseMs: totalMs, writeToResponseMs: rttMs, run4TimeoutBudgetMs: cfg.DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS, serverInfo: m0.frame.result?.serverInfo, sentinel, stderrTail: stderrTail.slice(-3) })
  const shutAt = Date.now()
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'req_m0s', method: 'shutdown' }) + '\n')
  const exited = await Promise.race([
    new Promise((res) => child.once('exit', (code) => res(code))),
    sleep(cfg.DEEPSEEK_MANAGED_SHUTDOWN_TIMEOUT_MS).then(() => 'timeout'),
  ])
  ev(`M0: shutdown → exit=${exited} in ${Date.now() - shutAt}ms`)

  // ------------------------------------------------------------------
  // T1：startManagedSession（provider 级全链；真实推理 1/1）
  // ------------------------------------------------------------------
  const timeline = []
  const sink = {
    onSessionDiscovered: (_p, snap) => timeline.push({ at: Date.now(), kind: 'discovered', snap }),
    onStatusChanged: (ref, from, to, detail) => timeline.push({ at: Date.now(), kind: 'status', nativeId: ref.nativeId, from, to, detail }),
    onMessageAppended: (ref, msg) => timeline.push({ at: Date.now(), kind: 'msg', nativeId: ref.nativeId, role: msg.role, text: msg.contentRedacted.slice(0, 80) }),
  }
  const provider = mod.createDeepseekProvider({
    managedGate: () => cfg.readDeepseekManagedGate(),
  })
  const t0 = Date.now()
  const start1 = await provider.startManagedSession('请直接回复：收到。不要使用任何工具。', sink)
  ev(`T1 start: ok=${start1.ok} nativeId=${start1.nativeId} totalMs=${Date.now() - t0} (spawn on the RESOLVED carrier + initialize + prompt accept)`)
  evRaw('t1-start.json', { ...start1, totalMs: Date.now() - t0, carrierCommand: carrier.command })
  if (!start1.ok) throw new Error('T1 startManagedSession failed: ' + start1.detail)
  const sid1 = start1.nativeId

  await pollUntil(async () => timeline.some((e) => e.kind === 'status' && e.nativeId === sid1 && e.to === 'waiting_input'), 180_000, 200, 'T1 idle')
  const t1Chunks = timeline.filter((e) => e.kind === 'msg' && e.nativeId === sid1 && e.role === 'assistant')
  const t1IdleAt = timeline.find((e) => e.kind === 'status' && e.to === 'waiting_input').at
  ev(`T1 turn: ${t1Chunks.length} assistant projections landed, all before idle = ${t1Chunks.every((c) => c.at < t1IdleAt)}; text=${JSON.stringify(t1Chunks.map((c) => c.text))}`)
  evRaw('t1-timeline.json', timeline.filter((e) => e.nativeId === sid1 || e.kind === 'discovered'))

  // observed 同一性：observed 扫描器看到同一 sessionId（persistence 同根）
  const observedSnaps = await provider.listSessions()
  const seen = observedSnaps.find((s) => s.nativeId === sid1)
  ev(`identity: observed listSessions sees sessionId=${sid1}: ${seen !== undefined} (mode=${seen?.mode ?? 'n/a'})`)
  const sessionsRoot = join(cfg.resolveDshHome(), 'sessions')
  const projectDirs = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []
  const projectDir = projectDirs.find((d) => existsSync(join(sessionsRoot, d, sid1)))
  ev(`identity: harness projectKey dir = ${projectDir ?? 'NOT FOUND'}`)
  evRaw('identity-observed.json', { sessionId: sid1, seenInObservedList: seen !== undefined, observedMode: seen?.mode ?? null, projectKeyDir: projectDir ?? null })
  if (seen === undefined) throw new Error('observed identity failed')

  // 诊断投影：carrier 结论入 control note
  const diag = provider.describeDiagnostics()
  ev(`diagnostics control note: ${diag.control?.note}`)
  evRaw('diagnostics.json', diag)
  if (!String(diag.control?.note).includes('spawn carrier: level 2 system node via where.exe')) throw new Error('diagnostics note missing the carrier verdict')

  // ------------------------------------------------------------------
  // R：键归 0 → legacy observed 形态 + spawn 拒绝（可撤销）
  // ------------------------------------------------------------------
  settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '0')
  const capsOff = await provider.getCapabilities({ providerId: 'deepseek', nativeId: 'probe' })
  ev(`revert: key=0 → caps mode=${capsOff.mode} granted=${capsOff.granted.length} evidence=${capsOff.evidence}`)
  evRaw('caps-reverted.json', capsOff)
  const spawnOff = await provider.startManagedSession('should not spawn', sink)
  ev(`revert: startManagedSession refused = ${!spawnOff.ok} detail=${spawnOff.detail}`)
  if (capsOff.mode !== 'observed' || capsOff.evidence !== mod.DEEPSEEK_CONTROL_NOTE) throw new Error('revert did not restore the byte-identical observed face')
  if (spawnOff.ok) throw new Error('startManagedSession must refuse after revert')

  const disposeAt = Date.now()
  await provider.dispose()
  ev(`wire: dispose done in ${Date.now() - disposeAt}ms`)

  ev('RUN4-FIX COMPLETE: carrier chain L1/L2 real evidence + L3 injected demo; M0 initialize latency captured on the RESOLVED system-node carrier (vs run4 30s timeout); 1 real prompt consumed (T1); zero credentials read/injected/logged')
} catch (err) {
  ev('RUN4-FIX FAILED: ' + (err instanceof Error ? err.stack : String(err)))
  process.exitCode = 1
} finally {
  try {
    closeDatabase()
  } catch {}
  writeFileSync(join(OUT, 'e2e-report.txt'), report.join('\n') + '\n')
  // 还原：临时 DEVHUB_HOME 清理（常驻实例零触碰）
  try {
    rmSync(devhubHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  } catch {}
}

// ------------------------------------------------------------------
// 常驻实例 health×3 还原复验（桌面实例零触碰的证明：uptime 连续递增）
// ------------------------------------------------------------------
const healthLines = []
try {
  for (let i = 1; i <= 3; i += 1) {
    const res = await fetch('http://127.0.0.1:8746/v1/health').then((r) => r.json()).catch((e) => ({ error: String(e) }))
    healthLines.push({ at: new Date().toISOString(), health: res })
    await sleep(2000)
  }
  const ok = healthLines.every((h) => h.health?.ok === true)
  const monotonic = healthLines.every((h, idx) => idx === 0 || h.health.uptimeSec >= healthLines[idx - 1].health.uptimeSec)
  healthLines.push({ verdict: ok && monotonic ? 'PASS (resident instance untouched; uptime monotonic)' : 'FAIL' })
} catch (err) {
  healthLines.push({ verdict: 'ERROR: ' + String(err) })
}
writeFileSync(join(OUT, 'health-x3.json'), JSON.stringify(healthLines, null, 2))
console.log('[run4-fix] health×3:', JSON.stringify(healthLines.map((h) => h.health?.uptimeSec ?? h.verdict)))
