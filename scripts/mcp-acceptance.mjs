#!/usr/bin/env node
// DevHub MCP M3 真实端到端验收（docs/08 §13.2 M3-A01…A12 + 任务书 A01…A13/E01…E05）。
//
// 与 smoke（InMemoryTransport）不同：本脚本用 SDK Client + StdioClientTransport
// spawn 真实子进程 `node scripts/run-mcp.mjs`（真 stdio 链路、真多进程共享 DB），
// 对本机 %APPDATA%\devhub\devhub.db 的真实数据断言。全部只读（detect 的写库是
// DevHub 自身状态持久化，docs/08 §6.1 立场），不删除/不修改任何系统状态。
//
// 用例清单（任务书编号；括号内为 docs/08 §13.2 对应项）：
//   A01      initialize 握手 serverInfo.name==='devhub' + stderr 纪律（M3-A01/A02）
//   A01-raw  原始 stdio 探针：stdout 每行合法 JSON、非法 JSON 行→协议错误帧不退
//            出、stdin 关闭→退出码 0（M3-A01/A08/A11）
//   A02      tools/list 恰 16 个点分名，全部 READ_ONLY（annotations 或权限表声明）（M3-A03）
//   A03      resources/list 6 个；environment/dashboard Markdown 含真实数据标志（M3-A06）
//   A04…A12 environment.detect / doctor / projects.list / projects.get /
//            services.list / services.inspect / docker.* / wsl.* / git.status 真实断言
//   A12b     dashboard.summary 真实计数（M3-A04）
//   A13      多进程共享 DB：启动 Electron App 期间 MCP 读同一库无 locked（M3-A10）
//   A14      并发 5 个 tools/call 响应帧无交错损坏（M3-A09）
//   A15      DEVHUB_HOME 透传 → 隔离空库（M3-A12）
//   A16…A19 skills.list / versions.list / archives.list / docker.images 真实调用
//           （docs/09 §10 只读扩展：A16 断言 agent 投影不带 vault 外路径字段、
//            A18 断言 limit 默认 20 上限 100 与 IPC archive:history 同口径、
//            A19 断言 daemon 降级语义且绝不起引擎）
//   A20      权限表外名拒绝语义不回归（4 个新 tool READ_ONLY；变更动作名绝不注册）
//   E01…E05 异常注入流（每项后跟随一次正常调用证明 server 存活）
//
// 末尾把"环境体检"场景原始输出落盘 acceptance/mcp-scenario-report.json。
// 退出码：0 = 全绿；1 = 存在失败。

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_MCP = join(ROOT, 'scripts', 'run-mcp.mjs')
const REPORT_PATH = join(ROOT, 'acceptance', 'mcp-scenario-report.json')
const CALL_TIMEOUT_MS = 180_000

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 进程内共享的场景证据（A04/A05/A08/A10/A11 期间采集，末尾落盘）。 */
const scenario = {
  generatedAt: null,
  server: null,
  machine: { node: process.version, platform: process.platform },
  tools: {},
}

function note(msg) {
  console.log(`    ${msg}`)
}

/** 连接一个真实 stdio MCP server 子进程；stderr: 'pipe' 以捕获 server stderr。 */
async function connectMcp(extraEnv) {
  const stderrChunks = []
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [RUN_MCP],
    cwd: ROOT,
    stderr: 'pipe',
    ...(extraEnv !== undefined ? { env: { ...extraEnv } } : {}),
  })
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString()))
  const client = new Client({ name: 'devhub-mcp-acceptance', version: '1.0.0' })
  await client.connect(transport)
  return {
    client,
    transport,
    stderr: () => stderrChunks.join(''),
    close: async () => {
      await client.close()
      await transport.close?.()
    },
  }
}

/** 带超时的 tools/call（detect/doctor 全量探测可能超过 SDK 默认 60s）。 */
async function callTool(client, name, args = {}) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })
}

/** 成功调用 → 断言非 isError 并返回 structuredContent。 */
async function callOk(client, name, args = {}) {
  const result = await callTool(client, name, args)
  assert.equal(result.isError, undefined, `${name} must not be an isError result`)
  assert.ok(result.structuredContent && typeof result.structuredContent === 'object', `${name} returns structuredContent`)
  return result.structuredContent
}

