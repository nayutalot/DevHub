#!/usr/bin/env node
/**
 * run3-fix E2E（DSW 批，docs/briefs/dsw-workspace.md §2）：DeepSeek managed
 * 工作区生产旋钮 provider 级真机验证——run3 阻断（spawn cwd 默认=用户 home 根 →
 * dsh 沙箱 temp-root 撞 Windows ACL → initialize 30s 超时 → COMMAND_NOT_
 * EXECUTABLE，acceptance/mobile-chat-relay-e2e/run3/）修复的正面证明。
 *
 * 验证序列（真实推理预算 = 恰 1 条最小 prompt）：
 *   M0  initialize 时延微探针（协议级，零推理）：键=1 + **默认工作区**（旋钮键
 *       缺行）→ provider 同款渲染+按需创建 <data>/dsh-workspace → 直接 spawn
 *       bin（cwd=默认工作区）→ initialize 应答时延（对照 run3 30s 超时）→
 *       版本哨兵核对 → shutdown 自退；
 *   T1  startManagedSession（provider 级，真实推理 1/1）：同默认工作区 spawn →
 *       initialize → prompt → firehose 流式 → idle；observed 面同 sessionId
 *       workdir=默认工作区（同根同一性 + 工作区生效双实锤）；
 *   R   键归 0 → caps 回 observed（逐字节 legacy 形态）+ spawn 结构化拒绝。
 *
 * 纪律：
 * - 隔离 DEVHUB_HOME 临时实例（库模式）——桌面常驻实例零触碰；毕后 /v1/health×3
 *   （uptime 连续递增）还原复验；
 * - 凭据三零：零读取 ~/.dsh/.credentials.yaml（harness credentials-local 自取）；
 *   spawn env 只增 DSH_CORDIS_CONFIG（配置路径）+ shell 式代理路由（非凭据）；
 *   日志零 key 值；
 * - 默认工作区旋钮路径即本批修法主体验证面（显式键/不存在拒由 dsh-102 夹具锁）。
 *
 * 用法：node run-e2e-fix.mjs（DEVHUB_HOME 由脚本自建临时目录）
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const OUT = join(HERE, 'evidence')
mkdirSync(OUT, { recursive: true })

const report = []
const ev = (line) => {
  const text = typeof line === 'string' ? line : JSON.stringify(line)
  report.push(text)
  console.log('[run3-fix]', text)
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

// 隔离 DEVHUB_HOME（临时实例；settings 键只发生在临时 DB）
const devhubHome = mkdtempSync(join(tmpdir(), 'devhub-dsw-fix-'))
process.env.DEVHUB_HOME = devhubHome
const { closeDatabase } = await import(new URL('../../../src/main/db/index.ts', import.meta.url).href)
const settings = await import(new URL('../../../src/main/services/settingsService.ts', import.meta.url).href)
const cfg = await import(new URL('../../../src/main/services/agentControl/providers/deepseekManagedConfig.ts', import.meta.url).href)
const mod = await import(new URL('../../../src/main/services/agentControl/providers/deepseekProvider.ts', import.meta.url).href)

// 网络路由（验证环境事实，DM 批同款）：api.deepseek.com 直连超时需系统代理；
// shell 式 env 设置 = 路由非凭据（零 key 值；provider 代码零注入）
process.env['NODE_USE_ENV_PROXY'] = '1'
process.env['HTTPS_PROXY'] = process.env['HTTPS_PROXY'] ?? 'http://127.0.0.1:7897'
process.env['HTTP_PROXY'] = process.env['HTTP_PROXY'] ?? 'http://127.0.0.1:7897'

try {
  // ------------------------------------------------------------------
  // 键=1；工作区旋钮键**缺行**（默认值=安全目录即验证主体）
  // ------------------------------------------------------------------
  settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '1')
  // 工作区旋钮键保持缺行（默认值=安全目录即验证主体；绝不预写键）
  const gate = cfg.readDeepseekManagedGate()
  const expectedWs = join(resolve(devhubHome), 'dsh-workspace')
  ev(`gate: enabled=${gate.enabled} provider=${gate.provider} model=${gate.model}`)
  ev(`workspace knob: key absent → default = ${gate.workspacePath} (expected ${expectedWs})`)
  if (gate.workspacePath !== expectedWs) throw new Error('default workspace did not resolve to <DEVHUB_HOME>/dsh-workspace')
  if (existsSync(gate.workspacePath)) throw new Error('default workspace pre-existed; on-demand-create evidence would be void (choose a fresh temp home)')
  ev(`workspace knob: gate read stayed write-free (dir absent before spawn) = ${!existsSync(gate.workspacePath)}`)
  ev(`gate: binPath=${gate.binPath} configPath=${gate.configPath}`)
  if (!gate.enabled) throw new Error('gate not enabled: ' + gate.reason)

  // caps：managed + workspace 结构化字段（本批新面）
  const capsProvider = mod.createDeepseekProvider({ managedGate: () => cfg.readDeepseekManagedGate() })
  const caps = await capsProvider.getCapabilities({ providerId: 'deepseek', nativeId: 'probe' })
  ev(`caps: mode=${caps.mode} granted=${caps.granted.join('|')} workspace=${caps.workspace}`)
  evRaw('caps-managed.json', caps)
  if (caps.mode !== 'managed' || caps.workspace !== expectedWs) throw new Error('caps did not flip to managed with the default workspace')

  // ------------------------------------------------------------------
  // M0：initialize 时延微探针（协议级，零推理）——run3 对照主证据
  // ------------------------------------------------------------------
  const ensured = cfg.ensureDeepseekCordisConfig({ workspacePath: gate.workspacePath, harnessRoot: gate.harnessRoot })
  if (!ensured.ok) throw new Error('cordis config render failed: ' + ensured.reason)
  ev(`M0: cordis.yml rendered at ${ensured.path} (workspaceRoot/cwd = default safe dir)`)
  const wsEnsure = cfg.ensureDeepseekManagedWorkspaceDir(gate.workspacePath)
  ev(`M0: workspace dir on-demand create → ok=${wsEnsure.ok} created=${wsEnsure.created} at ${gate.workspacePath}`)
  evRaw('m0-workspace.json', { workspacePath: gate.workspacePath, created: wsEnsure.created, configPath: ensured.path })

  const child = spawn(process.execPath, [gate.binPath, ensured.path], {
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
    ev(`M0: initialize NO response within ${cfg.DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS}ms (run3 timeout reproduced — FAIL)`)
    evRaw('m0-initialize.json', { ok: false, timeoutMs: cfg.DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS, stderrTail: stderrTail.slice(-5) })
    child.kill()
    throw new Error('M0 initialize timed out (run3 NOT fixed?)')
  }
  const totalMs = m0.at - spawnAt
  const rttMs = m0.at - initSentAt
  const sentinel = cfg.verifyDeepseekHandshake(m0.frame.result)
  ev(`M0: initialize answered — spawn→response total ${totalMs}ms, write→response ${rttMs}ms (run3 baseline: 30000ms budget exhausted = COMMAND_NOT_EXECUTABLE)`)
  ev(`M0: serverInfo=${JSON.stringify(m0.frame.result?.serverInfo)} sentinel ok=${sentinel.ok}`)
  evRaw('m0-initialize.json', { ok: true, spawnToResponseMs: totalMs, writeToResponseMs: rttMs, run3TimeoutBudgetMs: cfg.DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS, serverInfo: m0.frame.result?.serverInfo, sentinel, stderrTail: stderrTail.slice(-3) })
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
  ev(`T1 start: ok=${start1.ok} nativeId=${start1.nativeId} totalMs=${Date.now() - t0} (spawn+initialize+prompt accept; run3 failed this exact call)`)
  evRaw('t1-start.json', { ...start1, totalMs: Date.now() - t0 })
  if (!start1.ok) throw new Error('T1 startManagedSession failed: ' + start1.detail)
  const sid1 = start1.nativeId

  await pollUntil(async () => timeline.some((e) => e.kind === 'status' && e.nativeId === sid1 && e.to === 'waiting_input'), 180_000, 200, 'T1 idle')
  const t1Chunks = timeline.filter((e) => e.kind === 'msg' && e.nativeId === sid1 && e.role === 'assistant')
  const t1IdleAt = timeline.find((e) => e.kind === 'status' && e.to === 'waiting_input').at
  ev(`T1 turn: ${t1Chunks.length} assistant projections landed, all before idle = ${t1Chunks.every((c) => c.at < t1IdleAt)}; text=${JSON.stringify(t1Chunks.map((c) => c.text))}`)
  evRaw('t1-timeline.json', timeline.filter((e) => e.nativeId === sid1 || e.kind === 'discovered'))

  // observed 同一性 + 工作区生效实锤：observed 扫描器看到同一 sessionId；且
  // harness 侧 projectKey 目录名 = spawn cwd 归一化编码——默认工作区路径的
  // 关键段（temp-home 令牌 + dsh-workspace）必须出现在其中（run3 同位证据 =
  // home 根编码；本批 = 安全目录编码）
  const observedSnaps = await provider.listSessions()
  const seen = observedSnaps.find((s) => s.nativeId === sid1)
  ev(`identity: observed listSessions sees sessionId=${sid1}: ${seen !== undefined}`)
  const fsSync = await import('node:fs')
  const sessionsRoot = join(cfg.resolveDshHome(), 'sessions')
  const projectDirs = existsSync(sessionsRoot) ? fsSync.readdirSync(sessionsRoot) : []
  const projectDir = projectDirs.find((d) => existsSync(join(sessionsRoot, d, sid1)))
  const wsToken = devhubHome.split(/[\\/]/).filter(Boolean).pop() // 临时 home 唯一令牌
  const workspaceEncoded = projectDir !== undefined && projectDir.includes(wsToken) && projectDir.includes('dsh-workspace')
  ev(`workspace-at-runtime: harness projectKey dir for ${sid1} = ${projectDir ?? 'NOT FOUND'} (encodes temp-home token + dsh-workspace) = ${workspaceEncoded}`)
  ev(`workspace dir present after run = ${existsSync(gate.workspacePath)} (on-demand created by the provider spawn path)`)
  evRaw('identity-observed.json', {
    sessionId: sid1,
    seenInObservedList: seen !== undefined,
    sessionsRoot,
    projectKeyDir: projectDir ?? null,
    workspacePathEncodedInProjectKey: workspaceEncoded,
    expectedWorkspace: gate.workspacePath,
    workspaceDirPresent: existsSync(gate.workspacePath),
  })
  if (seen === undefined || projectDir === undefined || !workspaceEncoded) throw new Error('observed identity/workspace evidence failed')

  // ------------------------------------------------------------------
  // R：键归 0 → legacy observed 形态 + spawn 拒绝（可撤销）
  // ------------------------------------------------------------------
  settings.setSetting(cfg.DEEPSEEK_MANAGED_ENABLED_SETTING_KEY, '0')
  const capsOff = await provider.getCapabilities({ providerId: 'deepseek', nativeId: 'probe' })
  ev(`revert: key=0 → caps mode=${capsOff.mode} granted=${capsOff.granted.length} workspaceKeyPresent=${'workspace' in capsOff}`)
  evRaw('caps-reverted.json', capsOff)
  const spawnOff = await provider.startManagedSession('should not spawn', sink)
  ev(`revert: startManagedSession refused = ${!spawnOff.ok} detail=${spawnOff.detail}`)
  const diag = provider.describeDiagnostics()
  evRaw('diagnostics.json', diag)

  const disposeAt = Date.now()
  await provider.dispose()
  ev(`wire: dispose done in ${Date.now() - disposeAt}ms`)

  ev('RUN3-FIX COMPLETE: M0 initialize latency captured (vs run3 30s timeout); 1 real prompt consumed (T1); zero credentials read/injected/logged; workspace knob = default safe dir end-to-end')
} catch (err) {
  ev('RUN3-FIX FAILED: ' + (err instanceof Error ? err.stack : String(err)))
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
console.log('[run3-fix] health×3:', JSON.stringify(healthLines.map((h) => h.health?.uptimeSec ?? h.verdict)))