/** 领域错误调用 → isError:true + { code, message } 结构化帧。 */
async function callErr(client, name, args = {}) {
  const result = await callTool(client, name, args)
  assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must be an isError result`)
  const frame = JSON.parse(result.content[0].text)
  assert.equal(typeof frame.code, 'string', 'error frame carries stable code')
  assert.equal(typeof frame.message, 'string', 'error frame carries message')
  return frame
}

/** server 存活证明：任意正常 tool 在异常注入后仍成功。 */
async function liveness(client, tag) {
  const data = await callOk(client, 'devhub.dashboard.summary')
  assert.equal(typeof data.projectCount, 'number', `server alive after ${tag}`)
  return data
}

/** 实时 netstat -ano：当前 LISTENING 的 TCP 端口集合（真机只读探测）。 */
async function liveListeningPorts() {
  const ports = new Set()
  await new Promise((resolveProbe) => {
    const child = spawn('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => {
      out += c.toString()
    })
    child.on('error', () => resolveProbe())
    child.on('close', () => {
      for (const line of out.split('\n')) {
        if (!/\bLISTENING\b/.test(line)) continue
        const local = line.trim().split(/\s+/)[1] ?? ''
        const idx = local.lastIndexOf(':')
        if (idx > 0) ports.add(Number.parseInt(local.slice(idx + 1), 10))
      }
      resolveProbe()
    })
  })
  return ports
}

// ---------------------------------------------------------------------------
// 用例注册与执行
// ---------------------------------------------------------------------------

/** @type {{ id: string, name: string, fn: (ctx: any) => Promise<void> }[]} */
const cases = []
function registerCase(id, name, fn) {
  cases.push({ id, name, fn })
}

// 共享上下文：主 client（贯穿正常流 + 异常注入流，证明长会话稳定）。
const ctx = {}

registerCase('A01', 'initialize 握手 serverInfo.name==="devhub" + stderr 纪律（日志镜像不在 stdout）', async () => {
  const mcp = await connectMcp()
  ctx.mcp = mcp
  const version = mcp.client.getServerVersion()
  assert.ok(version, 'initialize handshake returned serverInfo')
  assert.equal(version.name, 'devhub', `serverInfo.name, got ${JSON.stringify(version)}`)
  assert.equal(version.version, '0.1.0', `serverInfo.version, got ${JSON.stringify(version)}`)

  const err = mcp.stderr()
  assert.ok(err.includes('DevHub MCP server ready'), `ready banner on stderr, got: ${JSON.stringify(err.slice(-300))}`)
  // stderr 纪律：协议帧只允许出现在 stdout —— stderr 不得出现任何 jsonrpc 帧
  for (const line of err.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed = null
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    assert.ok(!parsed || parsed.jsonrpc !== '2.0', `stderr must not carry JSON-RPC frames, got: ${trimmed.slice(0, 200)}`)
  }
  scenario.server = version
})

registerCase('A01-raw', '原始 stdio 探针：stdout 全部为合法 JSON-RPC 行；非法 JSON 行→协议错误帧且进程不退出；stdin 关闭→退出码 0（M3-A01/A08/A11）', async () => {
  const child = spawn(process.execPath, [RUN_MCP], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const stdoutLines = []
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    if (line.trim().length > 0) stdoutLines.push(line)
  })
  let stderrText = ''
  child.stderr.on('data', (c) => {
    stderrText += c.toString()
  })

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'devhub-acceptance-raw', version: '1.0.0' } } })
  const initResponse = await new Promise((resolveInit, rejectInit) => {
    const timer = setTimeout(() => rejectInit(new Error('timeout waiting for initialize response')), 30_000)
    rl.on('line', function onLine(line) {
      let frame = null
      try {
        frame = JSON.parse(line)
      } catch {
        return // A01 的"stdout 每行合法 JSON"断言在收尾统一做
      }
      if (frame.id === 1) {
        rl.off('line', onLine)
        clearTimeout(timer)
        resolveInit(frame)
      }
    })
  })
  assert.equal(initResponse.result?.serverInfo?.name, 'devhub', 'raw initialize response serverInfo.name')

  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  // M3-A08：非法 JSON 行 → 协议级错误帧，进程不退出
  child.stdin.write('this is not json at all\n')
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const listResponse = await new Promise((resolveList, rejectList) => {
    const timer = setTimeout(() => rejectList(new Error('timeout waiting for tools/list after invalid JSON line')), 30_000)
    rl.on('line', function onLine(line) {
      let frame = null
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (frame.id === 2) {
        rl.off('line', onLine)
        clearTimeout(timer)
        resolveList(frame)
      }
    })
  })
  assert.equal(Array.isArray(listResponse.result?.tools), true, 'server still answers tools/list after an invalid JSON line')
  assert.equal(listResponse.result.tools.length, 16, 'tools/list answers with the full 16-tool registry (process alive)')

  // 优雅退出：stdin 关闭 → 退出码 0（M3-A11）
  const exitCode = await new Promise((resolveExit) => {
    child.stdin.end()
    child.on('exit', (code) => resolveExit(code))
  })
  // stdout 纪律（M3-A01）：会话期间每一行 stdout 都必须是可解析 JSON
  for (const line of stdoutLines) {
    let parsed = null
    try {
      parsed = JSON.parse(line)
    } catch {
      assert.fail(`stdout discipline violated, non-JSON line: ${line.slice(0, 200)}`)
    }
    assert.ok(parsed && typeof parsed === 'object', 'stdout line parses to a frame object')
  }
  assert.ok(stderrText.includes('DevHub MCP server ready'), 'ready banner observed on stderr')
  assert.equal(exitCode, 0, `graceful exit code after stdin close, got ${exitCode}`)
})

registerCase('A02', 'tools/list 恰 16 个点分名，全部 READ_ONLY（annotations 或权限表声明）；有参 tool 严格 schema', async () => {
  const tools = await ctx.mcp.client.listTools()
  assert.equal(tools.tools.length, 16, `exactly 16 tools, got ${tools.tools.length}`)
  const names = tools.tools.map((t) => t.name)
  for (const name of names) {
    assert.match(name, /^devhub\.[a-z]+\.[a-zA-Z]+$/, `dotted name: ${name}`)
  }
  assert.equal(new Set(names).size, 16, 'no duplicate tool names')

  // 只读标注：优先 annotations.readOnlyHint；否则核对 server 权限分类表声明
  const permissions = await import(pathToFileURL(join(ROOT, 'src/main/mcp/permissions.ts')).href)
  const table = permissions.TOOL_PERMISSIONS
  for (const tool of tools.tools) {
    const annotated = tool.annotations?.readOnlyHint === true
    const declared = table[tool.name] === 'READ_ONLY'
    assert.ok(
      annotated || declared,
      `${tool.name} must be declared read-only (annotations.readOnlyHint or TOOL_PERMISSIONS READ_ONLY)`,
    )
    assert.equal(typeof tool.description, 'string', `description present for ${tool.name}`)
  }
  assert.deepEqual(
    Object.keys(table).sort(),
    [...names].sort(),
    'permission table covers exactly the advertised tools (no registry drift)',
  )

  // 有参 tool：strict zod → JSON Schema additionalProperties:false（拒绝未知键）
  const argTools = tools.tools.filter((t) => Object.keys(t.inputSchema?.properties ?? {}).length > 0)
  assert.ok(argTools.length >= 4, `argument tools present (projects.get/services.list/services.inspect/git.status), got ${argTools.length}`)
  for (const tool of argTools) {
    assert.equal(tool.inputSchema.type, 'object', `inputSchema object for ${tool.name}`)
    assert.equal(tool.inputSchema.additionalProperties, false, `strict schema rejects unknown keys for ${tool.name}`)
  }
  note(`12 dotted tools, all READ_ONLY; arg tools: ${argTools.map((t) => t.name).join(', ')}`)
})

registerCase('A03', 'resources/list 恰 6 个；devhub://environment 与 devhub://dashboard 含真实数据标志', async () => {
  const resources = await ctx.mcp.client.listResources()
  const uris = resources.resources.map((r) => r.uri).sort()
  assert.deepEqual(uris, [
    'devhub://dashboard',
    'devhub://docker',
    'devhub://environment',
    'devhub://projects',
    'devhub://services',
    'devhub://wsl',
  ], 'exactly the 6 stable URIs')

  const environment = await ctx.mcp.client.readResource({ uri: 'devhub://environment' })
  const envText = environment.contents[0].text
  assert.ok(envText.includes('24.15'), `environment markdown carries the real node version from the detect snapshot`)
  assert.ok(/\[WARNING\]/.test(envText), `environment markdown carries at least one [WARNING] doctor line`)
  assert.ok(envText.includes('Windows'), 'environment markdown carries the Windows section')
  assert.ok(/Docker: daemon unreachable|Docker daemon available/.test(envText), 'docker status line present')

  const dashboard = await ctx.mcp.client.readResource({ uri: 'devhub://dashboard' })
  const dashText = dashboard.contents[0].text
  assert.ok(dashText.includes('# DevHub dashboard'), 'dashboard markdown title')
  assert.ok(/\[WARNING\]|warning/i.test(dashText), 'dashboard markdown carries warning lines')
  assert.ok(/projects/.test(dashText), 'dashboard counters section present')
  note(`environment ${envText.length} chars / dashboard ${dashText.length} chars, both with real data markers`)
})

registerCase('A04', 'environment.detect：windows 工具 ≥5、python 双条目、Ubuntu 环境存在', async () => {
  const result = await callTool(ctx.mcp.client, 'devhub.environment.detect')
  assert.equal(result.isError, undefined, 'detect is not an error')
  const data = result.structuredContent
  assert.ok(Array.isArray(data.environments) && data.environments.length >= 2, `environments probed, got ${JSON.stringify(data.environments?.map((e) => e.name))}`)

  const windows = data.environments.find((e) => e.name === 'windows')
  assert.ok(windows, 'windows environment present')
  assert.ok(windows.tools.length >= 5, `windows tools >= 5, got ${windows.tools.length}`)
  const pythons = windows.tools.filter((t) => t.tool === 'python' && t.state === 'installed')
  assert.ok(pythons.length >= 2, `dual python entries (3.9/3.13), got ${JSON.stringify(pythons.map((p) => p.version))}`)
  assert.equal(new Set(pythons.map((t) => t.path)).size, pythons.length, 'python entries distinguished by path')
  assert.ok(data.environments.some((e) => e.name === 'wsl:Ubuntu'), 'wsl:Ubuntu environment present')

  scenario.tools['devhub.environment.detect'] = { structuredContent: data, summaryText: result.content[0].text }
  note(`environments: ${data.environments.map((e) => `${e.name}(${e.tools.length} tools)`).join(', ')}`)
})

registerCase('A05', 'environment.doctor：≥2 warning，真实基线（python PATH 顺序、node 24 vs 18、docker daemon）', async () => {
  const result = await callTool(ctx.mcp.client, 'devhub.environment.doctor')
  assert.equal(result.isError, undefined, 'doctor is not an error')
  const data = result.structuredContent
  assert.ok(Array.isArray(data.checks), 'checks array present')
  for (const check of data.checks) {
    assert.ok(['info', 'warning', 'error'].includes(check.severity), `severity enum: ${check.severity}`)
    assert.equal(typeof check.title, 'string', 'check title present')
  }
  const warnings = data.checks.filter((c) => c.severity === 'warning' || c.severity === 'error')
  assert.ok(warnings.length >= 2, `>=2 warnings on this machine, got ${JSON.stringify(data.checks.map((c) => c.id))}`)

  const ids = new Set(data.checks.map((c) => c.id))
  assert.ok(ids.has('windows-python-path-order'), 'real baseline: PATH-first Python order warning')
  assert.ok([...ids].some((id) => id.startsWith('version-mismatch:node:')), 'real baseline: node major version mismatch Windows vs WSL')
  assert.ok(ids.has('docker-daemon-unreachable'), 'real baseline: docker daemon unreachable warning')

  scenario.tools['devhub.environment.doctor'] = { structuredContent: data, summaryText: result.content[0].text }
  note(`checks: ${data.checks.map((c) => `[${c.severity}] ${c.id}`).join(', ')}`)
})

registerCase('A06', 'projects.list：≥3 项目且字段齐全（win/wsl path、git 摘要、docker 计数、environment 边或 null）', async () => {
  const data = await callOk(ctx.mcp.client, 'devhub.projects.list')
  assert.ok(Array.isArray(data.projects) && data.projects.length >= 3, `>=3 projects, got ${data.projects?.length}`)
  assert.equal(data.count, data.projects.length, 'count field agrees')
  for (const p of data.projects) {
    assert.equal(typeof p.id, 'number', `id: ${JSON.stringify(p)}`)
    assert.equal(typeof p.name, 'string', `name: ${p.name}`)
    assert.equal(typeof p.slug, 'string', `slug: ${p.slug}`)
    assert.equal(typeof p.git?.hasGit, 'boolean', `git.hasGit: ${p.name}`)
    assert.equal(typeof p.git?.dirtyCount, 'number', `git.dirtyCount: ${p.name}`)
    assert.equal(typeof p.docker?.containersTotal, 'number', `docker.containersTotal: ${p.name}`)
    assert.equal(typeof p.docker?.containersRunning, 'number', `docker.containersRunning: ${p.name}`)
    assert.ok(p.environment === null || (typeof p.environment === 'object' && typeof p.environment.name === 'string'), `environment edge or null: ${p.name}`)
    assert.equal(typeof p.updatedAt, 'number', `updatedAt: ${p.name}`)
  }
  const devhub = data.projects.find((p) => p.name === 'DevHub')
  assert.ok(devhub, 'DevHub project tracked')
  assert.equal(devhub.winPath, 'F:\\Active_Project\\DevHub', `winPath, got ${JSON.stringify(devhub.winPath)}`)
  assert.equal(devhub.wslPath, '/mnt/f/Active_Project/DevHub', `wslPath, got ${JSON.stringify(devhub.wslPath)}`)
  ctx.projects = data.projects
  note(`projects: ${data.projects.map((p) => p.name).join(', ')}`)
})

registerCase('A07', 'projects.get：真实项目 win/wsl path、repositories 区块、三 notAvailable 占位、relationships', async () => {
  const target = ctx.projects.find((p) => p.name === 'DevHub') ?? ctx.projects[0]
  const data = await callOk(ctx.mcp.client, 'devhub.projects.get', { projectId: target.id })
  assert.equal(data.id, target.id, 'detail id echoes')
  assert.equal(data.winPath, target.winPath, 'winPath present')
  assert.equal(data.wslPath, target.wslPath, 'wslPath present')
  assert.ok(Array.isArray(data.repositories), 'repositories (git) block present')
  for (const repo of data.repositories) {
    assert.equal(typeof repo.branch === 'string' || repo.branch === undefined, true, 'repository branch field')
  }
  for (const key of ['skills', 'mcpServers', 'archives']) {
    assert.deepEqual(data[key], { notAvailable: true, reason: 'TABLE_EXISTS_NO_SERVICE' }, `${key} explicit notAvailable placeholder (no fabrication)`)
  }
  assert.ok(Array.isArray(data.relationships), 'relationships edge list present')
  for (const edge of data.relationships) {
    assert.equal(typeof edge.relation, 'string', 'edge relation field')
    assert.ok(['outgoing', 'incoming'].includes(edge.direction), 'edge direction field')
  }
  assert.ok(Array.isArray(data.services) && Array.isArray(data.environments), 'services/environments blocks present')
  note(`project ${data.name}: repos=${data.repositories.length} services=${data.services.length} relationships=${data.relationships.length}`)
})

registerCase('A08', 'services.list：≥1 条，project 字段恒存在；归因不到显式 "unknown"，绝不猜测', async () => {
  const result = await callTool(ctx.mcp.client, 'devhub.services.list')
  assert.equal(result.isError, undefined, 'services.list is not an error')
  const data = result.structuredContent
  assert.ok(Array.isArray(data.services) && data.services.length >= 1, `>=1 snapshot rows, got ${data.services?.length}`)
  for (const row of data.services) {
    assert.ok(Number.isInteger(row.port) && row.port >= 0 && row.port <= 65535, `port valid: ${row.port}`)
    assert.ok(['windows', 'wsl', 'docker'].includes(row.origin), `origin enum: ${row.origin}`)
    assert.equal(typeof row.project, 'string', `project literal always present (row ${row.port})`)
    if (row.projectId === undefined) {
      assert.equal(row.project, 'unknown', `unattributed row ${row.port} must be explicitly "unknown"`)
    } else {
      assert.ok(row.project.length > 0 && row.project !== 'unknown', `attributed row ${row.port} carries its project name`)
    }
  }
  scenario.tools['devhub.services.list'] = {
    structuredContent: { services: data.services.slice(0, 20), count: data.count, note: 'services truncated to the first 20 rows per the M3 scenario-report spec' },
    summaryText: result.content[0].text,
    _fullServices: data.services,
  }
  ctx.services = data.services
  note(`${data.count} rows in the last snapshot; sample: :${data.services[0].port} ${data.services[0].processName ?? '?'} → project ${data.services[0].project}`)
})

registerCase('A09', 'services.inspect：真实 LISTENING 端口归因链完整；无人监听端口 1 → 显式 unknown/not found 不崩', async () => {
  // 真实监听端口：DB 快照行 ∩ 实时 netstat LISTENING
  const listening = await liveListeningPorts()
  assert.ok(listening.size >= 1, 'live netstat probe sees at least one LISTENING port')
  const dbPorts = [...new Set(ctx.services.map((r) => r.port))]
  const livePort = dbPorts.find((port) => listening.has(port))
  assert.ok(livePort !== undefined, `DB snapshot ports intersect live LISTENING set (db: ${dbPorts.slice(0, 8).join(',')})`)

  const data = await callOk(ctx.mcp.client, 'devhub.services.inspect', { port: livePort })
  assert.equal(data.port, livePort, 'echoed port')
  assert.equal(data.attributionChain, 'port→pid→process→origin→project', 'attribution chain description fixed')
  assert.ok(data.entries.length >= 1, `entries for live port ${livePort}`)
  for (const entry of data.entries) {
    assert.equal(typeof entry.project, 'string', 'entry project literal')
  }
  assert.equal(typeof data.snapshotAt, 'number', 'snapshotAt from max(lastSeenAt)')
  assert.equal(typeof data.resolvedProject, 'string', 'resolvedProject literal present')
  note(`live port ${livePort} → ${data.entries.length} entry(s), resolvedProject=${data.resolvedProject}`)

  // 无人监听且无快照记录的端口 → 显式 unknown + note，不是错误
  const empty = await callOk(ctx.mcp.client, 'devhub.services.inspect', { port: 1 })
  assert.equal(empty.entries.length, 0, 'port 1 has no snapshot record')
  assert.equal(empty.note, 'no record in last services snapshot', 'freshness note present')
  assert.equal(empty.resolvedProject, 'unknown', 'resolvedProject explicit unknown (never guessed)')
  ctx.livePort = livePort
})

registerCase('A10', 'docker.status + docker.containers：daemon 不可用 → available:false + reason + containers:[]，isError 恒为 false', async () => {
  const status = await callTool(ctx.mcp.client, 'devhub.docker.status')
  assert.equal(status.isError, undefined, 'docker.status is never an error (degradation is a normal condition)')
  const statusData = status.structuredContent
  assert.equal(typeof statusData.available, 'boolean', 'available boolean')
  assert.equal(statusData.available, statusData.cliAvailable === true && statusData.daemonAvailable === true, 'available = cli && daemon')
  assert.deepEqual(statusData.containers, [], 'status carries the empty containers placeholder')

  const containers = await callTool(ctx.mcp.client, 'devhub.docker.containers')
  assert.equal(containers.isError, undefined, 'docker.containers is never an error')
  const containerData = containers.structuredContent
  if (statusData.available === false) {
    assert.equal(containerData.available, false, 'degraded availability mirrors status')
    assert.ok(typeof containerData.reason === 'string' && containerData.reason.length > 0, `degradation reason present, got ${JSON.stringify(containerData)}`)
    assert.deepEqual(containerData.containers, [], 'degraded container list empty')
    note(`degraded as expected: ${containerData.reason}`)
  } else {
    assert.equal(containerData.available, true, 'available branch agrees with status')
    assert.ok(Array.isArray(containerData.containers), 'live container list array')
    for (const container of containerData.containers) {
      assert.equal(typeof container.project, 'string', 'attribution literal per container')
      assert.ok(Array.isArray(container.ports), 'ports array per container')
    }
    note(`daemon available: ${containerData.containers.length} container(s)`)
  }
  scenario.tools['devhub.docker.status'] = { structuredContent: statusData, summaryText: status.content[0].text }
})

registerCase('A11', 'wsl.status + wsl.distributions：Ubuntu 与 docker-desktop 在列；探测不到的字段显式 null（D2 分层）', async () => {
  const status = await callTool(ctx.mcp.client, 'devhub.wsl.status')
  assert.equal(status.isError, undefined, 'wsl.status is never an error')
  const statusData = status.structuredContent
  assert.equal(typeof statusData.available, 'boolean', 'available boolean')
  assert.ok(Array.isArray(statusData.distros), 'distros array')
  assert.equal(statusData.available, true, `WSL available on this machine, got ${JSON.stringify(statusData)}`)
  assert.ok(statusData.distros.includes('Ubuntu'), `Ubuntu in distros, got ${JSON.stringify(statusData.distros)}`)
  assert.ok(statusData.distros.includes('docker-desktop'), `docker-desktop in distros, got ${JSON.stringify(statusData.distros)}`)

  const distros = await callTool(ctx.mcp.client, 'devhub.wsl.distributions')
  assert.equal(distros.isError, undefined, 'wsl.distributions is never an error')
  const data = distros.structuredContent
  assert.equal(data.available, true, 'distributions availability mirrors status')
  assert.equal(data.toolSnapshot, 'available', 'A04 detect already built the tool snapshot')
  const byName = new Map(data.distributions.map((d) => [d.name, d]))
  const ubuntu = byName.get('Ubuntu')
  assert.ok(ubuntu, 'Ubuntu distribution row')
  assert.equal(ubuntu.version, '2', 'Ubuntu WSL2')
  assert.ok(Array.isArray(ubuntu.tools) && ubuntu.tools.length >= 1, 'Ubuntu carries the DB tool snapshot (detect ran in A04)')
  assert.equal(typeof ubuntu.snapshotAt, 'number', 'Ubuntu snapshotAt from environments.detected_at')
  const dockerDesktop = byName.get('docker-desktop')
  assert.ok(dockerDesktop, 'docker-desktop distribution row (listed live, excluded from detect)')
  assert.equal(dockerDesktop.tools, null, 'docker-desktop tools explicit null — no snapshot, never guessed')
  assert.equal(dockerDesktop.snapshotAt, null, 'docker-desktop snapshotAt explicit null')
  for (const distro of data.distributions) {
    const paired = (distro.tools === null) === (distro.snapshotAt === null)
    assert.ok(paired, `tools/snapshotAt null-ness paired for ${distro.name}`)
    assert.ok(typeof distro.state === 'string' && distro.state.length > 0, `live state for ${distro.name}`)
  }
  scenario.tools['devhub.wsl.status'] = { structuredContent: statusData, summaryText: status.content[0].text }
  note(`distros: ${data.distributions.map((d) => `${d.name}(v${d.version},${d.state}${d.tools ? ',snapshot' : ',no-snapshot'})`).join(', ')}`)
})

registerCase('A12', 'git.status：真实项目 DevHub → 真实仓库结构化返回（branch=main、工作树干净），不崩（2026-09-04 用户令 git init 后就地更新：原断言 notAGitRepository:true 的前提"主仓非 git 仓库"已被推翻）', async () => {
  const devhub = ctx.projects.find((p) => p.name === 'DevHub')
  const data = await callOk(ctx.mcp.client, 'devhub.git.status', { projectId: devhub.id })
  assert.equal(data.projectId, devhub.id, 'echoed projectId')
  assert.equal(data.project, 'DevHub', 'project name projected')
  assert.equal(data.path, devhub.winPath, 'probed path is the project winPath (whitelist default)')
  assert.notEqual(data.notAGitRepository, true, `DevHub is now a git repository (git init 2026-09-04), got ${JSON.stringify(data)}`)
  assert.equal(data.repository?.branch, 'main', 'main branch after init (projection nests repo info under repository)')
  assert.deepEqual(data.workingTree, { clean: true, modifiedCount: 0, untrackedCount: 0 }, 'clean working tree (验收跑在干净工作树上)')
  assert.equal(typeof data.checkedAt, 'number', 'checkedAt stamped')
  note(`DevHub at ${data.path} → git repo on ${data.branch}, tree clean`)
})

registerCase('A12b', 'dashboard.summary：projectCount===3、warnings≥1（与 UI Dashboard 同源口径，M3-A04）', async () => {
  const data = await callOk(ctx.mcp.client, 'devhub.dashboard.summary')
  assert.equal(data.projectCount, 3, `projectCount === 3 on this machine, got ${data.projectCount}`)
  assert.ok(Array.isArray(data.warnings) && data.warnings.length >= 1, `>=1 dashboard warning, got ${JSON.stringify(data.warnings)}`)
  assert.ok(data.dockerTotal >= data.dockerRunning, 'docker totals sane')
  assert.equal(typeof data.wslStatus?.available, 'boolean', 'wslStatus object embedded')
  assert.ok(Array.isArray(data.recentProjects) && data.recentProjects.length >= 1, 'recentProjects present')
  ctx.dashboard = data
  note(`projects=${data.projectCount} dirty=${data.dirtyRepoCount} docker=${data.dockerRunning}/${data.dockerTotal} warnings=${data.warnings.length}`)
})

// ---------------------------------------------------------------------------
// 异常注入流（E01…E05）：每项后必须再发一个正常调用证明 server 仍活着
// ---------------------------------------------------------------------------

registerCase('E01', 'invalid projectId（999999）→ isError 结构化 NOT_FOUND，server 存活', async () => {
  const frame = await callErr(ctx.mcp.client, 'devhub.projects.get', { projectId: 999999 })
  assert.equal(frame.code, 'NOT_FOUND', `code, got ${JSON.stringify(frame)}`)
  await liveness(ctx.mcp.client, 'E01')
})

registerCase('E02', 'git.status 白名单外路径（C:\\Windows\\System32）→ 结构化 BAD_PAYLOAD 拒绝，不探测该路径', async () => {
  const frame = await callErr(ctx.mcp.client, 'devhub.git.status', { projectId: 1, path: 'C:\\Windows\\System32' })
  assert.equal(frame.code, 'BAD_PAYLOAD', `code, got ${JSON.stringify(frame)}`)
  assert.ok(!frame.message.includes('System32'), 'refusal message must not echo/probe the foreign path')
  await liveness(ctx.mcp.client, 'E02')
})

registerCase('E03', 'services.inspect 未知端口 → 显式 unknown（不猜测、不崩）', async () => {
  const data = await callOk(ctx.mcp.client, 'devhub.services.inspect', { port: 64123 })
  assert.equal(data.entries.length, 0, 'no entries for the unheard port')
  assert.equal(data.resolvedProject, 'unknown', 'resolvedProject explicit unknown')
  assert.equal(data.note, 'no record in last services snapshot', 'freshness note present')
  await liveness(ctx.mcp.client, 'E03')
})

registerCase('E04', 'tools/call 不存在的工具名 → SDK 层错误（协议错误帧被 SDK 折叠为 isError），server 存活', async () => {
  // SDK 1.30 实测行为：server 侧 McpError(-32602, "Tool ... not found") 协议错误帧
  // 会被 client.callTool 折叠为 isError:true 的 CallToolResult（文本携带原始错误）。
  const result = await callTool(ctx.mcp.client, 'devhub.no.such.tool')
  assert.equal(result.isError, true, `unknown tool must surface as an error result, got ${JSON.stringify(result).slice(0, 200)}`)
  assert.match(result.content[0].text, /not found/i, 'error text carries the protocol-level not-found message')
  await liveness(ctx.mcp.client, 'E04')
})

registerCase('E05', 'docker daemon 不可用（真实状态）→ 连续两次调用均结构化降级、均非 isError', async () => {
  const first = await callTool(ctx.mcp.client, 'devhub.docker.status')
  const second = await callTool(ctx.mcp.client, 'devhub.docker.status')
  assert.equal(first.isError, undefined, 'first docker.status not an error')
  assert.equal(second.isError, undefined, 'second docker.status not an error')
  assert.equal(first.structuredContent.available, second.structuredContent.available, 'consecutive calls agree on availability')
  if (first.structuredContent.available === false) {
    assert.ok(first.structuredContent.reason, 'degradation carries reason (call 1)')
    assert.ok(second.structuredContent.reason, 'degradation carries reason (call 2)')
    note(`degraded twice in a row: ${first.structuredContent.reason}`)
  } else {
    note('daemon came up between runs; both calls report available:true (real state, no hardcoding)')
  }
  await liveness(ctx.mcp.client, 'E05')
})

// ---------------------------------------------------------------------------
// 多进程共享 DB（M3-A10）：Electron App 运行期间 MCP 读同一库
// ---------------------------------------------------------------------------

function tasklistPids(imageName) {
  return new Promise((resolvePids) => {
    const child = spawn('tasklist.exe', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${imageName}`], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => {
      out += c.toString()
    })
    child.on('error', () => resolvePids(new Set()))
    child.on('close', () => {
      const pids = new Set()
      for (const line of out.split('\n')) {
        const m = line.match(/^"([^"]*)","(\d+)"/)
        if (m && m[1].toLowerCase() === imageName.toLowerCase()) pids.add(Number(m[2]))
      }
      resolvePids(pids)
    })
  })
}

function killTree(pid, force) {
  return new Promise((resolveKill) => {
    const args = ['/PID', String(pid), '/T']
    if (force) args.push('/F')
    const child = spawn('taskkill.exe', args, { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => {
      out += c.toString()
    })
    child.stderr.on('data', (c) => {
      out += c.toString()
    })
    child.on('error', (err) => resolveKill(out + String(err)))
    child.on('close', () => resolveKill(out))
  })
}

/** 只对单个窗口进程投递 WM_CLOSE（不带 /T /F）；/T 优雅模式会被无窗口子进程拖垮整棵树。 */
function postClose(pid) {
  return new Promise((resolveKill) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid)], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => {
      out += c.toString()
    })
    child.stderr.on('data', (c) => {
      out += c.toString()
    })
    child.on('error', (err) => resolveKill(out + String(err)))
    child.on('close', () => resolveKill(out))
  })
}

registerCase('A13', '多进程共享 DB：后台启动 Electron App → 期间 MCP projects.list/dashboard.summary 数据一致、无 database locked → 优雅关闭并确认进程清理（M3-A10）', async () => {
  const baseline = await callOk(ctx.mcp.client, 'devhub.dashboard.summary')

  const electronBefore = await tasklistPids('electron.exe')
  const app = spawn('cmd.exe', ['/d', '/s', '/c', 'npm run dev'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let appOut = ''
  app.stdout.on('data', (c) => {
    appOut += c.toString()
  })
  app.stderr.on('data', (c) => {
    appOut += c.toString()
  })

  // 等窗口就绪：electron-vite dev 服务器就绪行 + DevHub electron.exe 进程出现 + 5s 沉降
  const deadline = Date.now() + 120_000
  let electronNow = new Set()
  try {
    for (;;) {
      if (Date.now() > deadline) throw new Error(`app did not become ready in time; output tail: ${JSON.stringify(appOut.slice(-500))}`)
      if (/ready in|built in|Local:/i.test(appOut)) {
        electronNow = await tasklistPids('electron.exe')
        const spawned = [...electronNow].filter((pid) => !electronBefore.has(pid))
        if (spawned.length > 0) {
          note(`dev server up; electron pid(s): ${spawned.join(', ')}`)
          break
        }
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    await new Promise((r) => setTimeout(r, 5000))

    // App 运行期间：MCP 读同一 %APPDATA%\devhub\devhub.db
    const duringProjects = await callOk(ctx.mcp.client, 'devhub.projects.list')
    const duringDash = await callOk(ctx.mcp.client, 'devhub.dashboard.summary')
    assert.equal(duringDash.projectCount, baseline.projectCount, `projectCount consistent across processes (${duringDash.projectCount} vs ${baseline.projectCount})`)
    assert.equal(duringProjects.count, baseline.projectCount, 'projects.list count consistent with the App-run database')
    assert.equal(duringProjects.projects.length, baseline.projectCount, 'no empty database opened by the MCP process')

    const combinedErr = ctx.mcp.stderr()
    assert.ok(!/database is locked|SQLITE_BUSY/i.test(combinedErr + appOut), 'no database locked / SQLITE_BUSY errors during concurrent access')
    note(`shared DB during app run: projects=${duringDash.projectCount}, warnings=${duringDash.warnings.length}, no lock errors`)
  } finally {
    // 优雅关闭：对 DevHub electron 主进程（窗口属主）单独投递 WM_CLOSE（不带 /T /F），
    // window-all-closed → app.quit() 优雅收尾；40s 等退出，超时升级强制树杀；确认进程清理
    if (app.pid !== undefined && app.exitCode === null) {
      const electronPids = [...electronNow].filter((pid) => !electronBefore.has(pid))
      if (electronPids.length > 0) {
        const out = await postClose(electronPids[0])
        note(`graceful WM_CLOSE → electron pid ${electronPids[0]}: ${out.split('\n').map((l) => l.trim()).filter(Boolean).join(' | ') || '(no output)'}`)
      }
      const gracefulDeadline = Date.now() + 40_000
      while (Date.now() < gracefulDeadline && app.exitCode === null) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (app.exitCode === null) {
        note('graceful close timed out; escalating to forceful tree kill')
        await killTree(app.pid, true)
      }
    }
    await new Promise((resolveExit) => {
      if (app.exitCode !== null) resolveExit()
      else app.on('exit', resolveExit)
    })
    const electronAfter = await tasklistPids('electron.exe')
    const leaked = [...electronNow].filter((pid) => electronAfter.has(pid))
    assert.equal(leaked.length, 0, `DevHub electron processes cleaned up, leaked: ${leaked.join(', ')}`)
    note(`app closed (exit code ${app.exitCode}); no DevHub electron processes remain`)
  }

  // App 关闭后 MCP 仍正常（连接未被殃及）
  const after = await callOk(ctx.mcp.client, 'devhub.dashboard.summary')
  assert.equal(after.projectCount, baseline.projectCount, 'MCP still serves consistent data after app shutdown')
})

registerCase('A14', '并发 5 个 tools/call：响应帧无交错损坏（逐行完整 JSON，M3-A09）', async () => {
  const results = await Promise.all([
    callTool(ctx.mcp.client, 'devhub.dashboard.summary'),
    callTool(ctx.mcp.client, 'devhub.projects.list'),
    callTool(ctx.mcp.client, 'devhub.services.inspect', { port: ctx.livePort }),
    callTool(ctx.mcp.client, 'devhub.wsl.status'),
    callTool(ctx.mcp.client, 'devhub.dashboard.summary'),
  ])
  for (const [i, result] of results.entries()) {
    assert.equal(result.isError, undefined, `concurrent call ${i} succeeded`)
    assert.ok(result.structuredContent && typeof result.structuredContent === 'object', `concurrent call ${i} returns a complete structured payload`)
  }
  assert.equal(results[0].structuredContent.projectCount, results[4].structuredContent.projectCount, 'duplicate calls agree')
  note('5 concurrent calls over one stdio connection: all frames complete and consistent')
})

registerCase('A15', 'DEVHUB_HOME 透传：设置后 MCP 打开隔离库（便携模式路径生效，M3-A12）', async () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'devhub-mcp-acceptance-'))
  const mcp = await connectMcp({ ...process.env, DEVHUB_HOME: isolatedHome })
  try {
    const data = await callOk(mcp.client, 'devhub.projects.list')
    assert.equal(data.count, 0, `isolated home opens an empty (fresh) database, got ${data.count}`)
    const dash = await callOk(mcp.client, 'devhub.dashboard.summary')
    assert.equal(dash.projectCount, 0, 'dashboard reads the same isolated empty database')
    assert.ok(mcp.stderr().includes('DevHub MCP server ready'), 'isolated server started cleanly')
    note(`isolated home ${isolatedHome} → 0 projects (real shared DB untouched)`)
  } finally {
    await mcp.close()
  }
})

registerCase('A16', 'skills.list：库内镜像 + agents 链接态五态汇总；agent 投影刻意不带 vault 外本机路径字段（skillsDir/agentsDir/agentFiles 不外泄），limit 语义正确', async () => {
  const data = await callOk(ctx.mcp.client, 'devhub.skills.list')
  assert.ok(Array.isArray(data.skills), 'skills array present')
  assert.equal(data.count, data.skills.length, 'count reflects the full mirror (no limit passed)')
  for (const s of data.skills) {
    assert.equal(typeof s.name, 'string', `skill name present: ${JSON.stringify(s).slice(0, 120)}`)
    assert.equal(typeof s.description, 'string', 'description literal (possibly empty)')
    if (s.vaultRelPath !== undefined) assert.match(s.vaultRelPath, /^skills\//, `vault reference stays vault-relative: ${s.vaultRelPath}`)
  }
  assert.ok(Array.isArray(data.agents), 'agents array present')
  for (const a of data.agents) {
    assert.ok(['windows', 'linux'].includes(a.platform), `agent platform enum: ${a.name}`)
    assert.equal(typeof a.enabled, 'boolean', `agent enabled boolean: ${a.name}`)
    assert.equal(typeof a.available, 'boolean', `agent availability literal: ${a.name}`)
    assert.ok(['windows', 'companion-cache', 'none'].includes(a.probe), `probe provenance enum: ${a.name}`)
    const c = a.counts
    for (const key of ['linked', 'missing', 'wrongTarget', 'realDir', 'vaultMissing']) {
      assert.equal(typeof c[key], 'number', `five-state count ${key} for ${a.name}`)
    }
    assert.equal(a.skillsDir, undefined, `agent ${a.name}: skillsDir not projected (out-of-vault path discipline)`)
    assert.equal(a.agentsDir, undefined, `agent ${a.name}: agentsDir not projected`)
    assert.equal(a.agentFiles, undefined, `agent ${a.name}: file listings not projected`)
  }
  const limited = await callOk(ctx.mcp.client, 'devhub.skills.list', { limit: 1 })
  assert.ok(limited.skills.length <= 1, 'limit caps the returned skills array')
  assert.equal(limited.count, data.count, 'count keeps the full-mirror semantics under limit')
  note(`${data.count} skill(s), ${data.agents.length} agent(s) projected without local paths`)
})

registerCase('A17', 'versions.list：目录 8 目标 + version_targets 快照合并（never live-check；未检测 = unknown + lastCheckedAt null）', async () => {
  const data = await callOk(ctx.mcp.client, 'devhub.versions.list')
  assert.ok(Array.isArray(data.targets) && data.targets.length === 8, `exactly the 8 catalog targets, got ${data.targets?.length}`)
  for (const t of data.targets) {
    assert.equal(typeof t.id, 'string', 'target id literal')
    assert.equal(typeof t.name, 'string', 'target display name')
    assert.equal(typeof t.channel, 'string', 'channel catalog text (no credential surface)')
    assert.ok(['npm', 'winget', 'native', 'github'].includes(t.channelKind), `channelKind enum: ${t.channelKind}`)
    assert.ok(t.installed === null || typeof t.installed === 'string', 'installed version or explicit null')
    assert.ok(t.latest === null || typeof t.latest === 'string', 'latest version or explicit null')
    assert.ok(['up-to-date', 'upgradable', 'unknown', 'check-failed', 'detect-only'].includes(t.state), `state enum: ${t.state}`)
    assert.ok(t.lastCheckedAt === null || Number.isInteger(t.lastCheckedAt), 'lastCheckedAt unix seconds or null')
  }
  note(`targets: ${data.targets.map((t) => `${t.id}=${t.state}`).join(', ')}`)
})

registerCase('A18', 'archives.list：archive_runs 最近 N 条（默认 20 上限 100；limit>100 在 SDK/zod schema 层拒绝，语义与 IPC archive:history 的 BAD_PAYLOAD 等价）', async () => {
  const data = await callOk(ctx.mcp.client, 'devhub.archives.list')
  assert.ok(Array.isArray(data.runs), 'runs array present')
  assert.ok(data.runs.length <= 20, `default limit 20, got ${data.runs.length}`)
  for (const r of data.runs) {
    assert.equal(typeof r.id, 'number', 'run id')
    assert.equal(typeof r.projectName, 'string', 'project name literal')
    assert.ok(['running', 'done', 'failed', 'rolled-back'].includes(r.status), `status enum: ${r.status}`)
    assert.equal(typeof r.oldPath, 'string', 'oldPath (archive fact, same projection as the IPC channel)')
    assert.equal(typeof r.newPath, 'string', 'newPath')
  }
  const limited = await callOk(ctx.mcp.client, 'devhub.archives.list', { limit: 1 })
  assert.ok(limited.runs.length <= 1, 'limit=1 caps the run list')
  // >100 的拒绝发生在 SDK/zod 层（docs/08 §10.1）：SDK 把入参校验错误折叠为
  // isError:true + "MCP error -32602: Input validation error" 文本帧（非 {code,message} JSON，
  // 与 smoke m2 expectInvalidParams 同款口径；IPC 侧同语义拒绝码为 BAD_PAYLOAD）。
  const rejected = await callTool(ctx.mcp.client, 'devhub.archives.list', { limit: 101 })
  assert.equal(rejected.isError, true, 'limit>100 must surface as an error result')
  assert.match(rejected.content[0].text, /Input validation error|Invalid arguments/, 'schema-level rejection message')
  await liveness(ctx.mcp.client, 'A18')
  note(`${data.runs.length} run(s) in the default view; limit>100 refused at the schema layer`)
})

registerCase('A19', 'docker.images：daemon down → available:false + reason + 空列表（与 docker:overview 同语义，绝不 isError、绝不起引擎）；daemon up → 结构化镜像表', async () => {
  const result = await callTool(ctx.mcp.client, 'devhub.docker.images')
  assert.equal(result.isError, undefined, 'docker.images is never an error (degradation is a normal condition)')
  const data = result.structuredContent
  assert.equal(typeof data.available, 'boolean', 'available boolean')
  assert.ok(Array.isArray(data.images), 'images array present')
  assert.equal(data.count, data.images.length, 'count agrees with the image array')
  assert.equal(typeof data.danglingCount, 'number', 'dangling count present')
  if (data.available === false) {
    assert.ok(typeof data.reason === 'string' && data.reason.length > 0, 'degradation reason present')
    assert.deepEqual(data.images, [], 'degraded image list empty')
    note(`degraded as expected: ${data.reason}`)
  } else {
    for (const image of data.images) {
      assert.equal(typeof image.repository, 'string', 'repository field')
      assert.equal(typeof image.tag, 'string', 'tag field')
      assert.equal(typeof image.imageId, 'string', 'imageId field')
      assert.equal(typeof image.size, 'string', 'size field')
    }
    note(`daemon available: ${data.count} image(s), ${data.danglingCount} dangling`)
  }
})

registerCase('A20', '权限表外名拒绝语义不回归：4 个新 tool 已入表且 READ_ONLY；表外/原型链名 → PERMISSION_DENIED；变更动作名（toggle/update/run 类）绝不注册（docs/09 §10）', async () => {
  const permissions = await import(pathToFileURL(join(ROOT, 'src/main/mcp/permissions.ts')).href)
  for (const name of ['devhub.skills.list', 'devhub.versions.list', 'devhub.archives.list', 'devhub.docker.images']) {
    assert.equal(permissions.TOOL_PERMISSIONS[name], 'READ_ONLY', `${name} registered READ_ONLY`)
  }
  for (const name of ['devhub.not_a_real_tool', 'devhub.skills.toggle', 'devhub.versions.update', 'toString', 'constructor']) {
    assert.throws(
      () => permissions.assertPermission(name),
      (err) => err.code === 'PERMISSION_DENIED',
      `off-table name must be denied: ${name}`
    )
  }
  const tools = await ctx.mcp.client.listTools()
  const names = tools.tools.map((tool) => tool.name)
  for (const banned of ['devhub.skills.toggle', 'devhub.versions.update', 'devhub.archives.run']) {
    assert.ok(!names.includes(banned), `change action ${banned} must not be a registered tool (MCP stays read-only)`)
  }
  await liveness(ctx.mcp.client, 'A20')
})

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

async function main() {
  let passed = 0
  const failed = []
  for (const { id, name, fn } of cases) {
    try {
      await fn(ctx)
      passed += 1
      console.log(`PASS ${id} — ${name}`)
    } catch (err) {
      failed.push(id)
      console.error(`FAIL ${id} — ${name}`)
      console.error(err && err.stack ? err.stack : String(err))
    }
  }

  // 关闭主 client（stdin 关闭 → server 优雅退出）
  if (ctx.mcp) {
    try {
      await ctx.mcp.close()
    } catch {
      // 关闭阶段异常不影响验收结论
    }
  }

  // 场景证据落盘（无论通过与否都写出已采集的原始事实）
  scenario.generatedAt = new Date().toISOString()
  scenario.acceptance = { passed, total: cases.length, failed }
  mkdirSync(dirname(REPORT_PATH), { recursive: true })
  writeFileSync(REPORT_PATH, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8')
  console.log(`\nscenario report written: ${REPORT_PATH}`)

  console.log(`\n${passed}/${cases.length} passed`)
  if (failed.length > 0) {
    console.error(`failed: ${failed.join(', ')}`)
    process.exitCode = 1
  }
}

await main()
