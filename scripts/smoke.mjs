#!/usr/bin/env node
// DevHub smoke test harness (docs/00-execution-constraints.md #2 and #27).
//
// Steps append new cases with registerCase(); existing cases are never removed
// or skipped — the suite only grows. Run with: npm run smoke
//
// Tier split（M3-P0b，docs/briefs/m3p0b-smoke-tiers.md）：append-only 铁律不变——
// 分层只是给用例打标记（registerCase 第 3 参 tier），164 条用例本体零删改，
// 全量档仍是现行为。
//   full（默认）: `npm run smoke`       —— 全部用例（含 Gateway/端口/子进程/真机面）
//   fast        : `npm run smoke:fast`  —— 纯逻辑/编解码/解析/夹具库子集（目标 <2min）
// 归类口径：拉起 Gateway、占监听端口、起子进程、真机探测、依赖真库状态、
// 隐式进程探测（如 archive preview 的占用扫描）→ full；纯函数/编解码/解析/
// 临时库夹具 → fast；边界拿不准一律 full（保守）。
//
// Exit code: 0 when every registered case passes, 1 otherwise.

import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'

/** @type {{ name: string, fn: () => void | Promise<void>, tier: 'fast' | 'full' }[]} */
const cases = []

/**
 * Register one smoke case. Append-only by contract (#27).
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 * @param {'fast' | 'full'} [tier] tier marker; default 'full'（未标记 = 保守进全量档）
 */
export function registerCase(name, fn, tier = 'full') {
  cases.push({ name, fn, tier })
}

/**
 * Parse --tier=fast|full（`--tier=fast` 与 `--tier fast` 两种形态都收；默认 full）。
 * @returns {'fast' | 'full'}
 */
function parseTierArg() {
  const argv = process.argv.slice(2)
  let tier = 'full'
  for (let i = 0; i < argv.length; i++) {
    const eq = argv[i].match(/^--tier=(.+)$/)
    if (eq) tier = eq[1]
    else if (argv[i] === '--tier') tier = argv[i + 1] ?? ''
  }
  if (tier !== 'fast' && tier !== 'full') {
    console.error(`[smoke] invalid --tier value: ${tier} (expected fast | full; default full)`)
    process.exit(1)
  }
  return tier
}

function isEntrypoint() {
  if (!process.argv[1]) return false
  return import.meta.url === pathToFileURL(process.argv[1]).href
}

/**
 * Run the selected tier. full = 现行为（全部用例，输出与分层前逐行一致），
 * fast = 纯逻辑子集（打印自己的计数行）。计数保持动态计算（R1 批设计）。
 * @param {'fast' | 'full'} tier
 */
async function run(tier) {
  const selected = tier === 'full' ? cases : cases.filter((c) => c.tier === tier)
  if (tier !== 'full') {
    console.log(`[smoke] tier=${tier}: running ${selected.length} of ${cases.length} registered cases`)
  }
  let passed = 0
  for (const { name, fn } of selected) {
    try {
      await fn()
      passed += 1
      console.log(`PASS ${name}`)
    } catch (err) {
      console.error(`FAIL ${name}`)
      console.error(err instanceof Error ? err.stack : String(err))
    }
  }
  console.log(`${passed}/${selected.length} passed${tier === 'full' ? '' : ` (tier=${tier})`}`)
  if (passed !== selected.length) {
    process.exitCode = 1
  }
}

if (isEntrypoint()) {
  // Step 0 builtin case: proves the harness itself executes assertions and
  // async flow correctly. Later steps append real cases via registerCase().
  registerCase('harness self-check: assert and async flow work', async () => {
    assert.equal(1 + 1, 2, 'sanity arithmetic')
    assert.ok(true, 'sanity truthiness')
    await Promise.resolve()
  }, 'fast')

  // ------------------------------------------------------------------
  // Step 1: shared contract layer (channels + types)
  // S2 批次 note（docs/09 §9 授权的同一模式更新）：skills 14 条并入白名单，21 → 35。
  // S3 批次 note（docs/09 §9 授权的同一模式更新）：apihub 6 条 + versions 4 条并入，
  // 35 → 45（apihub:adapters/current/profiles/saveProfile/deleteProfile/switch +
  // versions:list/check/update/job）。
  // S4 批次 note（docs/09 §8/§9 授权的同一模式更新）：docker 3 条（overview/logs/action，
  // 按文档命名）+ wsl 2 条（action/distroStats，§8.2 授权随 Environment 扩展批次并入）
  // 并入，45 → 50。
  // S5 批次 note（docs/10 §11 授权的同一模式更新）：archive 5 条（preview/run/
  // history/rollback/status）并入，50 → 55。archive:precheck 并入 preview
  // （占用扫描即预览影响面）；archive:settings 不设专用 channel——dest_root 读写由
  // settings:get/set（key=archive_dest_root，003 种子已覆盖）承担。
  // AC2 批次 note（docs/14 §A.1 授权的同一模式就地更新）：agents 13 条并入，55 → 68。
  // 夜间#1 批次 note（主控任务书授权的同一模式就地更新）：versions:cancel +
  // agents:probeProvider 并入，68 → 70（docker:action 枚举扩 remove / wsl:action 扩
  // shutdownAll 为既有 channel 的 payload 扩容，不新增白名单行）。
  // CP1 批次 note（ContestPin，docs/04「ContestPin 追加」节授权的同一模式就地更新）：
  // contestpin 9 条并入，70 → 79（list/get/create/update/delete/archive/nodeUpsert/
  // nodeDelete/linkProject；delete/nodeDelete 为 CONFIRM_REQUIRED 两段式）。
  // CP2 批次 note（ContestPin 悬浮窗，docs/22 §4 授权的同一模式就地更新）：
  // contestpin 5 条并入，79 → 84（overlayState/overlaySetEnabled/overlaySetCollapsed/
  // openInMain/openLink）。
  // CP3a 批次 note（ContestPin 识别配置，docs/22 §6 授权的同一模式就地更新）：
  // contestpin 4 条并入，84 → 88（configList/configSave/configDelete/configTest；
  // configDelete 为 CONFIRM_REQUIRED 两段式）。
  // ------------------------------------------------------------------
  registerCase('step1: channels whitelist has exactly 88 entries (CP3a 就地更新 84→88) and IPC_GATEWAY', async () => {
    const channels = await import(new URL('../src/shared/channels.ts', import.meta.url).href)
    assert.equal(channels.IPC_GATEWAY, 'devhub:invoke', 'gateway channel')
    const expected = [
      'scan:start',
      'scan:status',
      'scan:cancel',
      'projects:list',
      'projects:get',
      'projects:add',
      'projects:remove',
      'projects:rescan',
      'projects:update',
      'projects:openFolder',
      'projects:openVSCode',
      'projects:openTerminal',
      'projects:openWSL',
      'environment:detect',
      'environment:doctor',
      'services:list',
      'services:refresh',
      'dashboard:summary',
      'settings:get',
      'settings:set',
      'app:version',
      // S2 skills group (docs/09 §9 skills 条目 + 本批必需的 agent/companion 条目)
      'skills:scan',
      'skills:scanWsl',
      'skills:list',
      'skills:agents',
      'skills:linkStates',
      'skills:toggleLink',
      'skills:import',
      'skills:doctor',
      'skills:repair',
      'skills:sync',
      'skills:agent.upsert',
      'skills:agent.remove',
      'skills:companion.status',
      'skills:companion.deploy',
      // S3 apihub group (docs/09 §9)
      'apihub:adapters',
      'apihub:current',
      'apihub:profiles',
      'apihub:saveProfile',
      'apihub:deleteProfile',
      'apihub:switch',
      // S3 versions group (docs/09 §9 + 夜间#1：cancel 主动取消)
      'versions:list',
      'versions:check',
      'versions:update',
      'versions:job',
      'versions:cancel',
      // S4 docker group (docs/09 §9，按文档命名 overview/logs/action)
      'docker:overview',
      'docker:logs',
      'docker:action',
      // S4 wsl group (docs/09 §8.2/§9 授权并入)
      'wsl:action',
      'wsl:distroStats',
      // S5 archive group (docs/10 §11)
      'archive:preview',
      'archive:run',
      'archive:history',
      'archive:rollback',
      'archive:status',
      // AC2 agents group (docs/14 §A.1，13 条轮询 channel)
      'agents:providers',
      'agents:sessions',
      'agents:sessionDetail',
      'agents:messages',
      'agents:events',
      'agents:sessionAction',
      'agents:pairingCreate',
      'agents:devices',
      'agents:deviceRevoke',
      'agents:gatewayStatus',
      'agents:gatewayRestart',
      'agents:setAutoStart',
      'agents:diagnostics',
      // 夜间#1 批次（per-provider 单独重探，UX 验收 backlog）
      'agents:probeProvider',
      // CP1 contestpin group (docs/04「ContestPin 追加」节 + docs/22 §3)
      'contestpin:list',
      'contestpin:get',
      'contestpin:create',
      'contestpin:update',
      'contestpin:delete',
      'contestpin:archive',
      'contestpin:nodeUpsert',
      'contestpin:nodeDelete',
      'contestpin:linkProject',
      // CP2 contestpin overlay group (docs/22 §4 + docs/04「ContestPin 追加」节)
      'contestpin:overlayState',
      'contestpin:overlaySetEnabled',
      'contestpin:overlaySetCollapsed',
      'contestpin:openInMain',
      'contestpin:openLink',
      // CP3a contestpin recognition-config group (docs/22 §6 + docs/04「ContestPin 追加」节)
      'contestpin:configList',
      'contestpin:configSave',
      'contestpin:configDelete',
      'contestpin:configTest',
    ]
    assert.equal(channels.IPC_CHANNELS.length, 88, `expected 88 channels, got ${channels.IPC_CHANNELS.length}`)
    assert.deepEqual([...channels.IPC_CHANNELS], expected, 'whitelist must match docs/04 + docs/09 §9 + docs/10 §11 + docs/14 §A.1 + docs/04 ContestPin 追加节 + docs/22 §4/§6 exactly')
    assert.equal(new Set(channels.IPC_CHANNELS).size, 88, 'no duplicate channels')
  }, 'fast')

  // ------------------------------------------------------------------
  // Step 2: exec kernel
  // ------------------------------------------------------------------
  registerCase('step2: exec runs node --version via argv array', async () => {
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const result = await run(process.execPath, ['--version'])
    assert.equal(result.code, 0, `exit code, stderr=${result.stderr}`)
    assert.equal(result.timedOut, false)
    assert.ok(result.stdout.trim().startsWith('v'), `stdout should start with v, got: ${result.stdout}`)
    assert.ok(result.durationMs >= 0)
    assert.equal(result.command, process.execPath)
  })

  registerCase('step2: exec enforces timeout and reports timedOut', async () => {
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { timeoutMs: 500 })
    assert.equal(result.timedOut, true, 'should be flagged as timeout')
    assert.equal(result.code, -1, 'timeout exit code is -1')
    assert.ok(result.durationMs < 3000, `should not wait full 3s, took ${result.durationMs}ms`)
  })

  registerCase('step2: exec missing command returns structured error, does not throw', async () => {
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const result = await run('definitely-missing-cmd-xyz', [])
    assert.equal(result.code, -1, 'spawn failure maps to code -1')
    assert.equal(result.timedOut, false)
    assert.ok(result.stderr.length > 0, 'stderr carries the spawn error message')
  })

  registerCase('step2: exec decodes UTF-16LE BOM output without mojibake', async () => {
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    // PowerShell 输出 UTF-16LE（等价于 wsl.exe 的输出形态）：
    // 先手写 BOM 前导字节，再以 Unicode 输出编码写正文。脚本为静态字面量。
    const script =
      '[Console]::OutputEncoding=[System.Text.Encoding]::Unicode; ' +
      '$p=[System.Text.Encoding]::Unicode.GetPreamble(); ' +
      '[Console]::OpenStandardOutput().Write($p,0,$p.Length); ' +
      "Write-Output 'devhub-中文-héllo'"
    const result = await run('powershell.exe', ['-NoProfile', '-Command', script])
    assert.equal(result.code, 0, `powershell exit code, stderr=${result.stderr}`)
    assert.ok(result.stdout.includes('devhub-中文-héllo'), `decoded stdout: ${JSON.stringify(result.stdout)}`)
    assert.ok(!result.stdout.includes('\uFFFD'), 'no replacement chars (mojibake) allowed')
  })

  registerCase('step2: launch PowerShell scripts are syntactically valid literals', async () => {
    const { run, LAUNCH_SCRIPTS } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const kinds = Object.keys(LAUNCH_SCRIPTS)
    assert.deepEqual(kinds.sort(), ['folder', 'terminal', 'vscode', 'wsl'], 'four launch kinds')
    // 纯语法解析，不执行脚本、不弹任何窗口；被检脚本经 $env:DH_SCRIPT 传入（约束 #12 模式）
    const parser =
      '$e=$null; ' +
      '[void][System.Management.Automation.Language.Parser]::ParseInput($env:DH_SCRIPT,[ref]$null,[ref]$e); ' +
      'if ($e.Count -gt 0) { Write-Error $e[0].Message; exit 1 } else { exit 0 }'
    for (const kind of kinds) {
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], {
        env: { ...process.env, DH_SCRIPT: LAUNCH_SCRIPTS[kind] },
      })
      assert.equal(result.code, 0, `launch script "${kind}" must parse, stderr=${result.stderr}`)
    }
  })

  // ------------------------------------------------------------------
  // Step 3: SQLite layer (node:sqlite DatabaseSync + migrations)
  // ------------------------------------------------------------------
  // Step 5 note: 002_env_tools_unique.sql 加入后，全新库一次迁移应用 2 个文件
  // 并升到 user_version 2（用例名与覆盖面不变：全新库干净迁移 + 幂等重跑）。
  // S1 批次 note: 003_merge_legacy.sql 加入后，全新库一次迁移应用 3 个文件
  // 并升到 user_version 3（覆盖面不变：干净迁移 + 幂等重跑）。
  // AC2 批次 note（docs/13 §3 授权的同一模式就地更新）：004_agent_control.sql
  // 加入后，全新库一次迁移应用 4 个文件并升到 user_version 4（覆盖面不变）。
  // M3-C7b 批次 note（同一模式）：006_rotation_grace.sql 加入后，全新库一次
  // 迁移应用 6 个文件并升到 user_version 6（覆盖面不变，逐条已单列批次报告）。
  // CP1 批次 note（ContestPin，docs/22 §2 授权的同一模式就地更新）：008_contestpin.sql
  // 加入（007 判给 LR1、序号跳过），全新库一次迁移应用 7 个文件并升到 user_version 8。
  registerCase('step3: fresh db migrates to user_version 8 (CP1 就地更新 6→8), idempotent re-run', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const dir = mkdtempSync(join(tmpdir(), 'devhub-smoke-'))
    const db = dbModule.openDatabase(join(dir, 'test.db'))
    try {
      const applied = dbModule.migrate(db)
      assert.equal(applied, 7, '001..006+008 migrations applied on fresh db (CP1 批次就地更新 6→7)')
      const row = db.prepare('PRAGMA user_version').get()
      assert.equal(Number(row.user_version), 8, 'user_version after migrate (latest = 8, CP1 批次就地更新 6→8；007=LR1 序号跳过)')
      const appliedAgain = dbModule.migrate(db)
      assert.equal(appliedAgain, 0, 'second migrate run applies nothing')
    } finally {
      db.close()
    }
  }, 'fast')

  // S1 note: 003_merge_legacy.sql 新增 5 张合并表（skill_agents / skill_links /
  // apihub_profiles / version_targets / archive_runs），业务表总数 14 → 19。
  // AC2 批次 note（docs/13 §4 授权的同一模式就地更新）：004_agent_control.sql
  // 新增 8 张 AC 域表，业务表总数 19 → 27。
  // CP1 批次 note（ContestPin，docs/22 §2 授权的同一模式就地更新）：
  // 008_contestpin.sql 新增 7 张 ContestPin 域表，业务表总数 27 → 34
  // （= cp1-migration-fresh 的 7 表存在性检查并入本用例，docs/22 §2.1）。
  registerCase('step3: all 34 business tables exist after migration (CP1 就地更新 27→34)', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const dir = mkdtempSync(join(tmpdir(), 'devhub-smoke-'))
    const db = dbModule.openDatabase(join(dir, 'test.db'))
    try {
      dbModule.migrate(db)
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
      const names = rows.map((r) => r.name).sort()
      const expected = [
        'agent_events',
        'agent_messages',
        'agent_providers',
        'agent_sessions',
        'archives',
        'apihub_profiles',
        'archive_runs',
        'containers',
        'devices',
        'environments',
        'environment_tools',
        'event_deliveries',
        'mcp_servers',
        'projects',
        'relationships',
        'remote_commands',
        'remote_devices',
        'repositories',
        'resources',
        'scans',
        'security_audit_logs',
        'services',
        'settings',
        'skill_agents',
        'skill_links',
        'skills',
        'version_targets',
        // CP1 批次（ContestPin，docs/22 §2.1）：008 新增 7 张
        'contest_import_jobs',
        'contest_materials',
        'contest_nodes',
        'contest_reminder_log',
        'contest_reminders',
        'contestpin_configs',
        'contests',
      ].sort()
      assert.equal(names.length, 34, `expected 34 tables (14 phase-1 + 5 merge + 8 AC + 7 contestpin, CP1 就地更新 27→34), got ${names.length}: ${names.join(',')}`)
      assert.deepEqual(names, expected, 'table set must match docs/03 + docs/13 §4 + docs/22 §2.1 exactly')
    } finally {
      db.close()
    }
  }, 'fast')

  registerCase('step3: settings seeds, WAL mode and foreign_keys are active', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const dir = mkdtempSync(join(tmpdir(), 'devhub-smoke-'))
    const db = dbModule.openDatabase(join(dir, 'test.db'))
    try {
      dbModule.migrate(db)
      const scanRoot = db.prepare("SELECT value FROM settings WHERE key = 'scan_root'").get()
      assert.ok(scanRoot, 'scan_root seed exists')
      assert.equal(scanRoot.value, 'F:\\Active_Project', 'scan_root value')
      const theme = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get()
      assert.ok(theme, 'theme seed exists')
      assert.equal(theme.value, 'dark', 'theme value')
      // CP1 批次（ContestPin，docs/22 §2.1）：008 种子就地扩展断言
      const cpMode = db.prepare("SELECT value FROM settings WHERE key = 'contestpin_default_mode'").get()
      assert.ok(cpMode, 'contestpin_default_mode seed exists (CP1 就地扩展)')
      assert.equal(cpMode.value, 'two_stage', 'contestpin_default_mode value')
      const cpOverlay = db.prepare("SELECT value FROM settings WHERE key = 'contestpin_overlay_enabled'").get()
      assert.ok(cpOverlay, 'contestpin_overlay_enabled seed exists (CP1 就地扩展)')
      assert.equal(cpOverlay.value, '0', 'contestpin_overlay_enabled value')
      const journalMode = db.prepare('PRAGMA journal_mode').get()
      assert.equal(String(journalMode.journal_mode).toLowerCase(), 'wal', 'journal_mode is WAL')
      const foreignKeys = db.prepare('PRAGMA foreign_keys').get()
      assert.equal(Number(foreignKeys.foreign_keys), 1, 'foreign_keys enforced')
    } finally {
      db.close()
    }
  }, 'fast')

  // ------------------------------------------------------------------
  // Step 4: read-only adapters (git / fs / windows / wsl / docker)
  // 约定（交付说明 #16）：wsl/docker 等机器相关用例若因本机瞬时状态不满足
  // 前置条件，允许在用例内打印 SKIP note 并说明，不伪造数据。
  // ------------------------------------------------------------------
  function envSkipNote(reason) {
    console.warn(`SKIP note: ${reason}`)
  }

  registerCase('step4: gitStatus parses temp fixture repo; non-repo returns null', async () => {
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const adapter = await import(new URL('../src/main/adapters/git.ts', import.meta.url).href)
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    // 夹具仓库：git init + 一次提交 + 再改文件制造 dirty（夹具准备同样走 exec 内核）
    const repo = mkdtempSync(join(tmpdir(), 'devhub-git-'))
    const init = await run('git', ['init', repo])
    assert.equal(init.code, 0, `git init fixture failed: ${init.stderr}`)
    writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
    const add = await run('git', ['-C', repo, 'add', 'tracked.txt'])
    assert.equal(add.code, 0, `fixture add failed: ${add.stderr}`)
    const commit = await run('git', [
      '-C', repo,
      '-c', 'user.name=DevHub Smoke',
      '-c', 'user.email=smoke@devhub.invalid',
      'commit', '-m', 'init',
    ])
    assert.equal(commit.code, 0, `fixture commit failed: ${commit.stderr}`)
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n') // dirty

    const status = await adapter.gitStatus(repo)
    assert.ok(status !== null, 'gitStatus should parse fixture repo')
    assert.ok(status.branch === 'main' || status.branch === 'master', `branch, got ${JSON.stringify(status.branch)}`)
    assert.ok(status.dirtyCount >= 1, `dirtyCount >= 1, got ${status.dirtyCount}`)
    assert.equal(status.ahead, 0, 'no upstream configured => ahead 0')
    assert.equal(status.behind, 0, 'no upstream configured => behind 0')

    const head = await adapter.gitHead(repo)
    assert.ok(head !== null && /^[0-9a-f]{40}$/i.test(head), `HEAD sha, got ${JSON.stringify(head)}`)
    assert.equal(await adapter.gitRemote(repo), null, 'fixture repo has no origin remote')

    const plain = mkdtempSync(join(tmpdir(), 'devhub-plain-'))
    assert.equal(await adapter.gitStatus(plain), null, 'non-repo directory degrades to null')
  })

  registerCase('step4: discoverProjects finds exactly the fixture projects with hints and wslPath', async () => {
    const { discoverProjects } = await import(new URL('../src/main/adapters/fs.ts', import.meta.url).href)
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const root = mkdtempSync(join(tmpdir(), 'devhub-fs-'))
    mkdirSync(join(root, 'alpha-app'))
    writeFileSync(join(root, 'alpha-app', 'package.json'), '{"name":"alpha"}\n')
    mkdirSync(join(root, 'beta-py'))
    writeFileSync(join(root, 'beta-py', 'pyproject.toml'), '[project]\nname = "beta"\n')
    // 干扰项：node_modules 与隐藏目录内的标记不构成项目
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'package.json'), '{}\n')
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, '.hidden', 'package.json'), '{}\n')
    // 无标记目录
    mkdirSync(join(root, 'empty-dir'))

    const found = await discoverProjects(root)
    assert.equal(found.length, 2, `exactly 2 projects expected, got ${JSON.stringify(found, null, 1)}`)
    const alpha = found.find((p) => p.name === 'alpha-app')
    const beta = found.find((p) => p.name === 'beta-py')
    assert.ok(alpha !== undefined, 'alpha-app discovered')
    assert.ok(beta !== undefined, 'beta-py discovered')
    assert.equal(alpha.runtimeHint, 'node')
    assert.deepEqual(alpha.markers, ['package.json'])
    assert.equal(beta.runtimeHint, 'python')
    // wslPathForWinPath 独立断言映射（tmpdir 盘符动态计算）
    const expectedRoot = '/mnt/' + root[0].toLowerCase() + root.slice(2).replace(/\\/g, '/')
    assert.equal(alpha.wslPath, `${expectedRoot}/alpha-app`)
    assert.equal(beta.wslPath, `${expectedRoot}/beta-py`)
  }, 'fast')

  registerCase('step4: windows adapters report real listening ports, processes and details', async () => {
    const adapter = await import(new URL('../src/main/adapters/windows.ts', import.meta.url).href)

    const ports = await adapter.listListeningPorts()
    assert.ok(ports.length >= 1, `expected >=1 LISTENING port, got ${ports.length}`)
    assert.ok(ports.every((p) => Number.isInteger(p.port) && p.port >= 0 && p.port <= 65535), 'port numbers valid')
    assert.ok(ports.every((p) => Number.isInteger(p.pid) && p.pid >= 0), 'pids numeric')
    assert.ok(
      ports.every((p) => p.address.length > 0),
      `addresses captured, sample: ${JSON.stringify(ports[0])}`,
    )
    assert.ok(
      ports.some((p) => ['0.0.0.0', '127.0.0.1', '[::]'].includes(p.address) || p.address.startsWith('[')),
      'at least one local-wildcard/loopback listen',
    )

    const procs = await adapter.listWindowsProcesses()
    assert.ok(procs.length >= 1, `expected >=1 process, got ${procs.length}`)
    assert.ok(procs.every((p) => Number.isInteger(p.pid) && p.name.length > 0), 'process rows well-formed')

    const target = procs.find((p) => p.pid > 0)
    assert.ok(target !== undefined, 'at least one process with pid > 0')
    const details = await adapter.getProcessDetails([target.pid])
    assert.ok(details instanceof Map, 'getProcessDetails returns a Map')
    if (details.size > 0) {
      // 进程可能在两次探测之间退出，仅在命中时校验内容
      const detail = details.get(target.pid)
      assert.ok(detail !== undefined, 'detail present for probed pid')
      assert.ok(typeof detail.name === 'string' && detail.name.length > 0, `detail.name, got ${JSON.stringify(detail.name)}`)
    }
  })

  registerCase('step4: wsl distros parsed with state/version; wslPathForWinPath pure mapping', async () => {
    const adapter = await import(new URL('../src/main/adapters/wsl.ts', import.meta.url).href)

    const distros = await adapter.listDistros()
    if (distros.length === 0) {
      // 机器相关容错（交付说明 #16）：WSL 瞬时不可用时不伪造数据
      envSkipNote('wsl.exe -l -v returned no distros at run time (transient host state)')
    }
    assert.ok(distros.length >= 1, `expected >=1 WSL distro, got ${JSON.stringify(distros)}`)
    assert.ok(
      distros.every((d) => d.name.length > 0 && d.state.length > 0 && ['1', '2'].includes(d.version)),
      `distro rows well-formed: ${JSON.stringify(distros)}`,
    )
    assert.ok(
      distros.some((d) => d.isDefault === true),
      `default distro marked: ${JSON.stringify(distros)}`,
    )

    assert.equal(adapter.wslPathForWinPath('F:\\Active_Project\\DevHub'), '/mnt/f/Active_Project/DevHub')
    assert.equal(adapter.wslPathForWinPath('c:\\Users\\sakuya'), '/mnt/c/Users/sakuya')
    assert.equal(adapter.wslPathForWinPath('D:/mixed/slashes'), '/mnt/d/mixed/slashes')
    assert.equal(adapter.wslPathForWinPath('E:\\'), '/mnt/e')
    assert.equal(adapter.wslPathForWinPath('\\\\server\\share\\x'), '\\\\server\\share\\x', 'UNC passthrough')
  })

  registerCase('step4: dockerInfo structured degradation and listContainers array', async () => {
    const adapter = await import(new URL('../src/main/adapters/docker.ts', import.meta.url).href)

    const info = await adapter.dockerInfo()
    assert.equal(typeof info.cliAvailable, 'boolean', `cliAvailable field, got ${JSON.stringify(info)}`)
    assert.equal(typeof info.daemonAvailable, 'boolean', `daemonAvailable field, got ${JSON.stringify(info)}`)
    if (info.cliAvailable === true && info.daemonAvailable === true) {
      assert.ok(
        typeof info.serverVersion === 'string' && info.serverVersion.length > 0,
        `serverVersion present, got ${JSON.stringify(info)}`,
      )
    } else {
      assert.ok(
        typeof info.reason === 'string' && info.reason.length > 0,
        `degraded status must carry reason, got ${JSON.stringify(info)}`,
      )
      if (info.cliAvailable === false) {
        envSkipNote('docker CLI not found on this host at run time (transient PATH state)')
      }
    }

    const containers = await adapter.listContainers()
    assert.ok(Array.isArray(containers), 'listContainers returns an array')
    if (info.cliAvailable === true && info.daemonAvailable === false) {
      assert.equal(containers.length, 0, 'daemon unreachable => empty container list (structured degradation)')
    }
    if (info.daemonAvailable === true && containers.length > 0) {
      const first = containers[0]
      assert.ok(first.dockerId.length > 0 && first.name.length > 0, 'container rows well-formed')
      assert.ok(Array.isArray(first.ports), 'ports array present')
    }
  })

  // ------------------------------------------------------------------
  // Step 5: service layer (唯一写库层, docs/02 §1)
  // ------------------------------------------------------------------
  /** 每个用例独立的 DEVHUB_HOME：重置 DB 单例，保证用例间隔离。 */
  async function makeTempHome(prefix) {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const dir = mkdtempSync(join(tmpdir(), prefix))
    process.env.DEVHUB_HOME = dir
    dbModule.closeDatabase()
    return dir
  }

  /** 夹具项目：marker 决定运行时提示，git=true 时 init+commit 后再放脏文件。 */
  async function withFixtureProject(root, name, opts) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    if (opts.marker === 'pyproject.toml') {
      writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "' + name + '"\n')
    } else {
      writeFileSync(join(dir, 'package.json'), '{"name":"' + name + '"}\n')
    }
    if (opts.git) {
      const init = await run('git', ['init', dir])
      assert.equal(init.code, 0, `git init ${name} failed: ${init.stderr}`)
      writeFileSync(join(dir, 'tracked.txt'), 'v1\n')
      const add = await run('git', ['-C', dir, 'add', '.'])
      assert.equal(add.code, 0, `git add ${name} failed: ${add.stderr}`)
      const commit = await run('git', [
        '-C', dir,
        '-c', 'user.name=DevHub Smoke',
        '-c', 'user.email=smoke@devhub.invalid',
        'commit', '-m', 'init',
      ])
      assert.equal(commit.code, 0, `git commit ${name} failed: ${commit.stderr}`)
      writeFileSync(join(dir, 'dirty.txt'), 'untracked change\n') // dirty 文件
    }
    return dir
  }

  registerCase('step5: migration 002 relaxes env tool uniqueness to (env,tool,path); v1 db upgrades with data intact', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)

    // -- 全新库：migrate → user_version 8（001..006+008，CP1 就地更新 6→8；007=LR1）；
    //    同名工具双 path 并存落库，同 path 仍拒绝；cp1-migration-fresh 并入：
    //    008 的 7 张 ContestPin 表存在性检查（docs/22 §2.1，本用例就地扩展）
    const dir = mkdtempSync(join(tmpdir(), 'devhub-mig-'))
    const db = dbModule.openDatabase(join(dir, 'fresh.db'))
    try {
      const applied = dbModule.migrate(db)
      assert.equal(applied, 7, '001..006+008 applied on fresh db (CP1 批次就地更新 6→7)')
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 8, 'fresh db at user_version 8 (CP1 批次就地更新 6→8)')
      const cpTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
      for (const t of ['contests', 'contest_nodes', 'contest_reminders', 'contest_reminder_log', 'contest_materials', 'contest_import_jobs', 'contestpin_configs']) {
        assert.ok(cpTables.has(t), `008 table ${t} exists on fresh db (cp1-migration-fresh 并入本用例)`)
      }

      db.prepare("INSERT INTO environments (name, kind, detected_at, created_at, updated_at) VALUES ('windows', 'windows', 0, 0, 0)").run()
      const envId = Number(db.prepare("SELECT id FROM environments WHERE name = 'windows'").get().id)
      const insertTool = db.prepare(
        "INSERT INTO environment_tools (environment_id, tool, version, path, state, created_at, updated_at) VALUES (?, 'python', ?, ?, 'installed', 0, 0)",
      )
      insertTool.run(envId, '3.9.13', 'C:/Python39/python.exe')
      insertTool.run(envId, '3.13.5', 'C:/Python313/python.exe') // 002 后双解释器并存
      assert.throws(
        () => insertTool.run(envId, '3.13.5', 'C:/Python313/python.exe'),
        /UNIQUE/,
        'same (env, tool, path) must still be rejected',
      )
    } finally {
      db.close()
    }

    // -- 手工构造 v1 库（001 SQL + 手动 user_version=1）→ migrate 升 8，种子与数据保留
    const dir2 = mkdtempSync(join(tmpdir(), 'devhub-mig-v1-'))
    const db2 = dbModule.openDatabase(join(dir2, 'v1.db'))
    try {
      const sql001 = readFileSync(new URL('../src/main/db/migrations/001_init.sql', import.meta.url), 'utf8')
      db2.exec(sql001)
      db2.exec('PRAGMA user_version = 1') // 约束 #11 唯一例外；构造 v1 状态用
      const seedBefore = db2.prepare("SELECT value FROM settings WHERE key = 'scan_root'").get()
      assert.ok(seedBefore, 'v1 seed present before upgrade')
      db2.prepare("INSERT INTO environments (name, kind, detected_at, created_at, updated_at) VALUES ('windows', 'windows', 1, 1, 1)").run()
      db2.prepare(
        "INSERT INTO environment_tools (environment_id, tool, version, path, state, created_at, updated_at) VALUES (1, 'python', '3.9.13', 'C:/Python39/python.exe', 'installed', 1, 1)",
      ).run()

      const applied = dbModule.migrate(db2)
      assert.equal(applied, 6, 'only 002..006+008 apply to the v1 library (CP1 批次就地更新 5→6)')
      assert.equal(Number(db2.prepare('PRAGMA user_version').get().user_version), 8, 'v1 upgraded to user_version 8 (CP1 批次就地更新 6→8)')
      const seedAfter = db2.prepare("SELECT value FROM settings WHERE key = 'scan_root'").get()
      assert.ok(seedAfter && seedAfter.value === 'F:\\Active_Project', 'settings seed survived the table rebuild')
      const toolRow = db2.prepare("SELECT path, version FROM environment_tools WHERE environment_id = 1 AND tool = 'python'").get()
      assert.ok(toolRow, 'v1 tool row survived the rebuild migration')
      assert.equal(toolRow.path, 'C:/Python39/python.exe', 'tool row path preserved')
      assert.equal(toolRow.version, '3.9.13', 'tool row version preserved')
    } finally {
      db2.close()
    }
  }, 'fast')

  registerCase('step5: scanService persists fixture projects, dirty repository, scans row and contains edge', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const scanService = await import(new URL('../src/main/services/scanService.ts', import.meta.url).href)

    await makeTempHome('devhub-scan-')
    try {
      const db = dbModule.getDatabase()
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 8, 'home db migrated to 8 (CP1 批次就地更新 6→8)')

      const root = mkdtempSync(join(tmpdir(), 'devhub-projects-'))
      await withFixtureProject(root, 'alpha-web', { marker: 'package.json', git: true })
      await withFixtureProject(root, 'beta-py', { marker: 'pyproject.toml', git: false })
      settings.setSetting('scan_root', root)

      const status = await scanService.startScan()
      assert.equal(status.status, 'done', `scan must finish done, got ${JSON.stringify(status)}`)
      assert.equal(status.foundCount, 2, `foundCount, got ${status.foundCount}`)

      const projects = db.prepare('SELECT id, name FROM projects').all()
      assert.equal(projects.length, 2, `exactly 2 project rows, got ${JSON.stringify(projects)}`)
      const repos = db.prepare('SELECT project_id, is_dirty FROM repositories').all()
      assert.equal(repos.length, 1, `exactly 1 repository row (alpha-web only), got ${JSON.stringify(repos)}`)
      assert.equal(repos[0].is_dirty, 1, 'fixture repo is dirty (untracked file)')

      const scans = db.prepare('SELECT * FROM scans').all()
      assert.equal(scans.length, 1, 'one scans row')
      assert.equal(scans[0].status, 'done', 'scans row done')
      assert.equal(scans[0].found_count, 2, 'scans row found_count')
      assert.ok(scans[0].finished_at !== null && Number(scans[0].finished_at) >= Number(scans[0].started_at), 'finished_at set')

      const projectResources = Number(db.prepare("SELECT COUNT(*) AS c FROM resources WHERE resource_type = 'project'").get().c)
      assert.equal(projectResources, 2, 'two project resources registered')
      const contains = Number(db.prepare("SELECT COUNT(*) AS c FROM relationships WHERE relation_type = 'contains'").get().c)
      assert.ok(contains >= 1, `at least one contains edge, got ${contains}`)

      console.log(`    scan sample: found=${status.foundCount} projects=[${projects.map((p) => p.name).join(', ')}] containsEdges=${contains}`)
    } finally {
      dbModule.closeDatabase()
    }
  })

  registerCase('step5: scan re-entrancy returns the running scan; cancel token finalizes cancelled and resets', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const scanService = await import(new URL('../src/main/services/scanService.ts', import.meta.url).href)

    await makeTempHome('devhub-cancel-')
    try {
      const db = dbModule.getDatabase()
      const root = mkdtempSync(join(tmpdir(), 'devhub-cancel-root-'))
      await withFixtureProject(root, 'gamma-app', { marker: 'package.json', git: true })
      settings.setSetting('scan_root', root)

      // 防重入：startScan 的 scans 行与 active 句柄在首个 await 前同步建立，
      // 紧随其后的再次 startScan 必然观察到同一 running 扫描
      const pending = scanService.startScan()
      const reentry = await scanService.startScan()
      assert.equal(reentry.status, 'running', `re-entrant call observes running, got ${JSON.stringify(reentry)}`)

      const cancel = scanService.cancelScan()
      assert.equal(cancel.cancelled, true, 'cancel during running scan')

      const final = await pending
      assert.equal(final.scanId, reentry.scanId, 'no second scan was started')
      assert.equal(final.status, 'cancelled', `final status, got ${JSON.stringify(final)}`)

      const row = db.prepare('SELECT status, finished_at FROM scans WHERE id = ?').get(final.scanId)
      assert.equal(row.status, 'cancelled', 'scans row records cancelled')
      assert.ok(row.finished_at !== null, 'scans row finished_at set')

      // 无 running 扫描时 cancel 幂等
      assert.deepEqual(scanService.cancelScan(), { cancelled: false })

      // 令牌复位：取消后可再次正常完成扫描
      const second = await scanService.startScan()
      assert.notEqual(second.scanId, final.scanId, 'a new scan id after the cancelled one')
      assert.equal(second.status, 'done', `token reset allows a clean rerun, got ${JSON.stringify(second)}`)
    } finally {
      dbModule.closeDatabase()
    }
  })

  registerCase('step5: services refresh merges sources with attribution fields; upsert is idempotent per key', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const servicesService = await import(new URL('../src/main/services/servicesService.ts', import.meta.url).href)

    await makeTempHome('devhub-svc-')
    try {
      const records = await servicesService.refreshServices()
      assert.ok(records.length >= 1, `expected >=1 service record on a listening host, got ${records.length}`)

      for (const record of records) {
        assert.ok(Number.isInteger(record.port) && record.port >= 0 && record.port <= 65535, `port valid: ${JSON.stringify(record)}`)
        assert.ok(['windows', 'wsl', 'docker'].includes(record.origin), `origin enum: ${record.origin}`)
        assert.ok(record.pid === undefined || Number.isInteger(record.pid), `pid numeric or absent: ${JSON.stringify(record)}`)
        assert.ok(Number.isInteger(record.firstSeenAt) && Number.isInteger(record.lastSeenAt), 'timestamps present')
      }
      assert.ok(
        records.some((r) => typeof r.processName === 'string' && r.processName.length > 0),
        `at least one record carries processName, sample: ${JSON.stringify(records[0])}`,
      )

      const rows = servicesService.listServices()
      assert.ok(rows.length >= records.length, 'list returns everything seen this round (plus retained stale rows)')
      assert.ok('projectName' in rows[0], 'list rows carry the joined projectName field (may be undefined)')
      const byPort = servicesService.findByPort(rows[0].port)
      assert.ok(byPort.length >= 1, 'findByPort hits at least the queried port')

      // upsert 幂等：第二次 refresh 不得产生 (port, origin, pid) 重复行
      await servicesService.refreshServices()
      const db = dbModule.getDatabase()
      const dupes = db
        .prepare('SELECT port, origin, IFNULL(pid, -1) AS k, COUNT(*) AS c FROM services GROUP BY port, origin, k HAVING c > 1')
        .all()
      assert.equal(dupes.length, 0, `no duplicate service keys, got ${JSON.stringify(dupes)}`)

      console.log(`    services sample: ${JSON.stringify(records.slice(0, 3))}`)
    } finally {
      dbModule.closeDatabase()
    }
  })

  registerCase('step5: environment detect persists windows+wsl tools with python dual entries; doctor emits real warnings', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const envService = await import(new URL('../src/main/services/environmentService.ts', import.meta.url).href)
    const wslAdapter = await import(new URL('../src/main/adapters/wsl.ts', import.meta.url).href)

    await makeTempHome('devhub-env-')
    try {
      const detected = await envService.detectEnvironment()
      const names = detected.environments.map((e) => e.name)
      assert.ok(names.includes('windows'), `windows env persisted, got ${JSON.stringify(names)}`)

      const distros = await wslAdapter.listDistros()
      if (distros.length === 0) {
        envSkipNote('wsl.exe -l -v returned no distros at run time (transient host state)')
      } else {
        assert.ok(names.some((n) => n.startsWith('wsl:')), `wsl env persisted, got ${JSON.stringify(names)}`)
        if (distros.some((d) => d.name === 'Ubuntu')) {
          assert.ok(names.includes('wsl:Ubuntu'), `wsl:Ubuntu persisted, got ${JSON.stringify(names)}`)
        }
      }

      const db = dbModule.getDatabase()
      const toolCount = Number(db.prepare('SELECT COUNT(*) AS c FROM environment_tools').get().c)
      assert.ok(toolCount >= 10, `environment_tools >= 10 rows, got ${toolCount}`)

      const pythons = db
        .prepare(
          "SELECT et.path, et.version FROM environment_tools et JOIN environments e ON e.id = et.environment_id WHERE e.name = 'windows' AND et.tool = 'python' AND et.state = 'installed'",
        )
        .all()
      assert.ok(pythons.length >= 2, `expected >=2 installed windows python entries (3.9/3.13 dual), got ${JSON.stringify(pythons)}`)
      assert.equal(new Set(pythons.map((r) => r.path)).size, pythons.length, 'python entries distinguished by path (002 semantics)')

      const doctor = await envService.runDoctor()
      const warnings = doctor.checks.filter((c) => c.severity === 'warning')
      assert.ok(
        warnings.length >= 2,
        `expected >=2 doctor warnings on this machine, got ${JSON.stringify(doctor.checks, null, 1)}`,
      )
      assert.ok(
        doctor.checks.every(
          (c) => ['info', 'warning', 'error'].includes(c.severity) && typeof c.id === 'string' && typeof c.title === 'string',
        ),
        'doctor check shape { id, severity, title }',
      )
      console.log('    doctor checks:', JSON.stringify(doctor.checks, null, 1))
    } finally {
      dbModule.closeDatabase()
    }
  })

  registerCase('step5: dashboardSummary numbers agree with direct SQL; recentProjects and warnings shapes hold', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const dashboardService = await import(new URL('../src/main/services/dashboardService.ts', import.meta.url).href)

    await makeTempHome('devhub-dash-')
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare(
        'INSERT INTO projects (name, slug, win_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('proj-one', 'proj-one', 'F:/Active_Project/proj-one', now, now, now)
      db.prepare('INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        'proj-two', 'proj-two', 'F:/Active_Project/proj-two', now - 120, now - 120,
      )
      db.prepare(
        'INSERT INTO repositories (project_id, branch, is_dirty, ahead, behind, created_at, updated_at) VALUES (1, ?, 1, 0, 0, ?, ?)',
      ).run('main', now, now)
      db.prepare(
        'INSERT INTO services (port, protocol, pid, process_name, origin, project_id, first_seen_at, last_seen_at) VALUES (48080, ?, 4242, ?, ?, 1, ?, ?)',
      ).run('tcp', 'node.exe', 'windows', now, now)

      const summary = await dashboardService.dashboardSummary()

      assert.equal(summary.projectCount, Number(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c), 'projectCount matches SQL')
      assert.equal(summary.projectCount, 2)
      assert.equal(summary.dirtyRepoCount, Number(db.prepare('SELECT COUNT(*) AS c FROM repositories WHERE is_dirty = 1').get().c), 'dirtyRepoCount matches SQL')
      assert.equal(summary.dirtyRepoCount, 1)
      assert.equal(summary.serviceCount, 1, 'serviceCount counts last_seen within 15 minutes')
      assert.ok(summary.dockerTotal >= summary.dockerRunning, `docker totals sane: ${summary.dockerRunning}/${summary.dockerTotal}`)
      assert.equal(typeof summary.wslStatus.available, 'boolean', 'wslStatus.available boolean')
      assert.ok(Array.isArray(summary.wslStatus.distros), 'wslStatus.distros array')

      assert.ok(summary.recentProjects.length >= 1 && summary.recentProjects.length <= 5, 'recentProjects bounded')
      assert.equal(summary.recentProjects[0].name, 'proj-one', 'most recently opened project first')
      for (const rp of summary.recentProjects) {
        assert.ok(
          typeof rp.id === 'number' && typeof rp.name === 'string' && typeof rp.hasGit === 'boolean' && typeof rp.dirtyCount === 'number',
          `ProjectSummary shape: ${JSON.stringify(rp)}`,
        )
      }

      assert.ok(Array.isArray(summary.warnings), 'warnings array present')
      for (const warning of summary.warnings) {
        assert.ok(
          ['info', 'warning', 'error'].includes(warning.severity) && typeof warning.title === 'string',
          `DashboardWarning shape (unified severity): ${JSON.stringify(warning)}`,
        )
      }

      console.log(
        `    dashboard sample: projects=${summary.projectCount} dirty=${summary.dirtyRepoCount} docker=${summary.dockerRunning}/${summary.dockerTotal} services=${summary.serviceCount} warnings=${summary.warnings.length} recent=${summary.recentProjects.map((r) => r.name).join(',')}`,
      )
    } finally {
      dbModule.closeDatabase()
    }
  })

  // ------------------------------------------------------------------
  // Step 8c (F5): recentProjects lastOpenedAt 回退 updated_at —— Dashboard
  // Recent 必须能显示相对时间，即使项目从未被打开过（last_opened_at NULL）。
  // ------------------------------------------------------------------
  registerCase('step8c: dashboardSummary recentProjects lastOpenedAt falls back to updated_at; updatedAt projected on ProjectSummary', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const dashboardService = await import(new URL('../src/main/services/dashboardService.ts', import.meta.url).href)

    await makeTempHome('devhub-dash-f5-')
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      // 从未打开过（无 last_opened_at）；updated_at = now - 60
      db.prepare(
        'INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('never-opened', 'never-opened', 'F:/Active_Project/never-opened', now - 3600, now - 60)
      // 打开过（last_opened_at = now）：回退不得覆盖真实打开时间
      db.prepare(
        'INSERT INTO projects (name, slug, win_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('opened-once', 'opened-once', 'F:/Active_Project/opened-once', now, now - 3600, now - 60)

      const summary = await dashboardService.dashboardSummary()

      const never = summary.recentProjects.find((p) => p.name === 'never-opened')
      assert.ok(never !== undefined, 'never-opened project present in recentProjects')
      assert.equal(never.lastOpenedAt, now - 60, 'lastOpenedAt falls back to updated_at when never opened')
      assert.equal(never.updatedAt, now - 60, 'updatedAt projected on ProjectSummary')

      const opened = summary.recentProjects.find((p) => p.name === 'opened-once')
      assert.ok(opened !== undefined, 'opened-once project present in recentProjects')
      assert.equal(opened.lastOpenedAt, now, 'real last_opened_at is preserved (no fallback override)')
      assert.equal(opened.updatedAt, now - 60, 'updatedAt stays the raw column value')

      assert.equal(
        summary.recentProjects[0].name,
        'opened-once',
        'ordering still prefers last_opened_at over updated_at',
      )
    } finally {
      dbModule.closeDatabase()
    }
  })

  // ------------------------------------------------------------------
  // Step 6: IPC handler registry + gateway dispatch（纯模块，零 electron）
  // 说明：未注册 channel 的稳定错误码按 docs/04 §1 / docs/02 §3 取
  // CHANNEL_NOT_ALLOWED（文档权威原则，约束 #6）。
  // ------------------------------------------------------------------
  registerCase(
    'step6: handler registry keys equal the 88-channel whitelist (CP3a 就地更新 84→88); app:version returns injected value; unknown channel folds to CHANNEL_NOT_ALLOWED envelope',
    async () => {
      const channels = await import(new URL('../src/shared/channels.ts', import.meta.url).href)
      const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)

      const registry = handlers.createHandlerRegistry({ appVersion: '0.1.0-smoke' })
      const keys = Object.keys(registry).sort()
      assert.equal(keys.length, 88, `registry must hold exactly 88 handlers, got ${keys.length}`)
      assert.deepEqual(keys, [...channels.IPC_CHANNELS].sort(), 'registry keys must equal IPC_CHANNELS (no more, no less)')

      const version = await registry['app:version']({})
      assert.equal(version.appVersion, '0.1.0-smoke', 'app:version returns the injected version')
      assert.equal(typeof version.electronVersion, 'string', 'electronVersion field present (empty outside electron)')
      assert.equal(typeof version.nodeVersion, 'string', 'nodeVersion field present')

      const rejected = await handlers.dispatchGatewayRequest(registry, { channel: 'system:secrets', payload: {} })
      assert.equal(rejected.ok, false, 'unknown channel must not resolve')
      assert.equal(rejected.error.code, 'CHANNEL_NOT_ALLOWED', 'docs/04 §1 stable error code')
      assert.equal(typeof rejected.error.message, 'string')

      const protoProbe = await handlers.dispatchGatewayRequest(registry, { channel: '__proto__', payload: {} })
      assert.equal(protoProbe.ok, false, 'prototype-chain keys must not bypass the whitelist')
      assert.equal(protoProbe.error.code, 'CHANNEL_NOT_ALLOWED')
    },
    'fast',
  )

  registerCase(
    'step6: dispatchGatewayRequest wraps ok/error envelopes; malformed request, BAD_PAYLOAD and service NOT_FOUND never throw',
    async () => {
      const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
      const registry = handlers.createHandlerRegistry({ appVersion: '0.1.0-smoke' })

      // ok envelope
      const ok = await handlers.dispatchGatewayRequest(registry, { channel: 'app:version', payload: {} })
      assert.equal(ok.ok, true, 'success envelope ok=true')
      assert.ok('data' in ok && typeof ok.data === 'object', 'success envelope carries data')
      assert.equal(ok.data.appVersion, '0.1.0-smoke', 'data preserved through the envelope')

      // error envelope：handler 侧 payload 校验（BAD_PAYLOAD）
      const badId = await handlers.dispatchGatewayRequest(registry, { channel: 'projects:get', payload: { id: 'not-a-number' } })
      assert.equal(badId.ok, false)
      assert.equal(badId.error.code, 'BAD_PAYLOAD')
      assert.equal(typeof badId.error.message, 'string')

      // error envelope：ServiceError 折叠（空库 home 下 scan:status → NOT_FOUND）
      await makeTempHome('devhub-ipc-')
      const notFound = await handlers.dispatchGatewayRequest(registry, { channel: 'scan:status', payload: {} })
      assert.equal(notFound.ok, false)
      assert.equal(notFound.error.code, 'NOT_FOUND')

      // 外层请求形状非法
      const malformed = await handlers.dispatchGatewayRequest(registry, 42)
      assert.equal(malformed.ok, false)
      assert.equal(malformed.error.code, 'BAD_PAYLOAD')

      for (const envelope of [badId, notFound, malformed]) {
        assert.ok(!('stack' in envelope.error), 'renderer-facing error carries no stack')
        assert.equal(typeof envelope.error.code, 'string')
        assert.equal(typeof envelope.error.message, 'string')
      }
    },
    'fast',
  )

  // ------------------------------------------------------------------
  // Step 7: renderer UI（lib 纯辅助为 smoke 可直载的 electron-free 模块）
  // ------------------------------------------------------------------
  registerCase(
    'step7: lib/format pure helpers — relativeTime boundaries, port filter exact+fuzzy, command line truncation',
    async () => {
      const fmt = await import(new URL('../src/renderer/src/lib/format.ts', import.meta.url).href)
      const now = Date.now()
      const sec = (msAgo) => Math.floor((now - msAgo) / 1000)

      // relativeTime 边界：缺省 / 刚刚 / 分钟 / 小时 / 天
      assert.equal(fmt.relativeTime(undefined, now), '—', 'undefined timestamp renders em dash')
      assert.equal(fmt.relativeTime(0, now), '—', 'zero timestamp renders em dash')
      assert.equal(fmt.relativeTime(sec(30_000), now), '刚刚', '<1 minute => just now')
      assert.equal(fmt.relativeTime(now - 30_000, now), '刚刚', 'millisecond timestamps tolerated')
      assert.equal(fmt.relativeTime(sec(5 * 60_000), now), '5 分钟前', 'minutes bucket')
      assert.equal(fmt.relativeTime(sec(59 * 60_000), now), '59 分钟前', 'minute bucket upper edge')
      assert.equal(fmt.relativeTime(sec(60 * 60_000), now), '1 小时前', 'hours bucket lower edge')
      assert.equal(fmt.relativeTime(sec(3 * 3600_000), now), '3 小时前', 'hours bucket')
      assert.equal(fmt.relativeTime(sec(24 * 3600_000), now), '1 天前', 'days bucket lower edge')
      assert.equal(fmt.relativeTime(sec(6 * 86400_000), now), '6 天前', 'days bucket')
      assert.ok(fmt.relativeTime(sec(60 * 86400_000), now).length > 0, 'beyond 30 days falls back to a date string')

      // 端口过滤：精确优先 + 无精确时模糊子串 + 非数字按进程/项目名
      const rows = [
        { port: 80, processName: 'nginx', projectName: undefined },
        { port: 8080, processName: 'node', projectName: 'alpha-web' },
        { port: 3000, processName: 'vite', projectName: 'beta-py' },
      ]
      assert.equal(fmt.filterServiceRows(rows, '').length, 3, 'empty query keeps all rows')
      assert.deepEqual(
        fmt.filterServiceRows(rows, '8080').map((r) => r.port),
        [8080],
        'exact port query answers "who owns 8080" precisely',
      )
      assert.deepEqual(
        fmt.filterServiceRows(rows, '80').map((r) => r.port),
        [80],
        'exact match wins over substring when an exact hit exists',
      )
      assert.deepEqual(
        fmt.filterServiceRows(rows, '08').map((r) => r.port),
        [8080],
        'no exact hit => fuzzy substring over port digits',
      )
      assert.deepEqual(
        fmt.filterServiceRows(rows, '808').map((r) => r.port),
        [8080],
        'substring port query',
      )
      assert.deepEqual(
        fmt.filterServiceRows(rows, 'NOD').map((r) => r.port),
        [8080],
        'non-digit query matches processName case-insensitively',
      )
      assert.deepEqual(
        fmt.filterServiceRows(rows, 'beta').map((r) => r.port),
        [3000],
        'non-digit query matches projectName',
      )
      assert.equal(fmt.filterServiceRows(rows, '9999').length, 0, 'no match => empty, never invented rows')

      // 命令行截断：单行化不破坏显示、长度上限、缺省占位
      assert.equal(fmt.formatCommandLine(undefined), '—', 'missing command renders em dash')
      assert.equal(fmt.formatCommandLine('   '), '—', 'blank command renders em dash')
      assert.equal(fmt.oneLine('node  server.js\n\t--port\t8080'), 'node server.js --port 8080', 'newlines/tabs collapse')
      const long = 'cmd /c ' + 'x'.repeat(300)
      const cut = fmt.formatCommandLine(long, 40)
      assert.ok(cut.length <= 40, `truncated output respects max, got ${cut.length}`)
      assert.ok(cut.endsWith('…'), 'truncation carries an ellipsis, never mid-token silent cut')
      assert.ok(cut.startsWith('cmd /c '), 'truncation keeps the prefix for recognition')
      assert.equal(fmt.truncate('short', 40), 'short', 'short strings pass through unchanged')
    },
    'fast',
  )

  registerCase(
    'step7: severity→style mapping covers info/warning/error with no fallback gap',
    async () => {
      const fmt = await import(new URL('../src/renderer/src/lib/format.ts', import.meta.url).href)

      // 三态正典值
      assert.equal(fmt.normalizeSeverity('info'), 'info')
      assert.equal(fmt.normalizeSeverity('warning'), 'warning')
      assert.equal(fmt.normalizeSeverity('error'), 'error')
      // 大小写不敏感 + 近义词 + 未知/缺省折叠，不存在映射缺口
      assert.equal(fmt.normalizeSeverity('ERROR'), 'error', 'case-insensitive')
      assert.equal(fmt.normalizeSeverity('Warning'), 'warning', 'case-insensitive')
      assert.equal(fmt.normalizeSeverity(undefined), 'info', 'undefined folds to info')
      assert.equal(fmt.normalizeSeverity(''), 'info', 'empty folds to info')
      assert.equal(fmt.normalizeSeverity('critical'), 'info', 'unknown folds to info, never escapes the enum')

      const allowedClasses = new Set(['diag-info', 'diag-warning', 'diag-error'])
      const probeInputs = ['info', 'warning', 'error', 'INFO', 'WARNING', 'ERROR', 'warn', 'err', '', 'fatal', 'trace', undefined, null, 42]
      const glyphs = new Set()
      for (const input of probeInputs) {
        const cls = fmt.severityClass(/** @type {any} */ (input))
        assert.ok(allowedClasses.has(cls), `severityClass(${String(input)}) => ${cls} within the three-state set`)
        glyphs.add(fmt.severityGlyph(/** @type {any} */ (input)))
      }
      // 三态图标互异（info / warning / error 视觉可区分）
      assert.equal(glyphs.size, 3, `glyphs are distinct across states, got ${JSON.stringify([...glyphs])}`)
      assert.equal(fmt.severityClass('error'), 'diag-error')
      assert.equal(fmt.severityClass('warning'), 'diag-warning')
      assert.equal(fmt.severityClass('info'), 'diag-info')
    },
    'fast',
  )

  // ------------------------------------------------------------------
  // M1 批次（MCP 集成前置）：跨进程 DB 路径对齐
  // DEVHUB_HOME 未设时，纯 Node 进程（MCP Server / smoke）的 getDbPath()
  // 必须指向与 Electron userData 一致的目录（Windows %APPDATA%/<应用数据
  // 目录名>，非 Windows ~/.config/<应用数据目录名>），否则 MCP 独立进程会
  // 打开另一个空库（docs/02 §1.1 paths 策略、docs/08 §2 共享 DB）。
  // 只断言路径字符串；不创建目录、不打开数据库。
  // ------------------------------------------------------------------
  registerCase(
    'm1: getDbPath aligns with the Electron userData directory when DEVHUB_HOME is unset',
    async () => {
      const { readFileSync } = await import('node:fs')
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const paths = await import(new URL('../src/main/core/paths.ts', import.meta.url).href)

      // 应用数据目录名与 Electron 同源：package.json 的 productName ?? name
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      const appDirName = pkg.productName ?? pkg.name
      assert.equal(typeof appDirName, 'string', 'sanity: app dir name resolves from package.json')

      const savedHome = process.env.DEVHUB_HOME
      delete process.env.DEVHUB_HOME
      try {
        const dbPath = paths.getDbPath()
        const expectedHome =
          process.platform === 'win32'
            ? join(process.env.APPDATA, appDirName)
            : join(homedir(), '.config', appDirName)
        assert.equal(
          dbPath,
          join(expectedHome, 'devhub.db'),
          `db path must align with electron userData, got ${dbPath}`,
        )
        // 回落不得再指向项目内 <projectRoot>/data（第 4 级极端兜底）
        assert.ok(
          !dbPath.startsWith(paths.getProjectRoot()),
          `must not fall back to project-local data dir, got ${dbPath}`,
        )
      } finally {
        if (savedHome === undefined) delete process.env.DEVHUB_HOME
        else process.env.DEVHUB_HOME = savedHome
      }
    },
    'fast',
  )

  // ------------------------------------------------------------------
  // M2 批次（MCP 集成实现）：经 SDK InMemoryTransport 全链路调用
  // （真实走 SDK 校验与 envelope，docs/08 §13）。写库用例一律 DEVHUB_HOME
  // 临时目录 + closeDatabase 隔离；真机只读探测按 step4 同款容错。
  // ------------------------------------------------------------------

  /** 连接一个 Client ↔ createDevhubMcpServer() 的 InMemoryTransport 对。 */
  async function openMcp() {
    const sdkClient = await import('@modelcontextprotocol/sdk/client/index.js')
    const inMemory = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { createDevhubMcpServer } = await import(new URL('../src/main/mcp/server.ts', import.meta.url).href)

    const client = new sdkClient.Client({ name: 'devhub-smoke', version: '0.0.0' })
    const server = createDevhubMcpServer()
    const [clientTransport, serverTransport] = inMemory.InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    return { client, server }
  }

  const M2_TOOL_NAMES = [
    'devhub.environment.detect',
    'devhub.environment.doctor',
    'devhub.projects.list',
    'devhub.projects.get',
    'devhub.services.list',
    'devhub.services.inspect',
    'devhub.docker.status',
    'devhub.docker.containers',
    'devhub.docker.images',
    'devhub.wsl.status',
    'devhub.wsl.distributions',
    'devhub.git.status',
    'devhub.dashboard.summary',
    'devhub.skills.list',
    'devhub.versions.list',
    'devhub.archives.list',
  ].sort()

  /** isError 结果的 JSON 帧（{ code, message }）。 */
  function m2ErrorFrame(result) {
    assert.equal(result.isError, true, 'expected isError:true result')
    const frame = JSON.parse(result.content[0].text)
    assert.equal(typeof frame.code, 'string', 'error frame carries stable code')
    assert.equal(typeof frame.message, 'string', 'error frame carries message')
    return frame
  }

  /**
   * SDK/zod 入参校验失败：SDK 1.30 把 tool 执行期的 McpError（含入参校验）
   * 统一折叠为 isError:true 的 CallToolResult（docs/08 §10.1「SDK 自动校验失败 → isError」）。
   */
  async function expectInvalidParams(client, name, args) {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, true, `expected isError for ${name} ${JSON.stringify(args)}`)
    assert.match(
      result.content[0].text,
      /Input validation error|Invalid arguments/,
      `schema-level rejection message for ${name} ${JSON.stringify(args)}`,
    )
  }

  registerCase('m2-t01: server wires exactly 16 dotted tools; permission table covers exactly those, all READ_ONLY（夜间#2 四只读工具授权更新 12→16，docs/09 §10）', async () => {
    const permissions = await import(new URL('../src/main/mcp/permissions.ts', import.meta.url).href)

    await makeTempHome('devhub-m2-t01-')
    const { client, server } = await openMcp()
    try {
      const tools = await client.listTools()
      assert.equal(tools.tools.length, 16, `exactly 16 tools, got ${tools.tools.length}`)
      assert.deepEqual(tools.tools.map((t) => t.name).sort(), M2_TOOL_NAMES, 'all 16 dotted names, no drift')
      for (const tool of tools.tools) {
        assert.equal(tool.inputSchema.type, 'object', `inputSchema object for ${tool.name}`)
        assert.equal(typeof tool.description, 'string', `description present for ${tool.name}`)
      }

      // 权限分类表覆盖且仅覆盖 16 个 tool，值全为 READ_ONLY（docs/08 §9.2；夜间#2 扩 12→16）
      assert.deepEqual(Object.keys(permissions.TOOL_PERMISSIONS).sort(), M2_TOOL_NAMES, 'permission table exact coverage')
      for (const name of M2_TOOL_NAMES) {
        assert.equal(permissions.TOOL_PERMISSIONS[name], 'READ_ONLY', `${name} is READ_ONLY`)
      }

      // 表外名称 → PERMISSION_DENIED（等价 BLOCKED）
      assert.throws(
        () => permissions.assertPermission('devhub.not_a_real_tool'),
        (err) => err.code === 'PERMISSION_DENIED',
        'off-table name must be denied',
      )
      // 防原型链键绕过白名单
      assert.throws(() => permissions.assertPermission('toString'), (err) => err.code === 'PERMISSION_DENIED')

      // Phase B 预留注册接口：CONFIRM_REQUIRED 本期拒绝并说明 Phase B 待启用
      permissions.registerPermission('devhub.services.stop', 'CONFIRM_REQUIRED')
      try {
        assert.throws(
          () => permissions.assertPermission('devhub.services.stop'),
          (err) => err.code === 'CONFIRM_REQUIRED' && /Phase B/.test(err.message),
          'CONFIRM_REQUIRED refused with Phase B notice',
        )
      } finally {
        permissions.unregisterPermission('devhub.services.stop')
      }
      assert.equal(permissions.permissionFor('devhub.services.stop'), 'BLOCKED', 'unregister restores BLOCKED')
    } finally {
      await client.close()
      await server.close()
      const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
      dbModule.closeDatabase()
    }
  }, 'fast')

  registerCase('m2-t02: resources/list has the 6 stable URIs; environment markdown carries Windows + versions; dashboard non-empty', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    await makeTempHome('devhub-m2-t02-')
    const { client, server } = await openMcp()
    try {
      // 夹具快照（SQL 直插，确定性：不依赖真机探测）
      const db = dbModule.getDatabase()
      db.prepare("INSERT INTO environments (name, kind, detected_at, created_at, updated_at) VALUES ('windows', 'windows', 1700000000, 1700000000, 1700000000)").run()
      db.prepare("INSERT INTO environments (name, kind, detected_at, created_at, updated_at) VALUES ('wsl:Ubuntu', 'wsl', 1700000000, 1700000000, 1700000000)").run()
      const toolInsert = db.prepare(
        "INSERT INTO environment_tools (environment_id, tool, version, path, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'installed', 1700000000, 1700000000)",
      )
      toolInsert.run(1, 'python', '3.9.13', 'C:/Python39/python.exe')
      toolInsert.run(1, 'python', '3.13.5', 'C:/Python313/python.exe')
      toolInsert.run(1, 'node', '24.15.0', 'C:/Program Files/nodejs/node.exe')
      toolInsert.run(2, 'node', '22.14.0', '/usr/bin/node')

      const resources = await client.listResources()
      const uris = resources.resources.map((r) => r.uri).sort()
      assert.deepEqual(uris, [
        'devhub://dashboard',
        'devhub://docker',
        'devhub://environment',
        'devhub://projects',
        'devhub://services',
        'devhub://wsl',
      ], 'exactly the 6 stable URIs')

      const environment = await client.readResource({ uri: 'devhub://environment' })
      const envText = environment.contents[0].text
      assert.ok(envText.includes('Windows'), 'markdown carries the Windows section')
      assert.ok(envText.includes('3.9.13') && envText.includes('24.15.0'), 'markdown carries tool version rows')
      assert.ok(envText.includes('PATH-first'), 'PATH-first Python annotation present for multi-version')

      const dashboard = await client.readResource({ uri: 'devhub://dashboard' })
      assert.ok(dashboard.contents[0].text.length > 0, 'dashboard markdown non-empty')
      assert.ok(dashboard.contents[0].text.includes('# DevHub dashboard'), 'dashboard markdown title')
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  }, 'fast')

  registerCase('m2-t03: prompts/list has the 4 dotted names; find_port_owner renders the port argument into the text', async () => {
    await makeTempHome('devhub-m2-t03-')
    const { client, server } = await openMcp()
    try {
      const prompts = await client.listPrompts()
      assert.equal(prompts.prompts.length, 4, `exactly 4 prompts, got ${prompts.prompts.length}`)
      assert.deepEqual(
        prompts.prompts.map((p) => p.name).sort(),
        [
          'devhub.diagnose_environment',
          'devhub.find_port_owner',
          'devhub.inspect_project',
          'devhub.review_development_environment',
        ],
        'prompt names per docs/08 §8',
      )

      const rendered = await client.getPrompt({ name: 'devhub.find_port_owner', arguments: { port: '5432' } })
      const text = rendered.messages[0].content.text
      assert.ok(text.includes('5432'), 'port argument substituted into the instruction text')
      assert.ok(!text.includes('{{port}}'), 'no unsubstituted template slot remains')
      assert.ok(text.includes('attribution chain'), 'verbatim instruction text marker')

      const noArg = await client.getPrompt({ name: 'devhub.diagnose_environment' })
      assert.ok(noArg.messages[0].content.text.includes('devhub.environment.doctor'), 'no-arg prompt renders verbatim')
    } finally {
      await client.close()
      await server.close()
      const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
      dbModule.closeDatabase()
    }
  }, 'fast')

  registerCase('m2-t04: environment.detect returns structuredContent + summary text; windows tools >=5 with dual python', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    await makeTempHome('devhub-m2-t04-')
    const { client, server } = await openMcp()
    try {
      const result = await client.callTool({ name: 'devhub.environment.detect', arguments: {} })
      assert.ok(!result.isError, 'detect is not an error')
      const payload = result.structuredContent
      assert.ok(payload && Array.isArray(payload.environments), 'structuredContent.environments present')
      assert.equal(typeof result.content[0].text, 'string')
      assert.ok(result.content[0].text.length > 0, 'human-readable summary text present')

      const windows = payload.environments.find((e) => e.name === 'windows')
      assert.ok(windows, 'windows environment persisted')
      assert.ok(windows.tools.length >= 5, `windows tools >= 5, got ${windows.tools.length}`)
      const pythons = windows.tools.filter((t) => t.tool === 'python' && t.state === 'installed')
      assert.ok(pythons.length >= 2, `dual python entries, got ${JSON.stringify(pythons)}`)
      assert.equal(new Set(pythons.map((t) => t.path)).size, pythons.length, 'python entries distinguished by path')

      // 写库立场（docs/08 §6.1）：detect 落库 —— 快照行存在
      const db = dbModule.getDatabase()
      const toolCount = Number(db.prepare('SELECT COUNT(*) AS c FROM environment_tools').get().c)
      assert.ok(toolCount >= 10, `snapshot rows persisted, got ${toolCount}`)
      console.log(`    m2-t04 sample: ${result.content[0].text.split('\n').slice(0, 3).join(' | ')}`)
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  })

  registerCase('m2-t05: environment.doctor emits the real-machine warning baseline (>=2) as structured checks', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    await makeTempHome('devhub-m2-t05-')
    const { client, server } = await openMcp()
    try {
      const result = await client.callTool({ name: 'devhub.environment.doctor', arguments: {} })
      assert.ok(!result.isError, 'doctor is not an error')
      const payload = result.structuredContent
      assert.ok(Array.isArray(payload.checks), 'checks array present')
      const warnings = payload.checks.filter((c) => c.severity === 'warning')
      assert.ok(warnings.length >= 2, `real-machine baseline >= 2 warnings, got ${JSON.stringify(payload.checks)}`)
      for (const check of payload.checks) {
        assert.ok(['info', 'warning', 'error'].includes(check.severity) && typeof check.title === 'string', 'check shape')
      }
      console.log(`    m2-t05 sample: ${result.content[0].text.split('\n')[0]}`)
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  })

  registerCase('m2-t06: projects.list enhanced projection — 3 fixture projects with path/runtime/git/lastScan/docker fields', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const projectService = await import(new URL('../src/main/services/projectService.ts', import.meta.url).href)
    await makeTempHome('devhub-m2-t06-')
    const { client, server } = await openMcp()
    try {
      const root = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'devhub-m2-projects-'))
      const alpha = await withFixtureProject(root, 'alpha-web', { marker: 'package.json', git: true })
      const beta = await withFixtureProject(root, 'beta-py', { marker: 'pyproject.toml', git: false })
      await withFixtureProject(root, 'gamma-app', { marker: 'package.json', git: false })
      await projectService.addProject({ winPath: alpha, name: 'alpha-web' })
      await projectService.addProject({ winPath: beta, name: 'beta-py' })
      await projectService.addProject({ winPath: `${root}\\gamma-app`, name: 'gamma-app' })

      const result = await client.callTool({ name: 'devhub.projects.list', arguments: {} })
      assert.ok(!result.isError, 'projects.list is not an error')
      const projects = result.structuredContent.projects
      assert.equal(projects.length, 3, `3 projects, got ${projects.length}`)

      const alphaRow = projects.find((p) => p.name === 'alpha-web')
      assert.ok(alphaRow, 'alpha-web present')
      assert.equal(typeof alphaRow.winPath, 'string', 'winPath projected')
      assert.equal(alphaRow.runtimeHint, 'git', 'runtime hint takes the highest-priority marker (.git)')
      assert.equal(alphaRow.git.hasGit, true, 'git summary hasGit')
      assert.equal(typeof alphaRow.git.dirtyCount, 'number', 'git dirtyCount projected')
      assert.equal(typeof alphaRow.git.lastScanAt, 'number', 'git lastScanAt projected from repositories.last_status_at')
      assert.equal(typeof alphaRow.git.branch, 'string', 'git branch projected')
      assert.deepEqual(alphaRow.docker, { containersTotal: 0, containersRunning: 0 }, 'docker counts projected (empty fixture)')
      assert.ok(alphaRow.environment === null || typeof alphaRow.environment === 'object', 'environment edge or explicit null')

      const betaRow = projects.find((p) => p.name === 'beta-py')
      assert.equal(betaRow.runtimeHint, 'python', 'python runtime hint')
      assert.equal(betaRow.git.hasGit, false, 'non-git project hasGit false')
      assert.equal(betaRow.git.lastScanAt, undefined, 'no repo => no lastScanAt (absent, not guessed)')

      assert.equal(typeof alphaRow.updatedAt, 'number', 'updatedAt projected')
      assert.ok(result.content[0].text.includes('alpha-web'), 'summary text carries project names')
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  })

  registerCase('m2-t07: projects.get has wslPath, the three notAvailable placeholders and relationship edges; unknown id folds to NOT_FOUND', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const projectService = await import(new URL('../src/main/services/projectService.ts', import.meta.url).href)
    await makeTempHome('devhub-m2-t07-')
    const { client, server } = await openMcp()
    try {
      // environments 'windows' 行（SQL 直插）→ addProject 落 located_in 边（不依赖真机探测）
      const db = dbModule.getDatabase()
      db.prepare("INSERT INTO environments (name, kind, detected_at, created_at, updated_at) VALUES ('windows', 'windows', 1700000000, 1700000000, 1700000000)").run()

      const root = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'devhub-m2-get-'))
      const dir = await withFixtureProject(root, 'delta-app', { marker: 'package.json', git: true })
      const added = await projectService.addProject({ winPath: dir, name: 'delta-app' })

      const result = await client.callTool({ name: 'devhub.projects.get', arguments: { projectId: added.id } })
      assert.ok(!result.isError, 'projects.get is not an error')
      const detail = result.structuredContent
      assert.equal(detail.wslPath, `/mnt/${dir[0].toLowerCase()}${dir.slice(2).replace(/\\/g, '/')}`, 'wslPath present (derived at add)')
      for (const key of ['skills', 'mcpServers', 'archives']) {
        assert.deepEqual(detail[key], { notAvailable: true, reason: 'TABLE_EXISTS_NO_SERVICE' }, `${key} explicit placeholder`)
      }
      assert.ok(Array.isArray(detail.relationships) && detail.relationships.length >= 2, 'relationship edges listed')
      const relations = detail.relationships.map((e) => e.relation)
      assert.ok(relations.includes('contains'), 'project contains repository edge')
      assert.ok(relations.includes('located_in'), 'project located_in windows edge')

      // 未知 id → isError + NOT_FOUND，随后 server 仍可服务（docs/08 §6.4/§13）
      const missing = await client.callTool({ name: 'devhub.projects.get', arguments: { projectId: 999999 } })
      const frame = m2ErrorFrame(missing)
      assert.equal(frame.code, 'NOT_FOUND', 'unknown projectId folds to NOT_FOUND')
      const alive = await client.callTool({ name: 'devhub.projects.get', arguments: { projectId: added.id } })
      assert.ok(!alive.isError, 'server survives the failed request (no crash)')
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  })

  registerCase('m2-t08: services.list/inspect real snapshot with attribution; unknown port + unattributed fixture fold to "unknown"; red lines enforced', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const servicesService = await import(new URL('../src/main/services/servicesService.ts', import.meta.url).href)
    await makeTempHome('devhub-m2-t08-')
    const { client, server } = await openMcp()
    try {
      // 真实三源探测落库（真数据快照，非伪造）
      const records = await servicesService.refreshServices()
      assert.ok(records.length >= 1, `expected >=1 live service record, got ${records.length}`)

      const listed = await client.callTool({ name: 'devhub.services.list', arguments: {} })
      assert.ok(!listed.isError, 'services.list is not an error')
      const rows = listed.structuredContent.services
      assert.ok(rows.length >= 1, 'at least one row with attribution fields')
      for (const row of rows) {
        assert.ok(['windows', 'wsl', 'docker'].includes(row.origin), `origin field: ${row.origin}`)
        assert.equal(typeof row.project, 'string', 'project literal always present')
        assert.ok(typeof row.lastSeenAt === 'number', 'lastSeenAt projected')
      }

      // 真实监听端口 → 完整归因链
      const livePort = records[0].port
      const inspected = await client.callTool({ name: 'devhub.services.inspect', arguments: { port: livePort } })
      assert.ok(!inspected.isError, 'inspect is not an error')
      const inspectData = inspected.structuredContent
      assert.equal(inspectData.attributionChain, 'port→pid→process→origin→project', 'chain description fixed')
      assert.ok(inspectData.entries.length >= 1, 'entries for the live port')
      assert.equal(inspectData.entries[0].port, livePort)
      assert.equal(typeof inspectData.resolvedProject, 'string', 'resolvedProject literal present')
      assert.equal(typeof inspectData.snapshotAt, 'number', 'snapshotAt from max(lastSeenAt)')

      // 未收录端口 → entries 空 + note + resolvedProject 'unknown'（不崩、不猜测）
      const usedPorts = new Set(records.map((r) => r.port))
      let freePort = 64000
      while (usedPorts.has(freePort) && freePort < 65535) freePort += 1
      const empty = await client.callTool({ name: 'devhub.services.inspect', arguments: { port: freePort } })
      assert.ok(!empty.isError, 'empty inspect is not an error')
      assert.equal(empty.structuredContent.entries.length, 0, 'no entries for the unrecorded port')
      assert.equal(empty.structuredContent.note, 'no record in last services snapshot', 'freshness note present')
      assert.equal(empty.structuredContent.resolvedProject, 'unknown', 'resolvedProject explicit unknown')

      // 归因不到（project_id NULL）+ 600 字符 commandLine 含敏感赋值 → 'unknown' + 截断 + 打码
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      const longCommand = `node.exe server.js ${'x'.repeat(600)} password=topsecretvalue`
      db.prepare(
        "INSERT INTO services (port, protocol, pid, process_name, command_line, working_dir, origin, project_id, first_seen_at, last_seen_at) VALUES (59999, 'tcp', 4242, 'node.exe', ?, NULL, 'windows', NULL, ?, ?)",
      ).run(longCommand, now, now)
      const unattributed = await client.callTool({ name: 'devhub.services.inspect', arguments: { port: 59999 } })
      assert.ok(!unattributed.isError, 'unattributed inspect is not an error')
      const entry = unattributed.structuredContent.entries[0]
      assert.equal(unattributed.structuredContent.resolvedProject, 'unknown', 'unattributed port resolves to unknown')
      assert.equal(entry.project, 'unknown', 'entry project explicit unknown')
      assert.ok(entry.commandLine.length <= 500, `commandLine truncated to 500, got ${entry.commandLine.length}`)
      assert.ok(!JSON.stringify(unattributed.structuredContent).includes('topsecretvalue'), 'secret value redacted from output')
      assert.ok(!unattributed.content[0].text.includes('topsecretvalue'), 'secret value redacted from summary text')

      // zod strict 校验：port 越界 / 类型错误 / 未知键 → isError（SDK 校验），server 存活
      await expectInvalidParams(client, 'devhub.services.inspect', { port: 70000 })
      await expectInvalidParams(client, 'devhub.services.inspect', { port: 'abc' })
      await expectInvalidParams(client, 'devhub.services.list', { port: 80, unexpectedKey: true })
      const alive = await client.callTool({ name: 'devhub.services.inspect', arguments: { port: livePort } })
      assert.ok(!alive.isError, 'server survives invalid-input rejections')

      console.log(`    m2-t08 sample: live port ${livePort} resolvedProject=${inspectData.resolvedProject} rows=${rows.length}`)
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  })

  registerCase('m2-t09: docker.status/containers structured degradation or real availability — never an error', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    await makeTempHome('devhub-m2-t09-')
    const { client, server } = await openMcp()
    try {
      const status = await client.callTool({ name: 'devhub.docker.status', arguments: {} })
      assert.ok(!status.isError, 'docker.status is never an error')
      const statusData = status.structuredContent
      assert.equal(typeof statusData.available, 'boolean', 'available boolean')
      assert.equal(statusData.available, statusData.cliAvailable && statusData.daemonAvailable, 'available = cli && daemon')
      assert.deepEqual(statusData.containers, [], 'status carries empty containers placeholder')

      const containers = await client.callTool({ name: 'devhub.docker.containers', arguments: {} })
      assert.ok(!containers.isError, 'docker.containers is never an error')
      const containerData = containers.structuredContent
      if (statusData.available === false) {
        // 结构化降级分支（本机 daemon 不可用 → available:false + reason + containers:[]）
        assert.equal(containerData.available, false, 'degraded containers availability')
        assert.ok(typeof containerData.reason === 'string' && containerData.reason.length > 0, 'degradation reason present')
        assert.deepEqual(containerData.containers, [], 'degraded container list is empty')
      } else {
        assert.equal(containerData.available, true, 'available branch agrees with status')
        assert.ok(Array.isArray(containerData.containers), 'container list array')
        for (const container of containerData.containers) {
          assert.equal(typeof container.project, 'string', 'attribution literal per container')
          assert.ok(Array.isArray(container.ports), 'ports array per container')
        }
      }
      console.log(`    m2-t09 sample: available=${statusData.available} reason=${statusData.reason ?? 'n/a'} containers=${containerData.containers.length}`)
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  })

  registerCase('m2-t10: wsl.status/distributions — live state + DB tool snapshot layering, unprobed fields are null (D2)', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const envService = await import(new URL('../src/main/services/environmentService.ts', import.meta.url).href)
    await makeTempHome('devhub-m2-t10-')
    const { client, server } = await openMcp()
    try {
      const status = await client.callTool({ name: 'devhub.wsl.status', arguments: {} })
      assert.ok(!status.isError, 'wsl.status is never an error')
      assert.equal(typeof status.structuredContent.available, 'boolean', 'available boolean')
      assert.ok(Array.isArray(status.structuredContent.distros), 'distros array')

      const distros = await client.callTool({ name: 'devhub.wsl.distributions', arguments: {} })
      assert.ok(!distros.isError, 'distributions is never an error')
      const info = distros.structuredContent

      if (status.structuredContent.available === false) {
        envSkipNote('wsl unavailable at run time (transient host state)')
        assert.equal(info.distributions.length, 0, 'unavailable => empty distributions')
        return
      }

      assert.ok(info.distributions.length >= 1, `expected >=1 distribution, got ${JSON.stringify(info.distributions)}`)
      if (!info.distributions.some((d) => d.name === 'Ubuntu')) {
        envSkipNote('no Ubuntu distro at run time (machine state); living with generic distro assertions')
      }
      // 无 detect 快照 → 工具摘要缺失显式 null + toolSnapshot missing + hint（不猜测）
      assert.equal(info.toolSnapshot, 'missing', 'fresh home has no tool snapshot')
      assert.ok(typeof info.hint === 'string' && info.hint.includes('devhub.environment.detect'), 'hint points at detect')
      for (const distro of info.distributions) {
        assert.equal(distro.tools, null, 'tools explicit null without snapshot')
        assert.equal(distro.snapshotAt, null, 'snapshotAt explicit null without snapshot')
        assert.ok(['1', '2'].includes(distro.version), `live version field: ${distro.version}`)
        assert.ok(typeof distro.state === 'string' && distro.state.length > 0, `live state field: ${distro.state}`)
      }

      // detect 之后 → 工具快照出现（DB 快照层，docs/08 D2）
      await envService.detectEnvironment()
      const after = await client.callTool({ name: 'devhub.wsl.distributions', arguments: {} })
      const afterInfo = after.structuredContent
      assert.equal(afterInfo.toolSnapshot, 'available', 'tool snapshot available after detect')
      assert.equal(afterInfo.hint, undefined, 'no hint once snapshot exists')
      const withTools = afterInfo.distributions.filter((d) => Array.isArray(d.tools))
      assert.ok(withTools.length >= 1, 'at least one distro carries the DB tool snapshot')
      for (const distro of withTools) {
        assert.ok(typeof distro.snapshotAt === 'number', 'snapshotAt stamped from environments.detected_at')
      }
      console.log(`    m2-t10 sample: distros=${afterInfo.distributions.map((d) => d.name).join(',')} toolSnapshot=${afterInfo.toolSnapshot}`)
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  })

  registerCase('m2-t11: git.status — fixture repo branch/counts/remote; whitelist + unknown id structured refusals; non-repo explicit', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const projectService = await import(new URL('../src/main/services/projectService.ts', import.meta.url).href)
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    await makeTempHome('devhub-m2-t11-')
    const { client, server } = await openMcp()
    try {
      // 夹具 git 仓库：init + origin remote + 提交 + 1 modified + 1 untracked
      const repo = mkdtempSync(join(tmpdir(), 'devhub-m2-git-'))
      const gitExec = async (args) => {
        const res = await run('git', args)
        assert.equal(res.code, 0, `fixture git ${args[0]} failed: ${res.stderr}`)
      }
      await gitExec(['init', repo])
      await gitExec(['-C', repo, 'remote', 'add', 'origin', 'https://example.com/devhub-fixture.git'])
      writeFileSync(join(repo, 'tracked.txt'), 'v1\n')
      await gitExec(['-C', repo, 'add', '.'])
      await gitExec(['-C', repo, '-c', 'user.name=DevHub Smoke', '-c', 'user.email=smoke@devhub.invalid', 'commit', '-m', 'init'])
      writeFileSync(join(repo, 'tracked.txt'), 'v2\n') // modified
      writeFileSync(join(repo, 'extra.txt'), 'untracked\n') // untracked

      const plainDir = mkdtempSync(join(tmpdir(), 'devhub-m2-plain-'))
      mkdirSync(join(plainDir, '.placeholder'), { recursive: true })

      const repoProject = await projectService.addProject({ winPath: repo, name: 'fixture-git' })
      const plainProject = await projectService.addProject({ winPath: plainDir, name: 'fixture-plain' })

      // 主路径：branch / dirty / modified / untracked / remote
      const status = await client.callTool({ name: 'devhub.git.status', arguments: { projectId: repoProject.id } })
      assert.ok(!status.isError, 'git.status is not an error')
      const data = status.structuredContent
      assert.equal(data.project, 'fixture-git', 'project name projected')
      assert.equal(data.path, repo, 'probed path echoed')
      assert.ok(data.repository.branch === 'main' || data.repository.branch === 'master', `branch, got ${data.repository.branch}`)
      assert.equal(data.repository.ahead, 0, 'no upstream => ahead 0')
      assert.equal(data.repository.behind, 0, 'no upstream => behind 0')
      assert.equal(data.repository.remoteUrl, 'https://example.com/devhub-fixture.git', 'remote url best-effort')
      assert.ok(/^[0-9a-f]{40}$/i.test(data.repository.headSha ?? ''), 'head sha best-effort')
      assert.equal(data.workingTree.clean, false, 'working tree dirty')
      assert.equal(data.workingTree.modifiedCount, 1, `modified count, got ${data.workingTree.modifiedCount}`)
      assert.equal(data.workingTree.untrackedCount, 1, `untracked count, got ${data.workingTree.untrackedCount}`)
      assert.equal(data.notAGitRepository, undefined, 'notAGitRepository absent for a repo')

      // 白名单：归一化命中（大小写 + 正斜杠变体）→ 通过
      const normalizedVariant = `${repo[0].toLowerCase()}${repo.slice(1).replace(/\\/g, '/')}`
      const viaWhitelist = await client.callTool({ name: 'devhub.git.status', arguments: { projectId: repoProject.id, path: normalizedVariant } })
      assert.ok(!viaWhitelist.isError, 'normalized whitelist variant passes')
      assert.equal(viaWhitelist.structuredContent.workingTree.untrackedCount, 1, 'same repo probed via variant path')

      // 白名单外 path → 结构化拒绝（BAD_PAYLOAD）
      const foreignPath = mkdtempSync(join(tmpdir(), 'devhub-m2-foreign-'))
      const rejected = await client.callTool({ name: 'devhub.git.status', arguments: { projectId: repoProject.id, path: foreignPath } })
      assert.equal(m2ErrorFrame(rejected).code, 'BAD_PAYLOAD', 'off-whitelist path refused')

      // 未知 projectId → NOT_FOUND
      const missing = await client.callTool({ name: 'devhub.git.status', arguments: { projectId: 999999 } })
      assert.equal(m2ErrorFrame(missing).code, 'NOT_FOUND', 'unknown projectId refused')

      // 非仓库项目 → 显式 notAGitRepository（不是错误）
      const notRepo = await client.callTool({ name: 'devhub.git.status', arguments: { projectId: plainProject.id } })
      assert.ok(!notRepo.isError, 'non-repo is a structured result, not an error')
      assert.equal(notRepo.structuredContent.notAGitRepository, true, 'notAGitRepository explicit')

      // server 存活
      const alive = await client.callTool({ name: 'devhub.dashboard.summary', arguments: {} })
      assert.ok(!alive.isError, 'server survives refusals')
      console.log(`    m2-t11 sample: branch=${data.repository.branch} modified=${data.workingTree.modifiedCount} untracked=${data.workingTree.untrackedCount}`)
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  })

  registerCase('m2-t12: dashboard.summary agrees with direct SQL and with dashboardService (same source)', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const dashboardService = await import(new URL('../src/main/services/dashboardService.ts', import.meta.url).href)
    await makeTempHome('devhub-m2-t12-')
    const { client, server } = await openMcp()
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare(
        'INSERT INTO projects (name, slug, win_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('m2-proj-one', 'm2-proj-one', 'F:/Active_Project/m2-proj-one', now, now, now)
      db.prepare('INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        'm2-proj-two', 'm2-proj-two', 'F:/Active_Project/m2-proj-two', now - 120, now - 120,
      )
      db.prepare(
        'INSERT INTO repositories (project_id, branch, is_dirty, ahead, behind, created_at, updated_at) VALUES (1, ?, 1, 0, 0, ?, ?)',
      ).run('main', now, now)
      db.prepare(
        'INSERT INTO services (port, protocol, pid, process_name, origin, project_id, first_seen_at, last_seen_at) VALUES (48080, ?, 4242, ?, ?, 1, ?, ?)',
      ).run('tcp', 'node.exe', 'windows', now, now)

      const result = await client.callTool({ name: 'devhub.dashboard.summary', arguments: {} })
      assert.ok(!result.isError, 'dashboard.summary is not an error')
      const summary = result.structuredContent

      assert.equal(summary.projectCount, Number(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c), 'projectCount matches SQL')
      assert.equal(summary.projectCount, 2, 'projectCount fixture value')
      assert.equal(summary.dirtyRepoCount, Number(db.prepare('SELECT COUNT(*) AS c FROM repositories WHERE is_dirty = 1').get().c), 'dirtyRepoCount matches SQL')
      assert.equal(summary.dirtyRepoCount, 1, 'dirtyRepoCount fixture value')
      assert.equal(summary.serviceCount, 1, 'serviceCount counts the recent-window row')
      assert.ok(summary.dockerTotal >= summary.dockerRunning, 'docker totals sane')
      assert.ok(Array.isArray(summary.warnings), 'warnings array')
      assert.ok(Array.isArray(summary.recentProjects) && summary.recentProjects.length >= 1, 'recentProjects present')

      // 同源断言：与 dashboardService.dashboardSummary() 完全同一口径（docs/08 §6.12）
      const direct = await dashboardService.dashboardSummary()
      assert.equal(summary.projectCount, direct.projectCount, 'same source: projectCount')
      assert.equal(summary.dirtyRepoCount, direct.dirtyRepoCount, 'same source: dirtyRepoCount')
      assert.equal(summary.serviceCount, direct.serviceCount, 'same source: serviceCount')
      console.log(`    m2-t12 sample: projects=${summary.projectCount} dirty=${summary.dirtyRepoCount} services=${summary.serviceCount} warnings=${summary.warnings.length}`)
    } finally {
      await client.close()
      await server.close()
      dbModule.closeDatabase()
    }
  })

  // ------------------------------------------------------------------
  // S1 批次：migration 003（功能合并）+ 一次性导入器 migrate-legacy.mjs
  // ------------------------------------------------------------------

  // 40. migration 003：全新库 user_version=3、新表齐全；v2 库升级路径保数据
  // （AC2 批次就地更新：004 加入后全新库一次迁到 4、v2 库应用 003+004，本用例
  //  断言按 docs/13 §3 授权的同一模式就地更新，覆盖面不变）
  registerCase('s1-40: migration 003 — fresh db at user_version 3 with merge tables; v2 db upgrades preserving data', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)

    // -- 全新库：直接迁到 8（CP1 就地更新 6→8）；003 的 5 张新表全部存在且列齐全
    const dir = mkdtempSync(join(tmpdir(), 'devhub-s1-40-'))
    const db = dbModule.openDatabase(join(dir, 'fresh.db'))
    try {
      const applied = dbModule.migrate(db)
      assert.equal(applied, 7, '001..006+008 applied on fresh db (CP1 批次就地更新 6→7)')
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 8, 'fresh db at user_version 8 (CP1 批次就地更新 6→8)')

      const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
      assert.deepEqual(columnsOf('skill_agents'), ['id', 'name', 'platform', 'skills_dir', 'agents_dir', 'include_json', 'enabled', 'created_at', 'updated_at'], 'skill_agents columns')
      assert.deepEqual(columnsOf('skill_links'), ['id', 'agent_id', 'skill_id', 'state', 'checked_at'], 'skill_links columns')
      assert.deepEqual(columnsOf('apihub_profiles'), ['id', 'name', 'provider', 'encrypted_blob', 'needs_rekey', 'created_at', 'updated_at'], 'apihub_profiles columns')
      assert.deepEqual(columnsOf('version_targets'), ['id', 'key', 'display_name', 'kind', 'installed_version', 'target_version', 'state', 'last_checked_at'], 'version_targets columns')
      assert.deepEqual(
        columnsOf('archive_runs'),
        ['id', 'project_id', 'project_name', 'old_path', 'new_path', 'status', 'fixed_files', 'external_files', 'residual_hits', 'stripped_json', 'started_at', 'finished_at'],
        'archive_runs columns',
      )
      // skills / archives 重建扩列后既有列仍在，新列就位
      assert.ok(['vault_rel_path', 'frontmatter_json'].every((c) => columnsOf('skills').includes(c)), 'skills gained vault_rel_path/frontmatter_json')
      assert.ok(['run_id', 'old_path'].every((c) => columnsOf('archives').includes(c)), 'archives gained run_id/old_path')

      // 合同语义：skill_agents.name UNIQUE；skill_links UNIQUE(agent_id, skill_id)；FK 级联
      const now = 1700000000
      db.prepare(
        "INSERT INTO skill_agents (name, platform, skills_dir, include_json, created_at, updated_at) VALUES ('agent-a', 'windows', 'C:/a/skills', '[\"*\"]', ?, ?)",
      ).run(now, now)
      assert.throws(
        () => db.prepare(
          "INSERT INTO skill_agents (name, platform, skills_dir, include_json, created_at, updated_at) VALUES ('agent-a', 'linux', '/a/skills', '[\"*\"]', ?, ?)",
        ).run(now, now),
        /UNIQUE/,
        'skill_agents.name unique',
      )
      db.prepare(
        "INSERT INTO skills (name, vault_rel_path, description, created_at, updated_at) VALUES ('skill-a', 'skills/skill-a', '', ?, ?)",
      ).run(now, now)
      const linkInsert = db.prepare(
        'INSERT INTO skill_links (agent_id, skill_id, state, checked_at) VALUES (1, 1, ?, ?)',
      )
      linkInsert.run('linked', now)
      assert.throws(() => linkInsert.run('missing', now), /UNIQUE/, 'skill_links UNIQUE(agent_id, skill_id)')
      db.prepare('DELETE FROM skill_agents WHERE id = 1').run()
      const linksLeft = Number(db.prepare('SELECT COUNT(*) AS c FROM skill_links').get().c)
      assert.equal(linksLeft, 0, 'skill_links cascade on agent delete')
    } finally {
      db.close()
    }

    // -- 手工构造 v2 库（001+002 SQL + 手动 user_version=2）→ migrate 仅应用 003+004，数据全保留
    const dir2 = mkdtempSync(join(tmpdir(), 'devhub-s1-40-v2-'))
    const db2 = dbModule.openDatabase(join(dir2, 'v2.db'))
    try {
      db2.exec(readFileSync(new URL('../src/main/db/migrations/001_init.sql', import.meta.url), 'utf8'))
      db2.exec(readFileSync(new URL('../src/main/db/migrations/002_env_tools_unique.sql', import.meta.url), 'utf8'))
      db2.exec('PRAGMA user_version = 2') // 约束 #11 唯一例外；构造 v2 状态用
      const now = 1700000000
      db2.prepare(
        "INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES ('legacy-proj', 'legacy-proj', 'F:/Active_Project/legacy-proj', ?, ?)",
      ).run(now, now)
      db2.prepare(
        "INSERT INTO skills (name, source_path, description, created_at, updated_at) VALUES ('old-skill', 'D:/somewhere/old-skill', 'legacy description', ?, ?)",
      ).run(now, now)
      db2.prepare(
        "INSERT INTO archives (project_id, archive_path, size_bytes, created_at, updated_at) VALUES (1, 'F:/Archive/legacy-proj', 123, ?, ?)",
      ).run(now, now)

      const applied = dbModule.migrate(db2)
      assert.equal(applied, 5, 'only 003..006+008 apply to the v2 library (CP1 批次就地更新 4→5)')
      assert.equal(Number(db2.prepare('PRAGMA user_version').get().user_version), 8, 'v2 upgraded to user_version 8 (CP1 批次就地更新 6→8)')

      const proj = db2.prepare('SELECT name, win_path FROM projects WHERE id = 1').get()
      assert.ok(proj && proj.name === 'legacy-proj', 'projects row survived')
      const skill = db2.prepare('SELECT name, source_path, description, vault_rel_path, frontmatter_json FROM skills WHERE id = 1').get()
      assert.ok(skill, 'skills row survived the rebuild')
      assert.equal(skill.source_path, 'D:/somewhere/old-skill', 'skills.source_path preserved')
      assert.equal(skill.description, 'legacy description', 'skills.description preserved')
      assert.equal(skill.vault_rel_path, null, 'skills.vault_rel_path NULL for pre-003 rows (backfilled by scan later)')
      const arch = db2.prepare('SELECT project_id, archive_path, size_bytes, run_id, old_path FROM archives WHERE id = 1').get()
      assert.ok(arch && arch.archive_path === 'F:/Archive/legacy-proj' && Number(arch.size_bytes) === 123, 'archives row survived the rebuild')
      assert.equal(arch.run_id, null, 'archives.run_id NULL for pre-003 rows')
      // 重建后的 archives 外键语义仍可用（插入新行 + project 级联）
      db2.prepare(
        "INSERT INTO archives (project_id, archive_path, created_at, updated_at) VALUES (1, 'F:/Archive/x', ?, ?)",
      ).run(now, now)
      assert.equal(Number(db2.prepare('SELECT COUNT(*) AS c FROM archives').get().c), 2, 'archives insertable after rebuild')
    } finally {
      db2.close()
    }
  }, 'fast')

  // ---- S1 fixtures：夹具老数据（registry.json / vault skills / api-hub-profiles / archiver config）----
  async function buildS1LegacyFixture(prefix) {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const root = mkdtempSync(join(tmpdir(), prefix))
    const vaultDir = join(root, 'SkillVault')
    const skillsDir = join(vaultDir, 'skills')
    mkdirSync(join(skillsDir, 'alpha-skill'), { recursive: true })
    mkdirSync(join(skillsDir, 'beta-tool'), { recursive: true })
    writeFileSync(
      join(skillsDir, 'alpha-skill', 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: Alpha does things\n---\n\n# Alpha\nbody\n',
    )
    writeFileSync(join(skillsDir, 'beta-tool', 'SKILL.md'), '---\nname: beta-tool\n---\nbody\n') // 无 description

    writeFileSync(
      join(vaultDir, 'registry.json'),
      JSON.stringify({
        version: 2,
        agents: [
          { name: 'zcode-win', platform: 'windows', skillsDir: 'C:\\u\\zcode\\skills', agentsDir: 'C:\\u\\zcode\\agents', include: ['*'] },
          { name: 'codex-win', platform: 'windows', skillsDir: 'C:\\u\\codex\\skills', include: ['alpha-skill'] },
          { name: 'zcode-wsl', platform: 'linux', skillsDir: '/root/.zcode/skills', agentsDir: '/root/.zcode/agents', include: ['*'] },
        ],
      }),
    )

    const appDataDir = join(root, 'legacy-userdata')
    mkdirSync(appDataDir, { recursive: true })
    writeFileSync(
      join(appDataDir, 'api-hub-profiles.json'),
      JSON.stringify({
        version: 1,
        byAdapter: {
          kimi: [{ id: 'ah-kimi-1', name: 'prod-key', fields: { baseUrl: 'https://api.example.com' }, apiKeySealed: 'LEGACY-DPAPI-BLOB-AAA', }],
          grok: [{ id: 'ah-grok-1', name: 'grok-key', fields: {}, apiKeySealed: 'LEGACY-DPAPI-BLOB-BBB' }],
        },
      }),
    )

    const atMs = 1788266592469
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        projects: [{ id: 'p-1', name: 'SmartWatch', path: 'G:\\科研学习\\SmartWatch' }],
        settings: { lastDestRoot: 'D:\\ArchiveRoot' },
        history: [
          { id: 'h1', projectName: 'SmartWatch', oldPath: 'G:\\科研学习\\SmartWatch', newPath: 'D:\\ArchiveRoot\\SmartWatch', at: atMs, fixedFiles: 4, externalFiles: 0, residualHits: 0, status: 'done' },
          { id: 'h2', projectName: 'DemoWeb', oldPath: 'C:\\Temp\\pa\\DemoWeb', newPath: 'C:\\Temp\\pa\\Archive\\DemoWeb', at: atMs + 1000, fixedFiles: 1, externalFiles: 2, residualHits: 1, status: 'rolled-back' },
          // 与 h2 同 old_path+at：必须被去重跳过
          { id: 'h3', projectName: 'DemoWeb', oldPath: 'C:\\Temp\\pa\\DemoWeb', newPath: 'C:\\Temp\\pa\\Archive\\DemoWeb', at: atMs + 1000, fixedFiles: 9, externalFiles: 9, residualHits: 9, status: 'done' },
        ],
      }),
    )
    return { root, vaultDir, skillsDir, registryPath: join(vaultDir, 'registry.json'), appDataDir, configPath: join(root, 'config.json'), atMs }
  }

  // 41. migrate-legacy 幂等：DEVHUB_HOME 隔离 + 夹具跑两遍结果一致（upsert 不重复）
  registerCase('s1-41: migrate-legacy is idempotent — fixture run twice keeps identical row counts (upsert, no dup)', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const importer = await import(new URL('./migrate-legacy.mjs', import.meta.url).href)
    const fx = await buildS1LegacyFixture('devhub-s1-41-')

    await makeTempHome('devhub-s1-41-home-')
    try {
      const opts = {
        registryPath: fx.registryPath,
        vaultSkillsDir: fx.skillsDir,
        archiveConfigPath: fx.configPath,
        legacyAppDataDirs: [fx.appDataDir],
        now: () => 1700000000,
      }
      const first = await importer.runLegacyMigration(opts)
      assert.equal(first.skillAgents.inserted, 3, 'first run inserts 3 agents')
      assert.equal(first.skills.inserted, 2, 'first run inserts 2 skills')
      assert.equal(first.apihub.inserted, 2, 'first run inserts 2 apihub placeholders')
      assert.equal(first.archive.runsInserted, 2, 'first run inserts 2 archive runs')

      const counts = (db) => ({
        agents: Number(db.prepare('SELECT COUNT(*) AS c FROM skill_agents').get().c),
        skills: Number(db.prepare('SELECT COUNT(*) AS c FROM skills').get().c),
        profiles: Number(db.prepare('SELECT COUNT(*) AS c FROM apihub_profiles').get().c),
        runs: Number(db.prepare('SELECT COUNT(*) AS c FROM archive_runs').get().c),
      })
      const db = dbModule.getDatabase()
      const before = counts(db)

      const second = await importer.runLegacyMigration(opts)
      assert.equal(second.skillAgents.inserted, 0, 'second run inserts no agents')
      assert.equal(second.skillAgents.updated, 3, 'second run updates 3 agents in place')
      assert.equal(second.skills.inserted, 0, 'second run inserts no skills')
      assert.equal(second.skills.updated, 2, 'second run updates 2 skills in place')
      assert.equal(second.apihub.inserted, 0, 'second run inserts no apihub placeholders')
      assert.equal(second.archive.runsInserted, 0, 'second run inserts no archive runs (dedup by old_path+at)')
      assert.equal(second.archive.runsSkipped, 3, 'all three entries skip on rerun (h1/h2 already imported, h3 in-file dup)')
      assert.equal(second.archive.destRootSet, false, 'dest root not overwritten once set')

      const after = counts(db)
      assert.deepEqual(after, before, 'row counts identical after the second run')
      assert.deepEqual(after, { agents: 3, skills: 2, profiles: 2, runs: 2 }, 'absolute counts after two runs')

      // 内容稳定性：updated_at 固定时钟下，两次 upsert 后字段值逐列一致
      const agentRow = db.prepare("SELECT * FROM skill_agents WHERE name = 'codex-win'").get()
      assert.equal(agentRow.agents_dir, null, 'agents without agentsDir stay NULL')
      assert.equal(agentRow.include_json, '["alpha-skill"]', 'include_json round-trip')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 42. 夹具导入正确性：agents 字段映射、skills frontmatter、history 去重与路径归一匹配、apihub 占位
  registerCase('s1-42: migrate-legacy fixture correctness — agent fields, skills mirror, run dedup + path-normalized project match, apihub placeholders', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const importer = await import(new URL('./migrate-legacy.mjs', import.meta.url).href)
    const fx = await buildS1LegacyFixture('devhub-s1-42-')

    await makeTempHome('devhub-s1-42-home-')
    try {
      const db = dbModule.getDatabase()
      // DevHub 侧先有一个项目：路径用「小写 + 正斜杠」变体登记，证明归一化匹配
      const now = 1700000000
      db.prepare(
        "INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES ('smartwatch', 'smartwatch', 'g:/科研学习/smartwatch', ?, ?)",
      ).run(now, now)

      const report = await importer.runLegacyMigration({
        registryPath: fx.registryPath,
        vaultSkillsDir: fx.skillsDir,
        archiveConfigPath: fx.configPath,
        legacyAppDataDirs: [fx.appDataDir],
        now: () => now,
      })

      // agents 数量与字段映射（含 v1 形态的 agentsDir 缺省 → NULL；linux 平台原样保留）
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM skill_agents').get().c), 3, '3 agents imported')
      const zcode = db.prepare("SELECT * FROM skill_agents WHERE name = 'zcode-win'").get()
      assert.equal(zcode.platform, 'windows')
      assert.equal(zcode.skills_dir, 'C:\\u\\zcode\\skills')
      assert.equal(zcode.agents_dir, 'C:\\u\\zcode\\agents')
      assert.equal(zcode.include_json, '["*"]')
      assert.equal(zcode.enabled, 1)
      const wsl = db.prepare("SELECT * FROM skill_agents WHERE name = 'zcode-wsl'").get()
      assert.equal(wsl.platform, 'linux')
      assert.equal(wsl.agents_dir, '/root/.zcode/agents')

      // skills 镜像：frontmatter description 提取；无 description 的 skill 行仍导入（description 空串）
      const alpha = db.prepare("SELECT * FROM skills WHERE name = 'alpha-skill'").get()
      assert.ok(alpha, 'alpha-skill mirrored')
      assert.equal(alpha.vault_rel_path, 'skills/alpha-skill')
      assert.equal(alpha.description, 'Alpha does things')
      assert.equal(JSON.parse(alpha.frontmatter_json).name, 'alpha-skill')
      assert.equal(alpha.source_path, null, 'vault mirror rows have NULL source_path')
      const beta = db.prepare("SELECT * FROM skills WHERE name = 'beta-tool'").get()
      assert.ok(beta, 'beta-tool mirrored even without description')
      assert.equal(beta.description, '')

      // history → archive_runs：old_path+at 去重；路径归一匹配关联；匹配不上只入 run 不造 projects
      const runs = db.prepare('SELECT * FROM archive_runs ORDER BY id').all()
      assert.equal(runs.length, 2, 'h3 (same old_path+at as h2) deduped away')
      const smartRun = runs.find((r) => r.project_name === 'SmartWatch')
      assert.ok(smartRun, 'SmartWatch run imported')
      assert.equal(smartRun.project_id, 1, 'matched DevHub project via normalized path (case/slash-insensitive)')
      assert.equal(smartRun.fixed_files, 4)
      assert.equal(smartRun.status, 'done')
      assert.equal(smartRun.started_at, Math.floor(fx.atMs / 1000))
      assert.equal(smartRun.finished_at, Math.floor(fx.atMs / 1000), 'legacy single timestamp lands in both columns')
      const demoRun = runs.find((r) => r.project_name === 'DemoWeb')
      assert.ok(demoRun, 'DemoWeb run imported')
      assert.equal(demoRun.project_id, null, 'unmatched history keeps project_id NULL')
      assert.equal(demoRun.status, 'rolled-back')
      assert.equal(demoRun.residual_hits, 1)
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c), 1, 'no projects rows fabricated')
      assert.equal(report.archive.unmatched, 1, 'report counts the unmatched run')

      // settings.lastDestRoot → archive_dest_root（此前为空才写入）
      const dest = db.prepare("SELECT value FROM settings WHERE key = 'archive_dest_root'").get()
      assert.ok(dest && dest.value === 'D:\\ArchiveRoot', 'archive_dest_root seeded from lastDestRoot')

      // 老 ApiHub blob：只登记占位（needs_rekey=1），sealed 原样封存，绝不出现明文/解密
      const prof = db.prepare("SELECT * FROM apihub_profiles WHERE name = 'prod-key'").get()
      assert.ok(prof, 'kimi profile placeholder imported')
      assert.equal(prof.provider, 'kimi')
      assert.equal(prof.needs_rekey, 1)
      const envelope = JSON.parse(Buffer.from(prof.encrypted_blob).toString('utf8'))
      assert.equal(envelope.sealed, 'LEGACY-DPAPI-BLOB-AAA', 'legacy blob stored verbatim (never decrypted)')
      assert.equal(envelope.fields.baseUrl, 'https://api.example.com', 'non-sensitive fields preserved in envelope')
      assert.equal(prof.encrypted_blob.toString('utf8').includes('plainStore'), false, 'no plainStore flag invented')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 43. settings 种子：vault_path / archive_dest_root 存在（003 种子，不覆盖已有值）
  registerCase('s1-43: settings seeds vault_path and archive_dest_root exist after migration', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const dir = mkdtempSync(join(tmpdir(), 'devhub-s1-43-'))
    const db = dbModule.openDatabase(join(dir, 'test.db'))
    try {
      dbModule.migrate(db)
      const vault = db.prepare("SELECT value FROM settings WHERE key = 'vault_path'").get()
      assert.ok(vault, 'vault_path seed exists')
      assert.equal(vault.value, 'C:\\Users\\sakuya\\SkillVault', 'vault_path seed value')
      const dest = db.prepare("SELECT value FROM settings WHERE key = 'archive_dest_root'").get()
      assert.ok(dest, 'archive_dest_root seed exists')
      assert.equal(dest.value, '', 'archive_dest_root seed is empty (unset, UI guides setup)')

      // 幂等：显式重复执行 003 的种子语句不覆盖用户已设值
      db.prepare("UPDATE settings SET value = 'D:\\MyVault' WHERE key = 'vault_path'").run()
      db.exec(
        "INSERT INTO settings (key, value) SELECT 'vault_path', 'C:\\Users\\sakuya\\SkillVault' WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'vault_path')",
      )
      const vaultAfter = db.prepare("SELECT value FROM settings WHERE key = 'vault_path'").get()
      assert.equal(vaultAfter.value, 'D:\\MyVault', 'user-set vault_path survives re-seeding')
    } finally {
      db.close()
    }
  }, 'fast')

  // 44. 真库只读断言：真实导入结果落库（skill_agents / archive_runs）。
  // 依赖本机已真实执行过 `node scripts/migrate-legacy.mjs`；真库缺失时打 SKIP note
  // 不伪造数据（step4 同款容错）。
  registerCase('s1-44: real-db readonly assertion — skill_agents >= 1 and archive_runs >= 1 after real import', async () => {
    const { existsSync } = await import('node:fs')
    const paths = await import(new URL('../src/main/core/paths.ts', import.meta.url).href)
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)

    const savedHome = process.env.DEVHUB_HOME
    delete process.env.DEVHUB_HOME
    let db = null
    try {
      const dbPath = paths.getDbPath()
      if (!existsSync(dbPath)) {
        envSkipNote(`real DevHub DB not found at ${dbPath}; run node scripts/migrate-legacy.mjs first`)
        return
      }
      db = dbModule.openDatabase(dbPath) // 只读用途：只跑 SELECT
      const migrated = Number(db.prepare('PRAGMA user_version').get().user_version)
      // AC2 批次就地更新（docs/13 §3 授权的同一模式）：004 存在后真实库一经任何
      // 进程打开即前移到 4，本断言跟随最新版本 3 → 4。
      // CP1 批次就地更新（docs/22 §2 授权的同一模式）：008 落地后跟随最新版本 6 → 8
      // （007=LR1 序号跳过；真实库在新版进程首次打开后前移到 8）。
      assert.equal(migrated, 8, `real db at user_version 8, got ${migrated} (CP1 批次就地更新 6→8)`)
      const agents = Number(db.prepare('SELECT COUNT(*) AS c FROM skill_agents').get().c)
      const runs = Number(db.prepare('SELECT COUNT(*) AS c FROM archive_runs').get().c)
      assert.ok(agents >= 1, `real import landed skill_agents rows, got ${agents}`)
      assert.ok(runs >= 1, `real import landed archive_runs rows, got ${runs}`)
      const needsRekey = Number(db.prepare('SELECT COUNT(*) AS c FROM apihub_profiles WHERE needs_rekey = 1').get().c)
      const dest = db.prepare("SELECT value FROM settings WHERE key = 'archive_dest_root'").get()
      console.log(
        `    real-db sample: skill_agents=${agents} archive_runs=${runs} apihub_needs_rekey=${needsRekey} archive_dest_root=${dest ? JSON.stringify(dest.value) : 'missing'}`,
      )
    } finally {
      if (db !== null) db.close()
      if (savedHome === undefined) delete process.env.DEVHUB_HOME
      else process.env.DEVHUB_HOME = savedHome
    }
  })

  // ------------------------------------------------------------------
  // S2 批次：Skills 管理核心（skillService + skills/* 子模块 + 14 条 IPC channel）
  // 写库用例全部 DEVHUB_HOME 隔离 + 夹具 vault；真机用例只读（step4 容错同款）。
  // ------------------------------------------------------------------

  /** S2 夹具 vault：skills/<a|b>/SKILL.md（含中文 frontmatter）+ agents/*.md；opts.git 时 init git 仓。 */
  async function buildS2VaultFixture(prefix, opts = {}) {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)

    const root = mkdtempSync(join(tmpdir(), prefix))
    const vault = join(root, 'SkillVault')
    const skillsDir = join(vault, 'skills')
    const agentsVaultDir = join(vault, 'agents')
    mkdirSync(join(skillsDir, 'alpha-skill'), { recursive: true })
    mkdirSync(join(skillsDir, 'beta-tool'), { recursive: true })
    mkdirSync(agentsVaultDir, { recursive: true })
    writeFileSync(
      join(skillsDir, 'alpha-skill', 'SKILL.md'),
      '---\nname: alpha-skill\ndescription: 数学建模竞赛全自动交付技能：审题、建模、求解与论文交付\n---\n\n# Alpha\nbody\n',
    )
    writeFileSync(join(skillsDir, 'beta-tool', 'SKILL.md'), '---\nname: beta-tool\ndescription: Beta does things\n---\nbody\n')
    writeFileSync(join(agentsVaultDir, 'agent-one.md'), '# agent one\n')
    writeFileSync(join(agentsVaultDir, 'agent-two.md'), '# agent two\n')
    if (opts.git === true) {
      const init = await run('git', ['init', vault])
      assert.equal(init.code, 0, `fixture vault git init: ${init.stderr}`)
    }
    return { root, vault, skillsDir, agentsVaultDir }
  }

  /** 夹具 agent：skillsDir 指向临时目录（真实建目录），include 全包含。 */
  async function makeFixtureAgent(name, skillsDir, agentsDir) {
    const { mkdirSync } = await import('node:fs')
    const svc = await import(new URL('../src/main/services/skillService.ts', import.meta.url).href)
    mkdirSync(skillsDir, { recursive: true })
    return svc.upsertAgent({
      name,
      platform: 'windows',
      skillsDir,
      ...(agentsDir !== undefined ? { agentsDir } : {}),
      include: ['*'],
    })
  }

  // 45. scanVault：夹具 2 skill（含中文 frontmatter）→ skills 表镜像正确、重复扫描幂等
  registerCase('s2-45: scanVault mirrors fixture vault (Chinese frontmatter) into skills table and is idempotent', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/skillService.ts', import.meta.url).href)

    await makeTempHome('devhub-s2-45-')
    const fx = await buildS2VaultFixture('devhub-s2-45-vault-', { git: true })
    try {
      settings.setSetting('vault_path', fx.vault)

      const report = svc.scanVault()
      assert.equal(report.vaultOk, true, `fixture vault healthy, issues=${JSON.stringify(report.issues)}`)
      assert.equal(report.skills.length, 2, `2 skills scanned, got ${JSON.stringify(report.skills.map((s) => s.name))}`)
      const alpha = report.skills.find((s) => s.name === 'alpha-skill')
      assert.ok(alpha, 'alpha-skill present')
      assert.ok(alpha.description.includes('数学建模竞赛全自动交付技能'), `Chinese description parsed, got ${JSON.stringify(alpha.description)}`)
      assert.equal(report.vaultPath, fx.vault, 'report carries the settings vault_path')

      // DB 镜像：行数、vault_rel_path、frontmatter_json、description
      const db = dbModule.getDatabase()
      const rows = db.prepare('SELECT * FROM skills ORDER BY name').all()
      assert.equal(rows.length, 2, '2 mirrored rows')
      const alphaRow = rows.find((r) => r.name === 'alpha-skill')
      assert.equal(alphaRow.vault_rel_path, 'skills/alpha-skill', 'vault_rel_path')
      assert.equal(alphaRow.source_path, null, 'vault mirror rows keep source_path NULL')
      assert.ok(alphaRow.description.includes('数学建模'), 'description column populated')
      assert.equal(JSON.parse(alphaRow.frontmatter_json).name, 'alpha-skill', 'frontmatter_json round-trip')

      // 幂等：重复扫描行数不变、字段不变
      const before = JSON.stringify(rows)
      svc.scanVault()
      const rows2 = db.prepare('SELECT * FROM skills ORDER BY name').all()
      assert.equal(rows2.length, 2, 'rescan keeps 2 rows (upsert, no dup)')
      const stable = rows2.map((r) => ({ ...r, id: 0, created_at: 0, updated_at: 0 }))
      const stableBefore = JSON.parse(before).map((r) => ({ ...r, id: 0, created_at: 0, updated_at: 0 }))
      assert.deepEqual(stable, stableBefore, 'rescan produces identical mirrored content')
    } finally {
      dbModule.closeDatabase()
    }
  })

  // 46. linkStates + toggle：missing → link → linked（真 junction）→ unlink → missing；real-dir 拒绝
  registerCase('s2-46: linkStates + toggleLink lifecycle — missing/link(junction)/unlink, real-dir refused with structured error', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/skillService.ts', import.meta.url).href)
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    await makeTempHome('devhub-s2-46-')
    const fx = await buildS2VaultFixture('devhub-s2-46-vault-')
    const agentSkills = mkdtempSync(join(tmpdir(), 'devhub-s2-46-agent-'))
    try {
      settings.setSetting('vault_path', fx.vault)
      svc.scanVault()
      const agent = await makeFixtureAgent('fixture-win', agentSkills)

      // 初始：missing
      const initial = await svc.linkStates()
      const view = initial.agents.find((a) => a.id === agent.id)
      assert.ok(view, 'fixture agent in linkStates result')
      assert.equal(view.links['alpha-skill'], 'missing', 'initial state missing')
      assert.equal(view.links['beta-tool'], 'missing', 'initial state missing (beta)')
      assert.equal(view.counts.missing, 2, 'counts.missing = 2')

      // 缓存回写：skill_links 出现 2 行 missing
      const db = dbModule.getDatabase()
      const cached = db.prepare('SELECT state FROM skill_links WHERE agent_id = ?').all(agent.id)
      assert.equal(cached.length, 2, 'skill_links cache rewritten for the agent')

      // link → linked（fs.readlink 验证真 junction）
      const linked = await svc.toggleLink(agent.id, 'alpha-skill', true, true)
      assert.equal(linked.state, 'linked', 'toggle enable → linked')
      assert.equal(linked.changed, true, 'changed=true')
      const linkPath = join(agentSkills, 'alpha-skill')
      const lstat = (await import('node:fs')).lstatSync(linkPath)
      assert.ok(lstat.isSymbolicLink(), 'link path is a junction/symlink (lstat)')
      const target = (await import('node:fs')).readlinkSync(linkPath)
      const normalized = target.replace(/^\\\?\\/, '').replace(/\\/g, '/').toLowerCase()
      assert.ok(normalized.endsWith('skillvault/skills/alpha-skill'), `junction resolves into the vault, got ${target}`)
      // 悬空解析验证：目标真实存在（statSync 穿透 junction）
      assert.ok((await import('node:fs')).existsSync(join(linkPath, 'SKILL.md')), 'SKILL.md reachable through the junction')

      // 不带 confirmed → confirmRequired（CONFIRM_REQUIRED 语义）
      const confirmGate = await svc.toggleLink(agent.id, 'beta-tool', true)
      assert.equal(confirmGate.confirmRequired, true, 'without confirmed the service asks for confirmation')
      assert.equal(confirmGate.state, 'missing', 'confirm branch reports current state')

      // unlink → missing（仅删链接本体）
      const unlinked = await svc.toggleLink(agent.id, 'alpha-skill', false, true)
      assert.equal(unlinked.state, 'missing', 'toggle disable → missing')
      assert.ok(!(await import('node:fs')).existsSync(linkPath), 'link body removed')

      // real-dir 拒绝：目标放真实目录 → 结构化错误且目录未动
      ;(await import('node:fs')).mkdirSync(linkPath, { recursive: true })
      ;(await import('node:fs')).writeFileSync(join(linkPath, 'user-content.txt'), 'precious\n')
      let refused = null
      try {
        await svc.toggleLink(agent.id, 'alpha-skill', true, true)
      } catch (err) {
        refused = err
      }
      assert.ok(refused !== null, 'toggle onto real-dir must throw ServiceError')
      assert.equal(refused.code, 'LINK_CONFLICT', `structured LINK_CONFLICT code, got ${refused.code}`)
      assert.ok(
        (await import('node:fs')).existsSync(join(linkPath, 'user-content.txt')),
        'real directory is untouched (永不自动处理)',
      )
      // disable 对 real-dir 同样拒绝
      let refusedDisable = null
      try {
        await svc.toggleLink(agent.id, 'alpha-skill', false, true)
      } catch (err) {
        refusedDisable = err
      }
      assert.equal(refusedDisable?.code, 'LINK_CONFLICT', 'disable also refuses real-dir')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 47. import：临时源目录 → vault 出现新 skill、源目录变 junction、逐字节一致、agent 建链、git commit
  registerCase('s2-47: importSkill — copy/verify/delete-source/junction/commit pipeline with agent linking', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/skillService.ts', import.meta.url).href)
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    await makeTempHome('devhub-s2-47-')
    const fx = await buildS2VaultFixture('devhub-s2-47-vault-', { git: true })
    const agentSkills = mkdtempSync(join(tmpdir(), 'devhub-s2-47-agent-'))
    // 夹具 vault 已是 git 仓：补本地身份（导入流水线的 commit 步骤真实执行）
    await run('git', ['-C', fx.vault, 'config', 'user.name', 'DevHub Smoke'])
    await run('git', ['-C', fx.vault, 'config', 'user.email', 'smoke@devhub.invalid'])

    const sourceDir = join(mkdtempSync(join(tmpdir(), 'devhub-s2-47-src-')), 'my-imported-skill')
    try {
      mkdirSync(join(sourceDir, 'scripts'), { recursive: true })
      writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: my-imported-skill\ndescription: 导入流水线夹具技能\n---\nbody\n')
      writeFileSync(join(sourceDir, 'scripts', 'run.mjs'), 'console.log("run")\n')

      settings.setSetting('vault_path', fx.vault)
      svc.scanVault()
      // include 用显式清单（非 ["*"]）：导入后白名单应自动补齐新 skill 名
      const agent = await svc.upsertAgent({
        name: 'fixture-win',
        platform: 'windows',
        skillsDir: agentSkills,
        include: ['alpha-skill'],
      })

      // 先 plan（不带 confirmed）→ confirmRequired + plan
      const gated = await svc.importSkill(sourceDir, [agent.id])
      assert.equal(gated.confirmRequired, true, 'import without confirmed returns the plan')
      assert.equal(gated.plan.ok, true, `plan ok, error=${gated.plan.error ?? ''}`)
      assert.equal(gated.plan.skillName, 'my-imported-skill', 'plan skill name from basename')
      assert.equal(gated.plan.frontmatter?.description, '导入流水线夹具技能', 'plan frontmatter preview')

      const result = await svc.importSkill(sourceDir, [agent.id], true)

      // vault 出现新 skill、逐字节一致
      const vaultCopy = join(fx.vault, 'skills', 'my-imported-skill')
      assert.ok(existsSync(join(vaultCopy, 'SKILL.md')) && existsSync(join(vaultCopy, 'scripts', 'run.mjs')), 'vault copy complete')
      assert.deepEqual(
        readFileSync(join(vaultCopy, 'SKILL.md')),
        readFileSync(join(sourceDir, 'SKILL.md')),
        'SKILL.md byte-identical (through the new junction)',
      )
      assert.deepEqual(
        readFileSync(join(vaultCopy, 'scripts', 'run.mjs')),
        readFileSync(join(sourceDir, 'scripts', 'run.mjs')),
        'script file byte-identical (source read through the new junction)',
      )

      // 源目录被删 → 原位置变成 junction 指向 vault
      const st = (await import('node:fs')).lstatSync(sourceDir)
      assert.ok(st.isSymbolicLink(), 'source location is now a junction (real dir deleted first)')
      const linkTarget = (await import('node:fs')).readlinkSync(sourceDir).replace(/\\/g, '/').toLowerCase()
      assert.ok(linkTarget.endsWith('skillvault/skills/my-imported-skill'), `junction → vault copy, got ${linkTarget}`)

      // agent 建链 + include 白名单补齐
      const agentLink = join(agentSkills, 'my-imported-skill')
      assert.ok((await import('node:fs')).lstatSync(agentLink).isSymbolicLink(), 'agent skillsDir junction created')
      const db = dbModule.getDatabase()
      const agentRow = db.prepare('SELECT include_json FROM skill_agents WHERE id = ?').get(agent.id)
      assert.ok(
        JSON.parse(agentRow.include_json).includes('my-imported-skill'),
        `include whitelist extended, got ${agentRow.include_json}`,
      )

      // skills 表镜像行出现
      const skillRow = db.prepare('SELECT * FROM skills WHERE name = ?').get('my-imported-skill')
      assert.ok(skillRow, 'skills table mirrored the imported skill')
      assert.equal(skillRow.vault_rel_path, 'skills/my-imported-skill', 'vault_rel_path')

      // vault git commit（静态前缀 + skill 名走 args）
      const log = await run('git', ['-C', fx.vault, 'log', '-1', '--format=%s'])
      assert.equal(log.code, 0, `git log: ${log.stderr}`)
      assert.ok(
        log.stdout.trim().startsWith('devhub: import my-imported-skill'),
        `commit message has static prefix + skill name, got ${JSON.stringify(log.stdout)}`,
      )

      // 链接态反馈
      assert.equal(result.links?.['fixture-win'], 'linked', 'per-agent link state reported')
    } finally {
      dbModule.closeDatabase()
    }
  })

  // 48. doctor/repair：构造 wrong-target → doctor 检出 → repair 重建 → linked；real-dir 返回需人工
  registerCase('s2-48: doctor detects wrong-target, repair rebuilds the junction; real-dir repair returns manualRequired', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/skillService.ts', import.meta.url).href)
    const { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join, resolve } = await import('node:path')

    await makeTempHome('devhub-s2-48-')
    const fx = await buildS2VaultFixture('devhub-s2-48-vault-')
    const agentSkills = mkdtempSync(join(tmpdir(), 'devhub-s2-48-agent-'))
    try {
      settings.setSetting('vault_path', fx.vault)
      svc.scanVault()
      const agent = await makeFixtureAgent('fixture-win', agentSkills)

      // 建链后破坏：junction 指向错误的 vault 路径（beta-tool）
      const linkPath = join(agentSkills, 'alpha-skill')
      symlinkSync(resolve(fx.skillsDir, 'beta-tool'), linkPath, 'junction')

      const doctorResult = await svc.doctor(agent.id)
      const item = doctorResult.items.find((i) => i.id === `wrong-target:fixture-win:alpha-skill`)
      assert.ok(item, `wrong-target item emitted, items=${JSON.stringify(doctorResult.items.map((i) => i.id))}`)
      assert.equal(item.fixable, true, 'wrong-target is fixable')
      assert.equal(item.fixId, 'relink', 'fixId relink')
      assert.equal(item.payload.linkPath, linkPath, 'fix payload linkPath')
      assert.equal(
        item.payload.vaultSkillDir?.toLowerCase(),
        join(fx.skillsDir, 'alpha-skill').toLowerCase(),
        'fix payload vault target',
      )

      // 确认门：不带 confirmed → confirmRequired
      const gated = await svc.repair(item.fixId, item.payload)
      assert.equal(gated.confirmRequired, true, 'repair requires confirmation first')

      const repaired = await svc.repair(item.fixId, item.payload, true)
      assert.ok(repaired.steps.length >= 1, 'repair steps logged')
      const after = await svc.linkStates(agent.id)
      assert.equal(after.agents[0].links['alpha-skill'], 'linked', 'repaired → linked (real junction to the right target)')
      assert.ok(existsSync(join(linkPath, 'SKILL.md')), 'SKILL.md reachable through the rebuilt junction')

      // real-dir 红线：repair 对真实目录返回 manualRequired，且目录原样
      rmSync(linkPath, { force: true })
      mkdirSync(linkPath, { recursive: true })
      const manual = await svc.repair('relink', item.payload, true)
      assert.equal(manual.manualRequired, true, 'real-dir repair returns manualRequired')
      assert.equal(manual.steps.length, 0, 'no destructive step executed')
      assert.ok(existsSync(linkPath), 'real dir untouched')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 49. agentsDir 硬链接模式：link 后 dev+ino 一致 → unlink 后清理（vault 文件不动）
  registerCase('s2-49: agentsDir hardlink sharing — enable makes dev+ino-identical files, disable cleans them up', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/skillService.ts', import.meta.url).href)
    const winLinks = await import(new URL('../src/main/services/skills/winLinks.ts', import.meta.url).href)
    const { mkdtempSync, mkdirSync, readdirSync, statSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    await makeTempHome('devhub-s2-49-')
    const fx = await buildS2VaultFixture('devhub-s2-49-vault-')
    const agentSkills = mkdtempSync(join(tmpdir(), 'devhub-s2-49-agent-'))
    const agentAgents = join(mkdtempSync(join(tmpdir(), 'devhub-s2-49-agents-')), 'agents')
    try {
      settings.setSetting('vault_path', fx.vault)
      svc.scanVault()
      const agent = await makeFixtureAgent('fixture-win', agentSkills, agentAgents)
      mkdirSync(agentAgents, { recursive: true })

      // 初始：真实空目录 → real-dir（非硬链接共享）
      const before = winLinks.agentsDirStateOf(fx.vault, agentAgents)
      assert.equal(before.state, 'real-dir', 'empty real dir starts as real-dir')

      // enable → 硬链接共享（同名同 inode）
      const enabled = await svc.setAgentsDirLink(agent.id, true)
      assert.equal(enabled.state, 'linked', `enable → linked, steps=${JSON.stringify(enabled.steps)}`)
      assert.equal(enabled.note, winLinks.AGENTS_DIR_HARDLINK_NOTE, 'linked note = 硬链接共享')
      for (const f of ['agent-one.md', 'agent-two.md']) {
        const a = statSync(join(fx.agentsVaultDir, f))
        const b = statSync(join(agentAgents, f))
        assert.equal(a.dev, b.dev, `${f} same dev`)
        assert.equal(a.ino, b.ino, `${f} same ino (hardlink)`)
        assert.ok(existsSync(join(fx.agentsVaultDir, f)), 'vault source intact')
      }
      const shared = winLinks.agentsDirStateOf(fx.vault, agentAgents)
      assert.equal(shared.state, 'linked', 'agentsDirStateOf recognizes the hardlink-shared form')

      // skill_links 缓存回写（该 agent 有 2 个 skill 行）
      const db = dbModule.getDatabase()
      const cached = db.prepare('SELECT state FROM skill_links WHERE agent_id = ?').all(agent.id)
      assert.equal(cached.length, 2, 'link cache rewritten after agentsDir repair')

      // disable → 硬链接清理（仅删与 vault 同 inode 的文件本体），vault 完整保留
      const disabled = await svc.setAgentsDirLink(agent.id, false)
      assert.equal(disabled.state, 'real-dir', 'after cleanup the dir is a plain real dir again')
      const leftover = readdirSync(agentAgents).filter((f) => f.toLowerCase().endsWith('.md'))
      assert.equal(leftover.length, 0, `hardlink files cleaned, got ${JSON.stringify(leftover)}`)
      assert.ok(existsSync(join(fx.agentsVaultDir, 'agent-one.md')), 'vault agent file survives')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 50. handlers 注册：新 channels 全部入白名单且 dispatch 可达（unknown → CHANNEL_NOT_ALLOWED）
  registerCase('s2-50: skills channels registered and dispatchable; strict payload validation; unknown folds to CHANNEL_NOT_ALLOWED', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const channels = await import(new URL('../src/shared/channels.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)

    const registry = handlers.createHandlerRegistry({ appVersion: 's2-smoke' })
    const skillChannels = channels.IPC_CHANNELS.filter((c) => c.startsWith('skills:'))
    assert.equal(skillChannels.length, 14, `14 skills channels whitelisted, got ${JSON.stringify(skillChannels)}`)
    for (const ch of skillChannels) {
      assert.ok(typeof registry[ch] === 'function', `${ch} has a registered handler`)
    }

    await makeTempHome('devhub-s2-50-')
    try {
      // dispatch 可达：skills:list 空库 → ok:true（空清单）
      const listed = await handlers.dispatchGatewayRequest(registry, { channel: 'skills:list', payload: {} })
      assert.equal(listed.ok, true, 'skills:list dispatches')
      assert.deepEqual(listed.data.skills, [], 'empty skills list on a fresh home')

      // CONFIRM_REQUIRED：sync 不带 confirmed → 结构化确认分支（不执行）
      const gated = await handlers.dispatchGatewayRequest(registry, { channel: 'skills:sync', payload: {} })
      assert.equal(gated.ok, true, 'skills:sync dispatches')
      assert.equal(gated.data.confirmRequired, true, 'sync without confirmed asks for confirmation')

      // 严格校验：toggleLink 缺 enable → BAD_PAYLOAD；agent.remove 非法 id → BAD_PAYLOAD
      const badToggle = await handlers.dispatchGatewayRequest(registry, {
        channel: 'skills:toggleLink',
        payload: { agentId: 1, skill: 'x' },
      })
      assert.equal(badToggle.ok, false)
      assert.equal(badToggle.error.code, 'BAD_PAYLOAD', 'toggleLink without enable rejected')
      const badRemove = await handlers.dispatchGatewayRequest(registry, { channel: 'skills:agent.remove', payload: { id: 0 } })
      assert.equal(badRemove.ok, false)
      assert.equal(badRemove.error.code, 'BAD_PAYLOAD', 'agent.remove with id=0 rejected')
      const badImport = await handlers.dispatchGatewayRequest(registry, {
        channel: 'skills:import',
        payload: { sourceDir: '', confirmed: false },
      })
      assert.equal(badImport.ok, false)
      assert.equal(badImport.error.code, 'BAD_PAYLOAD', 'import with empty sourceDir rejected')

      // unknown → CHANNEL_NOT_ALLOWED（网关合同不变）
      const unknown = await handlers.dispatchGatewayRequest(registry, { channel: 'skills:not_a_channel', payload: {} })
      assert.equal(unknown.ok, false)
      assert.equal(unknown.error.code, 'CHANNEL_NOT_ALLOWED', 'off-whitelist channel rejected')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 51. （真机只读）scanVault 真库：vault_path 下 4 skill 入库与 S1 导入一致
  registerCase('s2-51: real-db readonly assertion — 4+ vault-mirrored skills, no duplicate names (S1 import intact)', async () => {
    const { existsSync } = await import('node:fs')
    const paths = await import(new URL('../src/main/core/paths.ts', import.meta.url).href)
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)

    const savedHome = process.env.DEVHUB_HOME
    delete process.env.DEVHUB_HOME
    let db = null
    try {
      const dbPath = paths.getDbPath()
      if (!existsSync(dbPath)) {
        envSkipNote(`real DevHub DB not found at ${dbPath}; run node scripts/migrate-legacy.mjs first`)
        return
      }
      db = dbModule.openDatabase(dbPath) // 只读用途：只跑 SELECT
      const rows = db
        .prepare('SELECT name, vault_rel_path, description FROM skills WHERE vault_rel_path IS NOT NULL')
        .all()
      assert.ok(rows.length >= 4, `expected >=4 vault-mirrored skills, got ${rows.length}`)
      const names = rows.map((r) => r.name)
      assert.equal(new Set(names).size, names.length, `no duplicate skill names, got ${JSON.stringify(names)}`)
      for (const expected of ['hatch-pet', 'math-modeling', 'micu-gpt-image', 'migrate-subagents']) {
        const row = rows.find((r) => r.name === expected)
        assert.ok(row, `S1-imported skill ${expected} present`)
        assert.equal(row.vault_rel_path, `skills/${expected}`, `${expected} vault_rel_path`)
      }
      const agents = Number(db.prepare('SELECT COUNT(*) AS c FROM skill_agents').get().c)
      assert.ok(agents >= 4, `skill_agents >= 4, got ${agents}`)
      console.log(`    real-db skills sample: ${names.sort().join(', ')} · agents=${agents}`)
    } finally {
      if (db !== null) db.close()
      if (savedHome === undefined) delete process.env.DEVHUB_HOME
      else process.env.DEVHUB_HOME = savedHome
    }
  })

  // 52. syncVault 降级：夹具非 git vault → 结构化降级不崩
  registerCase('s2-52: syncVault structured degradation on a non-git fixture vault (no crash, reason reported)', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/skillService.ts', import.meta.url).href)

    await makeTempHome('devhub-s2-52-')
    const fx = await buildS2VaultFixture('devhub-s2-52-vault-')
    try {
      settings.setSetting('vault_path', fx.vault) // 夹具 vault 无 .git

      // 确认门
      const gated = await svc.syncVault()
      assert.equal(gated.confirmRequired, true, 'sync without confirmed asks for confirmation')

      const result = await svc.syncVault(true)
      assert.equal(result.degraded, true, 'non-git vault degrades structurally')
      assert.ok(result.reason.includes('.git'), `reason mentions .git, got ${JSON.stringify(result.reason)}`)
      assert.deepEqual(result.steps, [], 'no sync steps executed')
      assert.deepEqual(result.conflicts, [], 'no conflicts fabricated')
      assert.equal(svc.lastSyncAt(), undefined, 'lastSyncAt not recorded on a degraded run')

      // vault 路径不存在同样降级
      settings.setSetting('vault_path', 'C:\\__definitely_missing_vault__\\x')
      const missing = await svc.syncVault(true)
      assert.equal(missing.degraded, true, 'missing vault degrades')
      assert.ok(missing.reason.includes('不存在'), `reason mentions the missing path, got ${JSON.stringify(missing.reason)}`)
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // ------------------------------------------------------------------
  // S3 批次：ApiHub 接口中心 + 版本中心（docs/09 §6/§7/§9）
  // 写库/写文件用例全部夹具隔离（DEVHUB_HOME + 显式 homeDir/APIHUB_HOME 覆盖），
  // 真实 ~/.claude、~/.codex、~/.grok、~/.kimi-code、~/.zcode 全程零改动；
  // 真机探测用例（57/58）只读。
  // ------------------------------------------------------------------

  /** S3 夹具：独立 DB home + 独立 AI 配置 home（service deps.homeDir / APIHUB_HOME 注入）。 */
  async function makeS3Homes(prefix) {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const home = await makeTempHome(`${prefix}-home-`)
    const aiHome = mkdtempSync(join(tmpdir(), `${prefix}-aihome-`))
    const savedApihubHome = process.env.APIHUB_HOME
    process.env.APIHUB_HOME = aiHome
    return { home, aiHome, restore: () => {
      if (savedApihubHome === undefined) delete process.env.APIHUB_HOME
      else process.env.APIHUB_HOME = savedApihubHome
    } }
  }

  /** 夹具 key（已知尾 4 位，供 mask / 红线断言）。 */
  const S3_KEY = 'sk-devhub-smoke-SECRET-4321'

  // 53. crypto 注入：plaintext crypto 下 blob 落库为密文形态（≠明文）、读回一致、mask 正确
  registerCase('s3-53: injected plaintext crypto — blob sealed (≠ plaintext), roundtrip equal, mask tail-4', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const keyStore = await import(new URL('../src/main/services/apihub/keyStore.ts', import.meta.url).href)
    const store = await import(new URL('../src/main/services/apihub/profileStore.ts', import.meta.url).href)

    await makeTempHome('devhub-s3-53-')
    try {
      // maskKey：唯一对外投影形态（尾 4 位 + 长度）
      assert.deepEqual(keyStore.maskKey(S3_KEY), { tail: '4321', len: S3_KEY.length })

      const crypto = keyStore.plaintextKeyCrypto()
      assert.equal(crypto.plainStore, true, 'plaintext impl marks plainStore')

      const view = await store.upsertProfile(
        { adapterId: 'claude-cli', name: 'smoke-key', fields: { baseUrl: 'https://api.smoke.test' } },
        S3_KEY,
        crypto,
      )
      assert.equal(view.apiKeyTail, '4321', 'view tail is mask only')
      assert.equal(view.apiKeyLen, S3_KEY.length, 'view len')
      assert.equal(view.plainStore, true, 'plainStore flagged on the view')
      assert.equal(JSON.stringify(view).includes(S3_KEY), false, 'view never carries the full key')

      // 落库形态：envelope JSON 的 sealed = base64(plain) ≠ 明文；全值不出现在 blob
      const db = dbModule.getDatabase()
      const row = db.prepare('SELECT encrypted_blob FROM apihub_profiles WHERE id = ?').get(view.id)
      const blob = Buffer.from(row.encrypted_blob).toString('utf8')
      assert.equal(blob.includes(S3_KEY), false, 'blob never contains the plaintext key')
      const envelope = JSON.parse(blob)
      assert.equal(envelope.v, 1, 'envelope version')
      assert.equal(envelope.sealed, Buffer.from(S3_KEY, 'utf8').toString('base64'), 'sealed = injected crypto output')
      assert.notEqual(envelope.sealed, S3_KEY, 'sealed differs from plaintext')
      assert.equal(envelope.plainStore, true, 'envelope carries plainStore flag')

      // 读回一致
      const listed = await store.listProfileViews('claude-cli', crypto)
      assert.equal(listed.length, 1)
      assert.equal(listed[0].apiKeyTail, '4321')
      assert.deepEqual(listed[0].fields, { baseUrl: 'https://api.smoke.test' }, 'fields roundtrip')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 54. profiles CRUD + needsRekey 档案语义（不可解 blob → 禁止切换 + 引导重填；重录后解除）
  registerCase('s3-54: profiles CRUD and needsRekey semantics — undecryptable blob blocks switch, re-entering the key clears it', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const keyStore = await import(new URL('../src/main/services/apihub/keyStore.ts', import.meta.url).href)
    const store = await import(new URL('../src/main/services/apihub/profileStore.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/apihub/apihubService.ts', import.meta.url).href)

    await makeTempHome('devhub-s3-54-')
    try {
      // 可解密密钥的测试 crypto；对老 DPAPI 密文（LEGACY-* 前缀）如实失败（模拟换机后不可解）
      const crypto = {
        plainStore: false,
        encrypt: (plain) => Buffer.from(plain, 'utf8').toString('base64'),
        decrypt: (sealed) => {
          if (sealed.startsWith('LEGACY')) throw new Error('DPAPI blob not decryptable in this context')
          return Buffer.from(sealed, 'base64').toString('utf8')
        },
      }

      // CRUD：新增 → 编辑（不带 key，blob 保留）→ 名称冲突结构化错误 → 删除
      const created = await store.upsertProfile(
        { adapterId: 'grok', name: 'grok-a', fields: { modelId: 'grok-4', baseUrl: 'https://g.smoke.test', contextWindow: '500000', apiBackend: 'responses' } },
        S3_KEY,
        crypto,
      )
      const edited = await store.upsertProfile(
        { adapterId: 'grok', id: created.id, name: 'grok-a-renamed', fields: { modelId: 'grok-4', baseUrl: 'https://g2.smoke.test', contextWindow: '500000', apiBackend: 'responses' } },
        undefined,
        crypto,
      )
      assert.equal(edited.name, 'grok-a-renamed')
      assert.equal(edited.fields.baseUrl, 'https://g2.smoke.test')
      assert.equal(edited.apiKeyTail, '4321', 'edit without key keeps the sealed blob (tail unchanged)')
      let dup = null
      try {
        await store.upsertProfile({ adapterId: 'kimi', name: 'grok-a-renamed', fields: {} }, S3_KEY, crypto)
      } catch (err) {
        dup = err
      }
      assert.equal(dup?.code, 'DB_ERROR', 'global UNIQUE name conflict is a structured error')
      assert.equal(await store.removeProfile('grok', created.id).deleted, true, 'delete by provider+id')

      // needs_rekey 占位（S1 导入形态）：legacy blob 无法解密 → needsRekey=true、tail null、切换被拒
      const db = dbModule.getDatabase()
      const legacyBlob = Buffer.from(
        JSON.stringify({ v: 1, sealed: 'LEGACY-DPAPI-BLOB-S3', fields: { baseUrl: 'https://legacy.smoke.test' } }),
        'utf8',
      )
      db.prepare(
        "INSERT INTO apihub_profiles (name, provider, encrypted_blob, needs_rekey, created_at, updated_at) VALUES ('legacy-prof', 'claude-cli', ?, 1, 0, 0)",
      ).run(legacyBlob)

      const listed = await store.listProfileViews('claude-cli', crypto)
      const legacy = listed.find((p) => p.name === 'legacy-prof')
      assert.ok(legacy, 'legacy placeholder listed')
      assert.equal(legacy.needsRekey, true, 'needsRekey flagged')
      assert.equal(legacy.apiKeyTail, null, 'undecryptable tail stays null (绝不伪造)')
      assert.equal(legacy.apiKeyLen, null)

      let refused = null
      try {
        await svc.switchProfile('claude-cli', legacy.id, true, { homeDir: 'C:\\__s3_54_unused__', crypto })
      } catch (err) {
        refused = err
      }
      assert.equal(refused?.code, 'DEGRADED', 'switch on needs_rekey profile is refused')
      assert.ok(refused?.message.includes('needs_rekey'), 'refusal message guides re-entry')

      // 重录 key（编辑带 apiKeyPlain）→ needs_rekey 清零 → 可切换
      await store.upsertProfile(
        { adapterId: 'claude-cli', id: legacy.id, name: 'legacy-prof', fields: { baseUrl: 'https://legacy.smoke.test' } },
        S3_KEY,
        crypto,
      )
      const row = db.prepare('SELECT needs_rekey FROM apihub_profiles WHERE id = ?').get(legacy.id)
      assert.equal(Number(row.needs_rekey), 0, 're-entering the key clears needs_rekey')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 55. 适配器写-读回环：夹具 AI home 下 claude-cli 与 codex 写目标文件 → 读回一致 → 备份存在
  registerCase('s3-55: adapter write/read loop in fixture AI home — claude-cli & codex roundtrip with backups', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const keyStore = await import(new URL('../src/main/services/apihub/keyStore.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/apihub/apihubService.ts', import.meta.url).href)
    const { mkdirSync, writeFileSync, readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const fx = await import(new URL('../src/main/services/apihub/transforms.ts', import.meta.url).href)

    const homes = await makeS3Homes('devhub-s3-55')
    try {
      const crypto = keyStore.plaintextKeyCrypto()
      // 预置既有文件 → 验证「其余键零改动 + 备份存在且内容为原文件」
      mkdirSync(join(homes.aiHome, '.claude'), { recursive: true })
      writeFileSync(join(homes.aiHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] }, env: { OTHER: 'keep' } }, null, 2) + '\n')

      const saved = await svc.saveProfile(
        { adapterId: 'claude-cli', name: 'cc-prof', fields: { baseUrl: 'https://cc.smoke.test' } },
        S3_KEY,
        { homeDir: homes.aiHome, crypto },
      )
      const result = await svc.switchProfile('claude-cli', saved.profile.id, true, { homeDir: homes.aiHome, crypto })
      assert.equal(result.failed, undefined, `switch ok, error=${result.error ?? ''}`)

      // 读回：env 两键写入、既有键保留；key 全值只出现在目标文件（允许位置）
      const settingsText = readFileSync(join(homes.aiHome, '.claude', 'settings.json'), 'utf8')
      const parsed = JSON.parse(settingsText)
      assert.equal(parsed.env.ANTHROPIC_BASE_URL, 'https://cc.smoke.test')
      assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, S3_KEY, 'key plaintext lands in the target file only')
      assert.equal(parsed.permissions.allow[0], 'Bash', 'existing keys preserved')
      assert.equal(parsed.env.OTHER, 'keep', 'unrelated env preserved')
      const display = fx.claudeParseEnv(settingsText)
      assert.equal(display.keyTail, '4321', 'read-back mask tail matches profile')

      // 备份存在且 = 原文件（含 OTHER 键、无 env.ANTHROPIC_AUTH_TOKEN）
      const claudeDir = readdirSync(join(homes.aiHome, '.claude')).filter((f) => f.startsWith('settings.json.bak_'))
      assert.equal(claudeDir.length, 1, `one backup created, got ${JSON.stringify(claudeDir)}`)
      const backup = JSON.parse(readFileSync(join(homes.aiHome, '.claude', claudeDir[0]), 'utf8'))
      assert.equal(backup.env.OTHER, 'keep', 'backup preserves the pre-switch unrelated env')
      assert.equal(backup.env.ANTHROPIC_AUTH_TOKEN, undefined, 'backup is the pre-switch file (no token yet)')

      // codex 双文件回环
      const codexProf = await svc.saveProfile(
        { adapterId: 'codex', name: 'codex-prof', fields: { providerId: 'smoke-relay', baseUrl: 'https://codex.smoke.test/v1', wireApi: 'responses' } },
        S3_KEY,
        { homeDir: homes.aiHome, crypto },
      )
      const codexResult = await svc.switchProfile('codex', codexProf.profile.id, true, { homeDir: homes.aiHome, crypto })
      assert.equal(codexResult.failed, undefined, `codex switch ok, error=${codexResult.error ?? ''}`)
      assert.equal(codexResult.files.length, 2, 'codex writes two target files')
      const auth = JSON.parse(readFileSync(join(homes.aiHome, '.codex', 'auth.json'), 'utf8'))
      assert.equal(auth.OPENAI_API_KEY, S3_KEY)
      assert.equal(auth.auth_mode, 'apikey')
      const configText = readFileSync(join(homes.aiHome, '.codex', 'config.toml'), 'utf8')
      const cfg = fx.codexParseConfig(configText)
      assert.equal(cfg.modelProvider, 'smoke-relay')
      assert.equal(cfg.baseUrl, 'https://codex.smoke.test/v1')
      assert.equal(cfg.wireApi, 'responses')
    } finally {
      homes.restore()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 56. 切换流：两段式 + 只读文件写入失败 → 全量回滚恢复原内容
  registerCase('s3-56: two-phase switch (impacts then confirmed); read-only target file → structured failed result with full rollback', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const keyStore = await import(new URL('../src/main/services/apihub/keyStore.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/apihub/apihubService.ts', import.meta.url).href)
    const { writeFileSync, readFileSync, chmodSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')

    const homes = await makeS3Homes('devhub-s3-56')
    try {
      const crypto = keyStore.plaintextKeyCrypto()
      const deps = {
        homeDir: homes.aiHome,
        crypto,
        probeProcesses: async (names) => names.map((n, i) => ({ pid: 4000 + i, name: n })), // 注入：稳定不杀真进程
      }

      const prof = await svc.saveProfile(
        { adapterId: 'codex', name: 'p1', fields: { providerId: 'prov-a', baseUrl: 'https://a.smoke.test/v1', wireApi: 'chat' } },
        S3_KEY,
        deps,
      )
      // 既有文件（回滚基准）
      const authPath = join(homes.aiHome, '.codex', 'auth.json')
      const configPath = join(homes.aiHome, '.codex', 'config.toml')
      mkdirSync(join(homes.aiHome, '.codex'), { recursive: true })
      writeFileSync(authPath, '{"OPENAI_API_KEY":"old-key","auth_mode":"apikey","extra":1}\n')
      writeFileSync(configPath, 'model_provider = "old"\n')

      // 第一段：不带 confirmed → confirmRequired + impacts（文件清单；codex 无预检进程 → 空）
      const gated = await svc.switchProfile('codex', prof.profile.id, undefined, deps)
      assert.equal(gated.confirmRequired, true, 'first phase asks for confirmation')
      assert.deepEqual(gated.impacts.files, [authPath, configPath], 'impacts lists the target files')
      assert.equal(gated.impacts.processes.length, 0, 'codex registers no pre-check processes (docs/09 §6.3: only zcode)')

      // zcode 预检：注入探测 → impacts 携带运行中进程（不触达真机进程）
      const zcProf = await svc.saveProfile(
        { adapterId: 'zcode', name: 'zc-prof', fields: { providerId: 'smoke-relay', providerName: 'Smoke Relay', baseURL: 'https://zcode.smoke.test/api/anthropic' } },
        S3_KEY,
        deps,
      )
      const zcGated = await svc.switchProfile('zcode', zcProf.profile.id, undefined, deps)
      assert.equal(zcGated.confirmRequired, true)
      assert.equal(zcGated.impacts.processes.length, 1, 'zcode impacts carries the probed process')
      assert.equal(zcGated.impacts.processes[0].name, 'ZCode.exe')
      assert.ok(zcGated.impacts.warning !== undefined, 'zcode impacts carries the restart warning')

      // killPids 红线：不在 impacts 探测结果内的 pid 拒绝终止
      let badKill = null
      try {
        await svc.switchProfile('zcode', zcProf.profile.id, true, { ...deps, killPids: [999999] })
      } catch (err) {
        badKill = err
      }
      assert.equal(badKill?.code, 'BAD_PAYLOAD', 'killPids outside the impacts list is refused')

      // 第二段：confirmed → 写入成功
      const ok = await svc.switchProfile('codex', prof.profile.id, true, deps)
      assert.equal(ok.failed, undefined)
      assert.deepEqual(ok.files.map((f) => f.rolledBack), [false, false], 'both files written cleanly')

      // 失败回滚：auth.json 置只读 → rename 失败 → 两文件全部回滚恢复原内容
      const prof2 = await svc.saveProfile(
        { adapterId: 'codex', name: 'p2', fields: { providerId: 'prov-b', baseUrl: 'https://b.smoke.test/v1', wireApi: 'chat' } },
        S3_KEY,
        deps,
      )
      // 回滚基准 = 失败尝试前的内容（prof1 成功切换后的状态）
      const beforeAuth = readFileSync(authPath, 'utf8')
      const beforeConfig = readFileSync(configPath, 'utf8')
      chmodSync(authPath, 0o444)
      let failedResult = null
      try {
        failedResult = await svc.switchProfile('codex', prof2.profile.id, true, deps)
      } finally {
        chmodSync(authPath, 0o666)
      }
      assert.ok(failedResult !== null, 'switch returned a result')
      assert.equal(failedResult.failed, true, 'read-only target yields a structured failed result')
      assert.equal(failedResult.files[0].rolledBack, true, 'failed file reported rolledBack')
      assert.equal(failedResult.files[1].rolledBack, true, 'the other target also rolled back from its backup')
      assert.equal(JSON.stringify(failedResult).includes(S3_KEY), false, 'failure payload carries no key plaintext')
      assert.equal(readFileSync(authPath, 'utf8'), beforeAuth, 'auth.json restored byte-for-byte to the pre-attempt state')
      assert.equal(readFileSync(configPath, 'utf8'), beforeConfig, 'config.toml restored byte-for-byte to the pre-attempt state')
    } finally {
      homes.restore()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 57.（真机只读）进程检测：explorer.exe 查询返回非空列表
  registerCase('s3-57: process probe — real explorer.exe query returns a non-empty list (read-only)', async () => {
    const svc = await import(new URL('../src/main/services/apihub/apihubService.ts', import.meta.url).href)
    const hits = await svc.findRunningProcesses(['explorer.exe'])
    if (hits.length === 0) {
      envSkipNote('no explorer.exe process at run time (transient host state)')
      return
    }
    assert.ok(hits.length >= 1, `expected >=1 explorer.exe hit, got ${JSON.stringify(hits)}`)
    assert.ok(hits.every((p) => Number.isInteger(p.pid) && p.pid > 0 && p.name.toLowerCase() === 'explorer.exe'), 'rows well-formed')
    console.log(`    s3-57 sample: ${JSON.stringify(hits.slice(0, 3))}`)
  })

  // 58.（真机只读检测，不更新）versions 检测：8 目标全跑，结构化结果 + version_targets 全量 upsert
  registerCase('s3-58: versions checkAll — all 8 catalog entries return structured statuses (real machine, detect only)', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/versionCenter/versionService.ts', import.meta.url).href)

    await makeTempHome('devhub-s3-58-')
    try {
      const result = await svc.checkAll()
      assert.equal(result.statuses.length, 8, `8 catalog entries checked, got ${result.statuses.length}`)
      const ids = result.statuses.map((s) => s.id)
      assert.deepEqual(
        [...ids].sort(),
        ['claude-code-npm', 'claude-code-winget', 'claude-desktop', 'codex-desktop', 'deepseek-harness', 'grok-cli', 'kimi-cli', 'zcode'],
        'catalog ids exactly per docs/09 §7.1',
      )
      const states = new Set(['up-to-date', 'upgradable', 'unknown', 'check-failed', 'detect-only'])
      for (const s of result.statuses) {
        assert.ok(states.has(s.state), `state enum for ${s.id}: ${s.state}`)
        assert.ok(['npm', 'winget', 'native', 'github'].includes(s.channelKind), `channelKind for ${s.id}`)
        assert.equal(typeof s.channel === 'string' && s.channel.length > 0, true, `channel label for ${s.id}`)
        assert.ok(s.installed === null || typeof s.installed === 'string', `installed null-or-string for ${s.id}`)
        assert.ok(s.latest === null || typeof s.latest === 'string', `latest null-or-string for ${s.id}`)
      }
      // 快照全量 upsert：8 行落库
      const db = dbModule.getDatabase()
      const rows = Number(db.prepare('SELECT COUNT(*) AS c FROM version_targets').get().c)
      assert.equal(rows, 8, 'version_targets upserted for all entries')
      console.log('    s3-58 real-machine snapshot:')
      for (const s of result.statuses) {
        console.log(
          `      ${s.id.padEnd(18)} ${s.state.padEnd(12)} installed=${s.installed ?? '—'} latest=${s.latest ?? '—'}${s.note ? ` · ${s.note.slice(0, 80)}` : ''}`,
        )
      }
    } finally {
      dbModule.closeDatabase()
    }
  })

  // 59. 更新 job 状态机：命令注入 seam（node -e 速成功/速失败）→ running→done / running→failed；
  //     选型说明：service 支持deps.updateCommandOverride seam（handlers 不透传），job 走真实 core/exec.run。
  registerCase('s3-59: update job state machine — injected fixture commands run through core/exec: running→done and running→failed', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const catalog = await import(new URL('../src/main/services/versionCenter/catalog.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/versionCenter/versionService.ts', import.meta.url).href)

    await makeTempHome('devhub-s3-59-')
    try {
      const entry = catalog.findCatalogEntry('kimi-cli')
      assert.ok(entry, 'kimi-cli catalog entry')

      // 速成功：node -e "process.exit(0)"
      const okJob = svc.startUpdateJob(entry, { updateCommandOverride: { command: process.execPath, args: ['-e', 'process.exit(0)'] } })
      assert.equal(okJob.status, 'running', 'job starts running')
      assert.ok(okJob.jobId.length > 0)
      let done = okJob
      for (let i = 0; i < 100 && done.status === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 100))
        done = svc.jobSnapshot(okJob.jobId)
      }
      assert.equal(done.status, 'done', `fast-success job must reach done, got ${done.status} · ${JSON.stringify(done.log)}`)
      assert.ok(done.log.some((l) => l.startsWith('$ ')), 'job log records the injected command line')
      assert.ok(done.log.some((l) => l.includes('重新检查')), 'done path re-checks the entry')

      // 速失败：node -e "process.exit(3)"
      const failJob = svc.startUpdateJob(entry, { updateCommandOverride: { command: process.execPath, args: ['-e', 'process.exit(3)'] } })
      let failed = failJob
      for (let i = 0; i < 100 && failed.status === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 100))
        failed = svc.jobSnapshot(failJob.jobId)
      }
      assert.equal(failed.status, 'failed', `fast-fail job must reach failed, got ${failed.status}`)
      assert.equal(failed.error !== undefined && failed.error.length > 0, true, 'failed job carries the structured error')

      // 未知 jobId → NOT_FOUND
      let missing = null
      try {
        svc.jobSnapshot('vc-nope')
      } catch (err) {
        missing = err
      }
      assert.equal(missing?.code, 'NOT_FOUND')
    } finally {
      dbModule.closeDatabase()
    }
  })

  // 60. handlers：新 channels 全部 dispatch 可达；provider 非法枚举 / 非法 id → BAD_PAYLOAD
  registerCase('s3-60: apihub/versions handlers dispatch; invalid provider enum and ids fold to BAD_PAYLOAD', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const channels = await import(new URL('../src/shared/channels.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)

    const registry = handlers.createHandlerRegistry({ appVersion: 's3-smoke' })
    const newChannels = channels.IPC_CHANNELS.filter((c) => c.startsWith('apihub:') || c.startsWith('versions:'))
    // 夜间#1 就地更新：versions:cancel 并入，10 → 11（主控任务书授权的同一模式）
    assert.equal(newChannels.length, 11, `11 apihub/versions channels whitelisted, got ${JSON.stringify(newChannels)}`)
    for (const ch of newChannels) {
      assert.ok(typeof registry[ch] === 'function', `${ch} has a registered handler`)
    }

    const homes = await makeS3Homes('devhub-s3-60')
    try {
      // dispatch 可达：apihub:adapters → 7 适配器（枚举完整：含 2 个 N/A）
      const adapters = await handlers.dispatchGatewayRequest(registry, { channel: 'apihub:adapters', payload: {} })
      assert.equal(adapters.ok, true, 'apihub:adapters dispatches')
      assert.equal(adapters.data.adapters.length, 7, '7 adapter entries')
      const na = adapters.data.adapters.filter((a) => a.available === false).map((a) => a.id)
      assert.deepEqual([...na].sort(), ['claude-desktop', 'deepseek'], 'N/A adapters keep the enum complete')
      for (const a of adapters.data.adapters) {
        if (a.available) assert.ok(a.targetPaths.every((p) => p.startsWith(homes.aiHome)), `target paths inside the fixture home for ${a.id}`)
      }

      // versions:list 空库 → 8 行 unknown
      const list = await handlers.dispatchGatewayRequest(registry, { channel: 'versions:list', payload: {} })
      assert.equal(list.ok, true, 'versions:list dispatches')
      assert.equal(list.data.targets.length, 8)

      // provider 非法枚举 → BAD_PAYLOAD
      for (const channel of ['apihub:current', 'apihub:profiles', 'apihub:deleteProfile', 'apihub:switch']) {
        const rejected = await handlers.dispatchGatewayRequest(registry, { channel, payload: { adapterId: 'not-a-provider', id: 1 } })
        assert.equal(rejected.ok, false, `${channel} rejects invalid adapterId`)
        assert.equal(rejected.error.code, 'BAD_PAYLOAD', `${channel} invalid enum folds to BAD_PAYLOAD`)
      }
      // profileId 非法 → BAD_PAYLOAD
      const badId = await handlers.dispatchGatewayRequest(registry, { channel: 'apihub:switch', payload: { adapterId: 'zcode', id: 0 } })
      assert.equal(badId.error.code, 'BAD_PAYLOAD', 'id must be a positive integer')
      // versions:update 非法 catalog id → BAD_PAYLOAD；versions:job 空 jobId → BAD_PAYLOAD
      const badUpdate = await handlers.dispatchGatewayRequest(registry, { channel: 'versions:update', payload: { id: 'nope' } })
      assert.equal(badUpdate.error.code, 'BAD_PAYLOAD', 'versions:update unknown id folds to BAD_PAYLOAD')
      const badJob = await handlers.dispatchGatewayRequest(registry, { channel: 'versions:job', payload: { jobId: '' } })
      assert.equal(badJob.error.code, 'BAD_PAYLOAD', 'versions:job empty jobId folds to BAD_PAYLOAD')

      // unknown → CHANNEL_NOT_ALLOWED（网关合同不变）
      const unknown = await handlers.dispatchGatewayRequest(registry, { channel: 'apihub:not_a_channel', payload: {} })
      assert.equal(unknown.error.code, 'CHANNEL_NOT_ALLOWED')
    } finally {
      homes.restore()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 61. 密钥红线：save/switch 全链路返回值与日志文件无明文 key（夹具 key 已知前缀，mask 尾 4 位在场）
  registerCase('s3-61: key red line — full-chain save/switch returns and the log file never contain the plaintext key', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const { readFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const paths = await import(new URL('../src/main/core/paths.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)

    const homes = await makeS3Homes('devhub-s3-61')
    try {
      const registry = handlers.createHandlerRegistry({ appVersion: 's3-smoke' })
      const envelopes = []

      // 全链路：saveProfile（经网关）→ switch 确认 → profiles 读回
      const saved = await handlers.dispatchGatewayRequest(registry, {
        channel: 'apihub:saveProfile',
        payload: { input: { adapterId: 'kimi', name: 'redline-prof', fields: { providerId: 'redline', modelId: 'kimi-k3', baseUrl: 'https://redline.smoke.test/v1', type: 'openai', thinkingEnabled: 'true' } }, apiKeyPlain: S3_KEY },
      })
      assert.equal(saved.ok, true, `saveProfile ok, error=${saved.ok ? '' : saved.error.message}`)
      envelopes.push(saved)

      // 切换走两段式（ impacts 确认段也在红线审计范围内）
      const gated = await handlers.dispatchGatewayRequest(registry, { channel: 'apihub:switch', payload: { adapterId: 'kimi', id: saved.data.profile.id } })
      assert.equal(gated.ok, true, 'switch impacts dispatch')
      envelopes.push(gated)
      const done = await handlers.dispatchGatewayRequest(registry, { channel: 'apihub:switch', payload: { adapterId: 'kimi', id: saved.data.profile.id, confirmed: true } })
      assert.equal(done.ok, true, `switch ok, error=${done.ok ? '' : done.error.message}`)
      envelopes.push(done)

      const listed = await handlers.dispatchGatewayRequest(registry, { channel: 'apihub:profiles', payload: { adapterId: 'kimi' } })
      envelopes.push(listed)
      const current = await handlers.dispatchGatewayRequest(registry, { channel: 'apihub:current', payload: { adapterId: 'kimi' } })
      envelopes.push(current)

      // 红线断言：所有返回 envelope 的 JSON 序列化不含 key 全值；tail '4321' 在场（mask 工作）
      for (const env of envelopes) {
        assert.equal(JSON.stringify(env).includes(S3_KEY), false, 'no full key in any returned envelope')
      }
      assert.equal(JSON.stringify(listed).includes('4321'), true, 'mask tail is present in the profiles projection')

      // 日志文件红线：DEVHUB_HOME/logs/devhub.log 不含 key 全值
      const logFile = join(paths.getLogDir(), 'devhub.log')
      if (existsSync(logFile)) {
        const logText = readFileSync(logFile, 'utf8')
        assert.equal(logText.includes(S3_KEY), false, 'log file never contains the plaintext key')
      }

      // DB blob 红线（handler 全链路后复核）
      const db = dbModule.getDatabase()
      const row = db.prepare('SELECT encrypted_blob FROM apihub_profiles WHERE name = ?').get('redline-prof')
      assert.equal(Buffer.from(row.encrypted_blob).toString('utf8').includes(S3_KEY), false, 'DB blob never contains the plaintext key')
    } finally {
      homes.restore()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // ==================================================================
  // S4 批次（docs/09 §8/§9）：Docker 视图 + WSL 监控并入（62-68 追加，
  // step1/step6 的 45→50 断言按 docs/09 §9 授权的同一模式就地更新）
  // ==================================================================

  // 62. docker channels：全部 dispatch 可达；非法 action 枚举 / 注入样式 name → BAD_PAYLOAD
  registerCase('s4-62: docker handlers dispatch; invalid action enum and injection-style container names fold to BAD_PAYLOAD', async () => {
    const channels = await import(new URL('../src/shared/channels.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const dockerAdapter = await import(new URL('../src/main/adapters/docker.ts', import.meta.url).href)

    const registry = handlers.createHandlerRegistry({ appVersion: 's4-smoke' })
    const dockerChannels = channels.IPC_CHANNELS.filter((c) => c.startsWith('docker:'))
    assert.deepEqual([...dockerChannels].sort(), ['docker:action', 'docker:logs', 'docker:overview'], '3 docker channels per docs/09 §9 naming')
    for (const ch of dockerChannels) {
      assert.ok(typeof registry[ch] === 'function', `${ch} has a registered handler`)
    }

    // overview dispatch：envelope 恒 ok（daemon down → 结构化降级数据；up → 真实数据）
    const info = await dockerAdapter.dockerInfo()
    const overview = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:overview', payload: {} })
    assert.equal(overview.ok, true, `docker:overview dispatches, error=${overview.ok ? '' : overview.error.message}`)
    assert.equal(overview.data.status.available, info.cliAvailable && info.daemonAvailable, 'status.available mirrors dockerInfo')
    assert.equal(Array.isArray(overview.data.containers), true, 'containers array present')
    assert.equal(typeof overview.data.images.count, 'number', 'images stats present')

    // 非法 action 枚举 → BAD_PAYLOAD（夜间#1 就地更新：remove 已是合法动作
    // （docs/09 §8.3 DOUBLE_CONFIRM 落地），从非法清单移出，正反断言见 nb1-150）
    for (const action of ['pause', 'rm', 'start; reboot', 'STOP', '']) {
      const rejected = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:action', payload: { name: 'web-1', action } })
      assert.equal(rejected.ok, false, `action ${JSON.stringify(action)} must be rejected`)
      assert.equal(rejected.error.code, 'BAD_PAYLOAD', `invalid action enum folds to BAD_PAYLOAD (got ${JSON.stringify(action)})`)
    }

    // 注入样式 name → BAD_PAYLOAD（空白/分号/引号/命令替换/前导连字符一律拒绝）
    for (const name of ['-9sh', 'a; rm -rf /', 'a b', 'a\nb', '$(id)', "x'--", 'a&&b', '`id`', '../etc']) {
      const rejected = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:action', payload: { name, action: 'stop' } })
      assert.equal(rejected.ok, false, `injection-style name ${JSON.stringify(name)} must be rejected`)
      assert.equal(rejected.error.code, 'BAD_PAYLOAD', `injection-style name folds to BAD_PAYLOAD (got ${JSON.stringify(name)})`)
    }

    // 合法形状 name：daemon down → 结构化降级（envelope ok）；daemon up 且容器不存在 → NOT_FOUND；均不崩
    const missing = await handlers.dispatchGatewayRequest(registry, {
      channel: 'docker:action',
      payload: { name: 'no-such-container-zz', action: 'stop', confirmed: true },
    })
    if (info.daemonAvailable) {
      assert.equal(missing.ok, false, 'daemon up + unknown container folds to NOT_FOUND')
      assert.equal(missing.error.code, 'NOT_FOUND')
    } else {
      assert.equal(missing.ok, true, 'daemon down degrades in-band')
      assert.equal(missing.data.ok, false, 'action not executed')
      assert.equal(missing.data.degraded, true, 'degraded flag set')
    }
  })

  // 63. logs 参数边界：tail>500 截到 500（纯函数 + 结果回显双断言）；负数/非整数 BAD_PAYLOAD
  registerCase('s4-63: docker logs param boundaries — tail>500 clamps to 500, negative/fractional rejected', async () => {
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const dockerService = await import(new URL('../src/main/services/dockerService.ts', import.meta.url).href)
    const dockerAdapter = await import(new URL('../src/main/adapters/docker.ts', import.meta.url).href)

    // 纯函数断言：clamp 与 argv 构造（不触 daemon，确定性）
    assert.equal(dockerService.clampLogsTail(501), 500, 'tail>500 clamps to 500')
    assert.equal(dockerService.clampLogsTail(999999), 500, 'huge tail clamps to 500')
    assert.equal(dockerService.clampLogsTail(0), 0, 'tail 0 passes through')
    assert.equal(dockerService.clampLogsTail(undefined), 200, 'default tail is 200')
    assert.deepEqual(dockerService.containerLogsArgs('web', 500), ['logs', '--tail', '500', 'web'], 'literal argv, name as a single arg')
    assert.deepEqual(dockerService.containerLogsArgs('web', 200, 3600), ['logs', '--tail', '200', '--since', '3600s', 'web'], 'since appended as seconds')
    assert.deepEqual(dockerService.containerActionArgs('restart', 'web'), ['restart', 'web'], 'action argv')
    assert.deepEqual(dockerService.containerActionArgs('stop', 'abc123'), ['stop', 'abc123'], 'no shell, no flags injection surface')

    const registry = handlers.createHandlerRegistry({ appVersion: 's4-smoke' })
    for (const tail of [-1, -100, 1.5, '200', null]) {
      const rejected = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:logs', payload: { name: 'web', tail } })
      assert.equal(rejected.ok, false, `tail ${JSON.stringify(tail)} must be rejected`)
      assert.equal(rejected.error.code, 'BAD_PAYLOAD', `bad tail folds to BAD_PAYLOAD (got ${JSON.stringify(tail)})`)
    }
    const badSince = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:logs', payload: { name: 'web', since: -5 } })
    assert.equal(badSince.error.code, 'BAD_PAYLOAD', 'negative since folds to BAD_PAYLOAD')

    const info = await dockerAdapter.dockerInfo()
    const big = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:logs', payload: { name: 'web', tail: 5000 } })
    if (info.daemonAvailable) {
      assert.equal(big.ok, false, 'daemon up + unknown container folds to NOT_FOUND')
      assert.equal(big.error.code, 'NOT_FOUND')
    } else {
      assert.equal(big.ok, true, 'daemon down degrades in-band')
      assert.equal(big.data.ok, false, 'logs not fetched')
      assert.equal(big.data.tail, 500, 'tail clamped to 500 in the structured result')
      assert.ok(typeof big.data.error === 'string' && big.data.error.length > 0, 'degradation reason present')
    }
  })

  // 64. daemon 不可用降级：三工具（overview/action/logs）结构化降级不崩（真机 daemon down 即真实验证）
  registerCase('s4-64: daemon-unavailable degradation — overview/action/logs all structured, never crash (real daemon state)', async () => {
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const dockerAdapter = await import(new URL('../src/main/adapters/docker.ts', import.meta.url).href)

    const registry = handlers.createHandlerRegistry({ appVersion: 's4-smoke' })
    const info = await dockerAdapter.dockerInfo()

    const overview = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:overview', payload: {} })
    assert.equal(overview.ok, true, 'overview envelope ok even when daemon is down')
    assert.equal(overview.data.status.available, info.daemonAvailable)

    if (!info.daemonAvailable) {
      // 真机 daemon down：全部降级路径真实验证（约束 #26）
      assert.ok(typeof overview.data.status.reason === 'string' && overview.data.status.reason.length > 0, 'status carries reason')
      assert.equal(overview.data.containers.length, 0, 'containers empty on degradation')
      assert.equal(overview.data.images.available, false, 'images structured degradation')
      assert.equal(overview.data.images.images.length, 0, 'images empty on degradation')
      assert.ok(typeof overview.data.images.reason === 'string' && overview.data.images.reason.length > 0, 'images reason present')

      const logs = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:logs', payload: { name: 'whatever', tail: 100 } })
      assert.equal(logs.ok, true, 'logs envelope ok on degradation')
      assert.equal(logs.data.ok, false, 'logs degraded, not fetched')
      assert.equal(logs.data.text, '', 'no fabricated log text')
      assert.ok(typeof logs.data.error === 'string' && logs.data.error.length > 0, 'logs error carries reason')

      const act = await handlers.dispatchGatewayRequest(registry, {
        channel: 'docker:action',
        payload: { name: 'whatever', action: 'restart', confirmed: true },
      })
      assert.equal(act.ok, true, 'action envelope ok on degradation')
      assert.equal(act.data.ok, false, 'action not executed')
      assert.equal(act.data.degraded, true, 'action degraded flag')
      assert.ok(typeof act.data.error === 'string' && act.data.error.length > 0, 'action error carries reason')
      console.log('    real-machine docker daemon is down: all three degradation paths verified live')
    } else {
      assert.equal(overview.data.images.available, true, 'daemon up: images available')
      console.log('    real-machine docker daemon is up at run time; degradation asserted structurally (see service semantics)')
    }
  })

  // 65. wsl action：terminate 两段式 dry（无 confirmed → confirmRequired+impacts，绝不真终止）；
  // distro 非白名单 → BAD_PAYLOAD；boot 对发行版幂等成功（真跑，无害）
  registerCase('s4-65: wsl action — terminate two-phase dry with impacts; unknown distro BAD_PAYLOAD; boot idempotent (real distro)', async () => {
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const wslAdapter = await import(new URL('../src/main/adapters/wsl.ts', import.meta.url).href)

    const registry = handlers.createHandlerRegistry({ appVersion: 's4-smoke' })

    // distro 白名单（已知发行版列表）：fake-distro → BAD_PAYLOAD
    for (const channel of ['wsl:action', 'wsl:distroStats']) {
      const fake = await handlers.dispatchGatewayRequest(registry, { channel, payload: { distro: 'fake-distro', action: 'terminate' } })
      assert.equal(fake.ok, false, `${channel} must reject unknown distro`)
      assert.equal(fake.error.code, 'BAD_PAYLOAD', `${channel} unknown distro folds to BAD_PAYLOAD`)
    }
    // 非法 action 枚举 → BAD_PAYLOAD
    const badAction = await handlers.dispatchGatewayRequest(registry, { channel: 'wsl:action', payload: { distro: 'Ubuntu', action: 'shutdown' } })
    assert.equal(badAction.error.code, 'BAD_PAYLOAD', 'invalid wsl action enum folds to BAD_PAYLOAD')

    const distros = await wslAdapter.listDistros()
    if (distros.length === 0) {
      envSkipNote('wsl.exe -l -v returned no distros at run time (transient host state)')
      return
    }
    const target = distros.find((d) => !d.name.toLowerCase().startsWith('docker-desktop'))
    assert.ok(target !== undefined, 'at least one non-docker-desktop distro for action tests')

    // terminate dry：不带 confirmed → confirmRequired + impacts；绝不真终止
    const gated = await handlers.dispatchGatewayRequest(registry, { channel: 'wsl:action', payload: { distro: target.name, action: 'terminate' } })
    assert.equal(gated.ok, true, `terminate gate dispatches, error=${gated.ok ? '' : gated.error.message}`)
    assert.equal(gated.data.confirmRequired, true, 'two-phase gate returned')
    assert.equal(gated.data.impacts.distro, target.name, 'impacts name')
    assert.equal(gated.data.impacts.state, target.state, 'impacts state')
    assert.ok(Array.isArray(gated.data.impacts.listeningPorts), 'impacts listening ports array')
    for (const entry of gated.data.impacts.listeningPorts) {
      assert.ok(Number.isInteger(entry.port) && entry.port >= 0 && entry.port <= 65535, `impact port sane: ${JSON.stringify(entry)}`)
    }
    // 复核 dry：发行版状态原样（没有真的 terminate）
    const after = await wslAdapter.listDistros()
    const afterHit = after.find((d) => d.name === target.name)
    assert.ok(afterHit !== undefined, 'distro still present after dry gate')
    assert.equal(afterHit.state, target.state, 'terminate dry-run must not change the distro state')

    // boot 幂等（真跑，无害）：Running/Stopped 均应成功
    const boot = await handlers.dispatchGatewayRequest(registry, { channel: 'wsl:action', payload: { distro: target.name, action: 'boot' } })
    assert.equal(boot.ok, true, `boot dispatches, error=${boot.ok ? '' : boot.error.message}`)
    assert.equal(boot.data.ok, true, `boot executes ok, ${boot.ok ? (boot.data.error ?? '') : ''}`)
    assert.equal(boot.data.action, 'boot')
    console.log(`    boot ${target.name}: ok (was ${target.state} before boot)`)
  })

  // 66. wsl systemInfo（wsl:distroStats）：Ubuntu 返回 uptime/mem 或显式 null（以真实为准，不猜测）；
  // parseDistroStats 纯函数用确定性 fixture 断言
  registerCase('s4-66: wsl distroStats — Ubuntu returns uptime/mem or explicit nulls; parser is deterministic on a fixture', async () => {
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const wslAdapter = await import(new URL('../src/main/adapters/wsl.ts', import.meta.url).href)

    // 解析器 fixture（老 wslmon parseDistroStats 语义移植）：全字段可解析
    const parsed = wslAdapter.parseDistroStats(
      [
        'MemTotal:       16000000 kB',
        'MemFree:         2000000 kB',
        'MemAvailable:    8000000 kB',
        '0.00 0.01 0.00 1/363 1340',
        '/dev/sdd 1007G 20G 936G 3% /',
        '6660.90 159823.94',
      ].join('\n'),
    )
    assert.equal(parsed.memTotalKb, 16000000)
    assert.equal(parsed.memFreeKb, 2000000)
    assert.equal(parsed.memAvailKb, 8000000)
    assert.equal(parsed.load1, 0)
    assert.equal(parsed.diskTotal, '1007G')
    assert.equal(parsed.diskPct, 3)
    assert.equal(parsed.uptimeSec, 6661)
    // 半截输出：缺失字段 null，绝不硬造
    const partial = wslAdapter.parseDistroStats('MemTotal: 16 kB\n')
    assert.equal(partial.memTotalKb, 16)
    assert.equal(partial.uptimeSec, null)
    assert.equal(partial.load1, null)

    const registry = handlers.createHandlerRegistry({ appVersion: 's4-smoke' })
    const res = await handlers.dispatchGatewayRequest(registry, { channel: 'wsl:distroStats', payload: { distro: 'Ubuntu' } })
    if (res.ok === false && res.error.code === 'BAD_PAYLOAD') {
      envSkipNote('Ubuntu not in the known distro list at run time (transient host state)')
      return
    }
    assert.equal(res.ok, true, `distroStats dispatches, error=${res.ok ? '' : res.error.message}`)
    if (res.data.available === false) {
      envSkipNote(`wsl unavailable at run time: ${res.data.reason}`)
      return
    }
    assert.equal(res.data.distros.length, 1, 'single-distro query returns one view')
    const view = res.data.distros[0]
    assert.equal(view.name, 'Ubuntu')
    if (view.stats === null) {
      assert.ok(typeof view.reason === 'string' && view.reason.length > 0, 'null stats carry a structured reason')
      envSkipNote(`stats unavailable at run time: ${view.reason}`)
      return
    }
    const s = view.stats
    assert.ok(s.uptimeSec === null || (Number.isFinite(s.uptimeSec) && s.uptimeSec >= 0), `uptime real or null, got ${JSON.stringify(s.uptimeSec)}`)
    assert.ok(s.memTotalKb === null || (Number.isFinite(s.memTotalKb) && s.memTotalKb > 0), `memTotal real or null, got ${JSON.stringify(s.memTotalKb)}`)
    assert.ok(s.load1 === null || Number.isFinite(s.load1), `load1 real or null, got ${JSON.stringify(s.load1)}`)
    console.log(`    Ubuntu live stats: uptime=${s.uptimeSec}s memTotal=${s.memTotalKb}kB memAvail=${s.memAvailKb}kB load1=${s.load1}`)

    // 全量形态（{} → 全部发行版概要）可达且结构成立
    const all = await handlers.dispatchGatewayRequest(registry, { channel: 'wsl:distroStats', payload: {} })
    assert.equal(all.ok, true, 'summary form dispatches')
    assert.equal(all.data.available, true)
    assert.ok(Array.isArray(all.data.distros) && all.data.distros.length >= 1, 'summary lists every distro')
    for (const d of all.data.distros) {
      assert.equal(typeof d.name, 'string')
      assert.equal(d.stats === null || typeof d.stats === 'object', true, `stats or null for ${d.name}`)
      if (d.stats !== null) {
        assert.equal(d.state.toLowerCase(), 'running', 'stats probed only for running distros (never boot to probe)')
      }
    }
  })

  // 67. 回归：既有 Environment/Services/Dashboard 数据链路在白名单 45→50 扩展后无回归
  registerCase('s4-67: regression — dashboard/services/environment channels still dispatch after the S4 whitelist extension', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)

    await makeTempHome('devhub-s4-67-')
    try {
      const registry = handlers.createHandlerRegistry({ appVersion: 's4-smoke' })

      const version = await handlers.dispatchGatewayRequest(registry, { channel: 'app:version', payload: {} })
      assert.equal(version.ok, true)
      assert.equal(version.data.appVersion, 's4-smoke')

      const dash = await handlers.dispatchGatewayRequest(registry, { channel: 'dashboard:summary', payload: {} })
      assert.equal(dash.ok, true, `dashboard:summary dispatches, error=${dash.ok ? '' : dash.error.message}`)
      assert.equal(typeof dash.data.projectCount, 'number', 'projectCount shape')
      assert.equal(typeof dash.data.dockerRunning, 'number', 'dockerRunning shape')
      assert.equal(typeof dash.data.dockerTotal, 'number', 'dockerTotal shape')
      assert.equal(typeof dash.data.wslStatus.available, 'boolean', 'wslStatus shape')
      assert.ok(Array.isArray(dash.data.warnings), 'warnings array shape')

      const svc = await handlers.dispatchGatewayRequest(registry, { channel: 'services:list', payload: {} })
      assert.equal(svc.ok, true, 'services:list dispatches')
      assert.ok(Array.isArray(svc.data), 'services rows array')

      const doctor = await handlers.dispatchGatewayRequest(registry, { channel: 'environment:doctor', payload: {} })
      assert.equal(doctor.ok, true, `environment:doctor dispatches, error=${doctor.ok ? '' : doctor.error.message}`)
      assert.ok(Array.isArray(doctor.data.checks), 'doctor checks array')
      for (const check of doctor.data.checks) {
        assert.ok(['info', 'warning', 'error'].includes(check.severity), 'doctor severity enum unchanged')
      }
    } finally {
      dbModule.closeDatabase()
    }
  })

  // 68. handlers 编译期白名单覆盖断言更新（45→50，S5 就地更新 50→55，
  //  docs/10 §11 授权的同一模式；AC2 就地更新 55→68，docs/14 §A.1 授权同一模式；
  //  夜间#1 就地更新 68→70，主控任务书授权；CP1 就地更新 70→79，docs/04 ContestPin 节；
  //  CP2 就地更新 79→84，docs/22 §4 悬浮窗 5 条；CP3a 就地更新 84→88，docs/22 §6
  //  识别配置 4 条）：
  //  registry 键集 = 白名单 = 契约覆盖
  registerCase('s4-68: whitelist 45→50 (S5 就地更新为 55，AC2 就地更新 55→68，夜间#1 就地更新 68→70，CP1 就地更新 70→79，CP2 就地更新 79→84，CP3a 就地更新 84→88) — registry keys equal the whitelist and the compile-time contract assertion holds', async () => {
    const channels = await import(new URL('../src/shared/channels.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)

    assert.equal(channels.IPC_CHANNELS.length, 88, 'whitelist extended 45 → 50 (S4), 50 → 55 (S5 archive), 55 → 68 (AC2 agents), 68 → 70 (夜间#1), 70 → 79 (CP1 contestpin 9 条), 79 → 84 (CP2 contestpin 悬浮窗 5 条), 84 → 88 (CP3a contestpin 识别配置 4 条)')
    assert.equal(new Set(channels.IPC_CHANNELS).size, 88, 'no duplicates after extension')
    // 编译期断言 AssertContractCoversWhitelist 的解析产物（ChannelContract 恰好覆盖白名单）
    assert.equal(handlers.contractCoversWhitelist, true, 'ChannelContract covers exactly the whitelist (compile-time, observed at runtime)')

    const registry = handlers.createHandlerRegistry({ appVersion: 's4-smoke' })
    assert.deepEqual(Object.keys(registry).sort(), [...channels.IPC_CHANNELS].sort(), 'registry keys == whitelist')
    for (const ch of ['docker:overview', 'docker:logs', 'docker:action', 'wsl:action', 'wsl:distroStats', 'agents:providers', 'agents:sessionAction', 'agents:diagnostics']) {
      assert.ok(channels.IPC_CHANNELS.includes(ch), `${ch} whitelisted`)
      assert.equal(typeof registry[ch], 'function', `${ch} has a handler`)
    }
    // S4/S5 之外的 channel 不受扩展影响（抽查回归）
    for (const ch of ['skills:toggleLink', 'apihub:switch', 'versions:update', 'dashboard:summary']) {
      assert.equal(typeof registry[ch], 'function', `${ch} handler intact`)
    }
  }, 'fast')

  // ==================================================================
  // S5 批次（docs/10 全文权威）：Archive 归档模块（69-80 追加；
  // step1/step6/s4-68 的 50→55 计数断言按同一授权模式就地更新）。
  // 全部用例夹具化：DEVHUB_HOME 临时目录 + 临时项目目录；绝不真实归档
  // F:\Active_Project 下任何项目；G:\__zk-dep-test\archived 只读不动。
  // ==================================================================

  /** S5 夹具共享 fs/path 句柄（run() 作用域一次性导入）。 */
  const s5fs = await import('node:fs')
  const s5path = await import('node:path')

  /** S5 夹具：写文件（父目录自动创建），返回完整路径。 */
  function s5Write(dir, rel, content) {
    const full = s5path.join(dir, rel)
    s5fs.mkdirSync(s5path.dirname(full), { recursive: true })
    s5fs.writeFileSync(full, content)
    return full
  }

  /** S5 夹具：建目录（recursive），返回完整路径。 */
  function makeS5DirSync(parentDir, name) {
    const dir = s5path.join(parentDir, name)
    s5fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 直插 projects 行（绕开 addProject 的 git/markers 探测，确定性），返回 id。 */
  function s5InsertProject(db, name, winPath) {
    const now = Math.floor(Date.now() / 1000)
    const result = db
      .prepare('INSERT INTO projects (name, slug, win_path, wsl_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, name.toLowerCase(), winPath, winPath.replace(/\\/g, '/'), now, now)
    return Number(result.lastInsertRowid)
  }

  // 69. pathRefs 纯函数全表：变体匹配 / 边界 / `\\` 转义真实案例 / URL 编码 / 行列
  registerCase('s5-69: pathRefs full table — slash/case variants, FooBar boundary, \\\\ escape regression, URL-encoded form, lineCol/snippet', async () => {
    const pr = await import(new URL('../src/main/services/archive/pathRefs.ts', import.meta.url).href)

    // normalizeRoot / escapeRegExp
    assert.equal(pr.normalizeRoot('  F:\\Proj\\A\\  '), 'F:\\Proj\\A', 'trims whitespace and trailing separators')
    assert.equal(pr.normalizeRoot('F:/Proj/A//'), 'F:/Proj/A')
    // 反斜杠本身也是元字符：escapeRegExp 连同路径分隔符一起转义（buildPathRegex 内部随后会把整段替换为 [\\/]+）
    assert.equal(pr.escapeRegExp('F:\\A(B)[C].d'), String.raw`F:\\A\(B\)\[C\]\.d`, 'regex metachars escaped')

    // 空路径抛错（buildPathRegex）；buildEncodedPathRegex 无特殊字符 → null
    assert.throws(() => pr.buildPathRegex('   '), /空路径/, 'empty root refuses regex build')
    assert.equal(pr.buildEncodedPathRegex('ProjA'), null, 'no %-encoding needed -> null')

    // 正反斜杠等价 + 大小写不敏感
    const text = [
      'root = F:\\Proj\\A\\sub\\x.txt',
      'alt = F:/Proj/A/sub/y.txt',
      'case = f:\\proj\\a\\sub\\z.txt',
      'prefix-kept = F:\\Proj\\AB\\w.txt',
    ].join('\n')
    const hits = pr.findPathRefs(text, 'F:\\Proj\\A')
    // 3 处命中；「F:\Proj\AB」不误伤（后向边界：匹配后紧跟字母 B 非分隔/标点）
    assert.equal(hits.length, 3, `expected 3 hits (FooBar boundary respected), got ${hits.length}: ${JSON.stringify(hits.map((h) => h.matched))}`)

    // URL 编码变体：%5C/%2F/%20
    const encText = 'enc = F%3A%5CProj%5CA%5Csub%5Ce.txt' // 注意 %3A 不在变体集内（老实现仅编码分隔符与空格）
    const encText2 = 'enc2 = ' + pr.encodePath('F:\\Proj\\A\\sub with space\\e.txt')
    const encHits = pr.findPathRefs(encText2, 'F:\\Proj\\A')
    assert.equal(encHits.length, 1, 'encoded path (\\ -> %5C, space -> %20) is matched')
    assert.ok(encHits[0].matched.startsWith('F:%5CProj%5CA'), `encoded matched form (colon unencoded), got ${encHits[0].matched}`)

    // 改写：分隔符风格逐位保留；层级不齐沿用最后一次写法
    const { text: rewritten, count } = pr.replacePathRefs(text, 'F:\\Proj\\A', 'D:\\Arc\\A')
    assert.equal(count, 3, 'three replacements')
    assert.ok(rewritten.includes('D:\\Arc\\A\\sub\\x.txt'), 'backslash ref rewritten with backslashes')
    assert.ok(rewritten.includes('D:/Arc/A/sub/y.txt'), 'forward-slash ref rewritten with forward slashes')
    assert.ok(rewritten.toLowerCase().includes('d:\\arc\\a\\sub\\z.txt'), 'lowercase ref rewritten (replacement is canonical new root)')
    assert.ok(rewritten.includes('F:\\Proj\\AB\\w.txt'), 'longer sibling path untouched')

    // `\\` 双反斜杠转义真实案例回归（JSON 文件改写不损坏）：
    // JSON.stringify 产出的原始文本是 F:\\Proj\\A（双反斜杠字节），替换后必须仍是双反斜杠
    const jsonBefore = JSON.stringify({ root: 'F:\\Proj\\A', nested: 'F:\\Proj\\A\\data' })
    const { text: jsonAfter, count: jsonCount } = pr.replacePathRefs(jsonBefore, 'F:\\Proj\\A', 'D:\\Arc\\Proj\\A2')
    assert.equal(jsonCount, 2, 'both JSON occurrences replaced')
    const parsed = JSON.parse(jsonAfter)
    assert.equal(parsed.root, 'D:\\Arc\\Proj\\A2', 'double-backslash run length preserved (no broken escapes)')
    assert.equal(parsed.nested, 'D:\\Arc\\Proj\\A2\\data', 'nested value intact')
    assert.ok(jsonAfter.includes('\\\\'), 'raw text still carries \\\\ escape runs')

    // 层级数不齐：旧文本只有 1 个分隔位时，多出的层沿用最后一次分隔符写法
    assert.equal(pr.matchSeparator('C:\\x\\y\\z', 'C:\\x'), 'C:\\x\\y\\z', 'missing levels reuse the last separator run')
    assert.equal(pr.matchSeparator('C:/x/y', 'C:\\x'), 'C:\\x\\y', 'missing levels reuse the last OLD-text separator run (backslash here)')

    // lineColOf / snippetAround（1-based；BOM 由 walker 剥离，不在本层职责内）
    const lines = 'aaa\nbbb-ccc\nddd'
    const idx = lines.indexOf('ccc')
    assert.deepEqual(pr.lineColOf(lines, idx), { line: 2, col: 5 }, '1-based line/col')
    assert.equal(pr.snippetAround(lines, idx), 'bbb-ccc', 'snippet is the trimmed containing line')
    assert.ok(pr.snippetAround('x'.repeat(300), 0, 10).endsWith('…'), 'long snippet truncated with ellipsis')
  }, 'fast')

  // 70. scanRules / depDirs 规则表：忽略目录、venv 定点、二进制嗅探边界、lockfile 判定
  registerCase('s5-70: scanRules/depDirs rule table — ignore dirs, venv pinned files, NUL-at-8KB boundary, lockfile-gated node_modules strip', async () => {
    const rules = await import(new URL('../src/main/services/archive/scanRules.ts', import.meta.url).href)
    const dep = await import(new URL('../src/main/services/archive/depDirs.ts', import.meta.url).href)

    // IGNORE_DIRS：约 25 目录（24 项），小写命中；目录名大小写在 walker 层 lower 后比较
    assert.equal(rules.IGNORE_DIRS.size, 24, `ignore list size, got ${rules.IGNORE_DIRS.size}`)
    for (const d of ['node_modules', '.git', 'venv', '.venv', '__pycache__', 'dist', 'build', 'target', '.next', 'coverage', 'objects', 'listings']) {
      assert.ok(rules.IGNORE_DIRS.has(d), `IGNORE_DIRS contains ${d}`)
    }

    // venv 定点：activate 各形态 + pyvenv.cfg；非激活文件不命中
    for (const rel of ['pyvenv.cfg', 'scripts/activate', 'scripts/activate.bat', 'scripts/activate.ps1', 'scripts/activate.fish', 'scripts/activate.zsh', 'scripts/activate.csh', 'bin/activate', '/scripts/activate']) {
      assert.equal(rules.isVenvActivationFile(rel), true, `venv pinned: ${rel}`)
    }
    for (const rel of ['scripts/activate.bak', 'scripts/activate.bat.old', 'bin/python.exe', 'pyvenv.cfg.bak', 'other.txt']) {
      assert.equal(rules.isVenvActivationFile(rel), false, `not pinned: ${rel}`)
    }

    // 二进制扩展名 + NUL 嗅探（前 8KB；恰好 8KB 内 NUL = 二进制，第 8001 字节起不算）
    assert.equal(rules.hasBinaryExtension('photo.PNG'), true, 'case-insensitive extension')
    assert.equal(rules.hasBinaryExtension('archive.tar.gz'), true, 'last extension wins (.gz)')
    assert.equal(rules.hasBinaryExtension('noext'), false)
    assert.equal(rules.looksBinary(Buffer.alloc(8000, 0x41)), false, '8KB of text is not binary')
    const nulAtEnd = Buffer.alloc(8000, 0x41)
    nulAtEnd[7999] = 0
    assert.equal(rules.looksBinary(nulAtEnd), true, 'NUL within the first 8KB window counts')
    const nulBeyond = Buffer.alloc(8100, 0x41)
    nulBeyond[8000] = 0
    assert.equal(rules.looksBinary(nulBeyond), false, 'NUL at byte 8001 is outside the window')

    // manifest 优先级顺序（package.json 最优先）
    assert.equal(rules.MANIFESTS[0].file, 'package.json')
    assert.ok(rules.MANIFESTS.length >= 14, 'manifest table size')

    // depDirs 常量表
    assert.equal(dep.JS_DEP_DIR, 'node_modules')
    assert.deepEqual([...dep.VENV_DIR_NAMES].sort(), ['.venv', 'venv'])
    assert.ok(dep.JS_LOCKFILES.includes('package-lock.json') && dep.JS_LOCKFILES.includes('pnpm-lock.yaml') && dep.JS_LOCKFILES.includes('yarn.lock'))
    assert.ok(dep.PY_MANIFESTS.includes('pyproject.toml') && dep.PY_MANIFESTS.includes('requirements.txt'))

    // detectDepSkipDirs（mover 内，FS 判定）：lockfile 在场才剥离 node_modules；
    // pyproject 在场剥离 venv/.venv；缓存目录无条件剥离
    const mover = await import(new URL('../src/main/services/archive/mover.ts', import.meta.url).href)
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const withLock = mkdtempSync(join(tmpdir(), 'devhub-s5-70a-'))
    writeFileSync(join(withLock, 'package.json'), '{}')
    writeFileSync(join(withLock, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0')
    mkdirSync(join(withLock, 'node_modules'), { recursive: true })
    assert.deepEqual([...(await mover.detectDepSkipDirs(withLock))].sort(), ['node_modules'], 'lockfile present -> node_modules stripped')

    const noLock = mkdtempSync(join(tmpdir(), 'devhub-s5-70b-'))
    writeFileSync(join(noLock, 'package.json'), '{}')
    mkdirSync(join(noLock, 'node_modules'), { recursive: true })
    assert.deepEqual(await mover.detectDepSkipDirs(noLock), [], 'no lockfile -> node_modules kept (not safely reinstallable)')

    const py = mkdtempSync(join(tmpdir(), 'devhub-s5-70c-'))
    writeFileSync(join(py, 'requirements.txt'), 'requests\n')
    assert.deepEqual([...(await mover.detectDepSkipDirs(py))].sort(), ['.venv', 'venv'], 'python manifest -> venv dirs stripped')

    const cache = mkdtempSync(join(tmpdir(), 'devhub-s5-70d-'))
    mkdirSync(join(cache, '__pycache__'), { recursive: true })
    mkdirSync(join(cache, '.tox'), { recursive: true })
    assert.deepEqual([...(await mover.detectDepSkipDirs(cache))].sort(), ['.tox', '__pycache__'], 'cache dirs stripped unconditionally')
  }, 'fast')

  // 71. walker：夹具树命中/剪枝/定点 + 取消 token（预取消 + 扫描中途取消）
  registerCase('s5-71: walker — fixture tree hits with ignore pruning and venv pinning; oversize/binary skip; cancel token stops mid-scan', async () => {
    const walker = await import(new URL('../src/main/services/archive/walker.ts', import.meta.url).href)
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const root = mkdtempSync(join(tmpdir(), 'devhub-s5-71-'))
    const needle = root // 自引用 needle = 夹具根路径
    s5Write(root, 'a.txt', `root is ${needle}\\main\n`)
    s5Write(root, 'sub/b.json', JSON.stringify({ p: needle }))
    s5Write(root, 'sub/c-slash.txt', `slash form: ${needle.replace(/\\/g, '/')}/x\n`)
    // 被忽略目录整棵剪枝：node_modules 内的引用不产生命中
    s5Write(root, 'node_modules/m/index.js', `ignored ref ${needle}\n`)
    // venv 定点：pyvenv.cfg 与 Scripts|bin/activate* 仍被收集并命中
    s5Write(root, 'venv/pyvenv.cfg', `home = ${needle}\\venv\n`)
    s5Write(root, 'venv/Scripts/activate.bat', `set VIRTUAL_ENV=${needle}\\venv\n`)
    s5Write(root, 'venv/Scripts/deactivate-info.txt', `not pinned ${needle}\n`) // 非定点 → 不收集
    s5Write(root, 'venv/bin/activate', `export VIRTUAL_ENV="${needle}/venv"\n`)
    // 二进制扩展名剔除（不计入 skippedBinary——扩展名层直接过滤）
    s5Write(root, 'logo.png', `fake png with ${needle}\n`)
    // 无扩展名但前 8KB 含 NUL → skippedBinary
    const nulBuf = Buffer.concat([Buffer.from(`bin with ${needle}`), Buffer.alloc(4, 0)])
    s5Write(root, 'blob.dat', nulBuf)
    // >2MB → skippedOversize
    s5Write(root, 'big.log', ('x'.repeat(1024) + `\n${needle}\n`).repeat(3 * 1024))
    // 无引用文件
    s5Write(root, 'clean.md', '# nothing here\n')

    const result = await walker.findRefs([{ label: 'proj', root }], needle)
    // 命中：a.txt / b.json / c-slash.txt / pyvenv.cfg / activate.bat / bin/activate = 6
    assert.equal(result.totalHits, 6, `totalHits, got ${JSON.stringify(result.hits.map((h) => h.file))}`)
    assert.equal(result.scannedFiles, 7, 'scannedFiles counts read files incl. the clean one (clean.md)')
    assert.equal(result.skippedBinary, 1, 'blob.dat counted as binary-skipped')
    assert.equal(result.skippedOversize, 1, 'big.log counted as oversize-skipped')
    assert.equal(result.errorSummary.length, 0, 'clean fixture has no per-file errors')
    const hitFiles = result.hits.map((h) => h.file.replace(/\\/g, '/'))
    assert.ok(hitFiles.some((f) => f.endsWith('venv/pyvenv.cfg')), 'venv pinned pyvenv.cfg scanned')
    assert.ok(hitFiles.some((f) => f.endsWith('venv/Scripts/activate.bat')), 'venv activate.bat scanned')
    assert.ok(hitFiles.some((f) => f.endsWith('venv/bin/activate')), 'venv bin/activate scanned')
    assert.ok(!hitFiles.some((f) => f.includes('node_modules')), 'node_modules pruned entirely')
    assert.ok(!hitFiles.some((f) => f.endsWith('deactivate-info.txt')), 'non-pinned venv file not collected')
    assert.ok(!hitFiles.some((f) => f.endsWith('clean.md')), 'clean file yields no hit')
    const slashHit = result.hits.find((h) => h.file.endsWith('c-slash.txt'))
    assert.equal(slashHit.matched, needle.replace(/\\/g, '/'), 'forward-slash ref matched verbatim in its source form')
    assert.ok(result.hits.every((h) => typeof h.line === 'number' && h.line >= 1 && typeof h.col === 'number' && h.col >= 1), 'line/col 1-based')

    // uniqueHitFiles 去重
    assert.equal(walker.uniqueHitFiles(result.hits).length, 6, 'uniqueHitFiles dedupes by file')

    // 取消 token：预取消 → collectFiles 首个目录即中止
    const preCancelled = walker.createCancelToken()
    preCancelled.cancelled = true
    await assert.rejects(
      () => walker.findRefs([{ label: 'proj', root }], needle, { token: preCancelled }),
      (err) => err.name === 'WalkerCancelledError',
      'pre-cancelled token aborts before scanning',
    )

    // 扫描中途取消：3000 个含引用的小文件，2ms 后置 cancelled → walker 中止并抛取消
    const bigRoot = mkdtempSync(join(tmpdir(), 'devhub-s5-71b-'))
    for (let i = 0; i < 3000; i++) s5Write(bigRoot, `f${i}.txt`, `ref ${bigRoot} #${i}\n`)
    const midToken = walker.createCancelToken()
    setTimeout(() => {
      midToken.cancelled = true
    }, 2)
    await assert.rejects(
      () => walker.findRefs([{ label: 'big', root: bigRoot }], bigRoot, { token: midToken }),
      (err) => err.name === 'WalkerCancelledError',
      'cancel mid-scan stops the walker (per-file token checks)',
    )
  }, 'fast')

  // 72. 同卷移动：rename 模式，内容逐字节一致，源不存在；uniqueDestPath 与非空目标拒绝
  registerCase('s5-72: same-volume move — rename mode, byte-identical content, source gone; uniqueDestPath (-archived-YYYYMMDD(-N)); non-empty dest refused', async () => {
    const mover = await import(new URL('../src/main/services/archive/mover.ts', import.meta.url).href)
    const { mkdtempSync, existsSync, readFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const parent = mkdtempSync(join(tmpdir(), 'devhub-s5-72-'))
    const destRoot = makeS5DirSync(parent, 'archive-root')
    const src = makeS5DirSync(parent, 'proj-a')
    s5Write(src, 'app/main.py', 'print("hello")\n')
    s5Write(src, 'data.bin', Buffer.from([1, 2, 3, 0, 255]))

    // uniqueDestPath：空闲 → 原名；占用 → -archived-YYYYMMDD；再占用 → -2
    const first = await mover.uniqueDestPath(destRoot, 'proj-a')
    assert.equal(first, join(destRoot, 'proj-a'), 'free name returned as-is')
    mkdirSync(join(destRoot, 'proj-a'), { recursive: true })
    const second = await mover.uniqueDestPath(destRoot, 'proj-a')
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    assert.equal(second, join(destRoot, `proj-a-archived-${day}`), 'occupied -> dated name')
    mkdirSync(join(destRoot, `proj-a-archived-${day}`), { recursive: true })
    const third = await mover.uniqueDestPath(destRoot, 'proj-a')
    assert.equal(third, join(destRoot, `proj-a-archived-${day}-2`), 'both occupied -> -2 suffix')

    // 同卷移动（destPath 取 -2 名）：rename 模式、逐字节一致、源消失
    const dest = third
    const move = await mover.moveDirectory(src, dest, { onProgress: () => {}, isCancelled: () => false }, { skipDepDirs: true })
    assert.equal(move.mode, 'renamed', 'same volume -> rename')
    assert.equal(move.skippedDeps.length, 0, 'no dep dirs in this fixture')
    assert.equal(move.sourceLeftovers.length, 0, 'nothing left over')
    assert.equal(existsSync(src), false, 'source directory gone after rename')
    assert.equal(readFileSync(join(dest, 'app/main.py'), 'utf8'), 'print("hello")\n', 'text content byte-identical')
    assert.ok(readFileSync(join(dest, 'data.bin')).equals(Buffer.from([1, 2, 3, 0, 255])), 'binary content byte-identical')
    assert.deepEqual(await mover.detectDepSkipDirs(dest), [], 'detectDepSkipDirs empty after move')

    // 归档目标已存在且非空 → 拒绝（绝不盲目清场）
    await assert.rejects(
      () => mover.moveDirectory(join(parent, 'proj-b'), dest, { onProgress: () => {}, isCancelled: () => false }),
      /已存在且非空/,
      'non-empty destination is refused',
    )

    function makeS5DirSync(parentDir, name) {
      const dir = join(parentDir, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }
  }, 'fast')

  // 73. 跨卷移动（注入 renameFn 抛 EXDEV 模拟跨卷）+ 中途复制失败注入（失败保源清半成品）
  // 选型说明：目标盘写满无法确定性模拟；Windows 目录只读属性不阻止写入——
  // 因此 EXDEV 与复制失败都用 mover 的注入 seam（renameFn/copyFileFn）确定性构造。
  registerCase('s5-73: cross-volume via injected EXDEV — 4-worker verified copy, junctions skipped, deps pruned, source removed; injected copy failure keeps source and cleans dest', async () => {
    const mover = await import(new URL('../src/main/services/archive/mover.ts', import.meta.url).href)
    const fsp = await import('node:fs/promises')
    const { mkdtempSync, existsSync, readFileSync, statSync, mkdirSync, symlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const parent = mkdtempSync(join(tmpdir(), 'devhub-s5-73-'))
    const src = makeS5DirSync(parent, 'proj-x')
    s5Write(src, 'package.json', '{"name":"x"}')
    s5Write(src, 'package-lock.json', '{"lockfileVersion":3}')
    s5Write(src, 'src/index.js', 'console.log(1)\n')
    s5Write(src, 'node_modules/big/index.js', 'module.exports=2\n')
    // junction：跨卷不复制，计数 skippedLinks
    symlinkSync(join(src, 'src'), join(src, 'src-link'), 'junction')

    // EXDEV 注入 → 复制流程：node_modules 被 lockfile 规则剪枝（不复制）；junction 跳过
    const dest = join(parent, 'archive-out', 'proj-x')
    const exdev = new Error('cross-device link')
    exdev.code = 'EXDEV'
    const move = await mover.moveDirectory(
      src,
      dest,
      { onProgress: () => {}, isCancelled: () => false },
      { skipDepDirs: true },
      { renameFn: async () => { throw exdev } },
    )
    assert.equal(move.mode, 'copied', 'EXDEV -> copy branch')
    assert.deepEqual([...move.skippedDeps].sort(), ['node_modules'], 'dep dirs detected pre-move')
    assert.equal(move.skippedLinks, 1, 'junction counted as skipped link')
    assert.ok(!existsSync(join(dest, 'node_modules')), 'node_modules pruned from the archive copy')
    assert.ok(!existsSync(join(dest, 'src-link')), 'junction not copied across volumes')
    assert.equal(readFileSync(join(dest, 'src/index.js'), 'utf8'), 'console.log(1)\n', 'copied content intact')
    assert.equal(existsSync(src), false, 'source removed only after full verification')
    assert.equal(move.sourceLeftovers.length, 0, 'no leftovers on clean removal')

    // 失败注入：复制到 locked.bin 时失败 → 源完好、目标半成品清理干净
    const src2 = makeS5DirSync(parent, 'proj-y')
    s5Write(src2, 'a.txt', 'AAA')
    s5Write(src2, 'locked.bin', 'KEEP-ME')
    s5Write(src2, 'b.txt', 'BBB')
    const dest2 = join(parent, 'archive-out2', 'proj-y')
    const failCopy = async (s, d) => {
      if (d.endsWith('locked.bin')) throw new Error('injected copy failure')
      await fsp.copyFile(s, d)
    }
    const exdev2 = new Error('cross-device')
    exdev2.code = 'EXDEV'
    await assert.rejects(
      () =>
        mover.moveDirectory(
          src2,
          dest2,
          { onProgress: () => {}, isCancelled: () => false },
          { skipDepDirs: false },
          { renameFn: async () => { throw exdev2 }, copyFileFn: failCopy },
        ),
      /injected copy failure/,
      'copy failure propagates as the original error',
    )
    assert.equal(existsSync(dest2), false, 'partial destination cleaned up (no half-done artefacts)')
    assert.equal(existsSync(src2), true, 'source directory preserved on failure')
    assert.equal(readFileSync(join(src2, 'locked.bin'), 'utf8'), 'KEEP-ME', 'source files untouched')
    assert.equal(readFileSync(join(src2, 'a.txt'), 'utf8'), 'AAA')
    assert.equal(readFileSync(join(src2, 'b.txt'), 'utf8'), 'BBB')
    assert.equal(statSync(src2).isDirectory(), true, 'source still a directory')

    function makeS5DirSync(parentDir, name) {
      const dir = join(parentDir, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }
  }, 'fast')

  // 74. 剥离：node_modules 有/无 lockfile 两态 + venv + __pycache__；剥离清单随结果返回
  registerCase('s5-74: strip rules in the move — node_modules gated by lockfile (both states), venv and __pycache__ stripped, stripped list returned', async () => {
    const mover = await import(new URL('../src/main/services/archive/mover.ts', import.meta.url).href)
    const { mkdtempSync, existsSync, mkdirSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const parent = mkdtempSync(join(tmpdir(), 'devhub-s5-74-'))

    // 形态 A：lockfile 在场 → node_modules/venv/__pycache__ 全剥离
    const srcA = makeS5DirSync(parent, 'proj-a')
    s5Write(srcA, 'package.json', '{"name":"a"}')
    s5Write(srcA, 'package-lock.json', '{}')
    s5Write(srcA, 'pyproject.toml', '[project]\n')
    s5Write(srcA, 'node_modules/dep/index.js', 'x')
    s5Write(srcA, 'venv/Scripts/activate.bat', 'venv')
    s5Write(srcA, '__pycache__/m.cpython-313.pyc', 'bc')
    s5Write(srcA, 'keep.txt', 'keep')
    mkdirSync(join(parent, 'out-a'), { recursive: true }) // rename 要求目标父目录存在
    const destA = join(parent, 'out-a', 'proj-a')
    const moveA = await mover.moveDirectory(srcA, destA, { onProgress: () => {}, isCancelled: () => false }, { skipDepDirs: true })
    assert.deepEqual([...moveA.skippedDeps].sort(), ['.venv', '__pycache__', 'node_modules', 'venv'], 'strip list: node_modules + venv/.venv (both venv names register) + __pycache__')
    assert.ok(!existsSync(join(destA, 'node_modules')), 'node_modules stripped from archive copy')
    assert.ok(!existsSync(join(destA, 'venv')), 'venv stripped')
    assert.ok(!existsSync(join(destA, '__pycache__')), '__pycache__ stripped')
    assert.equal(readFileSync(join(destA, 'keep.txt'), 'utf8'), 'keep', 'regular files untouched')

    // 形态 B：无 lockfile → node_modules 保留；venv（pyproject 在场）与 __pycache__ 仍剥离
    const srcB = makeS5DirSync(parent, 'proj-b')
    s5Write(srcB, 'package.json', '{"name":"b"}')
    s5Write(srcB, 'pyproject.toml', '[project]\n')
    s5Write(srcB, 'node_modules/dep/index.js', 'x')
    s5Write(srcB, '.venv/pyvenv.cfg', 'home = x')
    s5Write(srcB, '__pycache__/m.pyc', 'bc')
    mkdirSync(join(parent, 'out-b'), { recursive: true })
    const destB = join(parent, 'out-b', 'proj-b')
    const moveB = await mover.moveDirectory(srcB, destB, { onProgress: () => {}, isCancelled: () => false }, { skipDepDirs: true })
    assert.deepEqual([...moveB.skippedDeps].sort(), ['.venv', '__pycache__', 'venv'], 'no lockfile -> node_modules NOT in strip list')
    assert.ok(existsSync(join(destB, 'node_modules')), 'node_modules kept when no lockfile (cannot reinstall deterministically)')
    assert.ok(!existsSync(join(destB, '.venv')), '.venv stripped (absolute-path scripts would break anyway)')
    assert.ok(!existsSync(join(destB, '__pycache__')), '__pycache__ stripped')

    // skipDepDirs: false → 什么都不剥离
    const srcC = makeS5DirSync(parent, 'proj-c')
    s5Write(srcC, 'package-lock.json', '{}')
    s5Write(srcC, 'node_modules/x.js', 'x')
    mkdirSync(join(parent, 'out-c'), { recursive: true })
    const destC = join(parent, 'out-c', 'proj-c')
    const moveC = await mover.moveDirectory(srcC, destC, { onProgress: () => {}, isCancelled: () => false }, { skipDepDirs: false })
    assert.equal(moveC.skippedDeps.length, 0, 'strip disabled -> empty list')
    assert.ok(existsSync(join(destC, 'node_modules')), 'nothing stripped when skipDepDirs=false')

    function makeS5DirSync(parentDir, name) {
      const dir = join(parentDir, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }
  }, 'fast')

  // 75. pathFixer：`\\` 转义/大小写/URL 编码变体改写、非 UTF-8 跳过、备份 + 回滚恢复
  registerCase('s5-75: pathFixer — variant rewrite with \\\\ escape preserved, non-UTF-8 skipped untouched, missing reported, backup + rollback restores originals', async () => {
    const fixer = await import(new URL('../src/main/services/archive/pathFixer.ts', import.meta.url).href)
    const pr = await import(new URL('../src/main/services/archive/pathRefs.ts', import.meta.url).href)
    await makeTempHome('devhub-s5-75-home-')
    const { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const parent = mkdtempSync(join(tmpdir(), 'devhub-s5-75-'))
    const oldRoot = makeS5DirSync(parent, 'old-root')
    const newRoot = join(parent, 'new-root')

    // remapMovedPath：前缀映射到新位置；非前缀原样返回
    const inner = join(oldRoot, 'config.json')
    assert.equal(fixer.remapMovedPath(inner, oldRoot, newRoot), join(newRoot, 'config.json'), 'internal file remapped')
    assert.equal(fixer.remapMovedPath(join(parent, 'other.txt'), oldRoot, newRoot), join(parent, 'other.txt'), 'external file untouched')
    assert.equal(fixer.remapMovedPath(oldRoot.toUpperCase() + '\\x', oldRoot, newRoot), join(newRoot, 'x'), 'case-insensitive prefix')

    // f1：JSON 双反斜杠（真实案例）——改写后仍可 JSON.parse 且转义不损坏
    const f1 = join(oldRoot, 'config.json')
    writeFileSync(f1, JSON.stringify({ root: oldRoot, list: [oldRoot, oldRoot + '\\sub'] }), 'utf8')
    // f2：正斜杠变体
    const f2 = join(oldRoot, 'readme.md')
    writeFileSync(f2, `see ${oldRoot.replace(/\\/g, '/')}/docs and ${oldRoot.replace(/\\/g, '/')}/more\n`, 'utf8')
    // f3：URL 编码变体
    const f3 = join(oldRoot, 'encoded.ini')
    writeFileSync(f3, `url=${pr.encodePath(oldRoot)}%5Ctail\n`, 'utf8')
    // f4：小写盘符/目录变体
    const f4 = join(oldRoot, 'case.txt')
    writeFileSync(f4, `lower = ${oldRoot.toLowerCase()}\\x\n`, 'utf8')
    // f5：GBK 字节（非 UTF-8）→ 必须跳过且内容不动
    const f5 = join(oldRoot, 'gbk.cfg')
    const gbkBytes = Buffer.concat([Buffer.from('path=', 'ascii'), Buffer.from(oldRoot, 'ascii'), Buffer.from('\r\nname=', 'ascii'), Buffer.from([0xc4, 0xe3]), Buffer.from([0xba, 0xc3])])
    writeFileSync(f5, gbkBytes)
    // f6：将被删除的引用文件 → missing
    const f6 = join(oldRoot, 'doomed.txt')
    writeFileSync(f6, `ref ${oldRoot}\n`, 'utf8')
    unlinkSync(f6) // 模拟改写前文件已消失

    const files = [f1, f2, f3, f4, f5, f6]
    const backupDir = join(parent, 'undo-75', '1')
    const outcome = await fixer.applyFixes(files, oldRoot, newRoot, backupDir)

    assert.equal(outcome.fixed.length, 4, `fixed files, got ${outcome.fixed.length}`)
    assert.deepEqual(outcome.skippedNonUtf8, [f5], 'GBK file skipped by UTF-8 round-trip check')
    assert.equal(outcome.missing.length, 1, 'missing file reported')
    assert.ok(outcome.totalReplacements >= 6, `total replacements, got ${outcome.totalReplacements}`)

    // f1 内容验证：JSON 仍合法、新路径、双反斜杠保留
    const parsed = JSON.parse(readFileSync(f1, 'utf8'))
    assert.equal(parsed.root, newRoot)
    assert.deepEqual(parsed.list, [newRoot, newRoot + '\\sub'])
    // f2 分隔符风格保留
    assert.ok(readFileSync(f2, 'utf8').includes(newRoot.replace(/\\/g, '/')), 'forward-slash style preserved')
    // f3 URL 编码改写
    assert.ok(readFileSync(f3, 'utf8').includes(pr.encodePath(newRoot)), 'encoded variant rewritten as encoded new root')
    // f5 原字节不动
    assert.ok(readFileSync(f5).equals(gbkBytes), 'non-UTF-8 file bytes untouched')

    // 备份存在：4 个 fixed 各有 0001-<basename> 形态备份
    assert.equal(outcome.fixed.every((f) => existsSync(f.backup)), true, 'every fixed file has a backup')
    assert.ok(existsSync(join(backupDir, '0001-config.json')), 'sequential backup naming')

    // 回滚：清单保存 → restoreBackups 逐条 copyFile → 原文逐字节恢复；幂等可重复
    const manifest = { runId: 1, entries: outcome.fixed.map((f) => ({ target: f.file, backup: f.backup })) }
    fixer.saveUndoManifest(manifest)
    assert.equal(fixer.undoManifestPath(1), join(process.env.DEVHUB_HOME, 'undo', '1.json'), 'manifest layout per docs/10 §7 (<DEVHUB_HOME>/undo/<runId>.json)')
    const restored1 = await fixer.restoreBackups(manifest)
    assert.equal(restored1, 4, 'first restore count')
    assert.equal(JSON.parse(readFileSync(f1, 'utf8')).root, oldRoot, 'content restored to the old root text')
    assert.ok(readFileSync(f5).equals(gbkBytes), 'skipped file never touched by rollback either')
    const restored2 = await fixer.restoreBackups(manifest)
    assert.equal(restored2, 4, 'rollback is idempotent and repeatable')

    // readUndoManifest：合法解析 + 缺失 → null
    const readBack = await fixer.readUndoManifest(1)
    assert.equal(readBack.entries.length, 4, 'manifest round-trip')
    assert.equal(await fixer.readUndoManifest(999), null, 'missing manifest -> null')

    // undo 目录布局：<dataDir>/undo/<runId>/（getDataDir 受 DEVHUB_HOME 影响）
    assert.ok(fixer.undoDirOf(1).includes(join('undo', '1')), 'undo dir under DEVHUB_HOME/undo/<runId>')

    function makeS5DirSync(parentDir, name) {
      const dir = join(parentDir, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }
  }, 'fast')

  // 76. preview→run 全链路：未带/伪造/过期 previewId 拒绝；正常链路落库 + projects 联动
  registerCase('s5-76: preview→run full chain — run without/forged/expired previewId refused (PROJECT_LOCKED-free fixture); done row + projects.win_path linkage + archives row + history', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/archiveService.ts', import.meta.url).href)

    const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const home = await makeTempHome('devhub-s5-76-home-')
    try {
      const projectsRoot = mkdtempSync(join(tmpdir(), 'devhub-s5-76-proj-'))
      const destRoot = mkdtempSync(join(tmpdir(), 'devhub-s5-76-dest-'))
      const proj = makeS5DirSync(projectsRoot, 'demo-web')
      s5Write(proj, 'package.json', '{"name":"demo-web"}')
      s5Write(proj, 'package-lock.json', '{}')
      s5Write(proj, 'node_modules/dep.js', 'x')
      s5Write(proj, 'settings.json', JSON.stringify({ home: proj, slash: proj.replace(/\\/g, '/') }))

      const projectId = s5InsertProject(dbModule.getDatabase(), 'demo-web', proj)
      settings.setSetting('archive_dest_root', destRoot)

      // --- 拒绝路径：未预览直跑（安全规则 1） ---
      const unknown = 'arc-00000000-0000-4000-8000-000000000000'
      await assert.rejects(() => svc.runArchive(unknown, true), (e) => e.code === 'NOT_FOUND', 'unknown previewId refused')
      await assert.rejects(() => svc.runArchive(unknown, undefined), (e) => e.code === 'NOT_FOUND', 'even the dry phase needs a real preview')
      await assert.rejects(() => svc.previewArchive(9999), (e) => e.code === 'NOT_FOUND', 'unknown project refused')

      // --- 正常预览（强制 dry-run：只读） ---
      const preview = await svc.previewArchive(projectId)
      assert.match(preview.previewId, /^arc-[0-9a-f-]{36}$/, 'previewId format arc-<uuid>')
      assert.ok(preview.expiresAt > Date.now(), 'expiresAt in the future')
      const impacts = preview.impacts
      assert.equal(impacts.projectId, projectId)
      assert.equal(impacts.oldPath, proj)
      assert.equal(impacts.destRoot, destRoot)
      assert.equal(impacts.destPath, join(destRoot, 'demo-web'))
      assert.equal(impacts.crossVolume, false, 'fixture stays on one volume')
      assert.ok(impacts.report.totalHits >= 2, `self-references found, got ${impacts.report.totalHits}`)
      assert.ok(impacts.depSkipDirs.includes('node_modules'), 'strip preview includes node_modules (lockfile present)')
      assert.equal(impacts.occupiers.length, 0, 'no occupiers in the fixture')
      assert.equal(impacts.dirLocked, false, 'fixture dir movable')
      // dry-run 不移动任何东西
      assert.ok(readFileSync(join(proj, 'package.json'), 'utf8').includes('demo-web'), 'dry-run moved nothing')

      // --- run：两段式（未 confirmed → confirmRequired + impacts） ---
      const gated = await svc.runArchive(preview.previewId, undefined)
      assert.equal(gated.confirmRequired, true, 'first phase asks for confirmation')
      assert.equal(gated.impacts.destPath, impacts.destPath, 'impacts echoed')

      // --- 过期拒绝：把 pending 全部置为过期后执行必须 NOT_FOUND ---
      svc._testExpireAllPreviews()
      await assert.rejects(() => svc.runArchive(preview.previewId, true), (e) => e.code === 'NOT_FOUND', 'expired previewId refused')

      // --- 重新预览 + confirmed 执行 ---
      const preview2 = await svc.previewArchive(projectId)
      const done = await svc.runArchive(preview2.previewId, true)
      assert.equal(done.confirmRequired, undefined)
      assert.equal(done.mode, 'renamed', 'same-volume fixture -> rename')
      assert.equal(done.movedFrom, proj)
      assert.equal(done.movedTo, join(destRoot, 'demo-web'))
      assert.ok(existsSyncSafe(join(destRoot, 'demo-web', 'package.json')), 'project moved to dest')
      assert.ok(!existsSyncSafe(proj), 'source gone')
      assert.ok(done.fixed.length >= 1, 'internal files fixed')
      assert.equal(done.residualHits, 0, 'no residual references after rewrite')
      assert.ok(done.skippedDeps.includes('node_modules'), 'node_modules stripped during move')
      // 改写内容验证（JSON 双反斜杠 + 正斜杠变体）
      const rewritten = JSON.parse(readFileSync(join(done.movedTo, 'settings.json'), 'utf8'))
      assert.equal(rewritten.home, done.movedTo, 'escaped variant rewritten')
      assert.equal(rewritten.slash, done.movedTo.replace(/\\/g, '/'), 'slash variant rewritten')

      // --- 落库与联动 ---
      const db = dbModule.getDatabase()
      const run = db.prepare('SELECT * FROM archive_runs WHERE id = ?').get(done.runId)
      assert.ok(run, 'archive_runs row written')
      assert.equal(run.status, 'done')
      assert.equal(run.project_id, projectId)
      assert.equal(run.old_path, proj)
      assert.equal(run.new_path, done.movedTo)
      assert.equal(run.residual_hits, 0)
      assert.deepEqual(JSON.parse(run.stripped_json), ['node_modules'], 'stripped_json records the stripped dirs')
      assert.ok(run.finished_at !== null && run.finished_at >= run.started_at, 'finished_at set')

      const projRow = db.prepare('SELECT win_path, wsl_path FROM projects WHERE id = ?').get(projectId)
      assert.equal(projRow.win_path, done.movedTo, 'projects.win_path updated to the new location')
      assert.equal(
        projRow.wsl_path,
        '/mnt/' + done.movedTo[0].toLowerCase() + done.movedTo.slice(2).replace(/\\/g, '/'),
        'wsl_path recomputed via wslPathForWinPath (/mnt form)',
      )


      const arch = db.prepare('SELECT * FROM archives WHERE run_id = ?').get(done.runId)
      assert.ok(arch, 'archives row linked to the run')
      assert.equal(arch.archive_path, done.movedTo)
      assert.equal(arch.old_path, proj)
      assert.ok(arch.size_bytes > 0, 'size_bytes measured')

      const history = svc.archiveHistory()
      const row = history.runs.find((r) => r.id === done.runId)
      assert.ok(row, 'history exposes the new run')
      assert.equal(row.status, 'done')
      assert.ok(row.undoEntries >= 1, 'undo manifest entries counted')
      assert.deepEqual(row.strippedDirs, ['node_modules'])

      // undo 目录与清单在 DEVHUB_HOME/undo 下
      const fixer = await import(new URL('../src/main/services/archive/pathFixer.ts', import.meta.url).href)
      assert.ok(existsSync(fixer.undoDirOf(done.runId)), 'undo backup dir exists for rollback availability')
      assert.ok(existsSync(fixer.undoManifestPath(done.runId)), 'undo manifest exists')
      assert.ok(home.length > 0, 'home fixture marker (DEVHUB_HOME isolation)')
    } finally {
      dbModule.closeDatabase()
    }

    function existsSyncSafe(p) {
      return existsSync(p)
    }
    function makeS5DirSync(parentDir, name) {
      const dir = join(parentDir, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }
  })

  // 77. 占用检测：cmd.exe 子进程持 cwd + 命令行含夹具路径 → 检出；未勾选终止 → PROJECT_LOCKED；
  //     killPids confirmed → 终止后归档成功（终止只走 confirmed 路径）
  registerCase('s5-77: occupancy — real child process holding cwd+argv in the fixture dir is detected; run without killPids refused (PROJECT_LOCKED); run with confirmed killPids kills then archives', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/archiveService.ts', import.meta.url).href)
    const procGuard = await import(new URL('../src/main/services/archive/procGuard.ts', import.meta.url).href)
    const { spawn } = await import('node:child_process')
    const { mkdtempSync, existsSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    await makeTempHome('devhub-s5-77-home-')
    let child = null
    try {
      const projectsRoot = mkdtempSync(join(tmpdir(), 'devhub-s5-77-proj-'))
      const destRoot = mkdtempSync(join(tmpdir(), 'devhub-s5-77-dest-'))
      const proj = makeS5DirSync(projectsRoot, 'busy-app')
      s5Write(proj, 'package.json', '{"name":"busy-app"}')
      s5Write(proj, 'server.js', '// long running\n')
      const projectId = s5InsertProject(dbModule.getDatabase(), 'busy-app', proj)
      settings.setSetting('archive_dest_root', destRoot)

      // 夹具占用进程：cmd.exe 持 cwd=夹具目录 + 命令行携带夹具路径（真实句柄，非模拟）。
      // （smoke 夹具脚手架允许直接 spawn；产品代码内一切命令仍只经 core/exec.run）
      child = spawn('cmd.exe', ['/d', '/c', `cd /d "${proj}" && ping -n 30 127.0.0.1 >nul`], { cwd: proj, stdio: 'ignore', windowsVerbatimArguments: true })
      const pid = child.pid

      // 检测：轮询等待 CIM 快照看见该进程（exe/cmdline 含项目路径，边界防误伤）
      let occupiers = []
      for (let i = 0; i < 40; i++) {
        occupiers = await procGuard.findOccupiersForPath(proj)
        if (occupiers.some((o) => o.pid === pid)) break
        await new Promise((r) => setTimeout(r, 250))
      }
      assert.ok(occupiers.some((o) => o.pid === pid), `fixture occupier pid ${pid} detected, got ${JSON.stringify(occupiers)}`)
      const hit = occupiers.find((o) => o.pid === pid)
      assert.ok(hit.cmd.toLowerCase().includes(proj.toLowerCase()), 'cmdline carries the project path')

      // 同前缀防误伤：兄弟目录 busy-app-2 不命中
      const sibling = makeS5DirSync(projectsRoot, 'busy-app-2')
      const occSibling = await procGuard.findOccupiersForPath(sibling)
      assert.ok(!occSibling.some((o) => o.pid === pid), 'sibling directory with shared prefix not falsely matched')

      // preview：impacts 展示占用（安全规则 2 的输入）。
      // 注：Win10+ 下「进程 cwd 停留」不必然阻断目录 rename（本机实测 rename 可成功），
      // 故 dirLocked 不作断言；执行闸门以执行时刻的 occupier 清单为准（PROJECT_LOCKED）。
      const preview = await svc.previewArchive(projectId)
      assert.ok(preview.impacts.occupiers.some((o) => o.pid === pid), 'preview impacts list the occupier')
      assert.equal(typeof preview.impacts.dirLocked, 'boolean', 'dirLocked probe returns a boolean')

      // 未勾选终止（无 killPids）→ PROJECT_LOCKED，绝不移动
      let lockedErr = null
      try {
        await svc.runArchive(preview.previewId, true)
      } catch (e) {
        lockedErr = e
      }
      assert.equal(lockedErr?.code, 'PROJECT_LOCKED', 'run without killPids folds to PROJECT_LOCKED')
      assert.equal(existsSync(join(proj, 'package.json')), true, 'nothing moved on the locked refusal')

      // killPids 红线：不在 impacts 清单内的 pid → BAD_PAYLOAD
      await assert.rejects(
        () => svc.runArchive(preview.previewId, true, [pid + 100000]),
        (e) => e.code === 'BAD_PAYLOAD',
        'killPids outside the previewed occupiers refused',
      )

      // confirmed + killPids（impacts 内 pid）→ 终止占用后归档成功
      const preview2 = await svc.previewArchive(projectId)
      const done = await svc.runArchive(preview2.previewId, true, [pid])
      assert.equal(done.confirmRequired, undefined)
      assert.equal(done.mode, 'renamed')
      assert.ok(existsSync(join(done.movedTo, 'server.js')), 'archived after the occupier was terminated')

      // 子进程已死（taskkill 温和路径即可终止 cmd/ping 树）
      let gone = false
      try {
        process.kill(pid, 0)
      } catch {
        gone = true
      }
      assert.equal(gone, true, 'occupier process terminated')
    } finally {
      if (child !== null && child.exitCode === null) {
        try {
          child.kill()
        } catch {}
      }
      dbModule.closeDatabase()
    }

    function makeS5DirSync(parentDir, name) {
      const dir = join(parentDir, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }
  })

  // 78. rollback：undo 内容还原 + 目录移回 + projects 还原 + archives 行删除 + undo 清理；
  //     重复回滚拒绝；无 confirmed 先回 impacts
  registerCase('s5-78: rollback — two-phase gate, content restored byte-for-byte, dir moved back, projects row restored, archives row removed, undo cleaned; re-rollback refused', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/archiveService.ts', import.meta.url).href)
    const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    await makeTempHome('devhub-s5-78-home-')
    try {
      const projectsRoot = mkdtempSync(join(tmpdir(), 'devhub-s5-78-proj-'))
      const destRoot = mkdtempSync(join(tmpdir(), 'devhub-s5-78-dest-'))
      const proj = makeS5DirSync(projectsRoot, 'roll-app')
      s5Write(proj, 'package.json', '{"name":"roll-app"}')
      s5Write(proj, 'refs.txt', `home = ${proj}\n`)
      const originalRefs = readFileSync(join(proj, 'refs.txt'), 'utf8')
      const projectId = s5InsertProject(dbModule.getDatabase(), 'roll-app', proj)
      settings.setSetting('archive_dest_root', destRoot)

      const preview = await svc.previewArchive(projectId)
      const done = await svc.runArchive(preview.previewId, true)
      assert.equal(done.residualHits, 0)
      const runId = done.runId

      // 第一段：confirmRequired + impacts
      const gate = await svc.rollbackArchive(runId)
      assert.equal(gate.confirmRequired, true)
      assert.equal(gate.impacts.runId, runId)
      assert.equal(gate.impacts.undoEntries, done.fixed.length)
      assert.equal(gate.impacts.oldPath, proj)
      assert.equal(gate.impacts.newPath, done.movedTo)

      // 第二段：confirmed → 内容还原 + 移回 + projects 还原 + undo 清理
      const rb = await svc.rollbackArchive(runId, true)
      assert.equal(rb.status, 'rolled-back')
      assert.equal(rb.restored, done.fixed.length, 'all rewritten files restored')
      assert.equal(rb.movedBack, true, 'directory moved back to the original location')
      assert.equal(rb.projectsRestored, true, 'projects.win_path restored')

      // 项目回到原路径、内容逐字节恢复、归档副本消失
      assert.equal(existsSync(join(proj, 'package.json')), true, 'project back at the original path')
      assert.equal(readFileSync(join(proj, 'refs.txt'), 'utf8'), originalRefs, 'reference file content restored byte-for-byte')
      assert.equal(existsSync(done.movedTo), false, 'archive location gone after moving back')

      const db = dbModule.getDatabase()
      const runRow = db.prepare('SELECT status FROM archive_runs WHERE id = ?').get(runId)
      assert.equal(runRow.status, 'rolled-back', 'run status rolled-back')
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM archives WHERE run_id = ?').get(runId).c, 0, 'archives row removed on rollback')
      const projRow = db.prepare('SELECT win_path FROM projects WHERE id = ?').get(projectId)
      assert.equal(projRow.win_path, proj, 'projects.win_path restored')

      // undo 清理（完整成功路径）
      assert.equal(existsSync(join(process.env.DEVHUB_HOME, 'undo', String(runId))), false, 'undo backup dir cleaned after full rollback')
      assert.equal(existsSync(join(process.env.DEVHUB_HOME, 'undo', `${runId}.json`)), false, 'undo manifest cleaned')

      // 重复回滚拒绝
      await assert.rejects(() => svc.rollbackArchive(runId, true), (e) => e.code === 'DB_ERROR' && /already rolled back/.test(e.message), 're-rollback refused')
    } finally {
      dbModule.closeDatabase()
    }

    function makeS5DirSync(parentDir, name) {
      const dir = join(parentDir, name)
      mkdirSync(dir, { recursive: true })
      return dir
    }
  })

  // 79. 历史上限：夹具灌 101 条 → 保留 100 删最旧（undo 不随裁剪删除）；history limit 边界
  registerCase('s5-79: history cap — 101 fixture rows trim to 100 keeping the newest; undo dirs untouched by trimming; archiveHistory limit boundaries', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/archiveService.ts', import.meta.url).href)
    const fixer = await import(new URL('../src/main/services/archive/pathFixer.ts', import.meta.url).href)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    await makeTempHome('devhub-s5-79-home-')
    try {
      const db = dbModule.getDatabase()
      const insert = db.prepare(
        "INSERT INTO archive_runs (project_id, project_name, old_path, new_path, status, fixed_files, external_files, residual_hits, started_at) VALUES (NULL, ?, ?, ?, 'done', 1, 0, 0, ?)",
      )
      for (let i = 1; i <= 101; i++) {
        insert.run(`proj-${i}`, `old-${i}`, `new-${i}`, 1700000000 + i)
      }
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM archive_runs').get().c), 101, '101 fixture rows before trim')

      // undo 目录：给最旧 run #1 造备份 + 清单——裁剪绝不动 undo（数据安全优先）
      mkdirSync(fixer.undoDirOf(1), { recursive: true })
      writeFileSync(join(fixer.undoDirOf(1), '0001-a.txt'), 'backup bytes')
      fixer.saveUndoManifest({ runId: 1, entries: [{ target: 'new-1/a.txt', backup: join(fixer.undoDirOf(1), '0001-a.txt') }] })

      svc.trimArchiveRuns(db)
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM archive_runs').get().c), 100, 'cap enforced at 100')
      assert.equal(db.prepare('SELECT id FROM archive_runs WHERE id = 1').get(), undefined, 'oldest run (id 1) trimmed')
      assert.ok(db.prepare('SELECT id FROM archive_runs WHERE id = 101').get(), 'newest run kept')
      assert.equal(fixer.undoDirOf(1) !== '', true, 'undo root derivable')
      const { existsSync } = await import('node:fs')
      assert.equal(existsSync(join(fixer.undoDirOf(1), '0001-a.txt')), true, 'undo backups survive the trim')
      assert.ok(existsSync(fixer.undoManifestPath(1)), 'undo manifest survives the trim')

      // history 投影：默认 100 上限；limit=5 → 5 行（最新优先）；limit>100 service 侧封顶
      const all = svc.archiveHistory()
      assert.equal(all.runs.length, 100, 'default limit 100')
      assert.equal(all.runs[0].projectName, 'proj-101', 'newest first')
      const five = svc.archiveHistory(5)
      assert.deepEqual(five.runs.map((r) => r.projectName), ['proj-101', 'proj-100', 'proj-99', 'proj-98', 'proj-97'], 'limit honored')
      const over = svc.archiveHistory(500)
      assert.equal(over.runs.length, 100, 'service caps limit at 100')

      // undoEntries 投影：裁剪后的 run 无清单 → null（绝不硬造 0）
      const trimmedRow = all.runs.find((r) => r.projectName === 'proj-2')
      assert.ok(trimmedRow, 'a surviving row exists')
      assert.equal(trimmedRow.undoEntries, null, 'rows without undo manifests report null')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 80. handlers：archive channels dispatch 可达 + 严格校验（projectId≥1 / previewId 格式 / runId≥1）
  registerCase('s5-80: archive handlers dispatch — whitelist + registry coverage, strict payload validation, unknown archive sub-channel folds to CHANNEL_NOT_ALLOWED', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const channels = await import(new URL('../src/shared/channels.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/archiveService.ts', import.meta.url).href)

    await makeTempHome('devhub-s5-80-home-')
    try {
      const registry = handlers.createHandlerRegistry({ appVersion: 's5-smoke' })
      const archiveChannels = channels.IPC_CHANNELS.filter((c) => c.startsWith('archive:'))
      assert.deepEqual(
        [...archiveChannels].sort(),
        ['archive:history', 'archive:preview', 'archive:rollback', 'archive:run', 'archive:status'],
        '5 archive channels per docs/10 §11 naming',
      )
      for (const ch of archiveChannels) {
        assert.ok(typeof registry[ch] === 'function', `${ch} has a registered handler`)
      }

      // projectId 严格校验：0 / 负数 / 非整数 / 非数字 → BAD_PAYLOAD
      for (const bad of [0, -1, 1.5, '1', null]) {
        const res = await handlers.dispatchGatewayRequest(registry, { channel: 'archive:preview', payload: { projectId: bad } })
        assert.equal(res.ok, false, `projectId ${JSON.stringify(bad)} rejected`)
        assert.equal(res.error.code, 'BAD_PAYLOAD')
      }
      // previewId 格式校验：非 arc-<uuid> → BAD_PAYLOAD
      for (const bad of ['', 'arc', 'arc-xyz', 'arc-12345', '<script>', `arc-${'g'.repeat(8)}-0000-4000-8000-000000000000`]) {
        const res = await handlers.dispatchGatewayRequest(registry, { channel: 'archive:run', payload: { previewId: bad, confirmed: true } })
        assert.equal(res.ok, false, `previewId ${JSON.stringify(bad)} rejected`)
        assert.equal(res.error.code, 'BAD_PAYLOAD', 'previewId format enforced at the gateway')
      }
      // 合法格式但未知 → 服务端 NOT_FOUND（注册表校验兜底，安全规则 1）
      const forged = await handlers.dispatchGatewayRequest(registry, {
        channel: 'archive:run',
        payload: { previewId: 'arc-00000000-0000-4000-8000-000000000000', confirmed: true },
      })
      assert.equal(forged.ok, false)
      assert.equal(forged.error.code, 'NOT_FOUND', 'forged-but-well-formed previewId folds to NOT_FOUND')

      // runId 严格校验：0 / 非整数 → BAD_PAYLOAD；未知 → NOT_FOUND
      for (const bad of [0, -3, 2.5, '1']) {
        const res = await handlers.dispatchGatewayRequest(registry, { channel: 'archive:rollback', payload: { runId: bad } })
        assert.equal(res.error.code, 'BAD_PAYLOAD', `runId ${JSON.stringify(bad)} rejected`)
      }
      const unknownRun = await handlers.dispatchGatewayRequest(registry, { channel: 'archive:rollback', payload: { runId: 424242 } })
      assert.equal(unknownRun.error.code, 'NOT_FOUND')

      // archive:status：格式校验 + 未知 previewId → NOT_FOUND
      const badStatus = await handlers.dispatchGatewayRequest(registry, { channel: 'archive:status', payload: { previewId: 'nope' } })
      assert.equal(badStatus.error.code, 'BAD_PAYLOAD')
      const unknownStatus = await handlers.dispatchGatewayRequest(registry, {
        channel: 'archive:status',
        payload: { previewId: 'arc-00000000-0000-4000-8000-000000000000' },
      })
      assert.equal(unknownStatus.error.code, 'NOT_FOUND')

      // archive:history：limit 校验（0/负/小数/超上限 → BAD_PAYLOAD；合法 → 落库行投影）
      for (const bad of [0, -1, 1.5, 101]) {
        const res = await handlers.dispatchGatewayRequest(registry, { channel: 'archive:history', payload: { limit: bad } })
        assert.equal(res.error.code, 'BAD_PAYLOAD', `limit ${JSON.stringify(bad)} rejected`)
      }
      const db = dbModule.getDatabase()
      db.prepare(
        "INSERT INTO archive_runs (project_id, project_name, old_path, new_path, status, fixed_files, external_files, residual_hits, stripped_json, started_at, finished_at) VALUES (NULL, 'DemoWeb', 'C:\\\\Temp\\\\pa\\\\DemoWeb', 'G:\\\\__zk-dep-test\\\\archived\\\\DemoWeb', 'done', 1, 2, 1, NULL, 1788266592, 1788266592)",
      ).run()
      const history = await handlers.dispatchGatewayRequest(registry, { channel: 'archive:history', payload: {} })
      assert.equal(history.ok, true, 'archive:history dispatches')
      assert.equal(history.data.runs.length, 1, 'legacy-style row returned')
      assert.equal(history.data.runs[0].projectName, 'DemoWeb')
      assert.equal(history.data.runs[0].strippedDirs, null, 'legacy stripped_json NULL projected as null')
      assert.equal(history.data.runs[0].undoEntries, null, 'legacy row has no undo manifest')

      // archive:settings 未设专用 channel（dest_root 读写由 settings:get/set 承担）→ 网关按白名单拒绝
      const settingsProbe = await handlers.dispatchGatewayRequest(registry, { channel: 'archive:settings', payload: {} })
      assert.equal(settingsProbe.ok, false)
      assert.equal(settingsProbe.error.code, 'CHANNEL_NOT_ALLOWED', 'docs/04 §1 stable error code for off-whitelist names')

      // killPids 形状校验
      const badKill = await handlers.dispatchGatewayRequest(registry, {
        channel: 'archive:run',
        payload: { previewId: 'arc-00000000-0000-4000-8000-000000000000', confirmed: true, killPids: [0] },
      })
      assert.equal(badKill.error.code, 'BAD_PAYLOAD', 'killPids must be positive integers')

      // service 内存注册表复位（不影响其它用例）
      svc._testReset()
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // ==================================================================
  // AC2 批次（docs/13 / docs/14 §A / docs/16 §1 AC2 行）：Agent Control
  // 数据层 + 白名单（81-88 追加；step1/step3/step5/step6/s1-40/s4-68 的
  // 计数断言按 s4-68「就地更新」授权模式更新并已在用例内注明）。
  // 全部用例夹具化：显式临时库或 makeTempHome 隔离 home；绝不触碰真实库。
  // ==================================================================

  // 81. migration 004 fresh 路径：user_version=4 + 8 新表 + 4 settings 种子 +
  //     agent_events AUTOINCREMENT（docs/13 §3/§4/§6）
  registerCase('ac2-81: migration 004 fresh — user_version=4, 8 new tables, 4 settings seeds, agent_events AUTOINCREMENT sequence', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac2-81-'))
    const db = dbModule.openDatabase(join(dir, 'fresh.db'))
    try {
      const applied = dbModule.migrate(db)
      assert.equal(applied, 7, '001..006+008 applied on fresh db (CP1 批次就地更新 6→7)')
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 8, 'fresh db at user_version 8 (CP1 批次就地更新 6→8)')

      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
      for (const t of [
        'agent_providers',
        'agent_sessions',
        'agent_messages',
        'agent_events',
        'remote_devices',
        'remote_commands',
        'event_deliveries',
        'security_audit_logs',
      ]) {
        assert.ok(tables.has(t), `new table ${t} exists`)
      }

      // docs/13 §4.4：agent_events.id 显式 AUTOINCREMENT（删最大行后 sequence 不回绕）
      const now = 1700000000
      db.prepare("INSERT INTO agent_events (event_type, event_id, payload_json, created_at) VALUES ('session.started', 'codex:s1:started:a', '{}', ?)").run(now)
      const firstId = Number(db.prepare('SELECT id FROM agent_events').get().id)
      db.prepare('DELETE FROM agent_events').run()
      db.prepare("INSERT INTO agent_events (event_type, event_id, payload_json, created_at) VALUES ('session.started', 'codex:s1:started:b', '{}', ?)").run(now)
      const secondId = Number(db.prepare('SELECT id FROM agent_events').get().id)
      assert.equal(secondId, firstId + 1, `AUTOINCREMENT sequence never reuses ids after delete (${firstId} -> ${secondId})`)

      const seeds = Object.fromEntries(
        db.prepare("SELECT key, value FROM settings WHERE key IN ('gateway_port','gateway_enabled','agents_monitor_enabled','login_autostart')").all().map((r) => [r.key, r.value]),
      )
      assert.deepEqual(
        seeds,
        { gateway_port: '8746', gateway_enabled: '0', agents_monitor_enabled: '1', login_autostart: '0' },
        '4 AC settings seeds per docs/13 §6',
      )

      assert.equal(dbModule.migrate(db), 0, 'idempotent re-run applies nothing')
    } finally {
      db.close()
    }
  }, 'fast')

  // 82. migration 004 v3→v4 升级路径（T1）：手工 v3 库预置 19 表数据 → 仅应用 004
  //     → 既有 19 表行级零变化（settings 例外 = 文档设计内的 4 条新种子键）
  registerCase('ac2-82: migration 004 v3→v4 upgrade — legacy 19 tables row-for-row unchanged (T1), only 004 applies, 4 settings seeds added', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac2-82-'))
    const db2 = dbModule.openDatabase(join(dir, 'v3.db'))
    try {
      db2.exec(readFileSync(new URL('../src/main/db/migrations/001_init.sql', import.meta.url), 'utf8'))
      db2.exec(readFileSync(new URL('../src/main/db/migrations/002_env_tools_unique.sql', import.meta.url), 'utf8'))
      db2.exec(readFileSync(new URL('../src/main/db/migrations/003_merge_legacy.sql', import.meta.url), 'utf8'))
      db2.exec('PRAGMA user_version = 3') // 约束 #11 唯一例外；构造 v3 状态用

      const now = 1700000000
      db2.prepare("INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES ('proj-a', 'proj-a', 'C:/tmp/proj-a', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO projects (name, slug, wsl_path, created_at, updated_at) VALUES ('proj-b', 'proj-b', '/mnt/c/b', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO repositories (project_id, remote_url, branch, head_sha, is_dirty, ahead, behind, created_at, updated_at) VALUES (1, 'https://example.invalid/a', 'main', 'deadbeef01', 1, 2, 0, ?, ?)").run(now, now)
      db2.prepare("INSERT INTO environments (name, kind, os_version, detected_at, created_at, updated_at) VALUES ('windows', 'windows', '10.0.26200', ?, ?, ?)").run(now, now, now)
      db2.prepare("INSERT INTO environment_tools (environment_id, tool, version, path, state, created_at, updated_at) VALUES (1, 'node', '24.15.0', 'C:/node.exe', 'installed', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO environment_tools (environment_id, tool, version, path, state, created_at, updated_at) VALUES (1, 'python', '3.13.5', 'C:/python.exe', 'installed', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO services (port, protocol, pid, process_name, command_line, working_dir, origin, project_id, first_seen_at, last_seen_at) VALUES (8080, 'tcp', 1234, 'node.exe', 'node server.js', 'C:/tmp/proj-a', 'windows', 1, ?, ?)").run(now, now)
      db2.prepare("INSERT INTO containers (docker_id, name, image, state, ports_json, project_id, created_at, updated_at) VALUES ('abc123def456', 'web', 'nginx:latest', 'running', '[{\"host\":80,\"container\":80,\"proto\":\"tcp\"}]', 1, ?, ?)").run(now, now)
      db2.prepare("INSERT INTO devices (name, host, user, kind, last_connected_at, created_at, updated_at) VALUES ('legacy-dev', 'h1', 'u1', 'ssh', ?, ?, ?)").run(now, now, now)
      db2.prepare("INSERT INTO skills (name, source_path, vault_rel_path, frontmatter_json, description, created_at, updated_at) VALUES ('skill-x', 'D:/src/skill-x', 'skills/skill-x', NULL, 'does x', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO mcp_servers (name, command, config_path, created_at, updated_at) VALUES ('mcp-1', 'node mcp.js', 'C:/mcp.json', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO archives (project_id, archive_path, run_id, old_path, size_bytes, created_at, updated_at) VALUES (1, 'C:/arc/proj-a', NULL, NULL, 5, ?, ?)").run(now, now)
      db2.prepare("INSERT INTO resources (resource_type, ref_id, display_name, created_at, updated_at) VALUES ('project', 1, 'proj-a', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO resources (resource_type, ref_id, display_name, created_at, updated_at) VALUES ('repository', 1, 'https://example.invalid/a', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO relationships (source_resource_id, target_resource_id, relation_type, created_at) VALUES (1, 2, 'contains', ?)").run(now)
      db2.prepare("INSERT INTO scans (kind, root_path, started_at, finished_at, status, found_count) VALUES ('projects', 'C:/tmp', ?, ?, 'done', 2)").run(now, now)
      db2.prepare("INSERT INTO settings (key, value) VALUES ('custom_key', 'keepme')").run()
      db2.prepare("INSERT INTO skill_agents (name, platform, skills_dir, agents_dir, include_json, enabled, created_at, updated_at) VALUES ('agent-a', 'windows', 'C:/a/skills', NULL, '[\"*\"]', 1, ?, ?)").run(now, now)
      db2.prepare("INSERT INTO skill_links (agent_id, skill_id, state, checked_at) VALUES (1, 1, 'linked', ?)").run(now)
      db2.prepare("INSERT INTO apihub_profiles (name, provider, encrypted_blob, needs_rekey, created_at, updated_at) VALUES ('p1', 'codex', NULL, 0, ?, ?)").run(now, now)
      db2.prepare("INSERT INTO version_targets (key, display_name, kind, installed_version, target_version, state, last_checked_at) VALUES ('codex-desktop', 'Codex', 'native', '1.0.0', NULL, 'up-to-date', ?)").run(now)
      db2.prepare("INSERT INTO archive_runs (project_id, project_name, old_path, new_path, status, fixed_files, external_files, residual_hits, stripped_json, started_at, finished_at) VALUES (1, 'proj-a', 'C:/tmp/proj-a', 'G:/arc/proj-a', 'done', 1, 0, 0, NULL, ?, ?)").run(now, now)

      const LEGACY_TABLES = [
        'projects', 'repositories', 'environments', 'environment_tools', 'services', 'containers',
        'devices', 'skills', 'mcp_servers', 'archives', 'resources', 'relationships', 'scans',
        'settings', 'skill_agents', 'skill_links', 'apihub_profiles', 'version_targets', 'archive_runs',
      ]
      assert.equal(LEGACY_TABLES.length, 19, 'exactly the 19 legacy tables are snapshotted')
      const before = {}
      for (const t of LEGACY_TABLES) before[t] = db2.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()
      assert.ok(before.settings.length >= 5, 'v3 settings carry 001/003 seeds + custom row')

      const applied = dbModule.migrate(db2)
      assert.equal(applied, 4, 'only 004..006+008 apply to the v3 library (CP1 批次就地更新 3→4)')
      assert.equal(Number(db2.prepare('PRAGMA user_version').get().user_version), 8, 'v3 upgraded to user_version 8 (CP1 批次就地更新 6→8)')

      for (const t of LEGACY_TABLES) {
        const after = db2.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()
        if (t === 'settings') {
          // docs/13 §7：settings 是唯一设计内新增行（4 条种子键），既有行零变化
          const afterByKey = Object.fromEntries(after.map((r) => [r.key, r.value]))
          for (const row of before.settings) {
            assert.equal(afterByKey[row.key], row.value, `settings.${row.key} unchanged (T1)`)
          }
          const addedKeys = after.filter((r) => !before.settings.some((b) => b.key === r.key)).map((r) => r.key).sort()
          assert.deepEqual(
            addedKeys,
            ['agents_monitor_enabled', 'contestpin_default_mode', 'contestpin_overlay_enabled', 'gateway_enabled', 'gateway_port', 'login_autostart'],
            'exactly the AC2 4 seed keys + CP1 2 contestpin seeds added (docs/13 §6 + docs/22 §2.1; CP1 批次就地更新 +2)',
          )
        } else {
          assert.deepEqual(after, before[t], `legacy table ${t} row-for-row unchanged (T1; devices/mcp_servers 预留表原样保留)`)
        }
      }
    } finally {
      db2.close()
    }
  }, 'fast')

  // 83. T2 负向护栏：setUserVersionLiteral 对未注册版本（99）显式 throw
  registerCase('ac2-83: T2 negative guard — setUserVersionLiteral throws for unregistered version; case 4 literal assignment works', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const { setUserVersionLiteral } = await import(new URL('../src/main/db/migrate.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac2-83-'))
    const db = dbModule.openDatabase(join(dir, 't.db'))
    try {
      assert.throws(
        () => setUserVersionLiteral(db, 99),
        /no literal user_version statement registered for migration version 99/,
        'unregistered version must throw (T2, docs/13 §3)',
      )
      for (const v of [1, 2, 3, 4]) {
        setUserVersionLiteral(db, v)
        assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), v, `registered literal case ${v} works`)
      }
    } finally {
      db.close()
    }
  }, 'fast')

  // 84. agents 13 条 channel：白名单尾部按 docs/14 §A.1 顺序逐字存在 + 注册表覆盖
  registerCase('ac2-84: agents channels (14, 夜间#1 就地更新 13→14) — whitelist tail in docs/14 §A.1 order, registry handlers, compile-time contract assertion holds（CP3a 就地更新 84→88：contestpin 尾窗再前移）', async () => {
    const channels = await import(new URL('../src/shared/channels.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)

    const expectedAgents = [
      'agents:providers',
      'agents:sessions',
      'agents:sessionDetail',
      'agents:messages',
      'agents:events',
      'agents:sessionAction',
      'agents:pairingCreate',
      'agents:devices',
      'agents:deviceRevoke',
      'agents:gatewayStatus',
      'agents:gatewayRestart',
      'agents:setAutoStart',
      'agents:diagnostics',
      'agents:probeProvider',
    ]
    assert.equal(channels.IPC_CHANNELS.length, 88, 'whitelist 55 → 70 (docs/14 §A.2; 夜间#1 就地更新 68→70), 70 → 79 (CP1 就地更新，docs/04 ContestPin 追加节), 79 → 84 (CP2 就地更新，docs/22 §4 悬浮窗 5 条), 84 → 88 (CP3a 就地更新，docs/22 §6 识别配置 4 条)')
    // CP3a 就地更新：CP2 后追加 CP3a contestpin 4 条（configList/Save/Delete/Test），
    // agents 尾窗再前移为 slice(-32, -18)
    assert.deepEqual([...channels.IPC_CHANNELS.slice(-32, -18)], expectedAgents, '14 agents channels appended verbatim in docs/14 §A.1 order (夜间#1 就地更新 13→14)')
    assert.deepEqual(
      [...channels.IPC_CHANNELS.slice(-18, -9)],
      [
        'contestpin:list',
        'contestpin:get',
        'contestpin:create',
        'contestpin:update',
        'contestpin:delete',
        'contestpin:archive',
        'contestpin:nodeUpsert',
        'contestpin:nodeDelete',
        'contestpin:linkProject',
      ],
      '9 contestpin channels appended verbatim in docs/04 ContestPin 追加节 order (CP1 批次)',
    )
    assert.deepEqual(
      [...channels.IPC_CHANNELS.slice(-9, -4)],
      [
        'contestpin:overlayState',
        'contestpin:overlaySetEnabled',
        'contestpin:overlaySetCollapsed',
        'contestpin:openInMain',
        'contestpin:openLink',
      ],
      '5 contestpin overlay channels appended verbatim in docs/22 §4 order (CP2 批次)',
    )
    assert.deepEqual(
      [...channels.IPC_CHANNELS.slice(-4)],
      [
        'contestpin:configList',
        'contestpin:configSave',
        'contestpin:configDelete',
        'contestpin:configTest',
      ],
      '4 contestpin recognition-config channels appended verbatim in docs/22 §6 order (CP3a 批次)',
    )

    const registry = handlers.createHandlerRegistry({ appVersion: 'ac2-smoke' })
    for (const ch of expectedAgents) {
      assert.equal(typeof registry[ch], 'function', `${ch} has a registered handler`)
    }
    assert.equal(handlers.contractCoversWhitelist, true, 'ChannelContract covers exactly the whitelist (observed at runtime)')
  }, 'fast')

  // 85. agent_sessions CHECK：session_mode 三态 CHECK 拒绝非法值；9 值 status 全部
  //     可插入（status 在 docs/13 §4.2 为注释枚举、无 CHECK——运行期合法性由
  //     AGENT_SESSION_STATUSES 白名单承担，「非法 status 拒绝」按批次报告冲突项处理）
  registerCase('ac2-85: agent_sessions — 9 status values all insertable; illegal session_mode rejected by CHECK; default status unknown', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac2-85-'))
    const db = dbModule.openDatabase(join(dir, 't.db'))
    try {
      dbModule.migrate(db)
      const now = 1700000000
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('codex', 'Codex', ?, ?)").run(now, now)

      assert.equal(svc.AGENT_SESSION_STATUSES.length, 9, 'AC1 修正后的 SessionStatus 9 值权威')
      let i = 0
      for (const status of svc.AGENT_SESSION_STATUSES) {
        i += 1
        db.prepare('INSERT INTO agent_sessions (provider_id, native_id, status, created_at, updated_at) VALUES (1, ?, ?, ?, ?)').run(
          `native-${status}`,
          status,
          now + i,
          now + i,
        )
      }
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get().c), 9, 'all 9 status values insert cleanly')

      // session_mode CHECK（docs/13 §4.2：授权矩阵判定根）
      assert.throws(
        () => db.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (1, 'native-bad-mode', 'hijacked', 'running', ?, ?)").run(now, now),
        /CHECK/,
        'illegal session_mode rejected by CHECK constraint',
      )

      // 缺省 status = 'unknown'（DDL DEFAULT）
      db.prepare("INSERT INTO agent_sessions (provider_id, native_id, created_at, updated_at) VALUES (1, 'native-default', ?, ?)").run(now, now)
      const row = db.prepare("SELECT status FROM agent_sessions WHERE native_id = 'native-default'").get()
      assert.equal(row.status, 'unknown', 'status defaults to unknown')
    } finally {
      db.close()
    }
  }, 'fast')

  // 86. redact.ts：maskKey 只出尾 4 位 + 长度；redactText 打码 token=/password= 值段
  registerCase('ac2-86: redact.ts — maskKey tail4+len only, redactText masks token/password/api_key value segments, no full secret leakage, idempotent', async () => {
    const redact = await import(new URL('../src/main/services/agentControl/redact.ts', import.meta.url).href)

    const secret = 'sk-proj-abcdef1234567890'
    const masked = redact.maskKey(secret)
    assert.deepEqual(masked, { tail: '7890', len: secret.length }, 'maskKey = tail 4 + length')
    assert.ok(!JSON.stringify(masked).includes('sk-proj'), 'mask output never carries a value prefix')

    const long = 'AKIA' + 'A'.repeat(36)
    assert.deepEqual(redact.maskKey(long), { tail: long.slice(-4), len: long.length }, 'maskKey works for long keys')

    const text = 'login failed: token=abc123secret and password="hunter2pass" and api_key=KIMIKEY9988 end'
    const redacted = redact.redactText(text)
    assert.ok(redacted.includes('token=***'), 'token value masked')
    assert.ok(redacted.includes('password=***'), 'password value masked (quoted form)')
    assert.ok(redacted.includes('api_key=***'), 'api_key value masked')
    assert.ok(!redacted.includes('abc123secret'), 'full token value absent')
    assert.ok(!redacted.includes('hunter2pass'), 'full password value absent')
    assert.ok(!redacted.includes('KIMIKEY9988'), 'full api_key value absent')

    assert.equal(redact.redactText('plain text without secrets'), 'plain text without secrets', 'non-sensitive text untouched')
    assert.equal(redact.redactText(redacted), redacted, 'redaction is idempotent')
  }, 'fast')

  // 87. agents 读类 channel dispatch（s5-80 模式）：真实探测投影 + gatewayStatus
  //     settings 真值 + 诊断形状 + payload 严格校验。
  //     AC3 批次 note（docs/16 §1 AC3 行授权的就地更新）：agents:providers 从「空态
  //     投影」升级为「catalog ensure + fixture provider 真实探测落库」（本批 IPC 升级
  //     交付物）；providers 断言从 [] 改为 5 行 catalog + fixture 探测值；diagnostics
  //     providers 断言同步。provider 经 setProviderOverride 注入夹具（真机路径零触碰）。
  function stubAgentProvider(id, opts = {}) {
    return {
      id,
      probeHealth: async () => ({
        installed: opts.installed ?? false,
        health: opts.health ?? 'unavailable',
        ...(opts.version !== undefined ? { version: opts.version } : {}),
        ...(opts.healthDetail !== undefined ? { healthDetail: opts.healthDetail } : {}),
      }),
      listSessions: async () => opts.sessions ?? [],
      readMessages: async () => ({ messages: [], cursor: '0', hasMore: false }),
      getCapabilities: async () => ({ mode: 'observed', granted: [], verifiedAt: Math.floor(Date.now() / 1000), evidence: 'fixture provider (smoke)' }),
      sendReply: async () => ({ ok: false, status: 'unsupported', errorCode: 'AGENT_CAPABILITY_MISSING', detail: 'fixture provider' }),
      pause: async () => ({ ok: false, status: 'unsupported', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: 'fixture provider' }),
      resume: async () => ({ ok: false, status: 'unsupported', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: 'fixture provider' }),
      startMonitor: () => ({ providerId: id, stop: async () => {} }),
      dispose: async () => {},
      describeDiagnostics: () => ({
        dataSource: { kind: opts.diagKind ?? 'fixture-source', readable: opts.diagReadable ?? false },
        control: { note: 'fixture provider (smoke)' },
      }),
    }
  }

  registerCase('ac2-87: agents read channels dispatch — catalog providers with fixture probe rows, gatewayStatus settings truth with running:false, diagnostics shape, strict payload validation (AC3 就地更新授权: docs/16 §1 AC3 行)', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    await makeTempHome('devhub-ac2-87-')
    try {
      svc.setProviderOverride('codex', stubAgentProvider('codex', { healthDetail: 'fixture: codex.exe not found' }))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      // AC4 批次就地更新（docs/16 §1 AC4 行授权模式，与 s4-68 同款）：kimi/zcode/
      // deepseek 三家 wired 后，本用例的探测/监控面必须保持夹具隔离——真机 kimi
      // --version 与真实 zcode db 探测/监控不允许在本用例内启动（否则真实会话会
      // 落入本用例断言库）。三家注入 stub。
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('zcode', stubAgentProvider('zcode'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      const registry = handlers.createHandlerRegistry({ appVersion: 'ac2-smoke' })
      const dispatch = (channel, payload) => handlers.dispatchGatewayRequest(registry, { channel, payload })

      // providers：catalog 5 行 ensure + fixture 真实探测落库（AC3 接线后的真实投影）
      const providers = await dispatch('agents:providers', {})
      assert.equal(providers.ok, true)
      assert.equal(providers.data.providers.length, 5, 'catalog ensure creates all 5 provider rows')
      assert.equal(providers.data.monitorEnabled, true, 'monitorEnabled from settings seed (1)')
      assert.ok(providers.data.probedAt !== null, 'probedAt stamped by real probe pass')
      const codexRow = providers.data.providers.find((p) => p.displayName === 'Codex')
      assert.ok(codexRow !== undefined, 'codex row present')
      assert.equal(codexRow.installed, false, 'fixture probe reports not installed')
      assert.equal(codexRow.health, 'unavailable', 'fixture probe health carried into row')
      assert.ok(codexRow.healthDetail.includes('fixture'), 'healthDetail carried into row')
      assert.equal(codexRow.enabled, true, 'per-provider enabled default 1')
      assert.ok(codexRow.lastProbeAt !== null, 'lastProbeAt stamped')

      // 监控关闭：零探测，返回缓存 + monitorEnabled:false 语义
      await dispatch('settings:set', { key: 'agents_monitor_enabled', value: '0' })
      const cached = await dispatch('agents:providers', {})
      assert.equal(cached.data.monitorEnabled, false, 'monitor off semantics')
      assert.equal(cached.data.providers.length, 5, 'cached rows still returned when monitor off')

      const sessions = await dispatch('agents:sessions', {})
      assert.deepEqual(sessions.data.sessions, [], 'sessions empty state')
      const devices = await dispatch('agents:devices', {})
      assert.deepEqual(devices.data.devices, [], 'devices empty state')
      const events = await dispatch('agents:events', {})
      // AC3 探测接线后：provider.health_changed 事件（unknown → fixture 探测值）真实落库
      assert.ok(events.data.events.length >= 1, 'probe writes provider.health_changed events')
      assert.ok(events.data.events.every((e) => e.eventType === 'provider.health_changed'), 'only health_changed events so far')

      // gatewayStatus：settings 真值 + running:false（结构化而非错误）
      const gw = await dispatch('agents:gatewayStatus', {})
      assert.deepEqual(
        gw.data,
        { enabled: false, running: false, port: 8746, activeDevices: 0, natpierce: { configured: false } },
        'gatewayStatus = seed truth + no listener (docs/14 §A.1 #10)',
      )

      // diagnostics：providers 数据源/控制通道真实形态（AC3：wired → describeDiagnostics，
      // 未 wired → 结构化 AC4 标注）+ 托盘/自启真值
      const diag = await dispatch('agents:diagnostics', {})
      assert.equal(diag.data.providers.length, 5, 'diagnostics covers catalog rows')
      const codexDiag = diag.data.providers.find((p) => p.id === codexRow.id)
      assert.equal(codexDiag.installed, false)
      assert.equal(codexDiag.exeFound, false, 'exeFound reflects probe')
      assert.equal(codexDiag.dataSource.kind, 'fixture-source', 'wired provider reports its data source kind via describeDiagnostics')
      assert.ok(codexDiag.control.note.length > 0, 'control note present')
      const deepseekRow = providers.data.providers.find((p) => p.displayName === 'DeepSeek Harness')
      const deepseekDiag = diag.data.providers.find((p) => p.id === deepseekRow.id)
      // AC4 批次就地更新（同上授权）：deepseek 已 wired，本用例注入 stub → kind 为
      // stub 的 fixture-source（真实「not-connected」形态由 ac4-115 真机/夹具断言）。
      assert.equal(deepseekDiag.dataSource.kind, 'fixture-source', 'AC4-wired provider reports its describeDiagnostics kind (stub here)')
      assert.deepEqual(diag.data.gateway, gw.data, 'diagnostics embeds gatewayStatus view')
      assert.deepEqual(diag.data.tray, { available: false }, 'tray lands in AC5')
      assert.equal(diag.data.autostart.enabled, false, 'autostart from settings seed (0)')
      assert.equal(diag.data.monitorEnabled, false, 'monitorEnabled reflects flipped setting')

      await dispatch('settings:set', { key: 'gateway_enabled', value: '1' })
      const gwOn = await dispatch('agents:gatewayStatus', {})
      assert.equal(gwOn.data.enabled, true, 'gatewayStatus reflects gateway_enabled=1')
      assert.equal(gwOn.data.running, false, 'still no listener in AC2/AC3')
      await dispatch('settings:set', { key: 'gateway_port', value: '9999' })
      const gwPort = await dispatch('agents:gatewayStatus', {})
      assert.equal(gwPort.data.port, 9999, 'gatewayStatus reflects gateway_port')

      // payload 严格校验（BAD_PAYLOAD 路径可用）
      for (const bad of [{ status: 'flying' }, { limit: 201 }, { limit: 0 }, { providerId: 'x' }]) {
        const res = await dispatch('agents:sessions', bad)
        assert.equal(res.ok, false, `agents:sessions rejects ${JSON.stringify(bad)}`)
        assert.equal(res.error.code, 'BAD_PAYLOAD')
      }
      const badDetail = await dispatch('agents:sessionDetail', { sessionId: 'x' })
      assert.equal(badDetail.error.code, 'BAD_PAYLOAD')
      const missingDetail = await dispatch('agents:sessionDetail', { sessionId: 424242 })
      assert.equal(missingDetail.error.code, 'NOT_FOUND')
      const missingMessages = await dispatch('agents:messages', { sessionId: 424242 })
      assert.equal(missingMessages.error.code, 'NOT_FOUND')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 88. agents 动作类 channel dispatch（s5-80 模式）：sessionAction 能力门细分、
  //     pairingCreate/gatewayRestart GATEWAY_DISABLED、deviceRevoke 两段式 + 审计、
  //     setAutoStart 落 settings。
  //     AC3 批次 note（docs/16 §1 AC3 行授权的就地更新）：sessionAction 能力门细分——
  //     能力未验证/过期 → AGENT_CAPABILITY_MISSING（docs/14 Part C 错误码），observed
  //     保持 COMMAND_NOT_EXECUTABLE；provider 经 setProviderOverride 注入夹具。
  registerCase('ac2-88: agents action channels dispatch — sessionAction refined capability gate (AGENT_CAPABILITY_MISSING / COMMAND_NOT_EXECUTABLE), pairingCreate GATEWAY_DISABLED, deviceRevoke two-phase with audit, gatewayRestart two-phase, setAutoStart persists (AC3 就地更新授权: docs/16 §1 AC3 行)', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)

    await makeTempHome('devhub-ac2-88-')
    try {
      const registry = handlers.createHandlerRegistry({ appVersion: 'ac2-smoke' })
      const dispatch = (channel, payload) => handlers.dispatchGatewayRequest(registry, { channel, payload })
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)

      // pairingCreate：gateway_enabled 默认 0 → GATEWAY_DISABLED（远程面未启用）
      const pairing = await dispatch('agents:pairingCreate', { deviceName: 'Pixel 9' })
      assert.equal(pairing.ok, false)
      assert.equal(pairing.error.code, 'GATEWAY_DISABLED', 'pairingCreate blocked while remote surface is disabled')

      // gatewayRestart 两段式：无 confirmed → confirmRequired + impacts；confirmed → GATEWAY_DISABLED
      const restartAsk = await dispatch('agents:gatewayRestart', {})
      assert.equal(restartAsk.ok, true)
      assert.equal(restartAsk.data.confirmRequired, true, 'gatewayRestart is two-phase')
      assert.equal(restartAsk.data.impacts.activeConnections, 0, 'no active connections in AC2')
      assert.ok(typeof restartAsk.data.impacts.note === 'string' && restartAsk.data.impacts.note.length > 0)
      const restartDo = await dispatch('agents:gatewayRestart', { confirmed: true })
      assert.equal(restartDo.ok, false)
      assert.equal(restartDo.error.code, 'GATEWAY_DISABLED', 'confirmed restart folds to GATEWAY_DISABLED (listener wiring lands in AC6)')

      // sessionAction payload 校验
      for (const bad of [
        { sessionId: 1, action: 'destroy' },
        { sessionId: 1, action: 'reply' },
        { sessionId: 1, action: 'reply', text: '   ' },
        { sessionId: 1, action: 'reply', text: 'x'.repeat(4001) },
      ]) {
        const res = await dispatch('agents:sessionAction', bad)
        assert.equal(res.error.code, 'BAD_PAYLOAD', `sessionAction rejects ${JSON.stringify({ ...bad, text: bad.text && bad.text.length > 20 ? '<long>' : bad.text })}`)
      }

      // sessionAction：会话不存在 → NOT_FOUND
      const missing = await dispatch('agents:sessionAction', { sessionId: 77, action: 'reply', text: 'hi' })
      assert.equal(missing.error.code, 'NOT_FOUND')

      // 夹具 provider + observed 会话 → 服务端能力门真实生效（无输入通道）
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('codex', 'Codex', ?, ?)").run(now, now)
      db.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (1, 'native-1', 'observed', 'running', ?, ?)").run(now, now)
      const gated = await dispatch('agents:sessionAction', { sessionId: 1, action: 'reply', text: 'hello there' })
      assert.equal(gated.ok, false)
      assert.equal(gated.error.code, 'COMMAND_NOT_EXECUTABLE', 'observed session denied by the server-side gate')

      // 伪造「已验证能力 + managed 会话」也绕不过门：granted 为空 → AGENT_CAPABILITY_MISSING
      // （AC3 细分：能力缺失与无通道是不同错误码；docs/14 Part C）
      db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE id = 1').run(
        JSON.stringify({ mode: 'managed', granted: [], verifiedAt: now, evidence: 'fabricated evidence' }),
      )
      db.prepare("UPDATE agent_sessions SET session_mode = 'managed' WHERE id = 1").run()
      const gated2 = await dispatch('agents:sessionAction', { sessionId: 1, action: 'reply', text: 'hello there' })
      assert.equal(gated2.ok, false)
      assert.equal(gated2.error.code, 'AGENT_CAPABILITY_MISSING', 'empty granted set folds to AGENT_CAPABILITY_MISSING (AC3 refinement)')

      // granted 含 reply 但 verifiedAt 过期（>300s）→ AGENT_CAPABILITY_MISSING（过期收缩）
      db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE id = 1').run(
        JSON.stringify({ mode: 'managed', granted: ['reply'], verifiedAt: now - 301, evidence: 'stale verification' }),
      )
      const gated3 = await dispatch('agents:sessionAction', { sessionId: 1, action: 'reply', text: 'hello there' })
      assert.equal(gated3.ok, false)
      assert.equal(gated3.error.code, 'AGENT_CAPABILITY_MISSING', 'stale capability verification folds to AGENT_CAPABILITY_MISSING')

      // granted 不含所请求能力 → AGENT_CAPABILITY_MISSING（fresh 但能力未授予）
      db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE id = 1').run(
        JSON.stringify({ mode: 'managed', granted: ['pause'], verifiedAt: now, evidence: 'pause only' }),
      )
      const gated4 = await dispatch('agents:sessionAction', { sessionId: 1, action: 'reply', text: 'hello there' })
      assert.equal(gated4.error.code, 'AGENT_CAPABILITY_MISSING', 'ungranted capability folds to AGENT_CAPABILITY_MISSING')

      // deviceRevoke 两段式：设备不存在 → NOT_FOUND（无 confirmed 也先查设备）
      const revokeMissing = await dispatch('agents:deviceRevoke', { deviceId: 55 })
      assert.equal(revokeMissing.error.code, 'NOT_FOUND')

      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('Pixel 9', 'android', ?, ?, ?, ?)").run(
        'a'.repeat(64),
        now,
        now,
        now,
      )
      const revokeAsk = await dispatch('agents:deviceRevoke', { deviceId: 1 })
      assert.equal(revokeAsk.ok, true)
      assert.equal(revokeAsk.data.confirmRequired, true, 'deviceRevoke is two-phase (never executes without confirmed)')
      assert.equal(revokeAsk.data.impacts.deviceId, 1)
      assert.equal(revokeAsk.data.impacts.deviceName, 'Pixel 9')
      const revokeDo = await dispatch('agents:deviceRevoke', { deviceId: 1, confirmed: true })
      assert.deepEqual(revokeDo.data, { revoked: true }, 'confirmed revoke executes')

      const devRow = db.prepare('SELECT status, revoked_at FROM remote_devices WHERE id = 1').get()
      assert.equal(devRow.status, 'revoked', 'device row flipped to revoked')
      assert.ok(devRow.revoked_at !== null, 'revoked_at stamped')
      const audits = db.prepare("SELECT category, action, device_id, outcome FROM security_audit_logs WHERE action = 'device_revoked'").all()
      assert.equal(audits.length, 1, 'exactly one device_revoked audit row (docs/13 §4.8)')
      assert.deepEqual({ ...audits[0] }, { category: 'device', action: 'device_revoked', device_id: 1, outcome: 'success' })

      // devices 投影：状态 revoked、绝无 token 哈希
      const devices = await dispatch('agents:devices', {})
      assert.equal(devices.data.devices.length, 1)
      assert.equal(devices.data.devices[0].status, 'revoked')
      assert.equal(devices.data.devices[0].tokenVersion, 1)
      assert.ok(!JSON.stringify(devices.data).includes('a'.repeat(16)), 'device projection carries no token material')

      // setAutoStart：写 settings login_autostart 真实生效（setLoginItemSettings 属 AC5）
      const autoOn = await dispatch('agents:setAutoStart', { enabled: true })
      assert.deepEqual(autoOn.data, { enabled: true })
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'login_autostart'").get().value, '1', 'login_autostart persisted (1)')
      const autoOff = await dispatch('agents:setAutoStart', { enabled: false })
      assert.deepEqual(autoOff.data, { enabled: false })
      assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'login_autostart'").get().value, '0', 'login_autostart persisted (0)')
      const autoBad = await dispatch('agents:setAutoStart', { enabled: 'yes' })
      assert.equal(autoBad.error.code, 'BAD_PAYLOAD', 'enabled must be a boolean')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // ==================================================================
  // AC3 批次（docs/16 §1 AC3 行）：spawnManaged（docs/12 §3 契约）/ 增量 jsonl /
  // 事件管线 / 状态判定边界 / codex & claude 夹具 / 能力门细分 / 资源登记 /
  // 真机只读探测。用例编号接续 ac2-88。
  // ==================================================================

  // 89. spawnManaged：正常退出 + 行序保证 + 不完整尾行退出冲刷（docs/12 §3 语义 4）
  registerCase('ac3-89: spawnManaged normal exit — line order preserved, incomplete trailing line flushed on exit, structured ManagedExit', async () => {
    const { spawnManaged } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const lines = []
    const proc = spawnManaged(
      process.execPath,
      ['-e', "console.log('l1'); setTimeout(() => { process.stdout.write('par'); setTimeout(() => { process.stdout.write('tial-tail\\n'); console.log('l3'); process.exit(0) }, 200) }, 200)"],
      { idleTimeoutMs: 5000, lifetimeTimeoutMs: 20000, onStdout: (line) => lines.push(line) },
    )
    const exit = await proc.exited
    assert.equal(exit.reason, 'exit', `reason, got ${exit.reason}`)
    assert.equal(exit.code, 0, `exit code, stderrTail=${JSON.stringify(exit.stderrTail)}`)
    assert.equal(exit.signal, null)
    assert.ok(exit.durationMs >= 0)
    assert.deepEqual(lines, ['l1', 'partial-tail', 'l3'], `line order + tail flush, got ${JSON.stringify(lines)}`)
  })

  // 90. spawnManaged：idle-timeout 触发树杀 + 无残留进程（docs/12 §3 语义 2/3）
  registerCase('ac3-90: spawnManaged idle-timeout — heartbeat fires killTree, reason idle-timeout, no leftover process in tasklist', async () => {
    const { spawnManaged } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const { run } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const proc = spawnManaged(process.execPath, ['-e', "console.log('alive'); setTimeout(() => {}, 60000)"], {
      idleTimeoutMs: 700,
      lifetimeTimeoutMs: 60000,
    })
    const started = Date.now()
    const exit = await proc.exited
    assert.equal(exit.reason, 'idle-timeout', `reason, got ${exit.reason}`)
    assert.ok(exit.durationMs < 10000, `killed promptly, took ${exit.durationMs}ms`)
    assert.ok(Date.now() - started < 15000)
    // 树杀后无残留：tasklist 按 PID 过滤断言（tasklist 无匹配时输出 INFO:）
    const check = await run('tasklist', ['/FI', `PID eq ${proc.pid}`, '/FO', 'CSV', '/NH'], { timeoutMs: 15000 })
    assert.ok(
      check.stdout.toLowerCase().includes('info:') || !check.stdout.includes(String(proc.pid)),
      `process ${proc.pid} must be gone after idle-timeout tree kill, got: ${check.stdout.trim().slice(0, 200)}`,
    )
  })

  // 91. spawnManaged：lifetime-timeout（活跃输出也会被总生命周期上限收尾）
  registerCase('ac3-91: spawnManaged lifetime-timeout — absolute ceiling kills an actively-outputting process', async () => {
    const { spawnManaged } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    const proc = spawnManaged(process.execPath, ['-e', 'setInterval(() => { console.log("tick") }, 200)'], {
      idleTimeoutMs: 30000,
      lifetimeTimeoutMs: 1200,
    })
    const exit = await proc.exited
    assert.equal(exit.reason, 'lifetime-timeout', `reason, got ${exit.reason}`)
    assert.ok(exit.durationMs < 10000, `duration ${exit.durationMs}ms`)
  })

  // 92. spawnManaged：spawn-error 折叠不 throw + stdin 结构化失败三态
  registerCase('ac3-92: spawnManaged spawn-error folded (no throw) + writeStdin structured failures (SPAWN_ERROR / STDIN_NOT_WRITABLE / STDIN_CLOSED)', async () => {
    const { spawnManaged } = await import(new URL('../src/main/core/exec.ts', import.meta.url).href)
    // spawn 失败（ENOENT）：exited('spawn-error')，不 throw，pid -1
    const dead = spawnManaged('definitely-missing-cmd-ac3-xyz', [])
    const deadExit = await dead.exited
    assert.equal(deadExit.reason, 'spawn-error')
    assert.equal(dead.pid, -1)
    assert.ok(deadExit.stderrTail.length > 0, 'spawn error message carried in stderrTail')
    const deadWrite = dead.writeStdin('x')
    assert.equal(deadWrite.ok, false)
    assert.equal(deadWrite.error.code, 'SPAWN_ERROR')
    await dead.killTree() // 幂等：pid -1 时立即返回
    // 未开启 stdinWritable：STDIN_NOT_WRITABLE
    const noStdin = spawnManaged(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], {})
    const w1 = noStdin.writeStdin('x')
    assert.equal(w1.ok, false)
    assert.equal(w1.error.code, 'STDIN_NOT_WRITABLE')
    await noStdin.exited
    // 进程已退出后再写：STDIN_CLOSED
    const withStdin = spawnManaged(process.execPath, ['-e', 'process.exit(0)'], { stdinWritable: true })
    await withStdin.exited
    const w2 = withStdin.writeStdin('x')
    assert.equal(w2.ok, false)
    assert.equal(w2.error.code, 'STDIN_CLOSED')
  })

  // 93. IncrementalJsonlReader：追加 / 不完整行缓冲 / 解析失败计数 / 轮转重置 / 行首偏移
  registerCase('ac3-93: incremental jsonl reader — append, partial line buffering, parse-failure counting, rotation reset re-read, byte offsets', async () => {
    const { mkdtempSync, writeFileSync, appendFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { IncrementalJsonlReader } = await import(new URL('../src/main/services/agentControl/monitorRegistry.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac3-93-'))
    const file = join(dir, 'rollout.jsonl')
    const reader = new IncrementalJsonlReader(file)

    writeFileSync(file, '{"a":1}\n{"a":2}\n', 'utf8')
    let r = await reader.read()
    assert.equal(r.readable, true)
    assert.equal(r.lines.length, 2)
    assert.equal(r.parsed.length, 2)
    assert.equal(r.parseFailures, 0)
    assert.equal(r.rotated, false)
    assert.equal(r.lines[0].byteOffset, 0)
    assert.equal(r.lines[1].byteOffset, 8)

    r = await reader.read()
    assert.equal(r.lines.length, 0, 'no new data → no lines')

    appendFileSync(file, '{"a":', 'utf8')
    r = await reader.read()
    assert.equal(r.lines.length, 0, 'incomplete tail stays buffered')

    appendFileSync(file, '3}\n{"b":bad}\n{"a":4}\n', 'utf8')
    r = await reader.read()
    assert.equal(r.lines.length, 3, 'buffered partial completed and flushed')
    assert.equal(r.lines[0].byteOffset, 16, 'absolute byte offset of completed partial line')
    assert.deepEqual(r.parsed.map((o) => o.a).filter(Boolean), [3, 4])
    assert.equal(r.parseFailures, 1, 'unparseable line counted, not fatal')

    writeFileSync(file, '{"r":1}\n', 'utf8') // 截断/轮转：size < offset
    r = await reader.read()
    assert.equal(r.rotated, true, 'offset > size detected as rotation/truncation')
    assert.equal(r.lines.length, 1)
    assert.deepEqual(r.parsed, [{ r: 1 }])
  }, 'fast')

  // 94. eventPipeline：sequence 单调 / event_id 幂等 / 先落库后投递 / deliveries 行 /
  //     payload 脱敏 / waiting_input 两值 / status_changed 仅变化才发 / 终态 finished
  registerCase('ac3-94: event pipeline — monotonic sequence, event_id replay idempotency, DB-before-delivery order, deliveries rows, payload redaction, waiting_input two statuses, status_changed change-only, finished terminal', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const ep = await import(new URL('../src/main/services/agentControl/eventPipeline.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    await makeTempHome('devhub-ac3-94-')
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('codex', 'Codex', ?, ?)").run(now, now)
      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('Pixel 9', 'android', ?, ?, ?, ?)").run('b'.repeat(64), now, now, now)

      // 先落库后投递：sink 触发时 agent_events 行必须已可读
      const sinkCalls = []
      ep.setEventDeliverySink((evt) => {
        const row = db.prepare('SELECT id, delivery_state FROM agent_events WHERE event_id = ?').get(evt.eventId)
        sinkCalls.push({ eventId: evt.eventId, rowPresent: row !== undefined, state: row?.delivery_state })
      })

      const input = {
        eventType: 'session.status_changed',
        providerKey: 'codex',
        nativeId: 'n1',
        payload: { from: 'unknown', to: 'running', token: 'supersecret123' },
      }
      const r1 = ep.recordEvent(input)
      assert.equal(r1.recorded, true)
      assert.ok(r1.sequence !== null && r1.sequence > 0, 'sequence = agent_events.id')
      assert.equal(r1.deliveries, 1, 'one active device → one pending delivery row')
      const deliveryRow = db.prepare('SELECT status FROM event_deliveries WHERE event_id = ?').get(r1.sequence)
      assert.ok(deliveryRow !== undefined && deliveryRow.status === 'pending', 'delivery row persisted in same transaction')
      assert.equal(sinkCalls.length, 1, 'delivery sink called after commit')
      assert.equal(sinkCalls[0].rowPresent, true, 'row already visible when delivery fires (DB before delivery)')

      // 重放同段：零重复
      const r2 = ep.recordEvent(input)
      assert.equal(r2.recorded, false, 'same fingerprint → INSERT deduped')
      assert.equal(r2.sequence, r1.sequence)
      assert.equal(sinkCalls.length, 1, 'deduped event does not re-deliver')
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM agent_events').get().c), 1, 'exactly one row')

      // sequence 单调
      const r3 = ep.recordEvent({ eventType: 'session.started', providerKey: 'codex', nativeId: 'n1', payload: { x: 1 } })
      assert.ok(r3.sequence > r1.sequence, 'monotonic sequence')

      // payload 脱敏：明文凭据绝不落库（键级判定：token 键整值打码）
      const raw = db.prepare('SELECT payload_json FROM agent_events WHERE id = ?').get(r1.sequence)
      assert.ok(!raw.payload_json.includes('supersecret123'), 'no plaintext secret in payload')
      assert.ok(raw.payload_json.includes('"token":"***"'), 'sensitive key value masked to ***')

      // status_changed 仅状态 ≠ 旧值才发（L3 applySessionStatus 比较后发）
      const countStatusEvents = () => Number(db.prepare("SELECT COUNT(*) AS c FROM agent_events WHERE event_type = 'session.status_changed'").get().c)
      const before = countStatusEvents()
      svc.applySessionStatus('codex', 'n2', 'running')
      assert.equal(countStatusEvents(), before + 1, 'unknown → running emits')
      svc.applySessionStatus('codex', 'n2', 'running')
      assert.equal(countStatusEvents(), before + 1, 'same status → no event')
      svc.applySessionStatus('codex', 'n2', 'approval_required')
      assert.equal(countStatusEvents(), before + 2, 'running → approval_required emits')
      const waiting = db.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'session.waiting_input' ORDER BY id DESC LIMIT 1").get()
      const waitingPayload = JSON.parse(waiting.payload_json)
      assert.equal(waitingPayload.status, 'approval_required', 'waiting_input payload.status carries approval_required')
      assert.throws(() => ep.recordWaitingInputEvent({ providerKey: 'codex', sessionId: 1, nativeId: 'n2', status: 'running' }), /waiting_input payload.status/, 'illegal payload.status rejected')

      // 终态：stopped → session.finished + ended_at
      svc.applySessionStatus('codex', 'n2', 'stopped')
      const finished = db.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'session.finished' ORDER BY id DESC LIMIT 1").get()
      assert.ok(finished !== undefined, 'terminal state emits session.finished')
      assert.equal(JSON.parse(finished.payload_json).finalStatus, 'stopped')
      const sessionRow = db.prepare("SELECT ended_at FROM agent_sessions WHERE native_id = 'n2'").get()
      assert.ok(sessionRow.ended_at !== null, 'ended_at stamped on terminal status')
    } finally {
      ep.setEventDeliverySink(null)
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 95. 状态判定器边界：codex event payload 判定（无审批判定源 → 绝不产生）+
  //     ReadFailureTracker 5 次降级沿 / 恢复沿 + connection_lost（终态不覆盖）+ 恢复重探
  registerCase('ac3-95: status judgment edges — codex payload evaluator never fabricates approval_required, ReadFailureTracker degrade/recover edges, connection_lost skips terminal sessions, recovery re-probes to unknown', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const codexMod = await import(new URL('../src/main/services/agentControl/providers/codexProvider.ts', import.meta.url).href)
    const mon = await import(new URL('../src/main/services/agentControl/monitorRegistry.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    // codex 状态判定边界（docs/12 §5：找不到判定源就不产生，绝不猜）
    assert.equal(codexMod.evalCodexEventPayload({ type: 'task_started' }), 'running', 'task_started → running')
    assert.equal(codexMod.evalCodexEventPayload({ type: 'task_complete' }), 'unknown', 'task_complete → unknown (非会话终态，判定不定)')
    assert.equal(codexMod.evalCodexEventPayload({ type: 'turn_aborted' }), 'unknown')
    assert.equal(codexMod.evalCodexEventPayload({ type: 'exec_approval_request' }), null, '审批片段判定源为空 → 绝不产生 approval_required')
    assert.equal(codexMod.evalCodexEventPayload({ type: 'token_count' }), null)
    assert.equal(codexMod.evalCodexEventPayload('not-an-object'), null)
    assert.deepEqual(codexMod.CODEX_APPROVAL_FRAGMENT_TYPES, [], 'approval fragment registry empty (实机复核无判定源)')

    // ReadFailureTracker：连续 5 次降级沿（只在跨越沿返回一次）+ 恢复沿
    const tracker = new mon.ReadFailureTracker(5)
    for (let i = 1; i <= 4; i++) assert.equal(tracker.recordFailure(), false, `failure ${i} below threshold`)
    assert.equal(tracker.recordFailure(), true, '5th failure crosses threshold (degrade edge)')
    assert.equal(tracker.recordFailure(), false, 'continued failures do not re-fire')
    assert.equal(tracker.recordSuccess(), true, 'first success after degrade is the recover edge')
    assert.equal(tracker.isDegraded, false)

    // connection_lost：非终态会话置失联；终态会话不覆盖；恢复重探 → unknown
    await makeTempHome('devhub-ac3-95-')
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('codex', 'Codex', ?, ?)").run(now, now)
      svc.applySessionStatus('codex', 'sA', 'running')
      svc.applySessionStatus('codex', 'sB', 'completed')
      const sA = db.prepare("SELECT id, status FROM agent_sessions WHERE native_id = 'sA'").get()
      const sB = db.prepare("SELECT id, status FROM agent_sessions WHERE native_id = 'sB'").get()
      assert.equal(sA.status, 'running')
      assert.equal(sB.status, 'completed')

      svc.markProviderSessionsConnectionLost('codex', 'rollout reads failing (stat failed: ENOENT)')
      assert.equal(db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(sA.id).status, 'connection_lost', 'active session → connection_lost')
      assert.equal(db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(sB.id).status, 'completed', 'terminal session NOT overwritten')
      const lostEvent = db.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'session.status_changed' ORDER BY id DESC LIMIT 1").get()
      assert.equal(JSON.parse(lostEvent.payload_json).to, 'connection_lost')

      svc.refreshConnectionLostSessions('codex')
      assert.equal(db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(sA.id).status, 'unknown', 'recovery re-probe → unknown (绝不猜真实态)')
      assert.equal(db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(sB.id).status, 'completed')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 96. Codex 夹具：假 rollout jsonl + session_index 发现 → 快照落库（workdir 归一匹配
  //     project）+ exposes 资源边 + session.started 事件 + readMessages 增量与消息落库幂等
  registerCase('ac3-96: codex fixture discovery — rollout + session_index → SessionSnapshot persisted with project match, exposes edge, session.started event, readMessages projection idempotent', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const codexMod = await import(new URL('../src/main/services/agentControl/providers/codexProvider.ts', import.meta.url).href)

    await makeTempHome('devhub-ac3-96-')
    const fixtureHome = mkdtempSync(join(tmpdir(), 'devhub-ac3-96-codex-'))
    const fixtureProject = join(fixtureHome, 'workspaces', 'demo-project')
    mkdirSync(join(fixtureHome, 'sessions', '2026', '09', '03'), { recursive: true })
    mkdirSync(fixtureProject, { recursive: true })
    const rolloutPath = join(fixtureHome, 'sessions', '2026', '09', '03', 'rollout-2026-09-03T10-00-00-ac3a0960-0000-7000-8000-000000000001.jsonl')
    writeFileSync(
      rolloutPath,
      [
        JSON.stringify({ timestamp: '2026-09-03T02:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: 'ac3a0960-0000-7000-8000-000000000001', id: 'ac3a0960-0000-7000-8000-000000000001', cwd: fixtureProject, timestamp: '2026-09-03T02:00:00.000Z', cli_version: '0.152.1' } }),
        JSON.stringify({ timestamp: '2026-09-03T02:00:05.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started' } }),
        JSON.stringify({ timestamp: '2026-09-03T02:00:09.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'user', content: [{ type: 'input_text', text: 'please run token=fixturesecret42' }] } }),
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(join(fixtureHome, 'session_index.jsonl'), JSON.stringify({ id: 'ac3a0960-0000-7000-8000-000000000001', thread_name: 'Fixtured Session', updated_at: '2026-09-03T02:00:09.000Z' }) + '\n', 'utf8')

    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare('INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('demo-project', 'demo-project', fixtureProject, now, now)
      const projectRow = db.prepare('SELECT id FROM projects ORDER BY id DESC LIMIT 1').get()

      const provider = codexMod.createCodexProvider({ codexHome: fixtureHome, codexBinRoot: join(fixtureHome, 'no-such-bin') })
      svc.setProviderOverride('codex', provider)
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      // AC4 批次就地更新（docs/16 §1 AC4 行授权模式）：三家新 wired provider 注入
      // stub，保证 probeWiredProviders 的探测/会话刷新保持夹具隔离（不触真机）。
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('zcode', stubAgentProvider('zcode'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      svc.ensureAgentProviderRows()
      svc.resetAgentControlThrottles() // 用例隔离：清掉先前用例遗留的快照刷新节流
      await svc.probeWiredProviders(true) // exe 缺失 → unavailable（合法降级），会话快照仍刷新

      const sessions = db.prepare("SELECT * FROM agent_sessions WHERE native_id = 'ac3a0960-0000-7000-8000-000000000001'").all()
      assert.equal(sessions.length, 1, 'rollout discovered and upserted exactly once')
      const row = sessions[0]
      assert.equal(row.workdir, fixtureProject, 'workdir from session_meta')
      assert.equal(row.title, 'Fixtured Session', 'title from session_index.jsonl')
      assert.equal(row.project_id, projectRow.id, 'workdir normalized-match to projects.win_path')
      assert.equal(row.session_mode, 'observed', 'discovered session is observed')
      assert.equal(row.status, 'unknown', 'no status evidence yet → unknown')

      // 资源登记：agent/session 节点 + exposes 边（docs/13 §5）
      const agentRes = db.prepare("SELECT id FROM resources WHERE resource_type = 'agent'").get()
      const sessionRes = db.prepare("SELECT id FROM resources WHERE resource_type = 'session'").get()
      assert.ok(agentRes !== undefined && sessionRes !== undefined, 'agent + session resource nodes registered')
      const edge = db.prepare("SELECT relation_type FROM relationships WHERE source_resource_id = ? AND target_resource_id = ?").get(agentRes.id, sessionRes.id)
      assert.equal(edge.relation_type, 'exposes', 'observed session → exposes edge')

      const startedEvent = db.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'session.started'").get()
      assert.ok(startedEvent !== undefined, 'session.started recorded on first discovery')

      // readMessages：增量投影 + content_redacted 脱敏 + 落库幂等（重放零重复）
      const page1 = await provider.readMessages({ providerId: 'codex', nativeId: 'ac3a0960-0000-7000-8000-000000000001' })
      assert.equal(page1.messages.length, 1)
      assert.equal(page1.messages[0].role, 'user')
      assert.ok(page1.messages[0].contentRedacted.includes('token=***'), 'message content redacted')
      assert.ok(!page1.messages[0].contentRedacted.includes('fixturesecret42'), 'no plaintext secret in projection')
      assert.ok(page1.messages[0].sourceRef.includes('offset='), 'source_ref points to file+offset')
      const persist1 = svc.persistMessage('codex', 'ac3a0960-0000-7000-8000-000000000001', page1.messages[0])
      assert.equal(persist1.recorded, true)
      const persist2 = svc.persistMessage('codex', 'ac3a0960-0000-7000-8000-000000000001', page1.messages[0])
      assert.equal(persist2.recorded, false, 'UNIQUE(session_id, native_msg_id) replay deduped')
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM agent_messages').get().c), 1)

      // 增量游标：append 后从 cursor 续读
      appendFileSync(
        rolloutPath,
        JSON.stringify({ timestamp: '2026-09-03T02:01:00.000Z', ordinal: 3, type: 'response_item', payload: { type: 'message', id: 'msg_2', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }) + '\n',
        'utf8',
      )
      const page2 = await provider.readMessages({ providerId: 'codex', nativeId: 'ac3a0960-0000-7000-8000-000000000001' }, page1.cursor)
      assert.equal(page2.messages.length, 1, 'incremental read from cursor')
      assert.equal(page2.messages[0].nativeMsgId, 'msg_2')
      assert.ok(Number(page2.cursor) > Number(page1.cursor))
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 97. Codex 夹具 app-server 握手：成功 → managed + granted 逐个验证；失败 → observed 降级
  registerCase('ac3-97: codex fixture app-server — handshake success grants verified reply/pause/resume (managed), crash folds to observed with empty granted', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const codexMod = await import(new URL('../src/main/services/agentControl/providers/codexProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac3-97-'))
    const script = join(dir, 'fake-appserver.mjs')
    writeFileSync(
      script,
      [
        "import { createInterface } from 'node:readline'",
        'const mode = process.env.FAKE_MODE ?? "ok"',
        'const reply = (o) => process.stdout.write(JSON.stringify(o) + "\\n")',
        'if (mode === "crash") process.exit(1)',
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        '  let m; try { m = JSON.parse(line) } catch { return }',
        '  if (m.method === "initialize") reply({ id: m.id, result: { userAgent: "fake-appserver/1.0" } })',
        '  else if (m.method === "thread/list") reply({ id: m.id, result: { data: [], nextCursor: null } })',
        '  else if (m.method === "thread/resume") reply({ id: m.id, result: { thread: { id: m.params.threadId, status: { type: process.env.FAKE_TURN === "active" ? "running" : "idle" } } } })',
        '  else if (m.method === "turn/start") reply({ id: m.id, result: { turn: { id: "turn-1", status: { type: "running" } } } })',
        '  else reply({ id: m.id, error: { code: -32600, message: "Invalid request: unknown variant `" + m.method + "`, expected one of `initialize`, `thread/list`, `thread/resume`, `turn/start`, `turn/interrupt`" } })',
        '})',
        '',
      ].join('\n'),
      'utf8',
    )
    const base = {
      exePath: process.execPath,
      appServerArgs: [script],
      // ac3-97 稳定化（超时加固，断言/用例名不变）：负载下 node 子进程冷启动
      // 可达数秒——3s 请求超时会把 ok 路径误折叠为 observed；idle 必须宽于
      // 单请求上限（否则静默期 idle 树杀误杀），lifetime 为整进程天花板。
      requestTimeoutMs: 8000,
      managedIdleTimeoutMs: 15000,
      managedLifetimeTimeoutMs: 45000,
    }
    const ref = { providerId: 'codex', nativeId: 'fixture-thread-1' }

    const okProvider = codexMod.createCodexProvider({ ...base, appServerEnv: { ...process.env, FAKE_MODE: 'ok' } })
    const caps = await okProvider.getCapabilities(ref)
    assert.equal(caps.mode, 'managed', `handshake ok → managed, got ${caps.mode}: ${caps.evidence}`)
    assert.deepEqual([...caps.granted].sort(), ['pause', 'reply', 'resume'], 'reply/pause/resume verified one-by-one via protocol method list')
    assert.ok(caps.evidence.includes('app-server handshake ok'), 'evidence verbatim')
    assert.ok(caps.verifiedAt > 0)

    const crashProvider = codexMod.createCodexProvider({ ...base, appServerEnv: { ...process.env, FAKE_MODE: 'crash' } })
    const caps2 = await crashProvider.getCapabilities(ref)
    assert.equal(caps2.mode, 'observed', 'handshake failure → observed downgrade')
    assert.deepEqual(caps2.granted, [], 'downgrade grants empty set')
    assert.ok(caps2.evidence.startsWith('app-server handshake failed'), `evidence: ${caps2.evidence.slice(0, 80)}`)
  })

  // 98. Codex 夹具命令执行：reply 真实执行（turn/start）/ pause 无活跃 turn 结构化失败 /
  //     pause 活跃 turn 提取执行
  registerCase('ac3-98: codex fixture command execution — sendReply executes via turn/start, pause without active turn fails structured, pause with active turn executes', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const codexMod = await import(new URL('../src/main/services/agentControl/providers/codexProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac3-98-'))
    const script = join(dir, 'fake-appserver.mjs')
    writeFileSync(
      script,
      [
        "import { createInterface } from 'node:readline'",
        'const reply = (o) => process.stdout.write(JSON.stringify(o) + "\\n")',
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        '  let m; try { m = JSON.parse(line) } catch { return }',
        '  if (m.method === "initialize") reply({ id: m.id, result: {} })',
        '  else if (m.method === "thread/resume") reply({ id: m.id, result: { thread: { id: m.params.threadId, status: { type: process.env.FAKE_TURN === "active" ? "running" : "idle" } } } })',
        '  else if (m.method === "turn/start") reply({ id: m.id, result: { turn: { id: "turn-1" } } })',
        '  else if (m.method === "turn/interrupt") reply({ id: m.id, result: { interrupted: true } })',
        '  else reply({ id: m.id, error: { code: -32600, message: "unknown variant `" + m.method + "`" } })',
        '})',
        '',
      ].join('\n'),
      'utf8',
    )
    const ref = { providerId: 'codex', nativeId: 'fixture-thread-9' }
    const mk = (env) =>
      codexMod.createCodexProvider({
        exePath: process.execPath,
        appServerArgs: [script],
        appServerEnv: { ...process.env, ...env },
        requestTimeoutMs: 3000,
        managedIdleTimeoutMs: 4000,
        managedLifetimeTimeoutMs: 15000,
      })

    const replyOutcome = await mk({ FAKE_TURN: 'idle' }).sendReply(ref, 'hello from devhub')
    assert.deepEqual({ ok: replyOutcome.ok, status: replyOutcome.status }, { ok: true, status: 'executed' }, 'reply executes via thread/resume + turn/start')

    const pauseIdle = await mk({ FAKE_TURN: 'idle' }).pause(ref)
    assert.equal(pauseIdle.ok, false)
    assert.equal(pauseIdle.status, 'failed')
    assert.equal(pauseIdle.errorCode, 'COMMAND_NOT_EXECUTABLE')
    assert.ok(pauseIdle.detail.includes('no active turn'), `structured failure detail: ${pauseIdle.detail}`)

    const pauseActive = await mk({ FAKE_TURN: 'active' }).pause(ref)
    assert.deepEqual({ ok: pauseActive.ok, status: pauseActive.status }, { ok: true, status: 'executed' }, 'pause with active turn executes via turn/interrupt')

    const resumeOutcome = await mk({ FAKE_TURN: 'idle' }).resume(ref)
    assert.deepEqual({ ok: resumeOutcome.ok, status: resumeOutcome.status }, { ok: true, status: 'executed' })
  })

  // 99. Claude 夹具：hooks 合并写入（备份存在 / 只动 hooks 键 / env+permissions 逐字节
  //     不变 / 幂等 / 恢复还原 / 损坏文件拒写）
  registerCase('ac3-99: claude hooks merge write — timestamped backup, only hooks key touched (env/permissions byte-identical), idempotent, restore byte-for-byte, corrupted settings refused', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const claudeMod = await import(new URL('../src/main/services/agentControl/providers/claudeProvider.ts', import.meta.url).href)

    const home = mkdtempSync(join(tmpdir(), 'devhub-ac3-99-'))
    const settingsPath = join(home, 'settings.json')
    const original = {
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721', ANTHROPIC_AUTH_TOKEN: 'sk-fixture-not-real' },
      permissions: { allow: ['Bash(npm run smoke)', 'Read'] },
      includeCoAuthoredBy: false,
      theme: 'dark',
    }
    const originalRaw = JSON.stringify(original, null, 2) + '\n'
    writeFileSync(settingsPath, originalRaw, 'utf8')
    const secret = 'c'.repeat(64)

    const res = await claudeMod.writeClaudeHooks({ claudeHome: home, port: 18746, secret })
    assert.ok(existsSync(res.backupPath), 'timestamped backup written')
    assert.match(res.backupPath, /settings\.json\.bak-\d{8}-\d{6}$/, 'backup naming settings.json.bak-<yyyyMMdd-HHmmss>')
    assert.equal(readFileSync(res.backupPath, 'utf8'), originalRaw, 'backup carries the exact pre-write bytes')
    assert.equal(res.url, `http://127.0.0.1:18746${claudeMod.CLAUDE_HOOKS_PATH}`)

    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(JSON.stringify(after.env), JSON.stringify(original.env), 'env keys byte-identical (ANTHROPIC_BASE_URL untouched)')
    assert.equal(JSON.stringify(after.permissions), JSON.stringify(original.permissions), 'permissions byte-identical')
    assert.equal(after.includeCoAuthoredBy, false, 'other keys preserved')
    assert.equal(after.theme, 'dark')
    assert.deepEqual(res.eventsWritten.sort(), ['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'], 'default hook events registered')
    const cmd = after.hooks.Notification[0].hooks[0].command
    assert.ok(cmd.includes(`X-DevHub-Secret: ${secret}`), 'hook command embeds the local random secret')
    assert.ok(cmd.includes('18746'), 'hook command embeds the listener port')
    assert.ok(cmd.includes(claudeMod.CLAUDE_HOOKS_MARKER_HEADER), 'hook command carries the DevHub marker header')

    // 幂等：重复写入不重复追加
    const res2 = await claudeMod.writeClaudeHooks({ claudeHome: home, port: 18746, secret })
    assert.deepEqual(res2.eventsWritten, [], 'second write is a no-op')
    assert.equal(res2.alreadyRegistered, true)
    const after2 = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.equal(after2.hooks.Notification.length, 1, 'no duplicate hook entries')

    // 恢复：逐字节还原
    await claudeMod.restoreClaudeHooks(res.backupPath, home)
    assert.equal(readFileSync(settingsPath, 'utf8'), originalRaw, 'restore reproduces the original file byte-for-byte')

    // 损坏 settings.json：拒写（绝不覆写损坏文件）
    writeFileSync(settingsPath, '{ not json', 'utf8')
    await assert.rejects(() => claudeMod.writeClaudeHooks({ claudeHome: home, port: 18746, secret }), /not valid JSON/, 'corrupted settings refused')
    assert.equal(readFileSync(settingsPath, 'utf8'), '{ not json', 'corrupted file left untouched')
  }, 'fast')

  // 100. Claude 回环 listener：正确 secret 回调 → 事件映射；错误 secret 静默拒绝计数；
  //      非回调路径 404；映射表边界
  registerCase('ac3-100: claude hooks loopback listener — correct secret accepted and mapped (approval_required/waiting_input/stopped), wrong secret silently rejected with counter, unknown events ignored', async () => {
    const { randomBytes } = await import('node:crypto')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const claudeMod = await import(new URL('../src/main/services/agentControl/providers/claudeProvider.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    // 映射表边界（docs/12 §5：approval_required 判定源 = hooks 审批事件）
    assert.equal(claudeMod.evalClaudeHookEvent('Notification', 'Claude needs your permission to use Bash').status, 'approval_required')
    assert.equal(claudeMod.evalClaudeHookEvent('Notification', 'Claude is waiting for your input').status, 'waiting_input')
    assert.equal(claudeMod.evalClaudeHookEvent('Stop').status, 'waiting_input')
    assert.equal(claudeMod.evalClaudeHookEvent('SessionEnd').status, 'stopped')
    assert.equal(claudeMod.evalClaudeHookEvent('UserPromptSubmit').status, 'running')
    assert.equal(claudeMod.evalClaudeHookEvent('MysteryEvent'), null, 'unknown hook events ignored')

    await makeTempHome('devhub-ac3-100-')
    const listener = await claudeMod.startClaudeHooksListener({
      port: 0,
      secret: randomBytes(24).toString('hex'),
      onEvent: () => {},
    })
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('claude-code', 'Claude Code', ?, ?)").run(now, now)

      // 错误 secret：403 静默拒绝 + 计数（回调不触发）
      let received = 0
      const rejectedListener = await claudeMod.startClaudeHooksListener({
        port: 0,
        secret: listener.secret,
        onEvent: () => {
          received += 1
        },
      })
      const badRes = await fetch(`http://127.0.0.1:${rejectedListener.port}${claudeMod.CLAUDE_HOOKS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-devhub-secret': 'wrong-secret' },
        body: JSON.stringify({ hook_event_name: 'Stop' }),
      })
      assert.equal(badRes.status, 403, 'wrong secret rejected')
      const noSecret = await fetch(`http://127.0.0.1:${rejectedListener.port}${claudeMod.CLAUDE_HOOKS_PATH}`, { method: 'POST', body: '{}' })
      assert.equal(noSecret.status, 403, 'missing secret rejected')
      const notFound = await fetch(`http://127.0.0.1:${rejectedListener.port}/other/path`, { method: 'POST' })
      assert.equal(notFound.status, 404, 'non-callback path 404')
      assert.ok(rejectedListener.rejectedCount >= 2, 'rejections counted (wrong + missing secret)')
      assert.equal(received, 0, 'rejected callbacks never reach onEvent (silent drop)')
      await rejectedListener.close()

      // 正确 secret：回调映射 → L3 落库（waiting_input payload.status 两值）
      const post = async (body) =>
        (
          await fetch(`http://127.0.0.1:${listener.port}${claudeMod.CLAUDE_HOOKS_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-devhub-secret': listener.secret },
            body: JSON.stringify(body),
          })
        ).status
      assert.equal(await post({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', session_id: 'ac3-sess-1' }), 202)
      assert.equal(received, 0, 'rejected listener still saw nothing')
      svc.applySessionStatus('claude-code', 'ac3-sess-1', 'approval_required', 'hook: Notification (permission/approval)')
      const row = db.prepare("SELECT status FROM agent_sessions WHERE native_id = 'ac3-sess-1'").get()
      assert.equal(row.status, 'approval_required', 'hooks approval event → approval_required status row')
      const waitingEvent = db.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'session.waiting_input' ORDER BY id DESC LIMIT 1").get()
      assert.equal(JSON.parse(waitingEvent.payload_json).status, 'approval_required', 'waiting_input event recorded with approval_required status')
      assert.equal(await post({ hook_event_name: 'Stop', session_id: 'ac3-sess-1' }), 202)
      assert.ok(listener.acceptedCount >= 1, 'accepted callbacks counted')
    } finally {
      await listener.close().catch(() => {})
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  })

  // 101. Claude 夹具：转录监控（真实 provider.startMonitor）→ 会话/消息/事件落库 +
  //      observed 能力集 + 监控取消收尾
  registerCase('ac3-101: claude fixture transcript monitor — real startMonitor discovers session, projects redacted messages, session.started event, observed capabilities, clean stop', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const claudeMod = await import(new URL('../src/main/services/agentControl/providers/claudeProvider.ts', import.meta.url).href)

    await makeTempHome('devhub-ac3-101-')
    const fixtureHome = mkdtempSync(join(tmpdir(), 'devhub-ac3-101-claude-'))
    const fixtureProject = join(fixtureHome, 'repos', 'claude-demo')
    mkdirSync(join(fixtureHome, 'projects', 'C--fixture-repos-claude-demo'), { recursive: true })
    mkdirSync(fixtureProject, { recursive: true })
    const sessionId = 'ac3c1a015-0000-7000-8000-000000000009'
    writeFileSync(
      join(fixtureHome, 'projects', 'C--fixture-repos-claude-demo', `${sessionId}.jsonl`),
      [
        JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'please fix token=claudefixture77' }, uuid: 'u1', timestamp: '2026-09-03T03:00:00.000Z', cwd: fixtureProject, sessionId }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] }, uuid: 'u2', timestamp: '2026-09-03T03:00:05.000Z', sessionId }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Fixture Claude Session', sessionId }),
        '',
      ].join('\n'),
      'utf8',
    )

    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare('INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('claude-demo', 'claude-demo', fixtureProject, now, now)
      const projectRow = db.prepare('SELECT id FROM projects ORDER BY id DESC LIMIT 1').get()

      const provider = claudeMod.createClaudeProvider({ claudeHome: fixtureHome })
      svc.setProviderOverride('claude-code', provider)
      svc.setProviderOverride('codex', stubAgentProvider('codex')) // 用例隔离：codex 不接入真机
      // AC4 批次就地更新（docs/16 §1 AC4 行授权模式）：三家新 wired provider 注入
      // stub——syncMonitorTasks 后 kimi/zcode/deepseek 的真实监控不允许在本用例内
      // 启动（真实 kimi wire 重放与真实 zcode db 全量投影会污染本用例断言库）。
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('zcode', stubAgentProvider('zcode'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      await svc.syncMonitorTasks() // 真实 startMonitor（watcher + hooks loopback listener）

      // 轮询等待发现落库（监控首轮立即执行）
      let sessionRow = null
      for (let i = 0; i < 50; i++) {
        sessionRow = db.prepare('SELECT * FROM agent_sessions WHERE native_id = ?').get(sessionId)
        if (sessionRow !== undefined) break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(sessionRow !== undefined, 'monitor discovered the fixture transcript into agent_sessions')
      assert.equal(sessionRow.workdir, fixtureProject, 'workdir from transcript cwd field (authoritative)')
      assert.equal(sessionRow.project_id, projectRow.id, 'workdir matched to projects.win_path')
      assert.equal(sessionRow.status, 'unknown', 'transcript has no status evidence → unknown')
      const startedEvents = Number(db.prepare("SELECT COUNT(*) AS c FROM agent_events WHERE event_type = 'session.started'").get().c)
      assert.ok(startedEvents >= 1, 'session.started recorded by monitor discovery')

      // 消息投影落库（脱敏）
      let msgRows = []
      for (let i = 0; i < 30; i++) {
        msgRows = db.prepare('SELECT role, content_redacted FROM agent_messages ORDER BY id').all()
        if (msgRows.length >= 2) break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(msgRows.length >= 2, `user + assistant messages projected, got ${msgRows.length}`)
      const userMsg = msgRows.find((m) => m.role === 'user')
      assert.ok(userMsg !== undefined && userMsg.content_redacted.includes('token=***'), 'user message redacted')
      assert.ok(!JSON.stringify(msgRows).includes('claudefixture77'), 'no plaintext secret landed')

      // observed 能力集：无 hooks 注册 → granted 空（docs/12 §5 能力验证门）
      const caps = await provider.getCapabilities({ providerId: 'claude-code', nativeId: sessionId })
      assert.equal(caps.mode, 'observed')
      assert.deepEqual(caps.granted, [])
      assert.ok(caps.evidence.includes('read-only transcript source'))

      // 诊断投影：数据源/控制通道真实形态
      const diag = provider.describeDiagnostics()
      assert.equal(diag.dataSource.kind, 'transcripts-jsonl')
      assert.ok(diag.control.note.length > 0)

      // 取消收尾：cancelAll 后任务退场
      svc.stopAllAgentControlRuntime()
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  })

  // 102. 资源边换边（observed ↔ attached）+ message.appended 重放零重复事件
  registerCase('ac3-102: resource edge switching — mode change swaps exposes/monitors edges, message.appended replay produces zero duplicate events', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    await makeTempHome('devhub-ac3-102-')
    try {
      const db = dbModule.getDatabase()
      svc.ensureAgentProviderRows()
      const r1 = svc.upsertSessionSnapshot('codex', { nativeId: 'edge-sess-1', workdir: 'C:\\nonexistent-path-ac3' }, 'observed')
      assert.ok(r1 !== null && r1.created)
      const agentRes = db.prepare("SELECT id FROM resources WHERE resource_type = 'agent' AND ref_id = (SELECT id FROM agent_providers WHERE provider = 'codex')").get()
      const sessionRes = db.prepare("SELECT id FROM resources WHERE resource_type = 'session' AND ref_id = ?", ).get(r1.sessionId)
      const edgeOf = () =>
        db.prepare('SELECT relation_type FROM relationships WHERE source_resource_id = ? AND target_resource_id = ?').all(agentRes.id, sessionRes.id).map((r) => r.relation_type).sort()
      assert.deepEqual(edgeOf(), ['exposes'], 'observed → exposes')

      svc.upsertSessionSnapshot('codex', { nativeId: 'edge-sess-1' }, 'attached')
      assert.deepEqual(edgeOf(), ['monitors'], 'mode switch to attached swaps the edge (same transaction semantics)')
      svc.upsertSessionSnapshot('codex', { nativeId: 'edge-sess-1' }, 'observed')
      assert.deepEqual(edgeOf(), ['exposes'], 'mode switch back to observed swaps again')

      const countMessageEvents = () => Number(db.prepare("SELECT COUNT(*) AS c FROM agent_events WHERE event_type = 'message.appended'").get().c)
      const msg = { role: 'assistant', contentRedacted: 'fixed token=*** issue', nativeMsgId: 'msg-replay-1', sourceRef: 'x#offset=1', occurredAt: Math.floor(Date.now() / 1000) }
      const p1 = svc.persistMessage('codex', 'edge-sess-1', msg)
      assert.equal(p1.recorded, true)
      assert.equal(countMessageEvents(), 1)
      const p2 = svc.persistMessage('codex', 'edge-sess-1', msg)
      assert.equal(p2.recorded, false, 'message row deduped by UNIQUE')
      assert.equal(countMessageEvents(), 1, 'replay produces zero duplicate events')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 103. Codex 真机只读探测：exe hash 目录发现 + --version + 真实会话发现（零写库零写入）
  registerCase('ac3-103: codex real machine probe (read-only) — exe hash-dir discovery, --version, real rollout session discovery; env-dependent with SKIP note', async () => {
    const codexMod = await import(new URL('../src/main/services/agentControl/providers/codexProvider.ts', import.meta.url).href)
    const provider = codexMod.createCodexProvider()
    const health = await provider.probeHealth()
    if (health.health === 'unavailable' || !health.installed) {
      envSkipNote('codex.exe not discovered under %LOCALAPPDATA%\\OpenAI\\Codex\\bin at run time')
      return
    }
    assert.ok(health.version !== undefined && /\d+\.\d+/.test(health.version), `version parsed: ${health.version}`)
    assert.ok(health.exePath.endsWith('codex.exe'), `exe path: ${health.exePath}`)
    assert.equal(health.health, 'ok')
    const sessions = await provider.listSessions()
    assert.ok(Array.isArray(sessions))
    assert.ok(sessions.every((s) => typeof s.nativeId === 'string' && s.nativeId.length > 0), 'snapshot native ids well-formed')
    envSkipNote(`real codex sessions discovered (read-only): ${sessions.length}`)
  })

  // 104. Codex 真机 app-server 握手（只读探测子进程，用后 killTree）：成功/失败都是合法
  //      结果——成功 → managed + granted ⊆ 全集；失败 → observed 降级（不伪造）
  registerCase('ac3-104: codex real machine app-server handshake probe (read-only) — structured CapabilitySet either way, downgrade is a legal outcome', async () => {
    const codexMod = await import(new URL('../src/main/services/agentControl/providers/codexProvider.ts', import.meta.url).href)
    const provider = codexMod.createCodexProvider({ requestTimeoutMs: 8000, managedIdleTimeoutMs: 10000, managedLifetimeTimeoutMs: 30000 })
    const health = await provider.probeHealth()
    if (health.health !== 'ok') {
      envSkipNote('codex probe not ok at run time; app-server handshake path covered by fixtures (ac3-97)')
      return
    }
    const caps = await provider.getCapabilities({ providerId: 'codex', nativeId: '-' })
    assert.ok(['managed', 'observed'].includes(caps.mode), `mode: ${caps.mode}`)
    assert.ok(caps.granted.every((g) => ['reply', 'pause', 'resume'].includes(g)), 'granted ⊆ capability universe')
    assert.ok(caps.verifiedAt > 0, 'verifiedAt stamped')
    assert.ok(caps.evidence.length > 0, 'evidence present')
    if (caps.mode === 'observed') {
      envSkipNote(`app-server handshake failed on this machine (legal downgrade): ${caps.evidence.slice(0, 120)}`)
    } else {
      envSkipNote(`app-server handshake ok; granted: ${caps.granted.join('|') || 'none'}`)
    }
    const diag = provider.describeDiagnostics()
    assert.ok(diag.control.note.length > 0, 'control note reflects the real handshake result')
  })

  // ==================================================================
  // AC4 批次（docs/16 §1 AC4 行）：Kimi / ZCode / DeepSeek 接入 + 事件管线收口。
  // 用例编号接续 ac3-104。铁律：~/.kimi-code、~/.zcode、deepseekHarnessRoot 全程
  // 零写入（真机用例只读；夹具全部落在独立 tmp 目录）；Kimi 绝不发起真实推理。
  // ==================================================================

  // 105. Kimi 夹具发现：session_index.jsonl（含墓碑行）+ state.json → 会话落库
  //      + project 归一匹配 + config.toml 红线 T10（api_key 投影只尾4位+长度）
  registerCase('ac4-105: kimi fixture discovery — session_index with tombstones + state.json → sessions persisted with project match; config.toml red line T10 (api_key projection is tail4+len only)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const kimiMod = await import(new URL('../src/main/services/agentControl/providers/kimiProvider.ts', import.meta.url).href)

    await makeTempHome('devhub-ac4-105-')
    const fixtureHome = mkdtempSync(join(tmpdir(), 'devhub-ac4-105-kimi-'))
    const workdirA = join(fixtureHome, 'ws', 'demo-kimi')
    const sessionA = 'session_105a0000-0000-4000-8000-000000000001'
    const sessionB = 'session_105b0000-0000-4000-8000-000000000002'
    const sessionDead = 'session_105dead00-0000-4000-8000-000000000003'
    const dirA = join(fixtureHome, 'sessions', 'wd_demo-kimi_105a', sessionA)
    const dirB = join(fixtureHome, 'sessions', 'wd_demo-kimi_105a', sessionB)
    mkdirSync(join(dirA, 'agents', 'main'), { recursive: true })
    mkdirSync(join(dirB, 'agents', 'main'), { recursive: true })
    mkdirSync(workdirA, { recursive: true })
    const t0 = 1786701271932
    writeFileSync(join(dirA, 'state.json'), JSON.stringify({ id: sessionA, version: 2, cwd: workdirA, createdAt: t0, updatedAt: t0 + 6000, archived: false, agents: { main: { homedir: join(dirA, 'agents', 'main'), type: 'main' } }, custom: {}, lastTurnReason: 'completed' }))
    writeFileSync(join(dirB, 'state.json'), JSON.stringify({ id: sessionB, version: 2, cwd: workdirA, createdAt: t0, updatedAt: t0 + 1000, archived: false, agents: { main: { homedir: join(dirB, 'agents', 'main'), type: 'main' } }, custom: {} }))
    writeFileSync(
      join(fixtureHome, 'session_index.jsonl'),
      [
        JSON.stringify({ sessionId: sessionA, sessionDir: dirA, workDir: workdirA }),
        JSON.stringify({ sessionId: sessionDead, sessionDir: join(fixtureHome, 'sessions', 'gone', sessionDead), workDir: workdirA }),
        JSON.stringify({ sessionId: sessionDead, deleted: true }),
        JSON.stringify({ sessionId: sessionB, sessionDir: dirB, workDir: workdirA }),
        '',
      ].join('\n'),
      'utf8',
    )
    const fakeKey = 'sk-kimi-fixture-abc123defghijk9999'
    writeFileSync(
      join(fixtureHome, 'config.toml'),
      [
        `default_model = "micuapi/kimi-k3"`,
        '',
        '[providers.micuapi]',
        'type = "openai"',
        'base_url = "https://fixture.invalid/v1"',
        `api_key = "${fakeKey}"`,
        '',
        '[models."micuapi/kimi-k3"]',
        'provider = "micuapi"',
        'model = "kimi-k3"',
        '',
        '[thinking]',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    )

    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare('INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('demo-kimi', 'demo-kimi', workdirA, now, now)
      const projectRow = db.prepare('SELECT id FROM projects ORDER BY id DESC LIMIT 1').get()

      const provider = kimiMod.createKimiProvider({ kimiHome: fixtureHome })
      svc.setProviderOverride('kimi', provider)
      svc.setProviderOverride('codex', stubAgentProvider('codex'))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('zcode', stubAgentProvider('zcode'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      svc.ensureAgentProviderRows()
      svc.resetAgentControlThrottles()
      await svc.probeWiredProviders(true) // kimi exe 缺失 → unavailable（合法降级），会话快照仍刷新

      for (const sid of [sessionA, sessionB]) {
        const row = db.prepare('SELECT * FROM agent_sessions WHERE native_id = ?').get(sid)
        assert.ok(row !== undefined, `session ${sid} discovered`)
        assert.equal(row.workdir, workdirA, 'workdir from state.json cwd')
        assert.equal(row.project_id, projectRow.id, 'workdir normalized-matched to projects.win_path')
        assert.equal(row.session_mode, 'observed', 'observed (managed unverified)')
        assert.equal(row.status, 'unknown', 'snapshot path never fabricates status')
        assert.ok(row.started_at !== null && row.last_activity_at !== null, 'startedAt/lastActivityAt from state.json ms fields')
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM agent_sessions WHERE native_id = ?').get(sessionDead).c, 0, 'tombstoned session is NOT discovered')

      // T10 红线：config.toml 投影序列化后绝不含 key 全值，只有尾4位+长度
      const projection = await kimiMod.projectKimiConfig(join(fixtureHome, 'config.toml'))
      const json = JSON.stringify(projection)
      assert.ok(!json.includes(fakeKey), 'projection JSON carries no full api_key')
      assert.ok(!json.includes('sk-kimi-fixture'), 'projection JSON carries no key prefix')
      assert.equal(projection.providers.length, 1)
      assert.deepEqual(projection.providers[0].apiKeyMasked, { tail: fakeKey.slice(-4), len: fakeKey.length }, 'api_key masked to tail4+len via maskKey')
      assert.equal(projection.defaultModel, 'micuapi/kimi-k3')
      assert.equal(projection.thinkingEnabled, true)
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 106. Kimi wire.jsonl：状态判定映射（实机复核全集）+ 消息投影脱敏 + 真实
  //      startMonitor → L3 落库（waiting_input/approval_required 事件贯通）
  registerCase('ac4-106: kimi wire.jsonl — status mapping table edges (interaction approval → approval_required, turn.ended completed → waiting_input, failed → failed, cancelled → unknown), redacted message projection, real startMonitor lands sessions/messages/events', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const kimiMod = await import(new URL('../src/main/services/agentControl/providers/kimiProvider.ts', import.meta.url).href)

    // 状态判定映射表边界（实机 0.36.0 语料复核后的写死映射）
    const approvals = new Set()
    assert.equal(kimiMod.evalKimiWireLine({ type: 'turn.prompt' }, approvals), 'running', 'turn.prompt → running')
    assert.equal(kimiMod.evalKimiWireLine({ type: 'interaction.request', id: 'a1', kind: 'approval' }, approvals), 'approval_required', 'interaction.request(kind=approval) → approval_required (docs/12 §5 指定判定源)')
    assert.equal(kimiMod.evalKimiWireLine({ type: 'interaction.resolved', id: 'a1', response: { decision: 'approved' } }, approvals), 'running', 'interaction.resolved → running (审批闭环、回合在途)')
    assert.equal(kimiMod.evalKimiWireLine({ type: 'interaction.request', id: 'a2', kind: 'plan_review' }, approvals), null, '未实测 kind 不产生状态（绝不猜）')
    assert.equal(kimiMod.evalKimiWireLine({ type: 'turn.ended', reason: 'completed' }, approvals), 'waiting_input', 'turn.ended completed → waiting_input')
    assert.equal(kimiMod.evalKimiWireLine({ type: 'turn.ended', reason: 'failed' }, approvals), 'failed', 'turn.ended failed → failed')
    assert.equal(kimiMod.evalKimiWireLine({ type: 'turn.ended', reason: 'cancelled' }, approvals), 'unknown', 'turn.ended cancelled → unknown (对齐 codex turn_aborted 先例)')
    assert.equal(kimiMod.evalKimiLastTurnReason('completed'), 'waiting_input')
    assert.equal(kimiMod.evalKimiLastTurnReason('cancelled'), 'unknown')
    assert.equal(kimiMod.evalKimiLastTurnReason(null), null)
    assert.deepEqual(kimiMod.KIMI_APPROVAL_KINDS, ['approval'], 'approval kinds = 实机复核全集')

    await makeTempHome('devhub-ac4-106-')
    const fixtureHome = mkdtempSync(join(tmpdir(), 'devhub-ac4-106-kimi-'))
    const sessionA = 'session_106a0000-0000-4000-8000-000000000001'
    const dirA = join(fixtureHome, 'sessions', 'wd_x_106a', sessionA)
    mkdirSync(join(dirA, 'agents', 'main'), { recursive: true })
    writeFileSync(
      join(dirA, 'agents', 'main', 'wire.jsonl'),
      [
        JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1786701271959 }),
        JSON.stringify({ type: 'turn.prompt', turnId: 0, time: 1786701272000 }),
        JSON.stringify({ type: 'interaction.request', id: 'approval_fixture_1', kind: 'approval', toolCallId: 'Bash_1', time: 1786701272500 }),
        JSON.stringify({ type: 'interaction.resolved', id: 'approval_fixture_1', response: { decision: 'approved', scope: 'session' }, time: 1786701273000 }),
        JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'please check token=kimifix55' }], id: 'm1' }, time: 1786701272000 }),
        JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'p1', part: { type: 'text', text: 'all done' } }, time: 1786701277000 }),
        JSON.stringify({ type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 6078, time: 1786701278071 }),
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(join(dirA, 'state.json'), JSON.stringify({ id: sessionA, version: 2, cwd: 'C:\\nonexistent-ac4-106', createdAt: 1786701271932, updatedAt: 1786701278072, archived: false, agents: { main: { homedir: join(dirA, 'agents', 'main'), type: 'main' } }, lastTurnReason: 'completed' }))
    writeFileSync(join(fixtureHome, 'session_index.jsonl'), JSON.stringify({ sessionId: sessionA, sessionDir: dirA, workDir: 'C:\\nonexistent-ac4-106' }) + '\n', 'utf8')

    try {
      const db = dbModule.getDatabase()
      const provider = kimiMod.createKimiProvider({ kimiHome: fixtureHome })
      svc.setProviderOverride('kimi', provider)
      svc.setProviderOverride('codex', stubAgentProvider('codex'))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('zcode', stubAgentProvider('zcode'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      svc.ensureAgentProviderRows()
      svc.syncMonitorTasks() // 真实 startMonitor（watcher + wire 重放）

      let sessionRow = null
      for (let i = 0; i < 50; i++) {
        sessionRow = db.prepare('SELECT * FROM agent_sessions WHERE native_id = ?').get(sessionA)
        if (sessionRow !== undefined) break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(sessionRow !== undefined, 'monitor discovered the fixture session')
      let rows = null
      for (let i = 0; i < 50; i++) {
        rows = {
          status: db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(sessionRow.id).status,
          waiting: db.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'session.waiting_input' ORDER BY id").all(),
          msgs: db.prepare('SELECT role, content_redacted FROM agent_messages WHERE session_id = ? ORDER BY id').all(sessionRow.id),
        }
        if (rows.status === 'waiting_input' && rows.waiting.length >= 2 && rows.msgs.length >= 2) break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.equal(rows.status, 'waiting_input', 'wire replay final state = waiting_input (turn.ended completed)')
      const statuses = rows.waiting.map((w) => JSON.parse(w.payload_json).status).sort()
      assert.deepEqual(statuses, ['approval_required', 'waiting_input'], 'both waiting_input payload.status values genuinely produced (approval_required 贯通)')
      assert.ok(rows.msgs.some((m) => m.role === 'user' && m.content_redacted.includes('token=***')), 'user message redacted')
      assert.ok(rows.msgs.some((m) => m.role === 'assistant' && m.content_redacted === 'all done'), 'assistant content.part projected')
      assert.ok(!JSON.stringify(rows.msgs).includes('kimifix55'), 'no plaintext secret landed')

      const diag = provider.describeDiagnostics()
      assert.equal(diag.dataSource.kind, 'kimi-wire-jsonl')
      assert.ok(diag.control.note.length > 0)
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 107. Kimi managed stdin reply（夹具假进程）：终态确认才成功；进程秒退无终态 →
  //      结构化失败（进程退出 ≠ 成功，docs/12 §8.3）
  registerCase('ac4-107: kimi managed stdin reply (fixture fake process) — success requires session-file terminal state; instant-exit without terminal state is a structured failure (process exit ≠ success)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const kimiMod = await import(new URL('../src/main/services/agentControl/providers/kimiProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac4-107-'))
    const sessionDir = join(dir, 'sess', 'session_107a0000-0000-4000-8000-000000000001')
    mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true })
    const fixtureHome = join(dir, 'kimihome')
    mkdirSync(fixtureHome, { recursive: true })
    writeFileSync(
      join(fixtureHome, 'session_index.jsonl'),
      JSON.stringify({ sessionId: 'session_107a0000-0000-4000-8000-000000000001', sessionDir, workDir: 'C:\\nonexistent-ac4-107' }) + '\n',
      'utf8',
    )
    const script = join(dir, 'fake-kimi.mjs')
    writeFileSync(
      script,
      [
        "import { createInterface } from 'node:readline'",
        "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        'const dir = process.env.KIMI_FAKE_SESSION_DIR',
        'if (process.env.FAKE_KIMI_MODE === "exit-early") { process.exit(0) }',
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        '  if (line.trim().length === 0) return',
        '  writeFileSync(join(dir, "state.json"), JSON.stringify({ updatedAt: Date.now(), lastTurnReason: "completed" }))',
        '  mkdirSync(join(dir, "agents", "main"), { recursive: true })',
        '  appendFileSync(join(dir, "agents", "main", "wire.jsonl"), JSON.stringify({ type: "turn.ended", turnId: 9, reason: "completed", time: Date.now() }) + "\\n")',
        '  process.exit(0)',
        '})',
        '',
      ].join('\n'),
      'utf8',
    )
    const base = {
      kimiHome: fixtureHome,
      exePath: process.execPath,
      spawnArgs: [script],
      spawnEnv: { ...process.env, KIMI_FAKE_SESSION_DIR: sessionDir },
      replySettleMs: 10_000,
      replyPollMs: 50,
      managedIdleTimeoutMs: 4000,
      managedLifetimeTimeoutMs: 20_000,
    }
    const ref = { providerId: 'kimi', nativeId: 'session_107a0000-0000-4000-8000-000000000001' }

    // 成功：stdin 注入 → 假进程终态落盘 → 会话文件终态确认才 executed
    const okProvider = kimiMod.createKimiProvider(base)
    const okOutcome = await okProvider.sendReply(ref, 'hello from devhub')
    assert.deepEqual({ ok: okOutcome.ok, status: okOutcome.status }, { ok: true, status: 'executed' }, `terminal state confirmed → executed, got ${JSON.stringify(okOutcome)}`)
    assert.ok(okOutcome.detail.includes('terminal state'), `detail carries the terminal evidence: ${okOutcome.detail}`)

    // 失败：假进程秒退但无任何终态 → 结构化失败（绝不因进程退出判成功）
    const failProvider = kimiMod.createKimiProvider({ ...base, spawnEnv: { ...process.env, KIMI_FAKE_SESSION_DIR: sessionDir, FAKE_KIMI_MODE: 'exit-early' } })
    const failOutcome = await failProvider.sendReply(ref, 'hello again')
    assert.equal(failOutcome.ok, false, 'process exit without terminal state must not succeed')
    assert.equal(failOutcome.status, 'failed')
    assert.equal(failOutcome.errorCode, 'COMMAND_NOT_EXECUTABLE')
    assert.ok(failOutcome.detail.includes('process exit'), `structured failure detail: ${failOutcome.detail}`)

    // 未配置 spawnArgs：结构化拒绝（真机红线路径：绝不启动真实 kimi）
    const unconfigured = kimiMod.createKimiProvider({ kimiHome: fixtureHome })
    const refused = await unconfigured.sendReply(ref, 'hi')
    assert.equal(refused.ok, false)
    assert.equal(refused.status, 'unsupported')
    assert.ok(refused.detail.includes('not configured'))
  })

  // 108. Kimi managed 探测（夹具）：stdin 探针 + 会话文件确认 → managed + reply；
  //      探测进程崩溃 → observed 降级（不伪造能力）
  registerCase('ac4-108: kimi managed probe (fixture) — stdin probe confirmed by session file → managed with reply granted; probe crash → observed downgrade with empty granted', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const kimiMod = await import(new URL('../src/main/services/agentControl/providers/kimiProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac4-108-'))
    const probeDir = join(dir, 'probe-sess')
    mkdirSync(probeDir, { recursive: true })
    const probeDirCrash = join(dir, 'probe-sess-crash') // 独立探测目录：ok 探测的 state.json 不污染 crash 用例
    mkdirSync(probeDirCrash, { recursive: true })
    const script = join(dir, 'fake-kimi-probe.mjs')
    writeFileSync(
      script,
      [
        "import { createInterface } from 'node:readline'",
        "import { writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        'if (process.env.FAKE_KIMI_MODE === "crash") { process.exit(1) }',
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        '  if (line.trim().length === 0) return',
        '  writeFileSync(join(process.env.KIMI_FAKE_SESSION_DIR, "state.json"), JSON.stringify({ updatedAt: Date.now(), lastTurnReason: "completed" }))',
        '  process.exit(0)',
        '})',
        '',
      ].join('\n'),
      'utf8',
    )
    const base = {
      kimiHome: join(dir, 'kimihome'),
      exePath: process.execPath,
      managedProbeArgs: [script],
      managedProbeEnv: { ...process.env, KIMI_FAKE_SESSION_DIR: probeDir },
      managedProbeSessionDir: probeDir,
      managedProbeConfirmMs: 10_000,
      replyPollMs: 50,
      managedIdleTimeoutMs: 4000,
      managedLifetimeTimeoutMs: 20_000,
    }
    const ref = { providerId: 'kimi', nativeId: 'probe' }

    const okProvider = kimiMod.createKimiProvider(base)
    const caps = await okProvider.getCapabilities(ref)
    assert.equal(caps.mode, 'managed', `probe ok → managed, got ${caps.mode}: ${caps.evidence}`)
    assert.deepEqual(caps.granted, ['reply'], 'reply granted after real stdin+session-file confirmation')
    assert.ok(caps.evidence.includes('managed probe ok'), `evidence verbatim: ${caps.evidence}`)
    assert.ok(caps.verifiedAt > 0)

    const crashProvider = kimiMod.createKimiProvider({ ...base, managedProbeSessionDir: probeDirCrash, managedProbeEnv: { ...process.env, KIMI_FAKE_SESSION_DIR: probeDirCrash, FAKE_KIMI_MODE: 'crash' } })
    const caps2 = await crashProvider.getCapabilities(ref)
    assert.equal(caps2.mode, 'observed', 'probe crash → observed downgrade')
    assert.deepEqual(caps2.granted, [], 'downgrade grants empty set')
    assert.ok(caps2.evidence.includes('managed probe failed'), `evidence: ${caps2.evidence}`)

    // 探测未配置（真机形态）：observed + 跳过原因随 evidence 记录
    const realShape = kimiMod.createKimiProvider({ kimiHome: join(dir, 'kimihome'), exePath: 'definitely-missing-ac4-108.exe' })
    const caps3 = await realShape.getCapabilities(ref)
    assert.equal(caps3.mode, 'observed')
    assert.deepEqual(caps3.granted, [])
    assert.ok(caps3.evidence.includes('skipped') || caps3.evidence.includes('failed'), `skip/failed reason recorded: ${caps3.evidence.slice(0, 120)}`)
  })

  // 109. Kimi 真机只读探测：--version + 真实 session_index 会话发现（零写入零推理）
  registerCase('ac4-109: kimi real machine probe (read-only) — exe discovery, --version, real session_index discovery; env-dependent with SKIP note; never launches a real session', async () => {
    const { existsSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const kimiMod = await import(new URL('../src/main/services/agentControl/providers/kimiProvider.ts', import.meta.url).href)
    const exe = join(homedir(), '.kimi-code', 'bin', 'kimi.exe')
    if (!existsSync(exe)) {
      envSkipNote('kimi.exe not found under ~/.kimi-code/bin at run time')
      return
    }
    const provider = kimiMod.createKimiProvider()
    const health = await provider.probeHealth()
    assert.equal(health.health, 'ok', `health ok, got ${health.health}: ${health.healthDetail ?? ''}`)
    assert.ok(health.version !== undefined && /\d+\.\d+/.test(health.version), `version parsed: ${health.version}`)
    assert.ok(health.exePath.endsWith('kimi.exe'), `exe path: ${health.exePath}`)
    const sessions = await provider.listSessions()
    assert.ok(Array.isArray(sessions), 'real session listing (read-only) works')
    assert.ok(sessions.every((s) => s.nativeId.startsWith('session_')), 'real native ids follow the session_<uuid> shape')
    envSkipNote(`real kimi sessions discovered (read-only): ${sessions.length}`)
  })

  // 110. ZCode 夹具：schema 白名单通过 → 健康探测/会话/消息/审批落库；task_status
  //      映射（completed/error）+ approval_required 事件贯通；T11 只读不变性
  registerCase('ac4-110: zcode fixture — schema whitelist passes, health ok, sessions/messages persisted, task_status map (completed/error) + approval_required waiting_input event through L3; T11 read-only invariance (mtime+hash of db trio unchanged)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync, readdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createHash } = await import('node:crypto')
    const { DatabaseSync } = await import('node:sqlite')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)

    // 映射表与审批形态（实机复核取值全集后写死）
    assert.deepEqual(zcodeMod.ZCODE_TASK_STATUS_MAP, { completed: 'completed', error: 'failed' }, 'task_status 实测全集 {completed,error} 的写死映射')
    assert.equal(zcodeMod.evalZcodeTaskStatus('completed'), 'completed')
    assert.equal(zcodeMod.evalZcodeTaskStatus('error'), 'failed')
    assert.equal(zcodeMod.evalZcodeTaskStatus('mystery_value'), 'unknown', '未登录取值 → unknown（绝不猜）')
    assert.equal(zcodeMod.evalZcodeTaskStatus(null), null, '无任务行 → 无证据')
    assert.equal(zcodeMod.evalZcodeApprovalStatus('none'), false, "实测全集 {'none'} = 无审批")
    assert.equal(zcodeMod.evalZcodeApprovalStatus('pending'), true, 'pending 形态 → 审批等待（判定源 docs/12 §5）')
    assert.equal(zcodeMod.evalZcodeApprovalStatus('approved'), false, '已闭环形态绝不判为等待')
    assert.equal(zcodeMod.evalZcodeApprovalStatus(null), false)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac4-110-'))
    const dbPath = join(dir, 'db.sqlite')
    const tasksPath = join(dir, 'tasks-index.sqlite')
    const snapshotRoot = join(dir, 'snaps')
    const workdir = join(dir, 'ws', 'demo-zcode')
    mkdirSync(workdir, { recursive: true })
    const nowMs = 1788383547842
    // 夹具库按真实 schema 子集建表插数（PRAGMA 白名单必须通过）
    const fdb = new DatabaseSync(dbPath)
    fdb.exec(`
      CREATE TABLE session (id TEXT, project_id TEXT, workspace_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, task_type TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
      CREATE TABLE tool_usage (id TEXT, session_id TEXT, tool_name TEXT, approval_status TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
      CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, sequence INTEGER);
    `)
    const insSession = fdb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated, task_type) VALUES (?, ?, ?, ?, ?, ?)')
    insSession.run('sess_s1_completed', workdir, 'Fix the bug', nowMs, nowMs + 5000, 'interactive')
    insSession.run('sess_s2_error', workdir, 'Broken run', nowMs, nowMs + 6000, 'interactive')
    insSession.run('sess_s3_notask', workdir, 'No task row', nowMs, nowMs + 7000, 'interactive')
    insSession.run('sess_s4_approval', workdir, 'Needs approval', nowMs, nowMs + 8000, 'interactive')
    const insMsg = fdb.prepare('INSERT INTO message (id, session_id, data, sequence, time_created) VALUES (?, ?, ?, ?, ?)')
    insMsg.run('msg_u1', 'sess_s1_completed', JSON.stringify({ role: 'user', time: { created: nowMs }, semantics: { uiVisibility: 'visible' } }), 0, nowMs)
    fdb.prepare('INSERT INTO part (id, message_id, data, sequence) VALUES (?, ?, ?, ?)').run('p_u1', 'msg_u1', JSON.stringify({ type: 'text', text: 'fix the token=zcfix77 leak' }), 0)
    insMsg.run('msg_a1', 'sess_s1_completed', JSON.stringify({ role: 'assistant', time: { created: nowMs + 4000 }, finish: 'stop', semantics: { uiVisibility: 'visible' } }), 1, nowMs + 4000)
    fdb.prepare('INSERT INTO part (id, message_id, data, sequence) VALUES (?, ?, ?, ?)').run('p_a1', 'msg_a1', JSON.stringify({ type: 'text', text: 'fixed' }), 0)
    insMsg.run('msg_hidden', 'sess_s1_completed', JSON.stringify({ role: 'user', synthetic: true, time: { created: nowMs + 1 }, semantics: { uiVisibility: 'hidden' } }), 2, nowMs + 1)
    fdb.prepare("INSERT INTO tool_usage (id, session_id, tool_name, approval_status, status, started_at, completed_at) VALUES ('tu_1', 'sess_s4_approval', 'Bash', 'pending', 'running', ?, NULL)").run(nowMs)
    fdb.close()
    const tdb = new DatabaseSync(tasksPath)
    tdb.exec('CREATE TABLE tasks (task_id TEXT, title TEXT, task_status TEXT, workspace_path TEXT, updated_at INTEGER);')
    const insTask = tdb.prepare('INSERT INTO tasks (task_id, title, task_status, workspace_path, updated_at) VALUES (?, ?, ?, ?, ?)')
    insTask.run('sess_s1_completed', 'Fix the bug', 'completed', workdir, nowMs)
    insTask.run('sess_s2_error', 'Broken run', 'error', workdir, nowMs)
    tdb.close()

    const sha256Of = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
    const trioState = () => ['', '-wal', '-shm'].map((suf) => {
      const p = dbPath + suf
      if (!existsSync(p)) return `${suf}:absent`
      return `${suf}:${statSync(p).size}:${Math.floor(statSync(p).mtimeMs)}:${sha256Of(p)}`
    }).join('|')
    const before = trioState()

    await makeTempHome('devhub-ac4-110-')
    try {
      const db = dbModule.getDatabase()
      db.prepare('INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('demo-zcode', 'demo-zcode', workdir, Math.floor(nowMs / 1000), Math.floor(nowMs / 1000))
      const projectRow = db.prepare('SELECT id FROM projects ORDER BY id DESC LIMIT 1').get()

      const provider = zcodeMod.createZcodeProvider({ zcodeDbPath: dbPath, tasksIndexPath: tasksPath, snapshotRoot, pollMs: 100, snapshotRefreshMs: 60_000 })
      svc.setProviderOverride('zcode', provider)
      svc.setProviderOverride('codex', stubAgentProvider('codex'))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      svc.ensureAgentProviderRows()
      svc.syncMonitorTasks()

      // 轮询等待：消息投影 + 三个映射状态 + 审批事件
      let verdict = null
      for (let i = 0; i < 80; i++) {
        const s1 = db.prepare("SELECT id, status, project_id FROM agent_sessions WHERE native_id = 'sess_s1_completed'").get()
        const s2 = db.prepare("SELECT status FROM agent_sessions WHERE native_id = 'sess_s2_error'").get()
        const s4 = db.prepare("SELECT status FROM agent_sessions WHERE native_id = 'sess_s4_approval'").get()
        const msgCount = Number(db.prepare('SELECT COUNT(*) AS c FROM agent_messages').get().c)
        const waitingRows = db.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'session.waiting_input'").all()
        if (s1 !== undefined && s2 !== undefined && s4 !== undefined && msgCount >= 2 && waitingRows.length >= 1) {
          verdict = { s1, s2, s4, msgCount, waitingRows }
          if (s1.status === 'completed' && s2.status === 'failed' && s4.status === 'approval_required') break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(verdict !== null, 'monitor discovered sessions and projected messages')
      assert.equal(verdict.s1.status, 'completed', 'task_status completed → completed')
      assert.equal(verdict.s2.status, 'failed', 'task_status error → failed')
      assert.equal(verdict.s4.status, 'approval_required', 'tool_usage.approval_status pending → approval_required')
      assert.equal(verdict.s1.project_id, projectRow.id, 'directory matched to projects.win_path')
      assert.equal(verdict.msgCount, 2, 'user+assistant projected; synthetic/hidden runtime message skipped')
      const userMsg = db.prepare("SELECT content_redacted FROM agent_messages WHERE role = 'user'").get()
      assert.ok(userMsg.content_redacted.includes('token=***') && !userMsg.content_redacted.includes('zcfix77'), 'message content redacted')
      const approvalEvent = verdict.waitingRows.map((w) => JSON.parse(w.payload_json)).find((p) => p.status === 'approval_required')
      assert.ok(approvalEvent !== undefined, 'session.waiting_input event with payload.status=approval_required genuinely recorded')

      // T11 只读不变性：探测/列举/监控轮询前后夹具库三件套 mtime+hash 逐字节不变
      const health = await provider.probeHealth()
      assert.equal(health.health, 'ok', `probeHealth ok, got ${health.health}: ${health.healthDetail ?? ''}`)
      const sessions = await provider.listSessions()
      assert.equal(sessions.length, 4, 'listSessions full snapshot')
      const after = trioState()
      assert.equal(after, before, 'T11: db.sqlite (+absent -wal/-shm) mtime+byte-hash unchanged across probe/list/monitor')

      const caps = await provider.getCapabilities({ providerId: 'zcode', nativeId: 'x' })
      assert.equal(caps.mode, 'observed', '裁决 4：恒 observed')
      assert.deepEqual(caps.granted, [], '恒空集')
      const denied = await provider.sendReply({ providerId: 'zcode', nativeId: 'x' }, 'hi')
      assert.equal(denied.status, 'unsupported')

      svc.stopAllAgentControlRuntime()
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(existsSync(snapshotRoot) ? readdirSync(snapshotRoot).filter((d) => d.startsWith('zcode-snap-')).length : 0, 0, 'no snapshot dirs left behind (auto direct path never snapshots)')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 111. ZCode schema 防御：白名单不匹配 → unavailable + 结构化 health_detail，
  //      监控启停不崩溃（R2：非公开 CLI schema 变更）
  registerCase('ac4-111: zcode schema defense — whitelist mismatch (missing table/column) → provider unavailable with structured health_detail; monitor start/stop never crashes; empty snapshots, no field guessing', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac4-111-'))
    const dbPath = join(dir, 'db.sqlite')
    const tasksPath = join(dir, 'tasks-index.sqlite')
    const fdb = new DatabaseSync(dbPath)
    // session 缺 title 列、tool_usage 整表缺失
    fdb.exec(`
      CREATE TABLE session (id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
    `)
    fdb.prepare("INSERT INTO session (id, directory, time_created, time_updated) VALUES ('sess_x', 'C:/nowhere', 1, 1)").run()
    fdb.close()
    const tdb = new DatabaseSync(tasksPath)
    tdb.exec('CREATE TABLE tasks (task_id TEXT, title TEXT, task_status TEXT, workspace_path TEXT, updated_at INTEGER);')
    tdb.close()

    await makeTempHome('devhub-ac4-111-')
    try {
      const db = dbModule.getDatabase()
      const provider = zcodeMod.createZcodeProvider({ zcodeDbPath: dbPath, tasksIndexPath: tasksPath, snapshotRoot: join(dir, 'snaps') })
      svc.setProviderOverride('zcode', provider)
      svc.setProviderOverride('codex', stubAgentProvider('codex'))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      svc.ensureAgentProviderRows()
      svc.resetAgentControlThrottles()
      await svc.probeWiredProviders(true)
      const row = db.prepare("SELECT health, health_detail FROM agent_providers WHERE provider = 'zcode'").get()
      assert.equal(row.health, 'unavailable', 'schema mismatch → unavailable')
      assert.ok(row.health_detail.includes('missing column: session.title'), `structured detail names the gap: ${row.health_detail}`)
      assert.ok(row.health_detail.includes('missing table: tool_usage'), `missing table reported: ${row.health_detail}`)

      assert.deepEqual(await provider.listSessions(), [], 'sessions snapshot empty (never guesses fields)')
      const page = await provider.readMessages({ providerId: 'zcode', nativeId: 'sess_x' })
      assert.deepEqual(page.messages, [])
      const handle = provider.startMonitor({}) // 启停不崩溃（空 sink）
      await new Promise((r) => setTimeout(r, 400))
      await handle.stop()
      const diag = provider.describeDiagnostics()
      assert.equal(diag.dataSource.readable, false, 'diagnostics mark the source unreadable')
      assert.ok(diag.dataSource.detail.length > 0)
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 112. ZCode 快照降级（模拟 CANTOPEN）：直连禁用 → 复制-读-删除；tmp 清理断言；
  //      数据经快照可读；自动模式下健康库零快照残留
  registerCase('ac4-112: zcode snapshot fallback (simulated CANTOPEN via directOpenMode=disabled) — copy-read-delete roundtrip, snapshot tmp cleaned after probe/monitor; healthy auto path leaves zero snapshot residue', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-ac4-112-'))
    const dbPath = join(dir, 'db-live', 'db.sqlite')
    mkdirSync(join(dir, 'db-live'), { recursive: true })
    const snapshotRoot = join(dir, 'snaps')
    const fdb = new DatabaseSync(dbPath)
    fdb.exec(`
      CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
      CREATE TABLE tool_usage (id TEXT, session_id TEXT, tool_name TEXT, approval_status TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
    `)
    fdb.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES ('sess_snap', 'C:/nowhere-ac4-112', 'Snapshot session', 1, 2)").run()
    fdb.close()
    const tasksPath = join(dir, 'tasks-index.sqlite')
    const tdb = new DatabaseSync(tasksPath)
    tdb.exec('CREATE TABLE tasks (task_id TEXT, title TEXT, task_status TEXT, workspace_path TEXT, updated_at INTEGER);')
    tdb.close()

    await makeTempHome('devhub-ac4-112-')
    try {
      const db = dbModule.getDatabase()
      const provider = zcodeMod.createZcodeProvider({
        zcodeDbPath: dbPath,
        tasksIndexPath: tasksPath,
        snapshotRoot,
        directOpenMode: 'disabled', // 确定性模拟 CANTOPEN：直连恒视为失败 → 快照降级
        pollMs: 100,
        snapshotRefreshMs: 60_000,
      })
      const health = await provider.probeHealth()
      assert.equal(health.health, 'ok', `snapshot path reads the data: ${health.healthDetail ?? ''}`)
      assert.ok((health.healthDetail ?? '').includes('snapshot'), 'health_detail records the snapshot fallback')
      const sessions = await provider.listSessions()
      assert.equal(sessions.length, 1, 'data readable via snapshot copy')
      assert.equal(sessions[0].nativeId, 'sess_snap')
      let left = existsSync(snapshotRoot) ? readdirSync(snapshotRoot).filter((d) => d.startsWith('zcode-snap-')) : []
      assert.equal(left.length, 0, 'probe/list snapshot dirs deleted after use (用完即删)')

      // 监控路径：常驻快照周期刷新 + 停止后零残留
      svc.setProviderOverride('zcode', provider)
      svc.setProviderOverride('codex', stubAgentProvider('codex'))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      svc.ensureAgentProviderRows()
      svc.syncMonitorTasks()
      let found = false
      for (let i = 0; i < 50; i++) {
        found = db.prepare("SELECT COUNT(*) AS c FROM agent_sessions WHERE native_id = 'sess_snap'").get().c > 0
        if (found) break
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(found, 'monitor ingests via resident snapshot')
      svc.stopAllAgentControlRuntime()
      await new Promise((r) => setTimeout(r, 300))
      left = existsSync(snapshotRoot) ? readdirSync(snapshotRoot).filter((d) => d.startsWith('zcode-snap-')) : []
      assert.equal(left.length, 0, 'resident snapshot removed on monitor stop')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 113. ZCode 真机只读探测：活跃写入中的真库（WAL）readOnly 直连 + 真实会话快照
  //      （零写入、绝不 checkpoint；T11 字节级不变性由夹具用例承载）
  registerCase('ac4-113: zcode real machine probe (read-only) — live WAL db readOnly open + real session snapshot + tasks-index status source; env-dependent with SKIP note', async () => {
    const { existsSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)
    const dbPath = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
    if (!existsSync(dbPath)) {
      envSkipNote('~/.zcode/cli/db/db.sqlite not found at run time')
      return
    }
    const provider = zcodeMod.createZcodeProvider()
    const health = await provider.probeHealth()
    assert.ok(['ok', 'unavailable'].includes(health.health), `legal outcomes only (schema defended), got ${health.health}: ${health.healthDetail ?? ''}`)
    if (health.health !== 'ok') {
      envSkipNote(`zcode schema whitelist mismatch at run time (legal defense): ${health.healthDetail ?? ''}`)
      return
    }
    const sessions = await provider.listSessions()
    assert.ok(sessions.length > 0, `real sessions discovered (read-only): ${sessions.length}`)
    assert.ok(sessions.every((s) => typeof s.nativeId === 'string' && s.nativeId.startsWith('sess_')), 'real native ids follow the sess_<uuid> shape')
    const caps = await provider.getCapabilities({ providerId: 'zcode', nativeId: '-' })
    assert.equal(caps.mode, 'observed', 'observed-only (裁决 4) on the real machine too')
    envSkipNote(`real zcode sessions discovered (read-only): ${sessions.length}`)
  })

  // 114. DeepSeek T12：harness 检测（夹具+真机）→ 「未接入」显式文案；绝不伪造
  //      会话/事件/能力
  registerCase('ac4-114: deepseek T12 — fixture + real harness root detection with explicit not-integrated wording; never fabricates sessions/events/capabilities (L3 projection verified)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const dsMod = await import(new URL('../src/main/services/agentControl/providers/deepseekProvider.ts', import.meta.url).href)

    await makeTempHome('devhub-ac4-114-')
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'devhub-ac4-114-dsh-'))
    writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '9.9.9-fixture', private: true }))
    writeFileSync(join(fixtureRoot, 'AGENTS.md'), '# fixture harness')
    writeFileSync(join(fixtureRoot, 'CLAUDE.md'), '# fixture')
    mkdirSync(join(fixtureRoot, 'packages'), { recursive: true })

    try {
      const db = dbModule.getDatabase()
      const provider = dsMod.createDeepseekProvider({ harnessRoot: fixtureRoot })
      svc.setProviderOverride('deepseek', provider)
      svc.setProviderOverride('codex', stubAgentProvider('codex'))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('zcode', stubAgentProvider('zcode'))
      svc.ensureAgentProviderRows()
      svc.resetAgentControlThrottles()
      await svc.probeWiredProviders(true)

      const row = db.prepare("SELECT installed, version, health, health_detail, capabilities_json FROM agent_providers WHERE provider = 'deepseek'").get()
      assert.equal(row.installed, 1, 'harness root detected')
      assert.equal(row.version, '9.9.9-fixture', 'version clue from package.json')
      assert.equal(row.health, 'ok', 'source tree healthy')
      assert.ok(row.health_detail.includes('harness detected'), `health_detail records what was detected: ${row.health_detail}`)
      assert.ok(row.health_detail.toLowerCase().includes('not integrated'), `health_detail carries the explicit not-integrated wording (T12): ${row.health_detail}`)
      const caps = JSON.parse(row.capabilities_json)
      assert.equal(caps.mode, 'observed')
      assert.deepEqual(caps.granted, [], 'capabilities empty set (never fabricated)')
      assert.ok(caps.evidence.toLowerCase().includes('not integrated'), `evidence carries not-integrated: ${caps.evidence}`)
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM agent_sessions s JOIN agent_providers p ON p.id = s.provider_id WHERE p.provider = 'deepseek'").get().c, 0, 'zero deepseek sessions (never fabricated)')

      assert.deepEqual(await provider.listSessions(), [])
      const ref = { providerId: 'deepseek', nativeId: 'x' }
      assert.deepEqual((await provider.readMessages(ref)).messages, [])
      const denied = await provider.sendReply(ref, 'hi')
      assert.equal(denied.ok, false)
      assert.equal(denied.status, 'unsupported')
      assert.equal(denied.errorCode, 'AGENT_CAPABILITY_MISSING')
      const diag = provider.describeDiagnostics()
      assert.equal(diag.dataSource.kind, 'not-connected')
      assert.equal(diag.dataSource.readable, false)
      assert.ok(diag.control.note.toLowerCase().includes('not integrated'))

      // 缺失根 → unavailable + 未接入文案
      const missing = dsMod.createDeepseekProvider({ harnessRoot: join(fixtureRoot, 'no-such-root') })
      const missingHealth = await missing.probeHealth()
      assert.equal(missingHealth.health, 'unavailable')
      assert.equal(missingHealth.installed, false)
      assert.ok(missingHealth.healthDetail.includes('not found'))

      // 真机根（env-dependent）：存在 → 探测到真实版本线索；不存在 → SKIP 注记
      const real = dsMod.createDeepseekProvider()
      const realHealth = await real.probeHealth()
      if (realHealth.installed) {
        assert.ok(realHealth.healthDetail.includes('harness detected'), `real harness detected: ${realHealth.healthDetail?.slice(0, 120)}`)
        envSkipNote(`real deepseekHarnessRoot detected: ${realHealth.version ?? 'version unknown'}`)
      } else {
        envSkipNote('deepseekHarnessRoot not present at run time')
      }
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 115. 事件管线收口 T13/T14：markDelivered/markAcked 只前进（ack 后 delivered
  //      拒绝）；eventsSince 补发语义；未确认事件绝不删除（静态断言零 DELETE 路径）
  registerCase('ac4-115: event pipeline closure T13/T14 — delivery state machine forward-only (delivered after acked rejected, device-granular aggregate), eventsSince replay semantics, no DELETE path on unconfirmed events (static assertion)', async () => {
    const { readFileSync } = await import('node:fs')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const ep = await import(new URL('../src/main/services/agentControl/eventPipeline.ts', import.meta.url).href)

    await makeTempHome('devhub-ac4-115-')
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('codex', 'Codex', ?, ?)").run(now, now)
      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('Pixel 9', 'android', ?, ?, ?, ?)").run('c'.repeat(64), now, now, now)
      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('Tablet', 'android', ?, ?, ?, ?)").run('d'.repeat(64), now, now, now)
      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('Third', 'android', ?, ?, ?, ?)").run('e'.repeat(64), now, now, now)
      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('FreshDevice', 'android', ?, ?, ?, ?)").run('f'.repeat(64), now, now, now)

      const r1 = ep.recordEvent({ eventType: 'session.started', providerKey: 'codex', nativeId: 'n1', payload: { i: 1 } })
      const r2 = ep.recordEvent({ eventType: 'session.status_changed', providerKey: 'codex', nativeId: 'n1', payload: { i: 2 } })
      const r3 = ep.recordEvent({ eventType: 'message.appended', providerKey: 'codex', nativeId: 'n1', payload: { i: 3 } })
      const r4 = ep.recordEvent({ eventType: 'session.finished', providerKey: 'codex', nativeId: 'n1', payload: { i: 4 } })
      assert.ok(r1.sequence > 0 && r2.sequence > r1.sequence && r3.sequence > r2.sequence && r4.sequence > r3.sequence)
      // 活跃设备 4 台 → 每事件 4 行 pending deliveries
      assert.equal(r1.deliveries, 4, 'pending delivery rows per active device')

      // pending → delivered → acked（设备粒度 + 聚合）
      const d1 = ep.markEventDelivered(r1.sequence, 1)
      assert.deepEqual(d1, { updated: true, state: 'pending' }, 'device 1 delivered; aggregate stays pending (others pending)')
      const d2 = ep.markEventDelivered(r1.sequence, 2)
      assert.deepEqual(d2, { updated: true, state: 'pending' }, 'device 2 delivered; aggregate stays pending (device 4 pending)')
      const d3 = ep.markEventDelivered(r1.sequence, 3)
      assert.deepEqual(d3, { updated: true, state: 'pending' }, 'device 3 delivered; aggregate stays pending (device 4 pending)')
      const d4 = ep.markEventDelivered(r1.sequence, 4)
      assert.deepEqual(d4, { updated: true, state: 'delivered' }, 'all devices delivered → aggregate delivered')
      const a1 = ep.markEventAcked(r1.sequence, 1)
      assert.deepEqual(a1, { updated: true, state: 'delivered' }, 'device 1 acked; aggregate still delivered (others delivered)')
      const a2 = ep.markEventAcked(r1.sequence, 2)
      assert.deepEqual(a2, { updated: true, state: 'delivered' }, 'device 2 acked; aggregate still delivered (device 4 delivered)')
      const a3 = ep.markEventAcked(r1.sequence, 3)
      assert.deepEqual(a3, { updated: true, state: 'delivered' }, 'device 3 acked; aggregate still delivered (device 4 delivered)')
      const a4 = ep.markEventAcked(r1.sequence, 4)
      assert.deepEqual(a4, { updated: true, state: 'acked' }, 'all acked → aggregate acked')
      const rejected = ep.markEventDelivered(r1.sequence, 1)
      assert.equal(rejected.updated, false, '只前进：delivered after acked rejected')
      assert.equal(rejected.state, 'acked', 'state stays acked (never backward)')
      const devRow = db.prepare('SELECT status FROM event_deliveries WHERE event_id = ? AND device_id = 1').get(r1.sequence)
      assert.equal(devRow.status, 'acked', 'device row untouched by rejected transition')
      const aggRow = db.prepare('SELECT delivery_state, acked_at FROM agent_events WHERE id = ?').get(r1.sequence)
      assert.equal(aggRow.delivery_state, 'acked')
      assert.ok(aggRow.acked_at !== null, 'acked_at stamped')

      // r2：设备 1 单独 ack（设备 4 仍 pending）→ 补发按设备行隔离
      const aR2 = ep.markEventAcked(r2.sequence, 1)
      assert.deepEqual(aR2, { updated: true, state: 'pending' }, 'device 1 acks r2; aggregate stays pending (others pending)')

      // 事件行直推（无设备粒度形态）：r5 delivered、r6 pending→acked 直达
      const r5 = ep.recordEvent({ eventType: 'provider.health_changed', providerKey: 'codex', payload: { x: 5 } })
      const noDev = ep.markEventDelivered(r5.sequence)
      assert.deepEqual(noDev, { updated: true, state: 'delivered' }, 'device-less markDelivered advances the event row')
      const r6 = ep.recordEvent({ eventType: 'command.result', providerKey: 'codex', payload: { x: 6 } })
      const directAck = ep.markEventAcked(r6.sequence)
      assert.deepEqual(directAck, { updated: true, state: 'acked' }, 'pending → acked straight (forward skip)')
      assert.throws(() => ep.markEventDelivered(424242), /not found/, 'missing event → NOT_FOUND (structured)')

      // T14 补发语义：eventsSince(seq, deviceId) 基于 deliveries 状态
      const page1 = ep.eventsSince(0, 1)
      const seqs = page1.events.map((e) => e.sequence)
      assert.ok(!seqs.includes(r1.sequence), 'acked event excluded from replay for device 1')
      assert.ok(!seqs.includes(r2.sequence), 'device-1-acked event excluded for device 1')
      assert.ok(seqs.includes(r3.sequence), 'pending event included')
      assert.ok(seqs.includes(r4.sequence), 'untouched event included')
      assert.ok(seqs.includes(r5.sequence), 'device-less delivered event included for device replay')
      assert.ok(seqs.includes(r6.sequence), 'aggregate-acked event still replays to device 1 (per-device rows rule; device never acked)')
      // 游标推进：after = r3 → r3 之前不再出现
      const page2 = ep.eventsSince(r3.sequence, 1)
      assert.ok(page2.events.every((e) => e.sequence > r3.sequence), 'cursor semantics: only events after the sequence')
      // 设备 4（未 ack r2）补发窗口包含 r2、但不含其已 ack 的 r1
      const pageDev2 = ep.eventsSince(0, 4)
      const seqs2 = pageDev2.events.map((e) => e.sequence)
      assert.ok(seqs2.includes(r2.sequence), 'per-device isolation: device 4 still replays r2 (never acked it)')
      assert.ok(!seqs2.includes(r1.sequence), 'per-device isolation: device 4 does not replay r1 (it acked it)')
      // 晚配对设备（无任何投递行）：配对前事件视同未确认，一并补发
      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('LatePair', 'android', ?, ?, ?, ?)").run('0'.repeat(64), now, now, now)
      const late = ep.eventsSince(0, 5)
      const seqsLate = late.events.map((e) => e.sequence)
      assert.ok(seqsLate.includes(r1.sequence) && seqsLate.includes(r2.sequence) && seqsLate.includes(r6.sequence), 'late-paired device (zero delivery rows) replays the full unconfirmed window')
      // 聚合态补发（deviceId = null）：acked 聚合事件移出窗口
      const pageAgg = ep.eventsSince(0, null)
      const seqsAgg = pageAgg.events.map((e) => e.sequence)
      assert.ok(!seqsAgg.includes(r1.sequence), 'aggregate-acked r1 excluded from aggregate replay')
      assert.ok(!seqsAgg.includes(r6.sequence), 'aggregate-acked r6 excluded from aggregate replay')
      assert.ok(seqsAgg.includes(r3.sequence) && seqsAgg.includes(r4.sequence), 'unacked aggregates included')
      // ack 后移出补发集
      ep.markEventAcked(r3.sequence, 1)
      assert.ok(!ep.eventsSince(0, 1).events.some((e) => e.sequence === r3.sequence), 'acked events leave the replay window')
      // limit 封顶 + hasMore
      const tiny = ep.eventsSince(0, 1, 1)
      assert.equal(tiny.events.length, 1, 'limit respected')
      assert.equal(tiny.hasMore, true, 'hasMore when truncated')

      // 未确认事件绝不删除：全库静态断言零 DELETE 路径（约束 #27 语义 + 裁决 5）
      for (const src of ['eventPipeline.ts', 'agentControlService.ts']) {
        const text = readFileSync(new URL(`../src/main/services/agentControl/${src}`, import.meta.url), 'utf8')
        assert.ok(!/DELETE\s+FROM\s+agent_events/i.test(text), `${src} has no DELETE FROM agent_events path`)
        assert.ok(!/DELETE\s+FROM\s+event_deliveries/i.test(text), `${src} has no DELETE FROM event_deliveries path`)
      }
      const counts = Number(db.prepare('SELECT COUNT(*) AS c FROM agent_events').get().c)
      assert.ok(counts >= 5, 'all events still present (nothing deleted during transitions)')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 116. 多 provider 并发不串会话：codex + zcode + claude 夹具同时监控 → 会话/
  //      消息/事件严格按 provider 归属（T「多 Agent 并发不串会话」smoke 层）
  registerCase('ac4-116: multi-provider concurrency — codex + zcode + claude fixture monitors run simultaneously; sessions/messages/events stay provider-scoped (no cross-provider mixing)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const codexMod = await import(new URL('../src/main/services/agentControl/providers/codexProvider.ts', import.meta.url).href)
    const claudeMod = await import(new URL('../src/main/services/agentControl/providers/claudeProvider.ts', import.meta.url).href)
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)

    await makeTempHome('devhub-ac4-116-')
    const root = mkdtempSync(join(tmpdir(), 'devhub-ac4-116-multi-'))

    // codex 夹具：rollout jsonl + session_index
    const codexHome = join(root, 'codex-home')
    const codexProject = join(root, 'ws', 'codex-demo')
    const codexSession = 'ac4c0d60000-0000-7000-8000-000000000001'
    mkdirSync(join(codexHome, 'sessions', '2026', '09', '03'), { recursive: true })
    mkdirSync(codexProject, { recursive: true })
    writeFileSync(
      join(codexHome, 'sessions', '2026', '09', '03', `rollout-2026-09-03T10-00-00-${codexSession}.jsonl`),
      [
        JSON.stringify({ timestamp: '2026-09-03T02:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: codexSession, cwd: codexProject, timestamp: '2026-09-03T02:00:00.000Z' } }),
        JSON.stringify({ timestamp: '2026-09-03T02:00:05.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started' } }),
        JSON.stringify({ timestamp: '2026-09-03T02:00:09.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'cx_msg_1', role: 'user', content: [{ type: 'input_text', text: 'codex says token=codexfix11' }] } }),
        '',
      ].join('\n'),
      'utf8',
    )
    // claude 夹具：转录 jsonl
    const claudeHome = join(root, 'claude-home')
    const claudeProject = join(root, 'ws', 'claude-demo')
    const claudeSession = 'ac4c1a015-0000-7000-8000-000000000009'
    mkdirSync(join(claudeHome, 'projects', 'C--fixture-ws-claude-demo'), { recursive: true })
    mkdirSync(claudeProject, { recursive: true })
    writeFileSync(
      join(claudeHome, 'projects', 'C--fixture-ws-claude-demo', `${claudeSession}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'claude says token=claudefix22' }, uuid: 'u1', timestamp: '2026-09-03T03:00:00.000Z', cwd: claudeProject, sessionId: claudeSession }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'claude done' }] }, uuid: 'u2', timestamp: '2026-09-03T03:00:05.000Z', sessionId: claudeSession }),
        '',
      ].join('\n'),
      'utf8',
    )
    // zcode 夹具：db.sqlite + tasks-index.sqlite
    const zcodeDb = join(root, 'zcode-home', 'db.sqlite')
    mkdirSync(join(root, 'zcode-home'), { recursive: true })
    const zcodeProject = join(root, 'ws', 'zcode-demo')
    mkdirSync(zcodeProject, { recursive: true })
    const zdb = new DatabaseSync(zcodeDb)
    zdb.exec(`
      CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
      CREATE TABLE tool_usage (id TEXT, session_id TEXT, tool_name TEXT, approval_status TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
      CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, sequence INTEGER);
    `)
    zdb.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES ('sess_ac4_116', ?, 'ZCode concurrent', 1, 2)").run(zcodeProject)
    zdb.prepare("INSERT INTO message (id, session_id, data, sequence, time_created) VALUES ('z_msg_1', 'sess_ac4_116', ?, 0, 1)").run(
      JSON.stringify({ role: 'user', time: { created: 1788383547842 }, semantics: { uiVisibility: 'visible' } }),
    )
    zdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('z_p1', 'z_msg_1', ?, 0)").run(JSON.stringify({ type: 'text', text: 'zcode says token=zcodefix33' }))
    zdb.close()
    writeFileSync(join(root, 'zcode-home', 'tasks-index.sqlite'), '') // 空文件 → schema 校验失败路径不炸（tasks 状态源缺席容忍）

    try {
      const db = dbModule.getDatabase()
      db.prepare('INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('codex-demo', 'codex-demo', codexProject, 0, 0)
      db.prepare('INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('claude-demo', 'claude-demo', claudeProject, 0, 0)
      db.prepare('INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('zcode-demo', 'zcode-demo', zcodeProject, 0, 0)

      svc.ensureAgentProviderRows()
      svc.setProviderOverride('codex', codexMod.createCodexProvider({ codexHome, codexBinRoot: join(root, 'no-bin') }))
      svc.setProviderOverride('claude-code', claudeMod.createClaudeProvider({ claudeHome }))
      svc.setProviderOverride('zcode', zcodeMod.createZcodeProvider({ zcodeDbPath: zcodeDb, tasksIndexPath: join(root, 'zcode-home', 'tasks-index.sqlite'), snapshotRoot: join(root, 'snaps'), pollMs: 100, snapshotRefreshMs: 60_000 }))
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      svc.syncMonitorTasks()

      let ready = false
      for (let i = 0; i < 80; i++) {
        const counts = {
          codex: db.prepare("SELECT COUNT(*) AS c FROM agent_sessions s JOIN agent_providers p ON p.id = s.provider_id WHERE p.provider = 'codex' AND s.native_id = ?").get(codexSession).c,
          claude: db.prepare("SELECT COUNT(*) AS c FROM agent_sessions s JOIN agent_providers p ON p.id = s.provider_id WHERE p.provider = 'claude-code' AND s.native_id = ?").get(claudeSession).c,
          zcode: db.prepare("SELECT COUNT(*) AS c FROM agent_sessions s JOIN agent_providers p ON p.id = s.provider_id WHERE p.provider = 'zcode' AND s.native_id = 'sess_ac4_116'").get().c,
          msgs: Number(db.prepare('SELECT COUNT(*) AS c FROM agent_messages').get().c),
          running: db.prepare("SELECT COUNT(*) AS c FROM agent_sessions WHERE status = 'running'").get().c,
        }
        if (counts.codex === 1 && counts.claude === 1 && counts.zcode === 1 && counts.msgs >= 3 && counts.running >= 1) {
          ready = true
          break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(ready, 'all three fixture monitors discovered their sessions and projected messages concurrently')

      // 会话归属：每个 native_id 恰好归属一个 provider，绝不串
      const rows = db.prepare('SELECT s.native_id, s.status, p.provider FROM agent_sessions s JOIN agent_providers p ON p.id = s.provider_id').all()
      const byNative = new Map()
      for (const row of rows) {
        const key = `${row.provider}:${row.native_id}`
        assert.ok(!byNative.has(key), `no duplicate (provider, native_id): ${key}`)
        byNative.set(key, row)
      }
      assert.ok(byNative.has(`codex:${codexSession}`), 'codex session owned by codex')
      assert.ok(byNative.has(`claude-code:${claudeSession}`), 'claude session owned by claude-code')
      assert.ok(byNative.has('zcode:sess_ac4_116'), 'zcode session owned by zcode')

      // 消息归属：每条消息的 content 指纹只出现在其 provider 的会话下
      const msgRows = db.prepare('SELECT m.content_redacted, p.provider FROM agent_messages m JOIN agent_sessions s ON s.id = m.session_id JOIN agent_providers p ON p.id = s.provider_id').all()
      assert.ok(msgRows.some((m) => m.provider === 'codex' && m.content_redacted.includes('codex says')), 'codex message under codex session')
      assert.ok(msgRows.some((m) => m.provider === 'claude-code' && m.content_redacted.includes('claude says')), 'claude message under claude session')
      assert.ok(msgRows.some((m) => m.provider === 'zcode' && m.content_redacted.includes('zcode says')), 'zcode message under zcode session')
      for (const fingerprint of ['codex says', 'claude says', 'zcode says']) {
        assert.equal(msgRows.filter((m) => m.content_redacted.includes(fingerprint)).length, 1, `fingerprint "${fingerprint}" appears exactly once`)
      }
      // 事件归属：status/started 事件按 provider 分组、native 指纹互不串扰
      const eventRows = db.prepare('SELECT e.provider_id, p.provider, e.event_type FROM agent_events e LEFT JOIN agent_providers p ON p.id = e.provider_id').all()
      assert.ok(eventRows.some((e) => e.provider === 'codex' && e.event_type === 'session.status_changed'), 'codex running status event under codex provider')
      assert.ok(eventRows.every((e) => e.provider !== null), 'every event carries a provider')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  })

  // ====================================================================
  // AC5 批次（docs/16 §1 AC5 行：托盘 + 自启 + Agents 视图；交付物 7）
  // ====================================================================

  // 117. 托盘摘要纯函数（docs/12 §10「查看 Agent 摘要」tooltip 数据源的文案层）：
  //      四态输入输出断言（无会话×监控开/关、有会话×监控开/关 + waiting/approval 计数段）
  registerCase('ac5-117: agentSummaryText four states — empty (monitor on/off), active counts with waiting/approval segments, monitor-off suffix; deterministic output', async () => {
    const mod = await import(new URL('../src/main/services/agentControl/traySummary.ts', import.meta.url).href)

    // 态 1：无会话 + 监控开
    assert.equal(
      mod.agentSummaryText({ totalSessions: 0, activeSessions: 0, waitingInput: 0, approvalRequired: 0, monitorEnabled: true }),
      'DevHub — Agents: no sessions (monitoring on)',
    )
    // 态 2：无会话 + 监控关
    assert.equal(
      mod.agentSummaryText({ totalSessions: 0, activeSessions: 0, waitingInput: 0, approvalRequired: 0, monitorEnabled: false }),
      'DevHub — Agents: no sessions (monitoring off)',
    )
    // 态 3：有会话 + 监控开，waiting/approval 全 0（段省略）
    assert.equal(
      mod.agentSummaryText({ totalSessions: 12, activeSessions: 3, waitingInput: 0, approvalRequired: 0, monitorEnabled: true }),
      'DevHub — Agents: 3/12 active',
    )
    // 态 4：有会话 + 监控开，waiting/approval 高亮计数段出现（docs/11 D3 托盘版）
    assert.equal(
      mod.agentSummaryText({ totalSessions: 12, activeSessions: 3, waitingInput: 1, approvalRequired: 2, monitorEnabled: true }),
      'DevHub — Agents: 3/12 active · 1 waiting input · 2 approval',
    )
    // 态 5：有会话 + 监控关（suffix 显式，绝不伪装监控在线）
    assert.equal(
      mod.agentSummaryText({ totalSessions: 12, activeSessions: 0, waitingInput: 0, approvalRequired: 0, monitorEnabled: false }),
      'DevHub — Agents: 0/12 active (monitoring off)',
    )
  }, 'fast')

  // 118. 托盘菜单数据源：getAgentSummaryCounts 从 agent_sessions 真实库投影计数
  //      （docs/12 §10；活跃 = running/waiting_input/approval_required/paused/connection_lost）
  registerCase('ac5-118: getAgentSummaryCounts projects real counts from agent_sessions (fixture db) and honors agents_monitor_enabled', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const settingsSvc = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    await makeTempHome('devhub-ac5-118-')
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare('INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('kimi', 'Kimi Code', now, now)
      const providerId = Number(db.prepare("SELECT id FROM agent_providers WHERE provider = 'kimi'").get().id)
      const insertSession = db.prepare(
        'INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      insertSession.run(providerId, 'ac5-sess-1', 'observed', 'running', now, now)
      insertSession.run(providerId, 'ac5-sess-2', 'observed', 'waiting_input', now, now)
      insertSession.run(providerId, 'ac5-sess-3', 'observed', 'approval_required', now, now)
      insertSession.run(providerId, 'ac5-sess-4', 'observed', 'completed', now, now)
      insertSession.run(providerId, 'ac5-sess-5', 'observed', 'connection_lost', now, now)
      insertSession.run(providerId, 'ac5-sess-6', 'observed', 'stopped', now, now)

      const counts = svc.getAgentSummaryCounts()
      assert.equal(counts.totalSessions, 6, 'all sessions counted')
      assert.equal(counts.activeSessions, 4, 'active = running + waiting_input + approval_required + paused + connection_lost (running/waiting/approval/connection_lost here)')
      assert.equal(counts.waitingInput, 1, 'waiting_input counted')
      assert.equal(counts.approvalRequired, 1, 'approval_required counted')
      assert.equal(counts.monitorEnabled, true, 'default seed agents_monitor_enabled=1')

      settingsSvc.setSetting('agents_monitor_enabled', '0')
      assert.equal(svc.getAgentSummaryCounts().monitorEnabled, false, 'monitor toggle reflects settings truth')
      settingsSvc.setSetting('agents_monitor_enabled', '1')

      // 文案层拼装（托盘 tooltip 的真实调用路径）
      const summaryMod = await import(new URL('../src/main/services/agentControl/traySummary.ts', import.meta.url).href)
      const text = summaryMod.agentSummaryText(svc.getAgentSummaryCounts())
      assert.ok(text.includes('4/6 active') && text.includes('1 waiting input') && text.includes('1 approval'), `summary text assembled from real db: ${text}`)
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 119. 自启胶水注入位（docs/12 §10：setLoginItemSettings 即时应用；services 层
  //      electron-free，electron 侧真实现由 autostartWire.ts 注入——本用例在系统 Node
  //      下断言注入缝的行为契约：未注入 = AC2 settings-only；注入成功路径 / 失败
  //      结构化路径 / applyAutoStartSetting 启动应用路径）
  registerCase('ac5-119: setAutoStart applier seam — null keeps AC2 settings-only, injected applier applied before settings write, failure folds to structured INTERNAL and leaves settings untouched, applyAutoStartSetting applies current value', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    await makeTempHome('devhub-ac5-119-')
    try {
      const db = dbModule.getDatabase()
      const readSetting = () => {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'login_autostart'").get()
        return row === undefined ? undefined : row.value
      }

      // 缝 A：未注入（smoke/系统 Node 默认）→ AC2 settings-only 行为保留
      assert.equal(svc.setAutoStart(true).enabled, true, 'setAutoStart returns enabled')
      assert.equal(readSetting(), '1', 'settings written without applier (AC2 behavior preserved)')

      // 缝 B：注入成功路径——applier 收到 openAtLogin 且先于 settings 写（两侧一致）
      const calls = []
      svc.setAutoStartApplier((enabled) => {
        calls.push(enabled)
        return { ok: true }
      })
      assert.equal(svc.setAutoStart(false).enabled, false, 'injected setAutoStart returns enabled')
      assert.deepEqual(calls, [false], 'applier invoked with the openAtLogin value')
      assert.equal(readSetting(), '0', 'settings written after successful apply')

      // 缝 C：注入失败路径——结构化 INTERNAL，settings 保持原值（两侧状态一致）
      svc.setAutoStartApplier(() => ({ ok: false, error: 'registry write denied (fixture)' }))
      assert.throws(
        () => svc.setAutoStart(true),
        (err) => err.code === 'INTERNAL' && err.message.includes('login item apply failed'),
        'applier failure folds to structured ServiceError INTERNAL',
      )
      assert.equal(readSetting(), '0', 'settings untouched when OS apply fails')

      // 缝 D：applyAutoStartSetting（启动时按现值应用一次，docs/12 §10）
      svc.setAutoStartApplier((enabled) => {
        calls.push(`apply:${enabled}`)
        return { ok: true }
      })
      assert.equal(svc.applyAutoStartSetting(), false, 'applyAutoStartSetting returns current settings truth')
      assert.deepEqual(calls, [false, 'apply:false'], 'startup application applies the current value once')
    } finally {
      svc.setAutoStartApplier(null) // 清缝，防泄漏到后续用例
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 120. 脱敏全通道扫描（docs/11 T10 在 IPC 面的 AC5 收口：13 条 agents channel
  //      任一返回序列化后无 token_hash / token 明文 / key 全值）。夹具库埋假凭据
  //      （kimi 形态 api_key、消息 token=、事件 credential 键、设备 token_hash），
  //      经真实 handler registry dispatch 全部 13 条 channel，扫描全部 envelope。
  registerCase('ac5-120: redaction sweep across all 13 agents channels — serialized envelopes contain no token_hash, no token plaintext, no key full value (fake fixture secrets)', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const channelsMod = await import(new URL('../src/shared/channels.ts', import.meta.url).href)
    const handlersMod = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    const FAKE_KIMI_KEY = 'ak-fakeac5123456789' // 假 kimi config.toml api_key 形态（T10）
    const FAKE_TOKEN_PLAIN = 'supersecrettoken123'
    const FAKE_TOKEN_HASH = 'f'.repeat(64)
    const FAKE_CRED = 'plaincred99'

    await makeTempHome('devhub-ac5-120-')
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      // 监控关闭：读类 channel（providers/diagnostics）不触发真实探测/监控启动，
      // 保持本用例夹具隔离（AC4 纪律：smoke 不触真机 provider 路径）
      db.prepare("INSERT INTO settings (key, value) VALUES ('agents_monitor_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run()
      db.prepare('INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('kimi', 'Kimi Code', now, now)
      const providerId = Number(db.prepare("SELECT id FROM agent_providers WHERE provider = 'kimi'").get().id)
      const sessionInfo = db
        .prepare(
          'INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(providerId, 'ac5-redact-sess', 'observed', 'running', now, now)
      const sessionId = Number(sessionInfo.lastInsertRowid)
      // 消息含假凭据（真实管线：provider 先经 redactText 再落库 → content_redacted 无明文；
      // 本夹具走同一函数，绝无绕过脱敏的明文投影）
      const redactMod = await import(new URL('../src/main/services/agentControl/redact.ts', import.meta.url).href)
      svc.persistMessage('kimi', 'ac5-redact-sess', {
        role: 'user',
        contentRedacted: redactMod.redactText(`config api_key="${FAKE_KIMI_KEY}" token=${FAKE_TOKEN_PLAIN}`),
        nativeMsgId: 'ac5-msg-1',
        sourceRef: 'fixture:offset=0',
      })
      // 事件 payload 含敏感键（键级脱敏兜底）
      const recordEvent = (await import(new URL('../src/main/services/agentControl/eventPipeline.ts', import.meta.url).href)).recordEvent
      recordEvent({
        eventType: 'session.status_changed',
        providerKey: 'kimi',
        sessionId,
        nativeId: 'ac5-redact-sess',
        payload: { sessionId, credential: FAKE_CRED, token: FAKE_TOKEN_PLAIN },
        summary: 'fixture event',
        fingerprint: 'ac5-redact-fp',
      })
      // 设备行带 token_hash（docs/14 §A.1 #8：绝无 Token 明文/哈希）
      db.prepare(
        'INSERT INTO remote_devices (device_name, platform, token_hash, token_version, status, paired_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('ac5-phone', 'android', FAKE_TOKEN_HASH, 1, 'active', now, now, now)

      // 13 条 agents channel 全清单（与白名单一致，防漏）
      const agentsChannels = channelsMod.IPC_CHANNELS.filter((c) => c.startsWith('agents:'))
      assert.equal(agentsChannels.length, 14, 'exactly 14 agents channels in the whitelist (夜间#1 就地更新 13→14)')
      assert.deepEqual(
        agentsChannels,
        [
          'agents:providers', 'agents:sessions', 'agents:sessionDetail', 'agents:messages', 'agents:events',
          'agents:sessionAction', 'agents:pairingCreate', 'agents:devices', 'agents:deviceRevoke',
          'agents:gatewayStatus', 'agents:gatewayRestart', 'agents:setAutoStart', 'agents:diagnostics',
          'agents:probeProvider',
        ],
        'agents channel set matches docs/14 §A.1 (夜间#1 就地更新 +probeProvider)',
      )

      const registry = handlersMod.createHandlerRegistry({ appVersion: 'ac5-smoke' })
      const requestFor = {
        'agents:providers': {},
        'agents:sessions': {},
        'agents:sessionDetail': { sessionId },
        'agents:messages': { sessionId },
        'agents:events': {},
        'agents:sessionAction': { sessionId, action: 'reply', text: 'fixture reply (never executes: observed)' },
        'agents:pairingCreate': {},
        'agents:devices': {},
        'agents:deviceRevoke': { deviceId: 1 },
        'agents:gatewayStatus': {},
        'agents:gatewayRestart': {},
        'agents:setAutoStart': { enabled: false },
        'agents:diagnostics': {},
      }

      const envelopes = {}
      for (const channel of agentsChannels) {
        const envelope = await handlersMod.dispatchGatewayRequest(registry, { channel, payload: requestFor[channel] })
        envelopes[channel] = envelope
        assert.equal(typeof envelope.ok, 'boolean', `${channel} returns a Result envelope`)
      }

      // 夹具自检：脱敏投影确实生效（contentRedacted / payload 键级打码）
      assert.ok(JSON.stringify(envelopes['agents:messages']).includes('***'), 'messages envelope carries redacted content')
      assert.ok(JSON.stringify(envelopes['agents:events']).includes('***'), 'events envelope carries masked keys')

      // 红线断言：任何 envelope 序列化后绝无假凭据全值 / token_hash / token 字段
      const blob = JSON.stringify(envelopes)
      for (const secret of [FAKE_KIMI_KEY, FAKE_TOKEN_PLAIN, FAKE_CRED, FAKE_TOKEN_HASH]) {
        assert.ok(!blob.includes(secret), `no plaintext secret in any agents envelope: ${secret.slice(0, 12)}…`)
      }
      assert.ok(!blob.includes(FAKE_TOKEN_HASH), 'no token_hash material in any agents envelope')
      assert.ok(!blob.includes('token_hash'), 'no token_hash field in any agents envelope')
      assert.ok(!blob.includes('tokenHash'), 'no tokenHash field in any agents envelope')
      // token 值字段：键级脱敏后的 "token":"***" 是合法投影形态——剥掉 *** 后
      // 不允许残留任何非空 token 值（红线是「无明文值」，不是「无键名」）
      const blobMasked = blob.split('***').join('')
      assert.ok(!/"token"\s*:\s*"[^"]+/.test(blobMasked), 'no non-empty token-value fields in any agents envelope (masked *** excluded)')
      assert.ok(!blobMasked.includes(FAKE_TOKEN_PLAIN), 'no token plaintext anywhere (masked-form excluded double-check)')

      // 结构化拒绝面同样干净：observed sessionAction / pairingCreate（gateway 默认关）
      assert.equal(envelopes['agents:sessionAction'].ok, false, 'observed sessionAction rejected by server-side capability gate')
      assert.ok(['AGENT_CAPABILITY_MISSING', 'COMMAND_NOT_EXECUTABLE'].includes(envelopes['agents:sessionAction'].error.code), `structured rejection code: ${envelopes['agents:sessionAction'].error.code}`)
      assert.equal(envelopes['agents:pairingCreate'].ok, false, 'pairingCreate refused with gateway disabled')
      assert.equal(envelopes['agents:pairingCreate'].error.code, 'GATEWAY_DISABLED', 'GATEWAY_DISABLED structured guidance code')
      assert.equal(envelopes['agents:setAutoStart'].data.enabled, false, 'setAutoStart direct-execution path works (applier absent in smoke)')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // ====================================================================
  // AC6 — Remote Gateway（docs/14 Part B/C + docs/15 §2-§5）。
  // 系统 Node 下真实回环 HTTP（node:http）+ 自搓 RFC6455 掩码帧 WS 客户端
  // （不复用服务端代码）全链路验证；gateway 模块 electron-free、.ts 直载
  // （Node strip-only 可加载——AC6 修复项：gateway 内禁用 TS 参数属性）。
  // 既有 120 用例零改动（append-only，约束 #27）。
  // ====================================================================
  const { randomBytes } = await import('node:crypto')
  const { request: httpRequest } = await import('node:http')

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 轮询直到 fn 返回真（Gateway 启停收敛 / 指令终态 / WS 断连等待）。 */
  async function pollUntil(fn, timeoutMs = 3000, stepMs = 40, label = 'condition') {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await fn()) return true
      await sleep(stepMs)
    }
    throw new Error(`pollUntil timeout: ${label}`)
  }

  /** 防重放两头（受保护请求必带，docs/14 §B.4）：unix 秒 + 128-bit 随机 nonce。 */
  function replayHeaders() {
    return {
      'X-DevHub-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-DevHub-Nonce': randomBytes(16).toString('hex'),
    }
  }

  /** 真实回环 HTTP 客户端；返回 {status, headers, raw, json}。 */
  function gwRequest(port, method, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const headers = { ...(opts.headers ?? {}) }
      const body = opts.body === undefined ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
      if (body !== null) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = Buffer.byteLength(body)
      }
      if (opts.token !== undefined) headers['Authorization'] = `Bearer ${opts.token}`
      // AC6 修复就地更新：agent:false = 每请求新建连接、用完即弃。Node 19+ 的
      // globalAgent 默认 keepAlive，而本夹具每个用例都重建监听并在 teardown
      // closeAllConnections()——池中被 RST 的同端口死 socket 会被下一用例复用，
      // 造成首请求 ECONNRESET（时序性偶发）。
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          let json
          try { json = JSON.parse(raw) } catch { json = undefined }
          resolve({ status: res.statusCode, headers: res.headers, raw, json })
        })
      })
      req.on('error', reject)
      if (body !== null) req.write(body)
      req.end()
    })
  }

  // ---- 自搓 WS 测试客户端（RFC6455 子集；掩码由测试侧实现，零复用服务端代码） ----

  /** 客户端 → 服务端帧（必带掩码，RFC6455 §5.1）。 */
  function encodeClientFrame(opcode, payload, { mask = true } = {}) {
    const maskKey = randomBytes(4)
    let header
    const len = payload.length
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0x00) | len])
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = (mask ? 0x80 : 0x00) | 126
      header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = (mask ? 0x80 : 0x00) | 127
      header.writeBigUInt64BE(BigInt(len), 2)
    }
    if (!mask) return Buffer.concat([header, payload])
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= maskKey[i % 4]
    return Buffer.concat([header, maskKey, masked])
  }

  /** 服务端 → 客户端帧解析（服务端不掩码；返回一帧 + 余量）。 */
  function parseServerFrame(buf) {
    if (buf.length < 2) return { frame: null, rest: buf }
    const opcode = buf[0] & 0x0f
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < offset + 2) return { frame: null, rest: buf }
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return { frame: null, rest: buf }
      len = Number(buf.readBigUInt64BE(offset))
      offset += 8
    }
    if (buf.length < offset + len) return { frame: null, rest: buf }
    return { frame: { opcode, payload: Buffer.from(buf.subarray(offset, offset + len)) }, rest: buf.subarray(offset + len) }
  }

  class WsTestClient {
    constructor(socket, head, response) {
      this.socket = socket
      this.response = response
      this.buffer = Buffer.alloc(0)
      this.queue = []
      this.waiters = []
      this.closed = false
      this.closeCode = null
      this.suppressPong = false // 心跳用例置 true：故意不回 pong → 服务端超时关连
      socket.on('data', (chunk) => this._feed(chunk))
      socket.on('close', () => { this.closed = true; this._wake() })
      socket.on('error', () => { this.closed = true; this._wake() })
      // AC6 修复就地更新：101 响应与 hello 首帧可能合并进同一 TCP 段（upgrade 的
      // head 参数）——构造时立即解析，否则要等服务端下一个数据帧（默认心跳 30s）
      // 才会触发 parse，短超时用例会误报 hello timeout。
      if (head !== undefined && head.length > 0) this._feed(Buffer.from(head))
    }

    /** 打开 WS。升级被拒时 resolve({upgraded:false,status,json})（结构化 HTTP 错误）。 */
    static open(port, token, opts = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ws open timeout (port ${port}, path ${opts.path ?? '/v1/events'})`)), 5000)
        const headers = {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': String(opts.version ?? 13),
        }
        if (opts.omitKey !== true) headers['Sec-WebSocket-Key'] = opts.wsKey ?? 'dGhlIHNhbXBsZSBub25jZQ=='
        if (token !== undefined) headers.Authorization = `Bearer ${token}`
        const req = httpRequest({ host: '127.0.0.1', port, path: opts.path ?? '/v1/events', headers })
        req.on('upgrade', (res, socket, head) => {
          clearTimeout(timer)
          resolve({ upgraded: true, client: new WsTestClient(socket, head, res) })
        })
        req.on('response', (res) => {
          let raw = ''
          res.setEncoding('utf8')
          // AC6 修复就地更新：服务端拒绝升级后立即销毁 socket（结构化错误响应 +
          // destroy，docs/14 §B.2），对端 RST 的预期重置在此吞掉（测试侧防护，
          // 不带崩进程；服务端侧 error handler 由 ws.ts rejectUpgrade 负责）。
          res.socket?.on('error', () => {})
          res.on('data', (c) => { raw += c })
          res.on('end', () => {
            clearTimeout(timer)
            let json
            try { json = JSON.parse(raw) } catch { json = undefined }
            resolve({ upgraded: false, status: res.statusCode, raw, json })
          })
        })
        req.on('error', (err) => { clearTimeout(timer); reject(err) })
        req.end()
      })
    }

    _feed(chunk) {
      this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
      while (true) {
        const parsed = parseServerFrame(this.buffer)
        if (parsed.frame === null) break
        this.buffer = parsed.rest
        const { opcode, payload } = parsed.frame
        if (opcode === 0x8) {
          this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null
          this.queue.push({ opcode, closeCode: this.closeCode })
          this.closed = true
          try { this.socket.destroy() } catch { /* 已关 */ }
          this._wake()
          continue
        }
        if (opcode === 0x9) {
          this.queue.push({ opcode, payload })
          if (!this.suppressPong) {
            try { this.socket.write(encodeClientFrame(0xA, payload)) } catch { /* 已关 */ }
          }
          this._wake()
          continue
        }
        if (opcode === 0xA) {
          this.queue.push({ opcode, payload })
          this._wake()
          continue
        }
        if (opcode === 0x1 || opcode === 0x2) {
          const text = payload.toString('utf8')
          let json
          try { json = JSON.parse(text) } catch { json = undefined }
          this.queue.push({ opcode, text, json })
          this._wake()
          continue
        }
      }
    }

    _wake() {
      for (const waiter of [...this.waiters]) {
        const hit = this.queue.find(waiter.predicate)
        if (hit !== undefined) {
          this.queue.splice(this.queue.indexOf(hit), 1)
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          waiter.resolve(hit)
        }
      }
    }

    async waitFrame(predicate, timeoutMs = 3000, label = 'frame') {
      const hit = this.queue.find(predicate)
      if (hit !== undefined) {
        this.queue.splice(this.queue.indexOf(hit), 1)
        return hit
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = this.waiters.findIndex((w) => w.timer === timer)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(new Error(`ws waitFrame timeout: ${label}; queued=${JSON.stringify(this.queue.map((f) => f.json?.type ?? f.opcode))}`))
        }, timeoutMs)
        this.waiters.push({
          predicate,
          timer,
          resolve: (frame) => { clearTimeout(timer); resolve(frame) },
        })
      })
    }

    async waitClose(timeoutMs = 3000) {
      const end = Date.now() + timeoutMs
      while (!this.closed && Date.now() < end) await sleep(20)
      if (!this.closed) throw new Error('ws waitClose timeout (connection still open)')
      return this.closeCode
    }

    /** 断言一段时间内无新帧到达（负向断言用）。 */
    async assertQuiet(ms, label = 'quiet window') {
      const before = this.queue.length
      await sleep(ms)
      if (this.queue.length !== before) {
        throw new Error(`ws expected no frames during ${label}, got ${JSON.stringify(this.queue.slice(before).map((f) => f.json?.type ?? f.opcode))}`)
      }
      assert.equal(this.closed, false, `connection must stay open during ${label}`)
    }

    sendJson(obj) {
      this.socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')))
    }

    sendRaw(opcode, payload, opts = {}) {
      this.socket.write(encodeClientFrame(opcode, Buffer.from(payload ?? []), opts))
    }

    end() {
      try { this.socket.end() } catch { /* 已关 */ }
    }
  }

  // ---- gateway 用例夹具（隔离 home + 防御性清场 + 模块装载） ----

  async function gwCaseSetup(prefix) {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const gw = await import(new URL('../src/main/services/agentControl/gateway/httpServer.ts', import.meta.url).href)
    const auth = await import(new URL('../src/main/services/agentControl/gateway/auth.ts', import.meta.url).href)
    const pairing = await import(new URL('../src/main/services/agentControl/gateway/pairing.ts', import.meta.url).href)
    const eventPipeline = await import(new URL('../src/main/services/agentControl/eventPipeline.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const settingsSvc = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    await makeTempHome(prefix)
    // 防御性清场：上一用例若未收尾，这里停监听 + 清防重放/限流/配对内存态
    await gw.resetGatewayInMemoryState()
    // 夹具 hermetic：读类端点（agents/diagnostics）关闭真实探测（ac2-87 先例）
    dbModule.getDatabase()
      .prepare("INSERT INTO settings (key, value) VALUES ('agents_monitor_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'")
      .run()
    return { dbModule, gw, auth, pairing, eventPipeline, svc, settingsSvc }
  }

  async function gwCaseTeardown(m) {
    const providerRegistry = await import(new URL('../src/main/services/agentControl/providerRegistry.ts', import.meta.url).href)
    providerRegistry.clearProviderOverrides()
    m.svc.stopAllAgentControlRuntime()
    await m.gw.resetGatewayInMemoryState()
    m.dbModule.closeDatabase()
  }

  /** 启用并启动 Gateway（真实监听 127.0.0.1；options 可注入短心跳——测试性最小改动缝）。 */
  async function startGatewayEnabled(m, options = {}) {
    m.settingsSvc.setSetting('gateway_enabled', '1')
    const status = await m.gw.startGateway(options)
    return status
  }

  /** REST pairing/create（真实回环 HTTP；201 断言内置）。 */
  async function pairingCreateHttp(port) {
    const r = await gwRequest(port, 'POST', '/v1/pairing/create', { body: { deviceName: 'ac6-phone' }, headers: replayHeaders() })
    assert.equal(r.status, 201, `pairing/create -> 201, got ${r.status} ${r.raw}`)
    return r.json
  }

  /** REST pairing/claim（真实链路配对；200 断言内置）。 */
  async function pairViaHttp(port, deviceName = 'ac6-phone') {
    const created = await pairingCreateHttp(port)
    const r = await gwRequest(port, 'POST', '/v1/pairing/claim', {
      body: { pairingId: created.pairingId, code: created.code, deviceName, platform: 'android' },
    })
    assert.equal(r.status, 200, `pairing/claim -> 200, got ${r.status} ${r.raw}`)
    return { deviceId: r.json.deviceId, token: r.json.token, tokenVersion: r.json.tokenVersion, code: created.code, pairingId: created.pairingId, expiresAt: created.expiresAt }
  }

  /** 夹具 provider 行（agent_providers；返回 id）。 */
  function fixtureProviderRow(db, provider = 'kimi') {
    const now = Math.floor(Date.now() / 1000)
    const info = db
      .prepare('INSERT INTO agent_providers (provider, display_name, installed, health, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)')
      .run(provider, `${provider} fixture`, 'ok', now, now)
    return Number(info.lastInsertRowid)
  }

  /**
   * 夹具会话行（agent_sessions）。AC6 修复就地更新：docs/13 §4.2 的 agent_sessions
   * 无 capabilities 列——CapabilitySet 判定根在 provider 级 agent_providers.capabilities_json
   * （docs/12 §5，resolveCommandGate 读 provider 行）。需要控制能力场景时对
   * agent_providers.capabilities_json 做 UPDATE（见 ac6-128/129）。
   */
  function fixtureSessionRow(db, providerId, nativeId, mode) {
    const now = Math.floor(Date.now() / 1000)
    const info = db
      .prepare('INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(providerId, nativeId, mode, 'running', `ac6 fixture ${nativeId}`, now, now)
    return Number(info.lastInsertRowid)
  }

  // 121. 生命周期：gateway_enabled=0 零监听（ECONNREFUSED）/ IPC settings:set 接线
  //      即时启停 / 端口顺延 8746→8747 / 全占 → GATEWAY_PORT_IN_USE（docs/14 Part B 监听行 + Part C）
  registerCase('ac6-121: gateway lifecycle — disabled zero-listen (ECONNREFUSED), settings:set live re-bind, port fallback 8746→8747, all-occupied GATEWAY_PORT_IN_USE', async () => {
    const { createServer } = await import('node:http')
    const { connect } = await import('node:net')
    const m = await gwCaseSetup('devhub-ac6-121-')
    const db = m.dbModule.getDatabase()
    try {
      // (a) 默认 gateway_enabled=0 → 零监听：直连 8746 ECONNREFUSED；startGateway 幂等零监听
      const refused = await new Promise((resolve) => {
        const sk = connect(8746, '127.0.0.1')
        sk.once('error', (e) => resolve(e.code))
        sk.once('connect', () => { sk.destroy(); resolve('CONNECTED') })
      })
      assert.equal(refused, 'ECONNREFUSED', 'disabled gateway must not listen on 8746')
      const st0 = await m.gw.startGateway()
      assert.equal(st0.running, false, 'startGateway with enabled=0 keeps zero-listen')
      assert.equal(db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action='gateway_started'").get().c, 0, 'no gateway_started audit while disabled')

      // (b) IPC settings:set 接线（handlers.ts → applyGatewaySettings）→ running 真值
      const handlersMod = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
      const registry = handlersMod.createHandlerRegistry({ appVersion: 'ac6-smoke' })
      const envOn = await handlersMod.dispatchGatewayRequest(registry, { channel: 'settings:set', payload: { key: 'gateway_enabled', value: '1' } })
      assert.equal(envOn.ok, true, `settings:set gateway_enabled=1 ok: ${JSON.stringify(envOn)}`)
      await pollUntil(async () => m.svc.getGatewayStatus().running === true, 4000, 50, 'gateway up via settings:set')
      const health = await gwRequest(8746, 'GET', '/v1/health')
      assert.equal(health.status, 200, `health on default port 8746 -> 200, got ${health.status}`)
      const envOff = await handlersMod.dispatchGatewayRequest(registry, { channel: 'settings:set', payload: { key: 'gateway_enabled', value: '0' } })
      assert.equal(envOff.ok, true, 'settings:set gateway_enabled=0 ok')
      await pollUntil(async () => m.svc.getGatewayStatus().running === false, 4000, 50, 'gateway down via settings:set')
      const refusedAgain = await new Promise((resolve) => {
        const sk = connect(8746, '127.0.0.1')
        sk.once('error', (e) => resolve(e.code))
        sk.once('connect', () => { sk.destroy(); resolve('CONNECTED') })
      })
      assert.equal(refusedAgain, 'ECONNREFUSED', 'disabled again → zero listen')

      // (c) 端口顺延：测试侧占 8746 → Gateway 落 8747（settings gateway_port=8746 不变）
      const occupier = createServer(() => {})
      await new Promise((resolve, reject) => { occupier.once('error', reject); occupier.listen(8746, '127.0.0.1', resolve) })
      m.settingsSvc.setSetting('gateway_enabled', '1')
      const st = await m.gw.startGateway()
      assert.equal(st.running, true, 'gateway running with occupied preferred port')
      assert.equal(st.actualPort, 8747, 'port fallback: 8746 occupied → actualPort 8747')
      const healthFallback = await gwRequest(8747, 'GET', '/v1/health')
      assert.equal(healthFallback.status, 200, 'health on fallback port 8747')
      const statusView = m.svc.getGatewayStatus()
      assert.equal(statusView.port, 8746, 'status.port keeps configured value')
      assert.equal(statusView.actualPort, 8747, 'status.actualPort carries the fallback truth')
      await m.gw.stopGateway('ac6-121 between (c) and (d)')

      // (d) 8746-8755 全占 → startGateway 拒绝 GATEWAY_PORT_IN_USE；applyGatewaySettings 折叠为 lastError
      const occupiers = [occupier]
      for (const port of [8747, 8748, 8749, 8750, 8751, 8752, 8753, 8754, 8755]) {
        const s = createServer(() => {})
        await new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', resolve) })
        occupiers.push(s)
      }
      await assert.rejects(
        () => m.gw.startGateway(),
        (err) => err.code === 'GATEWAY_PORT_IN_USE',
        'all 10 ports occupied → structured GATEWAY_PORT_IN_USE',
      )
      const stFailed = await m.gw.applyGatewaySettings()
      assert.equal(stFailed.running, false, 'applyGatewaySettings swallows to status, never throws')
      assert.ok(stFailed.lastError.includes('no available port'), `lastError structured: ${stFailed.lastError}`)
      assert.ok(db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action='gateway_start_failed'").get().c >= 1, 'gateway_start_failed audited')
      for (const s of occupiers) {
        await new Promise((resolve) => s.close(resolve))
      }
      m.settingsSvc.setSetting('gateway_enabled', '0')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 122. 配对全流程（真实回环 HTTP）：create 201（Crockford 8 位 / TTL 300s）→
  //      claim 200（Token 明文仅此一次）→ 码即失效；同时 1 活跃码（新签废旧码）；
  //      审计落库且零码明文/零 Token（docs/14 §B.1/B.3，docs/15 §2）
  registerCase('ac6-122: pairing REST full flow — create 201 Crockford/TTL300, claim 200 token-once, code dead after claim, one-active-code supersede, audit without code/token plaintext', async () => {
    const m = await gwCaseSetup('devhub-ac6-122-')
    const db = m.dbModule.getDatabase()
    try {
      const status = await startGatewayEnabled(m)
      assert.equal(status.actualPort, 8746, 'gateway on default port')

      // create：形状断言（8 位 Crockford、pairingId、TTL 300s）
      const first = await pairingCreateHttp(8746)
      assert.match(first.pairingId, /^pair-/, 'pairingId shape')
      assert.match(first.code, /^[0-9A-HJ-NP-TV-Z]{8}$/, `code is 8-char Crockford Base32 (no I/L/O/U): ${first.code}`)
      const nowSec = Math.floor(Date.now() / 1000)
      assert.ok(Math.abs(first.expiresAt - (nowSec + 300)) <= 5, `expiresAt ≈ now+300s, got ${first.expiresAt} vs ${nowSec}`)
      // 生成器确定性 + 符号表纪律（L3 纯函数）
      assert.equal(m.pairing.generatePairingCode('ac6-fixed-seed'), m.pairing.generatePairingCode('ac6-fixed-seed'), 'generatePairingCode deterministic for a fixed seed')
      assert.match(m.pairing.generatePairingCode(randomBytes(16).toString('hex')), /^[0-9A-HJ-NP-TV-Z]{8}$/, 'generator output within Crockford alphabet')

      // 新签发即废旧码（同时至多 1 活跃码）：旧码 claim → 401
      const second = await pairingCreateHttp(8746)
      const rOld = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { pairingId: first.pairingId, code: first.code, deviceName: 'ac6-old-phone', platform: 'android' },
      })
      assert.equal(rOld.status, 401, 'superseded code claim refused')
      assert.equal(rOld.json.error.code, 'AUTH_INVALID_TOKEN', 'superseded claim folds to AUTH_INVALID_TOKEN (no reason leakage)')

      // 新码 claim → 200 {deviceId, token, tokenVersion, gatewayName}；Token 256-bit base64url
      const rClaim = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { pairingId: second.pairingId, code: second.code, deviceName: 'ac6-phone', platform: 'android' },
      })
      assert.equal(rClaim.status, 200, `claim -> 200, got ${rClaim.status} ${rClaim.raw}`)
      assert.equal(typeof rClaim.json.deviceId, 'number', 'deviceId number')
      assert.match(rClaim.json.token, /^[A-Za-z0-9_-]{40,}$/, 'token is base64url 256-bit')
      assert.equal(rClaim.json.tokenVersion, 1, 'tokenVersion starts at 1')
      assert.equal(rClaim.json.gatewayName, 'devhub-gateway', 'gatewayName per docs/14 §B.1')

      // 码即失效（一次性）：同码重放 claim → 401
      const rReplay = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { pairingId: second.pairingId, code: second.code, deviceName: 'ac6-phone', platform: 'android' },
      })
      assert.equal(rReplay.status, 401, 'consumed code is one-time')
      assert.equal(rReplay.json.error.code, 'AUTH_INVALID_TOKEN', 'consumed claim code AUTH_INVALID_TOKEN')

      // claim 成功的 Token 可用（真链路）：Bearer + 防重放两头 → /v1/devices 200
      const rDevices = await gwRequest(8746, 'GET', '/v1/devices', { token: rClaim.json.token, headers: replayHeaders() })
      assert.equal(rDevices.status, 200, 'claimed token authenticates immediately')
      assert.equal(rDevices.json.devices.length, 1, 'device row visible')
      assert.equal(rDevices.json.devices[0].status, 'active', 'paired device active')

      // 审计红线：pairing 全链路落审计且 detail 零码明文/零 Token 明文/零哈希
      const audits = db.prepare("SELECT category, action, detail_json FROM security_audit_logs WHERE category='pairing' ORDER BY id").all()
      const actions = audits.map((a) => a.action)
      assert.ok(actions.includes('pairing_code_created'), `pairing_code_created audited: ${actions}`)
      assert.ok(actions.includes('pairing_claimed'), 'pairing_claimed audited')
      const auditBlob = JSON.stringify(audits)
      assert.ok(!auditBlob.includes(first.code) && !auditBlob.includes(second.code), 'no pairing code plaintext in audit')
      assert.ok(!auditBlob.includes(rClaim.json.token), 'no token plaintext in audit')
      assert.ok(!auditBlob.includes('token_hash') && !auditBlob.includes('tokenHash'), 'no token hash material in audit')
      // 库里也绝无码/Token 明文（token_hash 是哈希列，合法）
      const deviceRows = db.prepare('SELECT * FROM remote_devices').all()
      assert.ok(!JSON.stringify(deviceRows).includes(rClaim.json.token), 'no token plaintext in remote_devices')
      assert.match(deviceRows[0].token_hash, /^[0-9a-f]{64}$/, 'remote_devices stores SHA-256 hex only')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 123. 配对防御语义：TTL 注入（createPairingCode 可选 ttlSec——测试性最小改动缝）
  //      过期码 401 + 审计 expired；单码连续失败 5 次 → 码作废 + 审计 too_many_failures，
  //      正确码也不再可用（docs/15 §2）
  registerCase('ac6-123: pairing defense — injected TTL expiry refuses claim with audit, 5 consecutive failures void the code (correct code also dead after void)', async () => {
    const m = await gwCaseSetup('devhub-ac6-123-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)

      // 过期路径：ttlSec=0 注入（生产恒 300）
      const expired = m.pairing.createPairingCode('ac6-phone', 0)
      await sleep(1100)
      const rExpired = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { pairingId: expired.pairingId, code: expired.code, deviceName: 'ac6-phone', platform: 'android' },
      })
      assert.equal(rExpired.status, 401, 'expired code claim refused')
      assert.equal(rExpired.json.error.code, 'AUTH_INVALID_TOKEN', 'expired claim folds to AUTH_INVALID_TOKEN')
      const expiredAudit = db.prepare("SELECT detail_json FROM security_audit_logs WHERE action='pairing_code_expired' ORDER BY id DESC LIMIT 1").get()
      assert.ok(expiredAudit !== undefined, 'pairing_code_expired audited')
      assert.ok(expiredAudit.detail_json.includes('expired'), `reason=expired in audit: ${expiredAudit.detail_json}`)

      // 失败 5 次作废：全新码，5 次错码 claim → 401；第 5 次后码作废。
      // claim 同源限流（5 次/5min）是「记录即判满」语义——第 5 次尝试即 429，
      // 因此逐次复位限流窗口（测试侧内存态）让 5 次失败真实触达码校验。
      const { resetRateLimitState } = await import(new URL('../src/main/services/agentControl/gateway/auth.ts', import.meta.url).href)
      const fresh = m.pairing.createPairingCode('ac6-phone')
      for (let i = 1; i <= 5; i += 1) {
        resetRateLimitState()
        const r = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
          body: { pairingId: fresh.pairingId, code: 'ZZZZZZZZ', deviceName: 'ac6-phone', platform: 'android' },
        })
        assert.equal(r.status, 401, `wrong-code claim #${i} refused`)
        assert.equal(r.json.error.code, 'AUTH_INVALID_TOKEN', `wrong-code claim #${i} code`)
      }
      const voidAudit = db.prepare("SELECT detail_json FROM security_audit_logs WHERE action='pairing_code_expired' ORDER BY id DESC LIMIT 1").get()
      assert.ok(voidAudit.detail_json.includes('too_many_failures'), `5 failures void the code: ${voidAudit.detail_json}`)

      // claim 同源限流 5 次/5min 已满（尝试即计数）→ 复位窗口（测试侧）后用正确码验证「作废后不可再用」
      resetRateLimitState()
      const rCorrect = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { pairingId: fresh.pairingId, code: fresh.code, deviceName: 'ac6-phone', platform: 'android' },
      })
      assert.equal(rCorrect.status, 401, 'even the correct code is dead after too_many_failures void')
      // 库中设备数保持 0（全部 claim 均未成功）
      assert.equal(db.prepare('SELECT COUNT(*) c FROM remote_devices').get().c, 0, 'no device rows from failed claims')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 124. 设备凭据安全（docs/15 §3/§4）：错 Token 401；撤销他设备 403 DEVICE_FORBIDDEN；
  //      自撤销 200 → Token 即拒 401 DEVICE_REVOKED；桌面撤销 → 活跃 WS 服务端立即断
  registerCase('ac6-124: token security — wrong token 401, revoke-other 403 DEVICE_FORBIDDEN, self-revoke 200 then DEVICE_REVOKED, desktop revoke closes active WS server-side', async () => {
    const m = await gwCaseSetup('devhub-ac6-124-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const devA = await pairViaHttp(8746, 'ac6-phone-a')
      const devB = await pairViaHttp(8746, 'ac6-phone-b')

      // 错 Token → 401 AUTH_INVALID_TOKEN
      const rWrong = await gwRequest(8746, 'GET', '/v1/devices', { token: 'definitely-wrong-token-value', headers: replayHeaders() })
      assert.equal(rWrong.status, 401, 'wrong token refused')
      assert.equal(rWrong.json.error.code, 'AUTH_INVALID_TOKEN', 'AUTH_INVALID_TOKEN for unknown token')

      // 撤销他设备 → 403 DEVICE_FORBIDDEN（越权仅桌面 IPC agents:deviceRevoke）
      const rOther = await gwRequest(8746, 'DELETE', `/v1/devices/${devB.deviceId}`, { token: devA.token, headers: replayHeaders() })
      assert.equal(rOther.status, 403, 'revoke-other refused')
      assert.equal(rOther.json.error.code, 'DEVICE_FORBIDDEN', 'DEVICE_FORBIDDEN code')

      // 设备 B 保持 WS 活跃（撤销后要被服务端立即断开）
      // AC6 修复就地更新：WsTestClient.open resolve {upgraded, client}——连接操作
      // 必须取 .client（open 返回包本身没有 waitFrame/waitClose 方法）
      const openedB = await WsTestClient.open(8746, devB.token)
      assert.equal(openedB.upgraded, true, 'device B ws connected')
      const wsB = openedB.client
      const helloB = await wsB.waitFrame((f) => f.json?.type === 'hello', 2000, 'hello B')
      assert.equal(helloB.json.device, devB.deviceId, 'hello carries device id')

      // 设备列表：两台、零 Token 材料
      const rList = await gwRequest(8746, 'GET', '/v1/devices', { token: devA.token, headers: replayHeaders() })
      assert.equal(rList.status, 200, 'devices list ok')
      assert.equal(rList.json.devices.length, 2, 'two devices')
      const listBlob = JSON.stringify(rList.json)
      assert.ok(!listBlob.includes(devA.token) && !listBlob.includes('token_hash') && !listBlob.includes('tokenHash'), 'no token material in devices projection')

      // 自撤销 → 200 {revoked:true}；随后同 Token → 401 DEVICE_REVOKED（撤销即拒）
      const rSelf = await gwRequest(8746, 'DELETE', `/v1/devices/${devA.deviceId}`, { token: devA.token, headers: replayHeaders() })
      assert.equal(rSelf.status, 200, 'self-revoke ok')
      assert.deepEqual(rSelf.json, { revoked: true }, 'self-revoke body')
      const rAfter = await gwRequest(8746, 'GET', '/v1/devices', { token: devA.token, headers: replayHeaders() })
      assert.equal(rAfter.status, 401, 'revoked token refused')
      assert.equal(rAfter.json.error.code, 'DEVICE_REVOKED', 'DEVICE_REVOKED code')

      // 桌面撤销 B（L3 两段式 confirmed）→ 活跃 WS 服务端立即关闭
      m.svc.revokeDevice(devB.deviceId, true, 'ipc')
      const closeCode = await wsB.waitClose(2500)
      assert.equal(closeCode, 1000, `server closes revoked device ws with 1000, got ${closeCode}`)
      // B 的 REST 面同样即拒
      const rB = await gwRequest(8746, 'GET', '/v1/devices', { token: devB.token, headers: replayHeaders() })
      assert.equal(rB.status, 401, 'device B token dead after desktop revoke')
      assert.equal(rB.json.error.code, 'DEVICE_REVOKED', 'DEVICE_REVOKED for B')

      // 审计：device_revoked ×2（rest-self + ipc），detail 零凭据
      const revokes = db.prepare("SELECT detail_json FROM security_audit_logs WHERE action='device_revoked' ORDER BY id").all()
      assert.equal(revokes.length, 2, 'both revokes audited')
      const revokeBlob = JSON.stringify(revokes)
      assert.ok(!revokeBlob.includes(devA.token) && !revokeBlob.includes(devB.token), 'no token plaintext in revoke audits')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 125. 鉴权矩阵扫描：10 个受保护端点 × {无 Token, 错 Token} → 全部 401 AUTH_INVALID_TOKEN；
  //      豁免面 = /v1/health（无鉴权）与 /v1/pairing/*（码鉴权，非 Bearer）（docs/14 §B.1 鉴权列）
  registerCase('ac6-125: auth matrix scan — all 10 protected endpoints refuse missing/wrong bearer with 401 AUTH_INVALID_TOKEN; health and pairing exempt', async () => {
    const m = await gwCaseSetup('devhub-ac6-125-')
    try {
      await startGatewayEnabled(m)
      const { resetRateLimitState } = await import(new URL('../src/main/services/agentControl/gateway/auth.ts', import.meta.url).href)
      const endpoints = [
        ['GET', '/v1/diagnostics'],
        ['GET', '/v1/devices'],
        ['DELETE', '/v1/devices/1'],
        ['GET', '/v1/agents'],
        ['GET', '/v1/sessions'],
        ['GET', '/v1/sessions/1'],
        ['GET', '/v1/sessions/1/messages'],
        ['POST', '/v1/sessions/1/reply'],
        ['POST', '/v1/sessions/1/actions'],
        ['POST', '/v1/events/1/ack'],
      ]
      for (const [method, path] of endpoints) {
        for (const token of [undefined, 'wrong-token-ac6']) {
          resetRateLimitState() // 隔离鉴权失败限流（本用例只断言 401 码，限流行为归 ac6-127）
          const opts = { headers: replayHeaders() }
          if (token !== undefined) opts.token = token
          if (method === 'POST') opts.body = {}
          const r = await gwRequest(8746, method, path, opts)
          assert.equal(r.status, 401, `${method} ${path} ${token === undefined ? 'without' : 'with wrong'} token → 401, got ${r.status} ${r.raw}`)
          assert.equal(r.json.error.code, 'AUTH_INVALID_TOKEN', `${method} ${path} error code`)
        }
      }
      // 豁免面：health 无任何鉴权 200（形状 docs/14 §B.1：{ok,name,version,uptimeSec}）
      const health = await gwRequest(8746, 'GET', '/v1/health')
      assert.equal(health.status, 200, 'health exempt from bearer auth')
      assert.equal(health.json.ok, true, 'health ok flag')
      assert.equal(health.json.name, 'devhub', 'health name')
      assert.equal(typeof health.json.version, 'string', 'health version string')
      assert.ok(Number.isFinite(health.json.uptimeSec) && health.json.uptimeSec >= 0, 'health uptimeSec finite')
      // pairing/create 无 Bearer 可用（仅回环 + 防重放两头；码鉴权面豁免 Bearer）
      const created = await pairingCreateHttp(8746)
      assert.match(created.code, /^[0-9A-HJ-NP-TV-Z]{8}$/, 'pairing/create works without bearer (loopback + replay headers only)')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 126. 防重放（docs/14 §B.4，docs/15 §4）：缺头/窗口外（±400s）/重复 nonce →
  //      401 AUTH_REPLAYED + 审计 replay_rejected；±300s 边界通过；nonce LRU 10min
  //      过期后可复用（auth.checkReplayHeaders 的 nowMs 注入缝——注入 clock）
  registerCase('ac6-126: anti-replay — missing headers and ±400s timestamps refused 401 AUTH_REPLAYED with audit, ±300s boundary passes, duplicate nonce refused, LRU expiry allows reuse via injected clock', async () => {
    const m = await gwCaseSetup('devhub-ac6-126-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'ac6-phone')
      const { resetRateLimitState } = await import(new URL('../src/main/services/agentControl/gateway/auth.ts', import.meta.url).href)

      const getDevices = (headers) => gwRequest(8746, 'GET', '/v1/devices', { token: dev.token, headers })

      // 缺 timestamp / 缺 nonce → 401 AUTH_REPLAYED（受保护合同：无凭据按重放嫌疑拒绝）
      resetRateLimitState()
      const rNoTs = await getDevices({ 'X-DevHub-Nonce': randomBytes(16).toString('hex') })
      assert.equal(rNoTs.status, 401, 'missing X-DevHub-Timestamp refused')
      assert.equal(rNoTs.json.error.code, 'AUTH_REPLAYED', 'missing ts code')
      resetRateLimitState()
      const rNoNonce = await getDevices({ 'X-DevHub-Timestamp': String(Math.floor(Date.now() / 1000)) })
      assert.equal(rNoNonce.status, 401, 'missing X-DevHub-Nonce refused')
      assert.equal(rNoNonce.json.error.code, 'AUTH_REPLAYED', 'missing nonce code')

      // 窗口外（now±400s）→ 401；窗口边界（now±300s）→ 200
      const nowSec = Math.floor(Date.now() / 1000)
      for (const delta of [400, -400]) {
        resetRateLimitState()
        const r = await getDevices({ 'X-DevHub-Timestamp': String(nowSec + delta), 'X-DevHub-Nonce': randomBytes(16).toString('hex') })
        assert.equal(r.status, 401, `timestamp now${delta > 0 ? '+' : ''}${delta}s outside window refused`)
        assert.equal(r.json.error.code, 'AUTH_REPLAYED', `window code for delta ${delta}`)
      }
      for (const delta of [300, -300]) {
        resetRateLimitState()
        const r = await getDevices({ 'X-DevHub-Timestamp': String(nowSec + delta), 'X-DevHub-Nonce': randomBytes(16).toString('hex') })
        assert.equal(r.status, 200, `timestamp now${delta > 0 ? '+' : ''}${delta}s within ±300s boundary passes, got ${r.status}`)
      }

      // 重复 nonce：首个 200，重放 401
      resetRateLimitState()
      const nonce = randomBytes(16).toString('hex')
      const headers1 = { 'X-DevHub-Timestamp': String(nowSec), 'X-DevHub-Nonce': nonce }
      const r1 = await getDevices(headers1)
      assert.equal(r1.status, 200, 'first use of nonce accepted')
      resetRateLimitState()
      const r2 = await getDevices(headers1)
      assert.equal(r2.status, 401, 'duplicate nonce refused')
      assert.equal(r2.json.error.code, 'AUTH_REPLAYED', 'duplicate nonce code')

      // 审计：本用例的拒绝全部落 replay_rejected。AC6 修复就地更新：精确口径 ——
      // 本用例产生 5 次重放拒绝（缺 ts / 缺 nonce / +400 / -400 / 重复 nonce），
      // ±300s 边界与 nonce 首用都是 200 不审计；注入 clock 段的 assert.throws 是
      // 单元级直调（不经 httpServer 审计路径），不落库
      const replayAudits = db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action='replay_rejected'").get().c
      assert.ok(replayAudits >= 5, `replay rejections audited (got ${replayAudits})`)

      // 注入 clock（unit 级，nowMs 参数为既有注入缝）：
      // - 窗口边界 ±300s 通过 / ±301s 拒绝
      // - nonce LRU：599s 后同 nonce 仍拒绝；601s 后（LRU 10min 过期）配新 timestamp 可复用
      const t0 = 1_700_000_000_000
      const t0Sec = Math.floor(t0 / 1000)
      m.auth.checkReplayHeaders({ timestamp: String(t0Sec + 300), nonce: 'ac6-edge-plus300-nonce-0001' }, t0)
      assert.throws(
        () => m.auth.checkReplayHeaders({ timestamp: String(t0Sec + 301), nonce: 'ac6-edge-plus301-nonce-0001' }, t0),
        (err) => err.code === 'AUTH_REPLAYED',
        '+301s outside window',
      )
      m.auth.checkReplayHeaders({ timestamp: String(t0Sec - 300), nonce: 'ac6-edge-minus300-nonce-0001' }, t0)
      assert.throws(
        () => m.auth.checkReplayHeaders({ timestamp: String(t0Sec - 301), nonce: 'ac6-edge-minus301-nonce-0001' }, t0),
        (err) => err.code === 'AUTH_REPLAYED',
        '-301s outside window',
      )
      const lruNonce = 'ac6-lru-reuse-nonce-0000001'
      m.auth.checkReplayHeaders({ timestamp: String(t0Sec), nonce: lruNonce }, t0)
      assert.throws(
        () => m.auth.checkReplayHeaders({ timestamp: String(t0Sec + 599), nonce: lruNonce }, t0 + 599_000),
        (err) => err.code === 'AUTH_REPLAYED',
        'same nonce within 10min LRU still refused',
      )
      m.auth.checkReplayHeaders({ timestamp: String(t0Sec + 601), nonce: lruNonce }, t0 + 601_000)
      // 未抛 = LRU 过期后可复用（10min TTL，注入 clock 推进 601s）
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 127. 限流三联（docs/14 §B.4）：鉴权失败同源 5 次/60s → 429 + Retry-After: 60；
  //      常规请求 120 次/min/设备 → 429；配对 claim 同源 5 次/5min → 429
  registerCase('ac6-127: rate limits — auth failure 5/60s then 429+Retry-After 60, device requests 120/min then 429, pairing claim 5/5min then 429', async () => {
    const m = await gwCaseSetup('devhub-ac6-127-')
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'ac6-phone')
      const { resetRateLimitState } = await import(new URL('../src/main/services/agentControl/gateway/auth.ts', import.meta.url).href)

      // 鉴权失败限流：5 次 401（第 5 次失败即触发限流），第 6 次起 429 + Retry-After: 60
      const statuses = []
      for (let i = 1; i <= 6; i += 1) {
        const r = await gwRequest(8746, 'GET', '/v1/devices', { token: `wrong-token-${i}`, headers: replayHeaders() })
        statuses.push(r.status)
        if (i === 6) {
          assert.equal(r.json.error.code, 'AUTH_RATE_LIMITED', 'auth-failure limiter code')
          assert.equal(r.headers['retry-after'], '60', `Retry-After: 60 header, got ${r.headers['retry-after']}`)
        }
      }
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429], `auth failure sequence: ${statuses}`)

      // 常规请求限流：120/min/设备 —— 120 次 200，第 121 次 429
      //（/v1/health 无设备身份不消耗设备限流；/v1/devices 精确计数）
      resetRateLimitState()
      let okCount = 0
      let limited = null
      for (let i = 1; i <= 121; i += 1) {
        const r = await gwRequest(8746, 'GET', '/v1/devices', { token: dev.token, headers: replayHeaders() })
        if (r.status === 200) okCount += 1
        else { limited = r; break }
      }
      assert.equal(okCount, 120, `120 requests/min allowed, got ${okCount}`)
      assert.equal(limited.status, 429, '121st device request in window limited')
      assert.equal(limited.json.error.code, 'AUTH_RATE_LIMITED', 'device limiter code')
      assert.equal(limited.headers['retry-after'], '60', 'device limiter Retry-After')

      // 配对 claim 限流：同源 5 次/5min（「记录即判满」语义：第 5 次尝试即 429）
      resetRateLimitState()
      const fresh = m.pairing.createPairingCode('ac6-phone')
      const claimStatuses = []
      for (let i = 1; i <= 6; i += 1) {
        const r = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
          body: { pairingId: fresh.pairingId, code: 'ZZZZZZZZ', deviceName: 'ac6-phone', platform: 'android' },
        })
        claimStatuses.push(r.status)
        if (i === 5) {
          assert.equal(r.json.error.code, 'AUTH_RATE_LIMITED', 'claim limiter code')
          const retryAfter = Number(r.headers['retry-after'])
          assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1 && retryAfter <= 300, `claim limiter Retry-After ≤ 300: ${r.headers['retry-after']}`)
        }
      }
      assert.deepEqual(claimStatuses, [401, 401, 401, 401, 429, 429], `claim limiter sequence (4 real attempts then limit): ${claimStatuses}`)
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 128. 指令幂等/过期（docs/14 §B.5，docs/15 §5/W9）：同 key 重试返回原结果不重复执行；
  //      同 key 异 payload → 409 COMMAND_KEY_CONFLICT；过期（DB 侧注入时钟推进 expires_at）
  //      → 409 COMMAND_EXPIRED + command.result(expired) 事件恰好一条；再触发仍 409 不重复发事件
  registerCase('ac6-128: command idempotency and expiry — same key replays original result without re-execution, key/payload conflict 409, expired command 409 with exactly one command.result event', async () => {
    const m = await gwCaseSetup('devhub-ac6-128-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'ac6-phone')
      const providerId = fixtureProviderRow(db, 'kimi')
      // AC6 修复就地更新：能力判定根在 provider 级 agent_providers.capabilities_json
      // （docs/12 §5），fresh + reply/pause/resume 全授予让指令通过能力门到达执行
      db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE id = ?').run(
        JSON.stringify({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: Math.floor(Date.now() / 1000), evidence: 'fixture override' }),
        providerId,
      )
      const sessionId = fixtureSessionRow(db, providerId, 'ac6-idem-sess', 'managed')

      // 夹具 provider 注入（providerRegistry 既有夹具缝）：sendReply 计数，执行即终态
      const providerRegistry = await import(new URL('../src/main/services/agentControl/providerRegistry.ts', import.meta.url).href)
      const calls = { reply: 0 }
      providerRegistry.setProviderOverride('kimi', {
        id: 'kimi',
        probeHealth: async () => ({ status: 'ok' }),
        listSessions: async () => [],
        readMessages: async () => ({ items: [] }),
        getCapabilities: async () => ({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: Math.floor(Date.now() / 1000), evidence: 'fixture override' }),
        sendReply: async () => { calls.reply += 1; return { ok: true, status: 'executed' } },
        pause: async () => ({ ok: false, status: 'unsupported', detail: 'fixture' }),
        resume: async () => ({ ok: false, status: 'unsupported', detail: 'fixture' }),
        startMonitor: () => ({ providerId: 'kimi', stop: async () => {} }),
        dispose: async () => {},
      })

      const postReply = (body) => gwRequest(8746, 'POST', `/v1/sessions/${sessionId}/reply`, { token: dev.token, headers: replayHeaders(), body })

      // 首发：202 accepted → 异步执行到 executed
      const r1 = await postReply({ text: 'hello from device', idempotencyKey: 'ac6-k1' })
      assert.equal(r1.status, 202, `first submit -> 202, got ${r1.status} ${r1.raw}`)
      assert.equal(r1.json.status, 'accepted', 'first submit accepted')
      const commandId1 = r1.json.commandId
      await pollUntil(async () => db.prepare('SELECT status FROM remote_commands WHERE command_id = ?').get(commandId1)?.status === 'executed', 3000, 30, 'command executed')
      assert.equal(calls.reply, 1, 'provider executed exactly once')

      // 同 key 同 payload 重试 → 202 + 原 commandId + 原结果，不重复执行
      const r1retry = await postReply({ text: 'hello from device', idempotencyKey: 'ac6-k1' })
      assert.equal(r1retry.status, 202, 'same-key retry 202')
      assert.equal(r1retry.json.commandId, commandId1, 'same-key retry returns original commandId')
      assert.equal(r1retry.json.status, 'executed', 'same-key retry returns original result')
      assert.equal(calls.reply, 1, 'no duplicate execution on retry')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM remote_commands WHERE idempotency_key = ?').get('ac6-k1').c, 1, 'still exactly one row')

      // 同 key 异 payload → 409 COMMAND_KEY_CONFLICT
      const rConflict = await postReply({ text: 'a different text', idempotencyKey: 'ac6-k1' })
      assert.equal(rConflict.status, 409, 'same key different payload → 409')
      assert.equal(rConflict.json.error.code, 'COMMAND_KEY_CONFLICT', 'COMMAND_KEY_CONFLICT code')
      assert.equal(calls.reply, 1, 'conflicting retry does not execute')

      // 过期：预置 accepted 行 + DB 侧时钟推进（expires_at 过去 10s）→ 再触发 409 COMMAND_EXPIRED
      const now = Math.floor(Date.now() / 1000)
      db.prepare(
        "INSERT INTO remote_commands (command_id, idempotency_key, device_id, session_id, action, payload_json, status, expires_at, created_at) VALUES ('cmd-ac6-expired-1', 'ac6-k3', ?, ?, 'reply', '{\"text\":\"hello from device\"}', 'accepted', ?, ?)",
      ).run(dev.deviceId, sessionId, now - 10, now - 310)
      const rExpired = await postReply({ text: 'hello from device', idempotencyKey: 'ac6-k3' })
      assert.equal(rExpired.status, 409, `expired retry -> 409, got ${rExpired.status} ${rExpired.raw}`)
      assert.equal(rExpired.json.error.code, 'COMMAND_EXPIRED', 'COMMAND_EXPIRED code')
      const expiredRow = db.prepare("SELECT status, error_code FROM remote_commands WHERE idempotency_key = 'ac6-k3'").get()
      assert.equal(expiredRow.status, 'expired', 'row marked expired')
      assert.equal(expiredRow.error_code, 'COMMAND_EXPIRED', 'row error_code')
      const expiredEvents = db.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'command.result' AND payload_json LIKE '%cmd-ac6-expired-1%'").all()
      assert.equal(expiredEvents.length, 1, 'exactly one command.result(expired) event')
      assert.ok(expiredEvents[0].payload_json.includes('"expired"'), 'event carries expired status')

      // 再触发（已 expired 行）→ 仍 409，绝不重复标记/重复发事件（AC6 修复项验证）
      const rExpiredAgain = await postReply({ text: 'hello from device', idempotencyKey: 'ac6-k3' })
      assert.equal(rExpiredAgain.status, 409, 'second expired retry still 409')
      assert.equal(rExpiredAgain.json.error.code, 'COMMAND_EXPIRED', 'second expired retry code')
      const expiredEventsAgain = db.prepare("SELECT COUNT(*) c FROM agent_events WHERE event_type = 'command.result' AND payload_json LIKE '%cmd-ac6-expired-1%'").get().c
      assert.equal(expiredEventsAgain, 1, 'no duplicate expired event on retrigger')

      // 未过期新 key 正常第二指令（幂等链不相互污染）
      const r2 = await postReply({ text: 'second message', idempotencyKey: 'ac6-k2' })
      assert.equal(r2.status, 202, 'fresh key accepted')
      assert.notEqual(r2.json.commandId, commandId1, 'fresh key gets new commandId')
      assert.equal(calls.reply, 2, 'second command executes')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 129. 授权矩阵（docs/15 §5 + docs/12 §5 能力门，服务端复检）：observed 全禁
  //      COMMAND_NOT_EXECUTABLE；attached 无 pause；能力过期/未授予 AGENT_CAPABILITY_MISSING；
  //      未知会话 NOT_FOUND（REST 面）
  registerCase('ac6-129: authorization matrix over REST — observed all-forbidden, attached pause forbidden (COMMAND_NOT_EXECUTABLE), stale/empty capabilities (AGENT_CAPABILITY_MISSING), unknown session 404', async () => {
    const m = await gwCaseSetup('devhub-ac6-129-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'ac6-phone')
      const providerId = fixtureProviderRow(db, 'kimi')
      const now = Math.floor(Date.now() / 1000)
      // AC6 修复就地更新：能力判定根在 provider 级 agent_providers.capabilities_json
      // （docs/12 §5 resolveCommandGate 读 provider 行；agent_sessions 无 capabilities
      // 列，docs/13 §4.2）。mode 门（observed/attached）先于能力门，因此分阶段
      // UPDATE provider caps：先 fresh 全授予（拒绝码来自 mode 门），再 stale /
      // empty（拒绝码来自能力门）。
      const setProviderCaps = (caps) => db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE id = ?').run(JSON.stringify(caps), providerId)
      const observedId = fixtureSessionRow(db, providerId, 'ac6-obs', 'observed')
      const attachedId = fixtureSessionRow(db, providerId, 'ac6-att', 'attached')
      const staleId = fixtureSessionRow(db, providerId, 'ac6-stale', 'managed')
      const emptyId = fixtureSessionRow(db, providerId, 'ac6-empty', 'managed')

      const post = (path, body) => gwRequest(8746, 'POST', path, { token: dev.token, headers: replayHeaders(), body })

      // 阶段 1：caps fresh + 全授予 → 拒绝码由 session_mode 门决定（docs/15 §5 矩阵）
      setProviderCaps({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: now, evidence: 'fixture: fresh all granted' })
      // observed：reply / pause 全禁（无输入通道）
      const rObsReply = await post(`/v1/sessions/${observedId}/reply`, { text: 'should not pass' })
      assert.equal(rObsReply.status, 403, 'observed reply forbidden')
      assert.equal(rObsReply.json.error.code, 'COMMAND_NOT_EXECUTABLE', 'observed reply code')
      const rObsPause = await post(`/v1/sessions/${observedId}/actions`, { action: 'pause' })
      assert.equal(rObsPause.status, 403, 'observed pause forbidden')
      assert.equal(rObsPause.json.error.code, 'COMMAND_NOT_EXECUTABLE', 'observed pause code')

      // attached：pause 不在矩阵（attached 仅 reply）
      const rAttPause = await post(`/v1/sessions/${attachedId}/actions`, { action: 'pause' })
      assert.equal(rAttPause.status, 403, 'attached pause forbidden')
      assert.equal(rAttPause.json.error.code, 'COMMAND_NOT_EXECUTABLE', 'attached pause code')

      // 阶段 2：能力门——验证过期（verifiedAt 距今 >300s）→ AGENT_CAPABILITY_MISSING
      setProviderCaps({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: now - 400, evidence: 'stale verification' })
      const rStale = await post(`/v1/sessions/${staleId}/reply`, { text: 'stale caps' })
      assert.equal(rStale.status, 403, 'stale capability forbidden')
      assert.equal(rStale.json.error.code, 'AGENT_CAPABILITY_MISSING', 'stale caps code')

      // 阶段 3：能力门——验证新鲜但未授予 resume → AGENT_CAPABILITY_MISSING
      setProviderCaps({ mode: 'managed', granted: [], verifiedAt: now, evidence: 'fresh but none granted' })
      const rEmpty = await post(`/v1/sessions/${emptyId}/actions`, { action: 'resume' })
      assert.equal(rEmpty.status, 403, 'ungranted capability forbidden')
      assert.equal(rEmpty.json.error.code, 'AGENT_CAPABILITY_MISSING', 'ungranted caps code')

      // 未知会话：404 NOT_FOUND（reply 与 messages 双路）
      const rUnknown = await post('/v1/sessions/999999/reply', { text: 'nope' })
      assert.equal(rUnknown.status, 404, 'unknown session 404')
      assert.equal(rUnknown.json.error.code, 'NOT_FOUND', 'unknown session code')
      const rUnknownMsgs = await gwRequest(8746, 'GET', '/v1/sessions/999999/messages', { token: dev.token, headers: replayHeaders() })
      assert.equal(rUnknownMsgs.status, 404, 'unknown session messages 404')

      // 拒绝的指令绝不落 remote_commands 流水（门先于落库）
      assert.equal(db.prepare('SELECT COUNT(*) c FROM remote_commands').get().c, 0, 'no command rows from gated rejections')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 130. WS 协议核心（docs/14 §B.2）：握手 Sec-WebSocket-Accept 固定向量；
  //      hello 首帧 {sequence,device,heartbeatSec}；事件实时推送（seq/eventId/payload）+
  //      deliveries delivered；sync(after) 未 ack 事件按序补发；ack 批量推进只前进；
  //      REST /v1/events/{id}/ack 等效。自搓掩码帧客户端全链路
  registerCase('ac6-130: ws protocol core — RFC6455 accept fixed vector, hello first frame, live event push marks delivered, sync replays unacked in order, batch ack forward-only, REST ack equivalence', async () => {
    const m = await gwCaseSetup('devhub-ac6-130-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'ac6-phone')
      const providerId = fixtureProviderRow(db, 'kimi')
      // AC6 修复就地更新：会话仅作事件 sessionId 投影用（读路径不做能力门）；
      // capabilities 判定根在 provider 级（docs/13 §4.2 无会话级列）
      const sessionId = fixtureSessionRow(db, providerId, 'ac6-ws-sess', 'observed')

      // 固定向量握手：RFC6455 §4.2.2 示例 key → 精确 accept
      const opened = await WsTestClient.open(8746, dev.token, { wsKey: 'dGhlIHNhbXBsZSBub25jZQ==' })
      assert.equal(opened.upgraded, true, 'upgrade succeeded')
      const ws = opened.client
      assert.equal(ws.response.headers['sec-websocket-accept'], 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'Sec-WebSocket-Accept matches the RFC 6455 example vector exactly')
      assert.equal(ws.response.headers.upgrade, 'websocket', 'upgrade header echoed')

      // hello 首帧：{type,sequence,device,heartbeatSec}
      const hello = await ws.waitFrame((f) => f.json?.type === 'hello', 2000, 'hello')
      assert.equal(hello.json.sequence, m.eventPipeline.currentGlobalSequence(), 'hello.sequence = current global sequence')
      assert.equal(hello.json.device, dev.deviceId, 'hello.device = deviceId')
      assert.equal(hello.json.heartbeatSec, 30, 'hello.heartbeatSec default 30')

      // 实时推送：L3 recordEvent（COMMIT 后 sink → WS）→ event 帧 + deliveries delivered
      const rec1 = m.eventPipeline.recordEvent({
        eventType: 'session.status_changed',
        providerKey: 'kimi',
        sessionId,
        nativeId: 'ac6-ws-sess',
        payload: { sessionId, from: 'running', to: 'waiting_input' },
        summary: 'ac6 pushed event #1',
        fingerprint: 'ac6-ws-fp-1',
      })
      assert.equal(rec1.recorded, true, 'event recorded')
      const frame1 = await ws.waitFrame((f) => f.json?.type === 'event' && f.json.seq === rec1.sequence, 2500, 'pushed event 1')
      assert.equal(frame1.json.eventId, rec1.eventId, 'event frame eventId')
      assert.equal(frame1.json.eventType, 'session.status_changed', 'event frame eventType')
      assert.equal(frame1.json.sessionId, sessionId, 'event frame sessionId')
      assert.equal(frame1.json.summary, 'ac6 pushed event #1', 'event frame summary')
      assert.deepEqual(frame1.json.payload, { sessionId, from: 'running', to: 'waiting_input' }, 'event frame payload (redacted projection)')
      assert.equal(typeof frame1.json.createdAt, 'number', 'event frame createdAt')
      const deliveredRow = db.prepare('SELECT status FROM event_deliveries WHERE event_id = ? AND device_id = ?').get(rec1.sequence, dev.deviceId)
      assert.equal(deliveredRow.status, 'delivered', 'WS push marks delivery delivered')

      // 再录两条（推送），然后 sync(after=0)：未 ack 事件按序补发（含已 delivered 未 ack 的）
      const rec2 = m.eventPipeline.recordEvent({ eventType: 'message.appended', providerKey: 'kimi', sessionId, nativeId: 'ac6-ws-sess', payload: { sessionId, role: 'user', preview: 'second' }, fingerprint: 'ac6-ws-fp-2' })
      const rec3 = m.eventPipeline.recordEvent({ eventType: 'session.started', providerKey: 'kimi', sessionId, nativeId: 'ac6-ws-sess', payload: { sessionId }, fingerprint: 'ac6-ws-fp-3' })
      await ws.waitFrame((f) => f.json?.type === 'event' && f.json.seq === rec3.sequence, 2500, 'pushed event 3')
      ws.queue.length = 0 // 丢弃推送残留帧，sync 补发集从零开始断言
      ws.sendJson({ type: 'sync', after: 0 })
      await pollUntil(async () => ws.queue.filter((f) => f.json?.type === 'event').length >= 3, 2500, 40, 'sync replays the three unacked events')
      const syncSeqs = ws.queue.filter((f) => f.json?.type === 'event').map((f) => f.json.seq)
      const expectedSync = [rec1.sequence, rec2.sequence, rec3.sequence].sort((a, b) => a - b)
      assert.deepEqual(syncSeqs, expectedSync, `sync replays exactly the three unacked events in ascending order: ${JSON.stringify(syncSeqs)}`)
      ws.queue.length = 0

      // 批量 ack：三 seq 一次确认 → 设备行 acked + 聚合只前进
      ws.sendJson({ type: 'ack', seqs: [rec1.sequence, rec2.sequence, rec3.sequence] })
      await pollUntil(async () => {
        const rows = db.prepare('SELECT status FROM event_deliveries WHERE event_id = ? AND device_id = ?')
        return rows.get(rec1.sequence, dev.deviceId).status === 'acked'
          && rows.get(rec2.sequence, dev.deviceId).status === 'acked'
          && rows.get(rec3.sequence, dev.deviceId).status === 'acked'
      }, 2500, 40, 'batch ack advances device rows')
      const agg = db.prepare('SELECT delivery_state FROM agent_events WHERE id = ?').get(rec1.sequence)
      assert.equal(agg.delivery_state, 'acked', 'aggregate delivery_state acked')
      // acked 后 sync 不再补发（未确认不删，ack 即移出补发集）
      ws.sendJson({ type: 'sync', after: 0 })
      await ws.assertQuiet(500, 'post-ack sync')
      // 只前进：acked 之后 markEventDelivered 拒绝回退
      const regressed = m.eventPipeline.markEventDelivered(rec1.sequence, dev.deviceId)
      assert.equal(regressed.updated, false, 'delivered-after-acked is a forward-only no-op')
      assert.equal(regressed.state, 'acked', 'state stays acked')

      // REST ack 等效：新事件 → 推送 → REST ack 200 → acked；未知 seq → 404
      const rec4 = m.eventPipeline.recordEvent({ eventType: 'session.finished', providerKey: 'kimi', sessionId, nativeId: 'ac6-ws-sess', payload: { sessionId, finalStatus: 'completed' }, fingerprint: 'ac6-ws-fp-4' })
      await ws.waitFrame((f) => f.json?.type === 'event' && f.json.seq === rec4.sequence, 2500, 'pushed event 4')
      const rAck = await gwRequest(8746, 'POST', `/v1/events/${rec4.sequence}/ack`, { token: dev.token, headers: replayHeaders(), body: {} })
      assert.equal(rAck.status, 200, `REST ack -> 200, got ${rAck.status} ${rAck.raw}`)
      assert.deepEqual(rAck.json, { acked: true }, 'REST ack body')
      assert.equal(db.prepare('SELECT status FROM event_deliveries WHERE event_id = ? AND device_id = ?').get(rec4.sequence, dev.deviceId).status, 'acked', 'REST ack marks acked')
      const rAck404 = await gwRequest(8746, 'POST', '/v1/events/999999/ack', { token: dev.token, headers: replayHeaders(), body: {} })
      assert.equal(rAck404.status, 404, 'ack of unknown sequence 404')
      assert.equal(rAck404.json.error.code, 'NOT_FOUND', 'ack unknown code NOT_FOUND')
      ws.end()
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 131. WS 心跳（docs/14 §B.2 心跳行）：注入短心跳（heartbeatIntervalMs/pongTimeoutMs
  //      为 startGateway 可注入选项——测试性最小改动缝）；不回 pong → 服务端超时关连
  //      （close 1000）；正常回 pong 保活
  registerCase('ac6-131: ws heartbeat — injected short heartbeat, suppressed pong gets the server to close with 1000, pong-answering connection stays alive', async () => {
    const m = await gwCaseSetup('devhub-ac6-131-')
    try {
      await startGatewayEnabled(m, { heartbeatIntervalMs: 300, pongTimeoutMs: 150 })
      const dev = await pairViaHttp(8746, 'ac6-phone')

      // 不回 pong → 服务端在 ping 后的 pongTimeout 窗口内关闭（close 1000）
      const openedA = await WsTestClient.open(8746, dev.token)
      const wsA = openedA.client
      wsA.suppressPong = true
      await wsA.waitFrame((f) => f.json?.type === 'hello', 2000, 'hello A')
      const closeCode = await wsA.waitClose(3000)
      assert.equal(closeCode, 1000, `heartbeat timeout closes with 1000, got ${closeCode}`)

      // 正常回 pong（客户端默认自动回）→ 连接保持；客户端主动 ping → 服务端 pong 回显
      const openedB = await WsTestClient.open(8746, dev.token)
      const wsB = openedB.client
      await wsB.waitFrame((f) => f.json?.type === 'hello', 2000, 'hello B')
      await sleep(700) // 覆盖 ≥2 个心跳节拍
      wsB.sendRaw(0x9, 'ac6-ping') // 客户端 ping（掩码）
      const pong = await wsB.waitFrame((f) => f.opcode === 0xA, 2000, 'server pong echo')
      assert.equal(pong.payload.toString('utf8'), 'ac6-ping', 'server pongs back the ping payload')
      assert.equal(wsB.closed, false, 'pong-answering connection stays open across heartbeat ticks')
      wsB.end()
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 132. WS 升级拒绝 + 帧级协议边界（docs/14 §B.2 连接鉴权行 + RFC6455 纪律）：
  //      错路径 400 NOT_FOUND / 版本 400 / 缺 key 400 / 无 Token 401 / 撤销 Token 401
  //      DEVICE_REVOKED；未掩码帧 1002 / 非 JSON 1002 / JSON 数组 1002 / sync.after 非法 1002 /
  //      binary 1003；未知帧类型静默忽略（v1 预留面）
  registerCase('ac6-132: ws upgrade rejections and frame-level edges — 400/401 structured refusals, unmasked/bad-json/bad-sync frames closed 1002, binary 1003, unknown frame types ignored', async () => {
    const m = await gwCaseSetup('devhub-ac6-132-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'ac6-phone')

      // 升级拒绝
      const badPath = await WsTestClient.open(8746, dev.token, { path: '/v1/not-events' })
      assert.equal(badPath.upgraded, false, 'unknown upgrade path refused')
      assert.equal(badPath.status, 400, 'bad path → 400')
      assert.equal(badPath.json.error.code, 'NOT_FOUND', 'bad path code NOT_FOUND')
      const badVersion = await WsTestClient.open(8746, dev.token, { version: 12 })
      assert.equal(badVersion.upgraded, false, 'version != 13 refused')
      assert.equal(badVersion.status, 400, 'bad version → 400')
      assert.equal(badVersion.json.error.code, 'BAD_PAYLOAD', 'bad version code')
      const noKey = await WsTestClient.open(8746, dev.token, { omitKey: true })
      assert.equal(noKey.upgraded, false, 'missing Sec-WebSocket-Key refused')
      assert.equal(noKey.json.error.code, 'BAD_PAYLOAD', 'missing key code')
      const noAuth = await WsTestClient.open(8746, undefined)
      assert.equal(noAuth.upgraded, false, 'missing bearer refused at upgrade')
      assert.equal(noAuth.status, 401, 'no token → 401')
      assert.equal(noAuth.json.error.code, 'AUTH_INVALID_TOKEN', 'no token code')
      const wrongAuth = await WsTestClient.open(8746, 'wrong-token-ac6')
      assert.equal(wrongAuth.status, 401, 'wrong token → 401')
      const revokedDev = await pairViaHttp(8746, 'ac6-phone-revoked')
      m.svc.revokeDevice(revokedDev.deviceId, true, 'ipc')
      const revoked = await WsTestClient.open(8746, revokedDev.token)
      assert.equal(revoked.upgraded, false, 'revoked token refused at upgrade')
      assert.equal(revoked.status, 401, 'revoked → 401')
      assert.equal(revoked.json.error.code, 'DEVICE_REVOKED', 'revoked upgrade code DEVICE_REVOKED')

      // 帧级边界（每段新连接）
      const connect = async () => {
        const o = await WsTestClient.open(8746, dev.token)
        assert.equal(o.upgraded, true, 'edge sub-test connection established')
        await o.client.waitFrame((f) => f.json?.type === 'hello', 2000, 'edge hello')
        return o.client
      }
      const c1 = await connect()
      c1.sendRaw(0x1, '{"type":"sync","after":0}', { mask: false }) // 未掩码客户端帧
      assert.equal(await c1.waitClose(2000), 1002, 'unmasked client frame closed 1002')
      const c2 = await connect()
      c2.sendRaw(0x1, 'definitely not json')
      assert.equal(await c2.waitClose(2000), 1002, 'non-JSON text frame closed 1002')
      const c3 = await connect()
      c3.sendJson([1, 2, 3])
      assert.equal(await c3.waitClose(2000), 1002, 'JSON array frame closed 1002')
      const c4 = await connect()
      c4.sendJson({ type: 'sync', after: -1 })
      assert.equal(await c4.waitClose(2000), 1002, 'sync.after negative closed 1002')
      const c5 = await connect()
      c5.sendRaw(0x2, 'binary-payload')
      assert.equal(await c5.waitClose(2000), 1003, 'binary frame closed 1003')
      // 未知帧类型（含预留 token_rotation 回 ack）静默忽略，连接保持
      const c6 = await connect()
      c6.sendJson({ type: 'token_rotation', newToken: 'fixture-ignored' })
      c6.sendJson({ type: 'something-unknown', x: 1 })
      await c6.assertQuiet(400, 'unknown frame types ignored')
      c6.sendRaw(0x9, 'still-alive')
      const pong = await c6.waitFrame((f) => f.opcode === 0xA, 2000, 'alive pong')
      assert.equal(pong.payload.toString('utf8'), 'still-alive', 'connection alive after unknown frames')
      c6.end()
      assert.equal(db.prepare('SELECT COUNT(*) c FROM remote_devices WHERE status = \'active\'').get().c, 1, 'only the live device remains active')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 133. 断线期间事件 → 重连 sync 补发 → ack（T14 的 Gateway 真实链路版）：
  //      离线事件 deliveries pending；连上后 sync(after=0) 按序补发 → delivered → ack → acked；
  //      在线事件实时推送；eventsSince 补发集随 ack 收敛为空
  registerCase('ac6-133: offline event replay over the real gateway link — pending while offline, sync replays after reconnect, ack settles deliveries, eventsSince drains to empty', async () => {
    const m = await gwCaseSetup('devhub-ac6-133-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'ac6-phone')
      const providerId = fixtureProviderRow(db, 'kimi')
      // AC6 修复就地更新：会话仅作事件投影，无会话级 capabilities 列（docs/13 §4.2）
      const sessionId = fixtureSessionRow(db, providerId, 'ac6-off-sess', 'observed')

      // 离线事件（无任何 WS 连接）
      const e1 = m.eventPipeline.recordEvent({ eventType: 'session.waiting_input', providerKey: 'kimi', sessionId, nativeId: 'ac6-off-sess', payload: { sessionId, status: 'waiting_input' }, summary: 'offline waiting input', fingerprint: 'ac6-off-fp-1' })
      const offlineRow = db.prepare('SELECT status FROM event_deliveries WHERE event_id = ? AND device_id = ?').get(e1.sequence, dev.deviceId)
      assert.equal(offlineRow.status, 'pending', 'offline event stays pending')
      assert.equal(m.eventPipeline.eventsSince(0, dev.deviceId).events.length, 1, 'replay set has the offline event')

      // 重连（真实 WS）→ hello → sync 补发
      const opened = await WsTestClient.open(8746, dev.token)
      const ws = opened.client
      const hello = await ws.waitFrame((f) => f.json?.type === 'hello', 2000, 'hello')
      assert.equal(hello.json.sequence, e1.sequence, 'hello.sequence reflects the offline event as current max')
      ws.sendJson({ type: 'sync', after: 0 })
      const replayed = await ws.waitFrame((f) => f.json?.type === 'event' && f.json.seq === e1.sequence, 2500, 'replayed offline event')
      assert.equal(replayed.json.eventId, e1.eventId, 'replayed eventId matches')
      assert.equal(replayed.json.payload.status, 'waiting_input', 'replayed payload intact')
      await pollUntil(async () => db.prepare('SELECT status FROM event_deliveries WHERE event_id = ? AND device_id = ?').get(e1.sequence, dev.deviceId).status === 'delivered', 2000, 30, 'replay marks delivered')

      // ack → acked（只前进）
      ws.sendJson({ type: 'ack', seqs: [e1.sequence] })
      await pollUntil(async () => db.prepare('SELECT status FROM event_deliveries WHERE event_id = ? AND device_id = ?').get(e1.sequence, dev.deviceId).status === 'acked', 2000, 30, 'ack settles offline replay')

      // 在线事件实时推送 + REST ack
      const e2 = m.eventPipeline.recordEvent({ eventType: 'message.appended', providerKey: 'kimi', sessionId, nativeId: 'ac6-off-sess', payload: { sessionId, role: 'assistant', preview: 'online echo' }, fingerprint: 'ac6-off-fp-2' })
      await ws.waitFrame((f) => f.json?.type === 'event' && f.json.seq === e2.sequence, 2500, 'online push')
      const rAck = await gwRequest(8746, 'POST', `/v1/events/${e2.sequence}/ack`, { token: dev.token, headers: replayHeaders(), body: {} })
      assert.equal(rAck.status, 200, 'REST ack for online event')
      // 补发集收敛：两事件均 acked → eventsSince 为空
      const drained = m.eventPipeline.eventsSince(0, dev.deviceId)
      assert.equal(drained.events.length, 0, `eventsSince drains to empty after acks, got ${drained.events.length}`)
      ws.end()
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 134. 回环限定边界（docs/14 §B.1 + docs/15 §9）：isLoopbackRemoteAddress 判定表；
  //      静态断言 httpServer 源零 X-Forwarded-For 信任；伪造 XFF 不改变判定（回环源仍放行，
  //      决策只看 socket.remoteAddress）；pairing/create 无防重放头 401 + 审计（AC6 修复项）。
  //      测试边界（如实记录）：监听绑定 127.0.0.1，非回环源在传输层即不可达，进程内无法
  //      产生真实非回环连接——「非回环 → 403 GATEWAY_LOCAL_ONLY」以判定函数单测 + 绑定语义 +
  //      代码审查代替。
  registerCase('ac6-134: loopback-only boundary — loopback predicate table, no X-Forwarded-For trust (static + forged header ignored), create without replay headers refused+audited; true non-loopback source unreachable by bind semantics (recorded boundary)', async () => {
    const { readFileSync } = await import('node:fs')
    const m = await gwCaseSetup('devhub-ac6-134-')
    const db = m.dbModule.getDatabase()
    try {
      // 判定函数单测（GATEWAY_LOCAL_ONLY 的唯一决策点）
      assert.equal(m.gw.isLoopbackRemoteAddress('127.0.0.1'), true, 'IPv4 loopback')
      assert.equal(m.gw.isLoopbackRemoteAddress('::1'), true, 'IPv6 loopback')
      assert.equal(m.gw.isLoopbackRemoteAddress('::ffff:127.0.0.1'), true, 'IPv4-mapped loopback')
      assert.equal(m.gw.isLoopbackRemoteAddress('192.168.1.5'), false, 'private LAN address is not loopback')
      assert.equal(m.gw.isLoopbackRemoteAddress('::ffff:192.168.1.5'), false, 'mapped LAN address is not loopback')
      assert.equal(m.gw.isLoopbackRemoteAddress(undefined), false, 'undefined source refused')
      assert.equal(m.gw.isLoopbackRemoteAddress(''), false, 'empty source refused')

      // 静态断言：路由面零 forwarded 头信任（回环判定只来自 socket.remoteAddress）
      const httpServerSource = readFileSync(new URL('../src/main/services/agentControl/gateway/httpServer.ts', import.meta.url), 'utf8')
      assert.ok(!/forwarded/i.test(httpServerSource), 'httpServer.ts never reads X-Forwarded-For (no header-based source spoofing)')

      await startGatewayEnabled(m)

      // 伪造 XFF 不改变判定：回环 socket + 伪造外网 XFF → 仍 201（决策只看 socket）
      const rXff = await gwRequest(8746, 'POST', '/v1/pairing/create', {
        body: { deviceName: 'ac6-xff' },
        headers: { 'X-Forwarded-For': '203.0.113.9', ...replayHeaders() },
      })
      assert.equal(rXff.status, 201, `forged X-Forwarded-For from loopback is ignored (still 201), got ${rXff.status} ${rXff.raw}`)

      // 无防重放头的 pairing/create → 401 AUTH_REPLAYED + 审计（AC6 修复项：replay_rejected 落审计）
      const rNoHeaders = await gwRequest(8746, 'POST', '/v1/pairing/create', { body: { deviceName: 'ac6-noreplay' } })
      assert.equal(rNoHeaders.status, 401, 'pairing/create without replay headers refused')
      assert.equal(rNoHeaders.json.error.code, 'AUTH_REPLAYED', 'protected contract even on loopback')
      const audit = db.prepare("SELECT detail_json FROM security_audit_logs WHERE action='replay_rejected' ORDER BY id DESC LIMIT 1").get()
      assert.ok(audit !== undefined, 'replay rejection audited')
      assert.ok(audit.detail_json.includes('pairing_create'), `audit scopes pairing_create: ${audit.detail_json}`)
      assert.ok(!audit.detail_json.toLowerCase().includes('nonce'), 'audit detail never carries the nonce/header values')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 135. REST 读投影真实链路（docs/14 §B.1 读类端点）：agents 受限投影 / sessions 过滤
  //      （providerId/status/limit）/ sessionDetail / messages 脱敏且零 sourceRef /
  //      diagnostics 结构（docs/15 §6 红线：远程只有脱敏投影）
  registerCase('ac6-135: rest read projections — /v1/agents restricted shape, sessions server-side filters, session detail, messages redacted without sourceRef, diagnostics structure', async () => {
    const m = await gwCaseSetup('devhub-ac6-135-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'ac6-phone')
      const providerId = fixtureProviderRow(db, 'kimi')
      const now = Math.floor(Date.now() / 1000)
      db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE id = ?').run(
        JSON.stringify({ mode: 'observed', granted: [], verifiedAt: now, evidence: 'read-only source' }),
        providerId,
      )
      const s1 = fixtureSessionRow(db, providerId, 'ac6-read-1', 'observed')
      const s2 = fixtureSessionRow(db, providerId, 'ac6-read-2', 'managed')
      db.prepare("UPDATE agent_sessions SET status = 'waiting_input' WHERE id = ?").run(s2)

      const redactMod = await import(new URL('../src/main/services/agentControl/redact.ts', import.meta.url).href)
      m.svc.persistMessage('kimi', 'ac6-read-1', {
        role: 'user',
        contentRedacted: redactMod.redactText('please fix token=supersecretac6token99 in config'),
        nativeMsgId: 'ac6-read-m1',
        sourceRef: 'fixture:offset=0',
      })

      // /v1/agents：受限投影 {id, displayName, health, capabilities}
      const rAgents = await gwRequest(8746, 'GET', '/v1/agents', { token: dev.token, headers: replayHeaders() })
      assert.equal(rAgents.status, 200, '/v1/agents ok')
      assert.equal(rAgents.json.providers.length, 1, 'one provider projected')
      const proj = rAgents.json.providers[0]
      assert.deepEqual(Object.keys(proj).sort(), ['capabilities', 'displayName', 'health', 'id'], `restricted projection keys: ${JSON.stringify(Object.keys(proj))}`)
      assert.equal(proj.id, providerId, 'projection id')
      assert.deepEqual(proj.capabilities.granted, [], 'capabilities projected')

      // /v1/sessions：全量 2 条；status 过滤；limit 截断
      const rAll = await gwRequest(8746, 'GET', '/v1/sessions', { token: dev.token, headers: replayHeaders() })
      assert.equal(rAll.status, 200, '/v1/sessions ok')
      assert.equal(rAll.json.sessions.length, 2, 'both fixture sessions')
      const rWaiting = await gwRequest(8746, 'GET', '/v1/sessions?status=waiting_input', { token: dev.token, headers: replayHeaders() })
      assert.equal(rWaiting.json.sessions.length, 1, 'status filter server-side')
      assert.equal(rWaiting.json.sessions[0].status, 'waiting_input', 'filtered status value')
      const rLimited = await gwRequest(8746, 'GET', '/v1/sessions?limit=1', { token: dev.token, headers: replayHeaders() })
      assert.equal(rLimited.json.sessions.length, 1, 'limit truncates server-side')
      const sessKeys = Object.keys(rAll.json.sessions[0]).sort()
      for (const key of ['id', 'providerId', 'nativeId', 'sessionMode', 'status', 'stale']) {
        assert.ok(sessKeys.includes(key), `SessionView carries ${key} (got ${JSON.stringify(sessKeys)})`)
      }

      // /v1/sessions/{id}：{session, capabilities}
      const rDetail = await gwRequest(8746, 'GET', `/v1/sessions/${s1}`, { token: dev.token, headers: replayHeaders() })
      assert.equal(rDetail.status, 200, 'session detail ok')
      assert.equal(rDetail.json.session.id, s1, 'detail session id')
      assert.equal(rDetail.json.session.sessionMode, 'observed', 'detail session mode')
      assert.deepEqual(Object.keys(rDetail.json).sort(), ['capabilities', 'session'], 'detail shape {session, capabilities}')

      // /v1/sessions/{id}/messages：脱敏投影 + 零 sourceRef（本地源指针不出本机，docs/15 §6）
      const rMsgs = await gwRequest(8746, 'GET', `/v1/sessions/${s1}/messages`, { token: dev.token, headers: replayHeaders() })
      assert.equal(rMsgs.status, 200, 'messages ok')
      assert.equal(rMsgs.json.items.length, 1, 'one message')
      const item = rMsgs.json.items[0]
      assert.equal(item.role, 'user', 'message role')
      assert.ok(item.contentRedacted.includes('***'), 'contentRedacted masks the fixture secret')
      assert.ok(!item.contentRedacted.includes('supersecretac6token99'), 'no plaintext secret in remote projection')
      assert.ok(!('sourceRef' in item), `no sourceRef in remote items: ${JSON.stringify(item)}`)

      // /v1/diagnostics：{providers, gateway}；gateway 投影带运行真值
      const rDiag = await gwRequest(8746, 'GET', '/v1/diagnostics', { token: dev.token, headers: replayHeaders() })
      assert.equal(rDiag.status, 200, 'diagnostics ok')
      assert.ok(Array.isArray(rDiag.json.providers), 'diagnostics providers array')
      assert.equal(rDiag.json.gateway.running, true, 'diagnostics gateway running truth')
      assert.equal(rDiag.json.gateway.port, 8746, 'diagnostics gateway port')
      assert.ok(!JSON.stringify(rDiag.json).includes(dev.token), 'no token material in diagnostics')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 136. 请求校验 + 路由边界（BAD_PAYLOAD / NOT_FOUND 语义，约束 #14）：
  //      claim 载荷校验（platform/code 字符表/缺字段）/JSON 畸形/超限 body/
  //      reply 文本 >4000 / 非法 query（status/limit/providerId）/未知路由 404
  registerCase('ac6-136: request validation and routing edges — payload validation BAD_PAYLOAD on claim/reply/query, oversized body 400, malformed JSON 400, unknown routes 404', async () => {
    const m = await gwCaseSetup('devhub-ac6-136-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'ac6-phone')
      const providerId = fixtureProviderRow(db, 'kimi')
      // AC6 修复就地更新：校验面用例（400 全部在路由层读JsonBody/字段校验拒绝，
      // 不触能力门），无会话级 capabilities 列（docs/13 §4.2）
      const sessionId = fixtureSessionRow(db, providerId, 'ac6-val-sess', 'observed')
      // AC6 修复就地更新：防重放 nonce 一次性（docs/14 §B.4，重复 → 401
      // AUTH_REPLAYED）——authed 必须是工厂函数，每次请求取新 timestamp+nonce，
      // 复用同一 headers 对象会让第二次起全部 401
      const authed = () => ({ token: dev.token, headers: replayHeaders() })

      // claim 载荷校验（route 校验先于限流，绝不触达配对状态）
      const claim = (body) => gwRequest(8746, 'POST', '/v1/pairing/claim', { body })
      const rPlatform = await claim({ pairingId: 'pair-x', code: 'AAAAAAAA', deviceName: 'p', platform: 'ios' })
      assert.equal(rPlatform.status, 400, 'platform != android → 400')
      assert.equal(rPlatform.json.error.code, 'BAD_PAYLOAD', 'platform code')
      const rAlphabet = await claim({ pairingId: 'pair-x', code: 'AAAAAILO', deviceName: 'p', platform: 'android' })
      assert.equal(rAlphabet.status, 400, 'code with I/L/O → 400 (Crockford alphabet)')
      const rShort = await claim({ pairingId: 'pair-x', code: 'ABC', deviceName: 'p', platform: 'android' })
      assert.equal(rShort.status, 400, 'short code → 400')
      const rNoName = await claim({ pairingId: 'pair-x', code: 'AAAAAAAA', platform: 'android' })
      assert.equal(rNoName.status, 400, 'missing deviceName → 400')
      const rArrayBody = await gwRequest(8746, 'POST', '/v1/pairing/claim', { body: '["x"]' })
      assert.equal(rArrayBody.status, 400, 'JSON array body → 400 (object required)')
      const rBadJson = await gwRequest(8746, 'POST', '/v1/pairing/create', { body: '{oops', headers: replayHeaders() })
      assert.equal(rBadJson.status, 400, 'malformed JSON → 400')
      assert.equal(rBadJson.json.error.code, 'BAD_PAYLOAD', 'malformed JSON code')

      // 超限 body（>64KB）→ 400（校验在鉴权后仍结构化拒绝）
      const oversized = 'x'.repeat(70 * 1024)
      const rOversize = await gwRequest(8746, 'POST', `/v1/sessions/${sessionId}/reply`, { ...authed(), body: { text: oversized } })
      assert.equal(rOversize.status, 400, `oversized body → 400, got ${rOversize.status}`)
      assert.equal(rOversize.json.error.code, 'BAD_PAYLOAD', 'oversize code')

      // reply 文本 >4000 字符 → 400；空 text → 400
      const rLong = await gwRequest(8746, 'POST', `/v1/sessions/${sessionId}/reply`, { ...authed(), body: { text: 'a'.repeat(4001) } })
      assert.equal(rLong.status, 400, 'reply text >4000 chars → 400')
      assert.equal(rLong.json.error.code, 'BAD_PAYLOAD', 'long text code')
      const rEmpty = await gwRequest(8746, 'POST', `/v1/sessions/${sessionId}/reply`, { ...authed(), body: { text: '   ' } })
      assert.equal(rEmpty.status, 400, 'whitespace-only text → 400')

      // actions 枚举校验
      const rAction = await gwRequest(8746, 'POST', `/v1/sessions/${sessionId}/actions`, { ...authed(), body: { action: 'restart' } })
      assert.equal(rAction.status, 400, 'action outside pause|resume → 400')

      // 非法 query
      const rBadStatus = await gwRequest(8746, 'GET', '/v1/sessions?status=bogus', authed())
      assert.equal(rBadStatus.status, 400, 'bad status filter → 400')
      const rZeroLimit = await gwRequest(8746, 'GET', '/v1/sessions?limit=0', authed())
      assert.equal(rZeroLimit.status, 400, 'limit=0 → 400')
      const rBigLimit = await gwRequest(8746, 'GET', '/v1/sessions?limit=201', authed())
      assert.equal(rBigLimit.status, 400, 'limit>200 → 400')
      const rBadProvider = await gwRequest(8746, 'GET', '/v1/sessions?providerId=abc', authed())
      assert.equal(rBadProvider.status, 400, 'providerId non-integer → 400')

      // 未知路由 / 方法
      const rUnknown = await gwRequest(8746, 'GET', '/v1/definitely-not-a-route', authed())
      assert.equal(rUnknown.status, 404, 'unknown route 404')
      assert.equal(rUnknown.json.error.code, 'NOT_FOUND', 'unknown route code')
      const rPatchHealth = await gwRequest(8746, 'PATCH', '/v1/health', {})
      assert.equal(rPatchHealth.status, 404, 'unmatched method on known path 404')
      const rAckAbc = await gwRequest(8746, 'POST', '/v1/events/abc/ack', authed())
      assert.equal(rAckAbc.status, 404, 'non-numeric ack sequence 404')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 137. AC7b 裁决放宽（docs/14 §B.1 实现注记）：pairing/claim 的 pairingId 可选——
  //      code-only claim 成功（同时仅 1 活跃码，code 即唯一定位）；
  //      一次性/落库/审计语义零变化。
  registerCase('ac7b-137: code-only pairing claim (AC7b relaxation) — claim without pairingId succeeds via sole-active-code semantics, one-time + device row + audit unchanged', async () => {
    const m = await gwCaseSetup('devhub-ac7b-137-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const created = await pairingCreateHttp(8746)

      // code-only claim（请求体无 pairingId 字段）→ 200；响应形状与 pairingId 路径一致
      const rClaim = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { code: created.code, deviceName: 'ac7b-phone', platform: 'android' },
      })
      assert.equal(rClaim.status, 200, `code-only claim -> 200, got ${rClaim.status} ${rClaim.raw}`)
      assert.equal(typeof rClaim.json.deviceId, 'number', 'deviceId number')
      assert.match(rClaim.json.token, /^[A-Za-z0-9_-]{40,}$/, 'token is base64url 256-bit')
      assert.equal(rClaim.json.tokenVersion, 1, 'tokenVersion starts at 1')
      assert.equal(rClaim.json.gatewayName, 'devhub-gateway', 'gatewayName unchanged')

      // 一次性语义零变化：同码重放（仍不带 pairingId）→ 401 AUTH_INVALID_TOKEN
      const rReplay = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { code: created.code, deviceName: 'ac7b-phone', platform: 'android' },
      })
      assert.equal(rReplay.status, 401, 'code-only replay refused (one-time unchanged)')
      assert.equal(rReplay.json.error.code, 'AUTH_INVALID_TOKEN', 'AUTH_INVALID_TOKEN code')

      // 设备真实落库 + 审计零码明文（与 pairingId 路径同一落库/审计链路）
      assert.equal(db.prepare("SELECT COUNT(*) c FROM remote_devices WHERE device_name='ac7b-phone'").get().c, 1, 'device row created via code-only claim')
      const claimedAudit = db.prepare("SELECT detail_json FROM security_audit_logs WHERE action='pairing_claimed' ORDER BY id DESC LIMIT 1").get()
      assert.ok(claimedAudit !== undefined, 'pairing_claimed audited')
      assert.ok(!claimedAudit.detail_json.includes(created.code), 'no code plaintext in claim audit')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 138. AC7b 裁决放宽的边界：pairingId 提供时必须与活跃码精确匹配——
  //      pairingId+code 均错 → 401；pairingId 对不上而 code 正确 → 401；
  //      精确 pairingId + 正确 code → 200（双字段契约向后兼容）；失败计数语义不变。
  registerCase('ac7b-138: pairingId-when-provided must match exactly (AC7b) — wrong id + wrong code refused, mismatched id with correct code refused, exact id+code still 200', async () => {
    const m = await gwCaseSetup('devhub-ac7b-138-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const created = await pairingCreateHttp(8746)

      // (a) pairingId + code 均错 → 401 AUTH_INVALID_TOKEN（失败 1/5）
      const rBothWrong = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { pairingId: 'pair-00000000-0000-0000-0000-000000000000', code: 'ZZZZZZZZ', deviceName: 'ac7b-phone', platform: 'android' },
      })
      assert.equal(rBothWrong.status, 401, 'wrong pairingId + wrong code refused')
      assert.equal(rBothWrong.json.error.code, 'AUTH_INVALID_TOKEN', 'both-wrong folds to AUTH_INVALID_TOKEN')

      // (b) pairingId 对不上（非当前活跃码 id）而 code 正确 → 401（精确匹配语义，失败 2/5）
      const rIdMismatch = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { pairingId: 'pair-00000000-0000-0000-0000-000000000000', code: created.code, deviceName: 'ac7b-phone', platform: 'android' },
      })
      assert.equal(rIdMismatch.status, 401, 'mismatched pairingId with correct code refused')
      assert.equal(rIdMismatch.json.error.code, 'AUTH_INVALID_TOKEN', 'id-mismatch folds to AUTH_INVALID_TOKEN')

      // (c) 精确 pairingId + 正确 code → 200（双字段契约向后兼容；失败 2 次未达作废阈值 5）
      const rExact = await gwRequest(8746, 'POST', '/v1/pairing/claim', {
        body: { pairingId: created.pairingId, code: created.code, deviceName: 'ac7b-phone', platform: 'android' },
      })
      assert.equal(rExact.status, 200, `exact pairingId+code -> 200, got ${rExact.status} ${rExact.raw}`)
      assert.equal(db.prepare('SELECT COUNT(*) c FROM remote_devices').get().c, 1, 'exactly one device row')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // ------------------------------------------------------------------
  // AC8（docs/16 §1 AC8 行）：端到端最小路径 + NatPierce 投影
  // ------------------------------------------------------------------

  // 139. Codex 托管会话最小路径（夹具 app-server）：trigger 文件 → thread/start +
  //      managed 落库（session.started）→ turn/start；rollout 观察推进
  //      running → waiting_input；reply → 新 turn → 第二个 waiting_input
  //      （指纹去重不得吞并）；managed 行不被 observed 重扫降级。
  registerCase('ac8-139: codex managed turn path (fixture app-server) — trigger file -> thread/start managed upsert + session.started, rollout drives running -> waiting_input, reply -> second distinct waiting_input, managed row survives observed rescan', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const codexMod = await import(new URL('../src/main/services/agentControl/providers/codexProvider.ts', import.meta.url).href)

    await makeTempHome('devhub-ac8-139-')
    const fixtureHome = mkdtempSync(join(tmpdir(), 'devhub-ac8-139-codex-'))
    const dayDir = join(fixtureHome, 'sessions', '2026', '09', '03')
    mkdirSync(dayDir, { recursive: true })
    const rolloutPath = join(dayDir, 'rollout-2026-09-03T12-00-00-ac8a0139-0000-7000-8000-000000000139.jsonl')
    const triggerPath = join(fixtureHome, 'managed-turn.json')
    const threadId = 'ac8a0139-0000-7000-8000-000000000139'
    const fixtureProject = join(fixtureHome, 'workspaces', 'demo')
    mkdirSync(fixtureProject, { recursive: true })

    const script = join(fixtureHome, 'fake-appserver-ac8.mjs')
    writeFileSync(
      script,
      [
        "import { createInterface } from 'node:readline'",
        'const reply = (o) => process.stdout.write(JSON.stringify(o) + "\\n")',
        'globalThis.n = 0',
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        '  let m; try { m = JSON.parse(line) } catch { return }',
        '  if (m.method === "initialize") reply({ id: m.id, result: { userAgent: "fake-appserver-ac8/1.0" } })',
        '  else if (m.method === "thread/start") reply({ id: m.id, result: { thread: { id: process.env.FAKE_THREAD_ID, cwd: process.env.FAKE_CWD } } })',
        '  else if (m.method === "thread/resume") reply({ id: m.id, result: { thread: { id: m.params.threadId, status: { type: "idle" } } } })',
        '  else if (m.method === "turn/start") { globalThis.n += 1; reply({ id: m.id, result: { turn: { id: "turn-" + globalThis.n } } }) }',
        '  else if (m.method === "turn/interrupt") reply({ id: m.id, result: { interrupted: true } })',
        '  else reply({ id: m.id, error: { code: -32600, message: "unknown variant `" + m.method + "`" } })',
        '})',
        '',
      ].join('\n'),
      'utf8',
    )

    const provider = codexMod.createCodexProvider({
      codexHome: fixtureHome,
      codexBinRoot: join(fixtureHome, 'no-such-bin'),
      exePath: process.execPath,
      appServerArgs: [script],
      appServerEnv: { ...process.env, FAKE_THREAD_ID: threadId, FAKE_CWD: fixtureProject },
      requestTimeoutMs: 3000,
      managedIdleTimeoutMs: 8000,
      managedLifetimeTimeoutMs: 25000,
      managedTriggerPath: triggerPath,
      scanCacheMs: 500,
    })
    const db = dbModule.getDatabase()
    const row = () => db.prepare('SELECT * FROM agent_sessions WHERE native_id = ?').get(threadId)
    const waitFor = async (deadlineMs, predicate, label) => {
      const deadline = Date.now() + deadlineMs
      for (;;) {
        const value = predicate()
        if (value) return value
        if (Date.now() > deadline) throw new Error(`ac8-139 timeout waiting for: ${label}`)
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    try {
      svc.setProviderOverride('codex', provider)
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('zcode', stubAgentProvider('zcode'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      svc.ensureAgentProviderRows()
      svc.resetAgentControlThrottles()
      assert.equal(svc.startMonitorForProvider('codex'), true, 'codex monitor started')

      // 1) trigger 文件 → 托管会话创建（thread/start + turn/start，managed 落库）
      writeFileSync(triggerPath, JSON.stringify({ requestId: 'ac8-139-a', task: 'Reply with exactly: OK. Then stop.' }), 'utf8')
      const resultPath = `${triggerPath}.result.json`
      await waitFor(15000, () => existsSync(resultPath), 'managed turn result file')
      const result = JSON.parse(readFileSync(resultPath, 'utf8'))
      assert.equal(result.requestId, 'ac8-139-a')
      assert.equal(result.ok, true, `managed turn ok, got: ${result.detail}`)
      assert.equal(result.nativeId, threadId, 'nativeId = thread/start returned thread id')

      const s1 = row()
      assert.ok(s1 !== undefined, 'managed session row created')
      assert.equal(s1.session_mode, 'managed', 'session_mode = managed (DevHub-initiated)')
      assert.equal(s1.workdir, fixtureProject, 'workdir from thread/start cwd')
      const startedEvent = db.prepare("SELECT * FROM agent_events WHERE event_type = 'session.started' AND session_id = ?").get(s1.id)
      assert.ok(startedEvent !== undefined, 'session.started recorded for managed session')
      const agentRes = db.prepare("SELECT id FROM resources WHERE resource_type = 'agent'").get()
      const sessionRes = db.prepare("SELECT id FROM resources WHERE resource_type = 'session'").get()
      const edge = db.prepare('SELECT relation_type FROM relationships WHERE source_resource_id = ? AND target_resource_id = ?').get(agentRes.id, sessionRes.id)
      assert.equal(edge.relation_type, 'monitors', 'managed session -> monitors edge')

      // 2) rollout 观察推进：session_meta + task_started → running
      appendFileSync(
        rolloutPath,
        [
          JSON.stringify({ timestamp: '2026-09-03T12:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { session_id: threadId, id: threadId, cwd: fixtureProject, timestamp: '2026-09-03T12:00:00.000Z', cli_version: '0.153.0-fixture' } }),
          JSON.stringify({ timestamp: '2026-09-03T12:00:02.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-aaaa1111' } }),
          '',
        ].join('\n'),
        'utf8',
      )
      await waitFor(15000, () => row()?.status === 'running', 'status running from task_started')
      // discovery 重扫（observed 投影晚到）不得降级 managed 行（AC8 护栏）
      assert.equal(row().session_mode, 'managed', 'managed row survives observed rescan')

      // 3) task_complete（managed 线程）→ waiting_input + session.waiting_input 事件
      appendFileSync(
        rolloutPath,
        [
          JSON.stringify({ timestamp: '2026-09-03T12:00:06.000Z', ordinal: 2, type: 'response_item', payload: { type: 'message', id: 'msg_ac8_1', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] } }),
          JSON.stringify({ timestamp: '2026-09-03T12:00:07.000Z', ordinal: 3, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-aaaa1111', last_agent_message: 'OK' } }),
          '',
        ].join('\n'),
        'utf8',
      )
      await waitFor(15000, () => row()?.status === 'waiting_input', 'status waiting_input from task_complete')
      const wait1 = db.prepare("SELECT * FROM agent_events WHERE event_type = 'session.waiting_input' AND payload_json LIKE ?").all(`%${threadId}%`)
      assert.equal(wait1.length, 1, 'one waiting_input event after turn 1')

      // 4) reply（手机路径同款 provider 调用）→ 真实第二次 turn/start
      const replyOutcome = await provider.sendReply({ providerId: 'codex', nativeId: threadId }, 'Thanks. Reply DONE and finish.')
      assert.deepEqual({ ok: replyOutcome.ok, status: replyOutcome.status }, { ok: true, status: 'executed' }, `reply executed: ${replyOutcome.detail ?? ''}`)

      // 5) turn 2 rollout → running → 第二个 waiting_input（event_id 必须不同——
      //    turn_id 进入指纹，去重不得吞并第二次等待）
      appendFileSync(
        rolloutPath,
        [
          JSON.stringify({ timestamp: '2026-09-03T12:01:00.000Z', ordinal: 4, type: 'response_item', payload: { type: 'message', id: 'msg_ac8_2', role: 'user', content: [{ type: 'input_text', text: 'Thanks. Reply DONE and finish.' }] } }),
          JSON.stringify({ timestamp: '2026-09-03T12:01:02.000Z', ordinal: 5, type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-bbbb2222' } }),
          '',
        ].join('\n'),
        'utf8',
      )
      await waitFor(15000, () => row()?.status === 'running', 'status running from turn 2 task_started')
      appendFileSync(
        rolloutPath,
        [
          JSON.stringify({ timestamp: '2026-09-03T12:01:06.000Z', ordinal: 6, type: 'response_item', payload: { type: 'message', id: 'msg_ac8_3', role: 'assistant', content: [{ type: 'output_text', text: 'DONE' }] } }),
          JSON.stringify({ timestamp: '2026-09-03T12:01:07.000Z', ordinal: 7, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-bbbb2222', last_agent_message: 'DONE' } }),
          '',
        ].join('\n'),
        'utf8',
      )
      await waitFor(15000, () => {
        const events = db.prepare("SELECT event_id, summary FROM agent_events WHERE event_type = 'session.waiting_input' AND payload_json LIKE ?").all(`%${threadId}%`)
        return events.length >= 2 ? events : null
      }, 'second waiting_input event').then((events) => {
        assert.equal(new Set(events.map((e) => e.event_id)).size, 2, 'two distinct waiting_input event ids (turn_id in fingerprint)')
      })
      const msgs = db.prepare('SELECT role, content_redacted FROM agent_messages WHERE session_id = ? ORDER BY id').all(row().id)
      assert.ok(msgs.some((m) => m.role === 'assistant' && m.content_redacted === 'OK'), 'assistant OK projected')
      assert.ok(msgs.some((m) => m.role === 'user' && m.content_redacted.includes('DONE')), 'user reply projected (message.appended path)')
      assert.equal(row().session_mode, 'managed', 'session_mode still managed at end')
    } finally {
      await provider.dispose().catch(() => {})
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  })

  // 140. NatPierce 投影三态（docs/15 §8 / docs/16 §1 AC8 行）：全未配置 → AC2 逐字节
  //      形状；部分配置 → hint（只含变量名）；齐备 → configured + reachable（回环
  //      http 夹具探测可达 / 关闭端口不可达 / 非法协议 false）；投影零凭据。
  registerCase('ac8-140: natpierce projection three states — unset keeps AC2 shape, partial env gets hint (names only), full env configured + reachable probe (live loopback http / closed port / bad scheme); no credential material in any projection', async () => {
    const http = await import('node:http')
    const { readFileSync, existsSync } = await import('node:fs')
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const np = await import(new URL('../src/main/services/agentControl/natpierce.ts', import.meta.url).href)

    await makeTempHome('devhub-ac8-140-')
    const saved = {}
    for (const key of np.NATPIERCE_ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    let server = null
    try {
      svc.setProviderOverride('codex', stubAgentProvider('codex'))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('zcode', stubAgentProvider('zcode'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      np.resetNatPierceProbeCache()

      // 态 1：三者全未配置 → 与 AC2 契约形状逐字节一致（无 hint——引导在视图静态文案与文档）
      let status = svc.getGatewayStatus()
      assert.deepEqual(status.natpierce, { configured: false }, 'unset -> exact AC2 shape')

      // 态 2：部分配置（仅 endpoint；account/token 缺）→ configured:false + hint（只含变量名）
      process.env.NATPIERCE_ENDPOINT = 'http://127.0.0.1:1/healthz' // 关闭端口
      status = svc.getGatewayStatus()
      assert.equal(status.natpierce.configured, false, 'partial env -> configured false')
      assert.match(status.natpierce.hint, /NATPIERCE_ACCOUNT/, 'hint names missing var')
      assert.match(status.natpierce.hint, /NATPIERCE_TOKEN/, 'hint names missing var')
      assert.ok(!status.natpierce.hint.includes('127.0.0.1'), 'hint carries no values')
      // endpoint 已配置 → diagnostics 面节流探测可达性（关闭端口 → false）
      const refreshed = await np.refreshNatPierceStatus()
      assert.equal(refreshed.reachable, false, 'closed port -> reachable false')

      // 态 3：齐备 → configured:true + reachable（回环 http 夹具 = 可达）
      server = http.createServer((req, res) => res.end('ok'))
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = server.address().port
      const fakeAccount = 'fake-acct-9f8a7b6c'
      const fakeToken = 'fake-token-0123456789abcdef'
      process.env.NATPIERCE_ACCOUNT = fakeAccount
      process.env.NATPIERCE_TOKEN = fakeToken
      process.env.NATPIERCE_ENDPOINT = `http://127.0.0.1:${port}/healthz`
      np.resetNatPierceProbeCache()
      const refreshedFull = await np.refreshNatPierceStatus()
      assert.equal(refreshedFull.configured, true, 'full env -> configured true')
      assert.equal(refreshedFull.reachable, true, 'live loopback endpoint -> reachable true')
      assert.equal(refreshedFull.hint, undefined, 'no hint when configured')
      status = svc.getGatewayStatus()
      assert.equal(status.natpierce.configured, true, 'gatewayStatus projects configured')
      assert.equal(status.natpierce.reachable, true, 'gatewayStatus carries cached reachable')

      // 零凭据投影：gatewayStatus + diagnostics + 日志文件（如有）均不含假值
      const diag = await svc.getDiagnostics()
      const blob = JSON.stringify(status) + JSON.stringify(diag)
      assert.ok(!blob.includes(fakeAccount), 'no account value in projections')
      assert.ok(!blob.includes(fakeToken), 'no token value in projections')
      const logPath = await import(new URL('../src/main/core/paths.ts', import.meta.url).href).then((m) => m.getLogDir())
      const logFile = logPath.endsWith('logs') ? `${logPath}/devhub.log` : logPath
      if (existsSync(logFile)) {
        const logText = readFileSync(logFile, 'utf8')
        assert.ok(!logText.includes(fakeAccount) && !logText.includes(fakeToken), 'no credentials in log file')
      }

      // 边界：非法协议 → reachable false（结构化布尔，绝不抛）
      process.env.NATPIERCE_ENDPOINT = 'ftp://natpierce.example:7000'
      np.resetNatPierceProbeCache()
      assert.equal((await np.refreshNatPierceStatus()).reachable, false, 'non-http(s) scheme -> reachable false')
      // URL 非法 → false
      assert.equal(await np.probeNatPierceReachable('not a url'), false, 'unparseable endpoint -> false')
    } finally {
      if (server !== null) await new Promise((resolve) => server.close(resolve))
      for (const key of np.NATPIERCE_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
      np.resetNatPierceProbeCache()
      svc.stopAllAgentControlRuntime()
      const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
      dbModule.closeDatabase()
    }
  })

  // ------------------------------------------------------------------
  // 安全加固回归：skills doctor crlf 修复的 contained-in-vault 校验——
  // payload.files 里 `../` 逃逸 vault 的路径必须被跳过并计数，vault 内文件正常转换。
  // ------------------------------------------------------------------
  registerCase('sec-fix: skills doctor crlf fix skips payload paths escaping the vault', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { applyFix } = await import(new URL('../src/main/services/skills/doctor.ts', import.meta.url).href)

    const base = mkdtempSync(join(tmpdir(), 'devhub-doctor-crlf-'))
    const vault = join(base, 'vault')
    const outside = join(base, 'outside.txt')
    mkdirSync(join(vault, 'skills'), { recursive: true })
    writeFileSync(join(vault, 'skills', 'a.md'), 'x\r\ny\r\n', 'utf8')
    writeFileSync(outside, 'SECRET\r\n', 'utf8')
    try {
      const outcome = await applyFix({ vaultPath: vault }, 'crlf', {
        files: ['skills/a.md', '../outside.txt'],
      })
      assert.equal(readFileSync(join(vault, 'skills', 'a.md'), 'utf8'), 'x\ny\n', 'in-vault file converted to LF')
      assert.equal(readFileSync(outside, 'utf8'), 'SECRET\r\n', 'file outside vault untouched (traversal skipped)')
      assert.ok(outcome.message.includes('跳过 1'), `traversal skip counted in message: ${outcome.message}`)
      assert.ok(outcome.message.includes('已转换 1 个文件'), `converted count in message: ${outcome.message}`)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 'fast')

  // ------------------------------------------------------------------
  // AC9 退出滞留修复：quitGuarantee 状态机（electron-free 纯逻辑，直载）——
  // teardown 完成/硬上限后必须再次 quit + 挂退出看门狗；看门狗到点进程仍未退
  // 必须 force-exit（app.exit(0) 兜底），杜绝主进程+GPU+网络服务滞留；
  // 二次 before-quit 放行、重复触发幂等。
  // ------------------------------------------------------------------
  registerCase('ac9-exit-fix: quitGuarantee state machine converges to guaranteed app.exit(0) after teardown (or hard cap); idempotent on repeats', async () => {
    const qg = await import(new URL('../src/main/core/quitGuarantee.ts', import.meta.url).href)
    // 1) 首次 before-quit：preventDefault + 挂硬上限 → tearing-down（不发 quit）
    const first = qg.quitTransition('idle', 'first-before-quit')
    assert.equal(first.preventDefault, true, 'first before-quit must preventDefault for ordered teardown')
    assert.equal(first.armHardCap, true, 'hard cap must be armed together with teardown')
    assert.equal(first.quitAgain, false, 'no re-quit while ordered teardown is running')
    assert.equal(first.forceExit, false)
    assert.equal(first.nextStage, 'tearing-down', 'stage must move to tearing-down')
    // 2) teardown 完成：清硬上限 + 再次 quit + 挂退出看门狗 → quitting
    const done = qg.quitTransition(first.nextStage, 'teardown-completed')
    assert.equal(done.clearHardCap, true, 'hard cap cleared once teardown settles')
    assert.equal(done.quitAgain, true, 'teardown completion must re-issue app.quit()')
    assert.equal(done.armWatchdog, true, 'exit watchdog must be armed once teardown settles')
    assert.equal(done.forceExit, false)
    assert.equal(done.nextStage, 'quitting', 'stage must move to quitting')
    // 3) 看门狗到点进程仍在：必须 force-exit（退出保证，杜绝滞留）
    const wd = qg.quitTransition(done.nextStage, 'watchdog-elapsed')
    assert.equal(wd.forceExit, true, 'watchdog elapsed must converge to forced exit (app.exit(0))')
    assert.equal(wd.quitAgain, false, 'no graceful re-quit at watchdog time — force only')
    assert.equal(wd.nextStage, 'force-exit')
    // 4) 硬上限路径（收尾挂死）：同样 quit + 看门狗 → force-exit 收敛
    const cap = qg.quitTransition('tearing-down', 'hard-cap-elapsed')
    assert.equal(cap.quitAgain, true, 'hard cap must force the quit to proceed')
    assert.equal(cap.armWatchdog, true, 'hard cap path must also arm the exit watchdog')
    assert.equal(cap.nextStage, 'quitting')
    const capWd = qg.quitTransition(cap.nextStage, 'watchdog-elapsed')
    assert.equal(capWd.forceExit, true, 'hard cap path converges to forced exit too')
    // 5) 幂等/放行：二次 before-quit 不再拦截；重复触发不重复动作
    const secondQuit = qg.quitTransition('quitting', 'first-before-quit')
    assert.equal(secondQuit.preventDefault, false, 'second before-quit must let quit proceed')
    const repeatDone = qg.quitTransition('quitting', 'teardown-completed')
    assert.equal(repeatDone.quitAgain, false, 'repeated teardown-completed is a no-op')
    assert.equal(repeatDone.armWatchdog, false, 'watchdog armed at most once')
    const repeatWd = qg.quitTransition('force-exit', 'watchdog-elapsed')
    assert.equal(repeatWd.forceExit, false, 'force-exit is terminal')
    // 常量契约：5s 硬上限守收尾、3s 看门狗守最终退出
    assert.equal(qg.QUIT_TEARDOWN_HARD_CAP_MS, 5000, 'teardown hard cap stays 5s')
    assert.equal(qg.QUIT_EXIT_WATCHDOG_MS, 3000, 'exit watchdog grace stays 3s')
  }, 'fast')

  // ------------------------------------------------------------------
  // fix-zcode-subagent（用户报障：Agents 视图出现大量子智能体会话）——
  // zcodeProvider 只抓主智能体会话，过滤子智能体会话（三重判别特征取前两重
  // 双保险：task_type='subagent_child' + id 前缀 'sess_subagent_agent_'；
  // parent_id 不作判据）。141 用例锁 provider 侧一切会话发现路径；142 用例锁
  // scripts/cleanup-zcode-subagent-sessions.mjs 真库清污幂等。append-only 接续。
  // ------------------------------------------------------------------

  // 141. provider 侧过滤：listSessions / 监控增量（sessions 发现、messages 投影、
  //      tool_usage 审批、tasks 状态复核）全部不吃子会话；task_type 行值 NULL 由
  //      前缀兜底；无 task_type 列的降级库仅前缀兜底且白名单仍通过；L3 库零子会话行
  registerCase('fix-zcode-subagent-141: zcode provider filters subagent sessions in every discovery path — listSessions dual-guard (task_type + id prefix; NULL task_type row still excluded via prefix fallback), degraded db without task_type column stays whitelist-ok with prefix-only filter, monitor incrementals (discover/messages/approval/task status) never emit subagent sessions, L3 db keeps zero subagent rows', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)

    // 判据常量契约（源头过滤的双保险判据，供清理脚本同名语义对齐）
    assert.equal(zcodeMod.ZCODE_SUBAGENT_TASK_TYPE, 'subagent_child', 'explicit task_type marker')
    assert.equal(zcodeMod.ZCODE_SUBAGENT_ID_PREFIX, 'sess_subagent_agent_', 'id prefix fallback marker')
    assert.equal(zcodeMod.isZcodeSubagentSession('sess_subagent_agent_x', undefined), true, 'prefix hit with unavailable column → subagent')
    assert.equal(zcodeMod.isZcodeSubagentSession('sess_subagent_agent_x', null), true, 'prefix hit with NULL task_type → subagent')
    assert.equal(zcodeMod.isZcodeSubagentSession('sess_00401cb0-uuid', 'subagent_child'), true, 'task_type hit → subagent')
    assert.equal(zcodeMod.isZcodeSubagentSession('sess_00401cb0-uuid', 'interactive'), false, 'main session kept')
    assert.equal(zcodeMod.isZcodeSubagentSession('sess_00401cb0-uuid', null), false, 'NULL task_type without prefix → kept (never guesses)')
    // like 下划线转义：_ 是 LIKE 通配符，pattern 必须精确匹配字面下划线
    assert.ok(zcodeMod.ZCODE_SUBAGENT_ID_LIKE_PATTERN.includes('\\_'), 'LIKE pattern escapes underscore wildcards')

    const dir = mkdtempSync(join(tmpdir(), 'devhub-fix-zc-sub-'))
    const nowMs = 1788383547842
    const mkFixtureDb = (dbPath, withTaskTypeColumn) => {
      const fdb = new DatabaseSync(dbPath)
      const taskTypeCol = withTaskTypeColumn ? ', task_type TEXT' : ''
      fdb.exec(`
        CREATE TABLE session (id TEXT, project_id TEXT, workspace_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER${taskTypeCol});
        CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
        CREATE TABLE tool_usage (id TEXT, session_id TEXT, tool_name TEXT, approval_status TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
        CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, sequence INTEGER);
      `)
      return fdb
    }

    // 主库夹具（含 task_type 列）：主会话 ×2 + 子会话（显式 task_type）+ 兜底行
    // （task_type=NULL 但前缀命中）+ 非前缀 NULL 行（主会话，验证 NULL 不误删）
    const dbPath = join(dir, 'db.sqlite')
    const fdb = mkFixtureDb(dbPath, true)
    const insSession = fdb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated, task_type) VALUES (?, ?, ?, ?, ?, ?)')
    insSession.run('sess_main_completed', 'C:/ws/demo', 'Main one', nowMs, nowMs + 1000, 'interactive')
    insSession.run('sess_main_plain', 'C:/ws/demo', 'Main two (NULL task_type)', nowMs, nowMs + 2000, null)
    insSession.run('sess_subagent_agent_child', 'C:/ws/demo', 'child', nowMs, nowMs + 3000, 'subagent_child')
    insSession.run('sess_subagent_agent_notype', 'C:/ws/demo', 'child no type', nowMs, nowMs + 4000, null)
    const insMsg = fdb.prepare('INSERT INTO message (id, session_id, data, sequence, time_created) VALUES (?, ?, ?, ?, ?)')
    insMsg.run('msg_main_1', 'sess_main_completed', JSON.stringify({ role: 'user', time: { created: nowMs } }), 0, nowMs)
    insMsg.run('msg_child_1', 'sess_subagent_agent_child', JSON.stringify({ role: 'user', time: { created: nowMs + 10 } }), 0, nowMs + 10)
    insMsg.run('msg_child_2', 'sess_subagent_agent_notype', JSON.stringify({ role: 'user', time: { created: nowMs + 20 } }), 0, nowMs + 20)
    // 主会话消息正文在 part 表（真实 ZCode 形态）：缺 part 行的空正文消息会被
    // projectMessageRow 按设计跳过（绝不造内容）——夹具必须带正文来源
    fdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('part_main_1', 'msg_main_1', ?, 0)").run(JSON.stringify({ type: 'text', text: 'main message body' }))
    fdb.prepare("INSERT INTO tool_usage (id, session_id, tool_name, approval_status, status, started_at, completed_at) VALUES ('tu_child', 'sess_subagent_agent_child', 'Bash', 'pending', 'running', ?, NULL)").run(nowMs)
    fdb.close()

    // 降级夹具库（无 task_type 列）：白名单必须仍通过，前缀判据兜底过滤
    const dbPathNoCol = join(dir, 'db-notype.sqlite')
    const fdb2 = mkFixtureDb(dbPathNoCol, false)
    fdb2.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES ('sess_main_degraded', 'C:/ws/demo', 'Main degraded', 1, 2)").run()
    fdb2.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES ('sess_subagent_agent_nocol', 'C:/ws/demo', 'child nocol', 1, 2)").run()
    fdb2.close()

    const tasksPath = join(dir, 'tasks-index.sqlite')
    const tdb = new DatabaseSync(tasksPath)
    tdb.exec('CREATE TABLE tasks (task_id TEXT, title TEXT, task_status TEXT, workspace_path TEXT, updated_at INTEGER);')
    const insTask = tdb.prepare('INSERT INTO tasks (task_id, title, task_status, workspace_path, updated_at) VALUES (?, ?, ?, ?, ?)')
    insTask.run('sess_main_completed', 'Main one', 'completed', 'C:/ws/demo', nowMs)
    insTask.run('sess_subagent_agent_child', 'child', 'error', 'C:/ws/demo', nowMs)
    tdb.close()

    await makeTempHome('devhub-fix-zc-sub-')
    try {
      const db = dbModule.getDatabase()
      const snapshotRoot = join(dir, 'snaps')
      const provider = zcodeMod.createZcodeProvider({ zcodeDbPath: dbPath, tasksIndexPath: tasksPath, snapshotRoot, pollMs: 100, snapshotRefreshMs: 60_000 })

      // listSessions：只回 2 个主会话（子会话 + 兜底行全滤；投影字段语义不变）
      const sessions = await provider.listSessions()
      assert.deepEqual(sessions.map((s) => s.nativeId).sort(), ['sess_main_completed', 'sess_main_plain'], 'listSessions returns only main sessions')

      // 降级库（无 task_type 列）：白名单通过 + 前缀兜底只回主会话
      const degradedHealth = await zcodeMod.createZcodeProvider({ zcodeDbPath: dbPathNoCol, tasksIndexPath: tasksPath, snapshotRoot, directOpenMode: 'disabled' }).probeHealth()
      assert.equal(degradedHealth.health, 'ok', `db without task_type column stays whitelist-ok (optional-column semantics), got ${degradedHealth.health}: ${degradedHealth.healthDetail ?? ''}`)
      const degraded = await zcodeMod.createZcodeProvider({ zcodeDbPath: dbPathNoCol, tasksIndexPath: tasksPath, snapshotRoot, directOpenMode: 'disabled' }).listSessions()
      assert.deepEqual(degraded.map((s) => s.nativeId), ['sess_main_degraded'], 'degraded db: prefix-only filter still excludes subagent rows')

      // 监控增量：sessions 发现 / messages 投影 / tool_usage 审批 / tasks 状态复核
      // 全部不吃子会话（L3 ensureSessionRow 会反向建行——漏滤即重新污染）
      svc.setProviderOverride('zcode', provider)
      svc.setProviderOverride('codex', stubAgentProvider('codex'))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))
      svc.ensureAgentProviderRows()
      svc.syncMonitorTasks()
      let mainStatus = null
      for (let i = 0; i < 80; i++) {
        const row = db.prepare("SELECT status FROM agent_sessions WHERE native_id = 'sess_main_completed'").get()
        if (row !== undefined && row.status === 'completed') { mainStatus = row.status; break }
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.equal(mainStatus, 'completed', 'monitor reaches main session through L3 (fixture is live)')

      // L3 库复核：agent_sessions 零子会话行；消息只投影主会话；无子会话审批事件
      const subRows = db.prepare("SELECT COUNT(*) AS c FROM agent_sessions WHERE native_id LIKE 'sess\\_subagent\\_agent\\_%' ESCAPE '\\'").get()
      assert.equal(subRows.c, 0, 'monitor/upsert path keeps zero subagent session rows')
      const zcodeSessionRows = db.prepare("SELECT native_id FROM agent_sessions s JOIN agent_providers p ON p.id = s.provider_id WHERE p.provider = 'zcode'").all()
      assert.deepEqual(zcodeSessionRows.map((r) => r.native_id).sort(), ['sess_main_completed', 'sess_main_plain'], 'exactly the two main sessions persisted')
      const childMsgs = db.prepare("SELECT COUNT(*) AS c FROM agent_messages m JOIN agent_sessions s ON s.id = m.session_id WHERE s.native_id LIKE 'sess\\_subagent\\_agent\\_%' ESCAPE '\\'").get()
      assert.equal(childMsgs.c, 0, 'subagent messages never projected into L3')
      const mainMsgs = db.prepare("SELECT COUNT(*) AS c FROM agent_messages m JOIN agent_sessions s ON s.id = m.session_id WHERE s.native_id = 'sess_main_completed'").get()
      assert.equal(mainMsgs.c, 1, 'main session message still projected')
      const childApproval = db.prepare("SELECT COUNT(*) AS c FROM agent_events e JOIN agent_sessions s ON s.id = e.session_id WHERE s.native_id LIKE 'sess\\_subagent\\_agent\\_%' ESCAPE '\\'").get()
      assert.equal(childApproval.c, 0, 'subagent approval/task status never raised as events')

      // upsert 全量路径（refreshProviderSessions → listSessions → upsert）：仍零子会话
      const created = await svc.refreshProviderSessions('zcode', true)
      assert.ok(created >= 0)
      const subAfterRefresh = db.prepare("SELECT COUNT(*) AS c FROM agent_sessions WHERE native_id LIKE 'sess\\_subagent\\_agent\\_%' ESCAPE '\\'").get()
      assert.equal(subAfterRefresh.c, 0, 'full snapshot refresh keeps zero subagent rows')

      svc.stopAllAgentControlRuntime()
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 142. cleanup 脚本（scripts/cleanup-zcode-subagent-sessions.mjs）夹具库清污：
  //      dry-run 预览计数与全前缀清单 → apply 单事务删除（sessions/messages/会话域
  //      events/deliveries/resources/edges；health 事件与主会话数据不动；
  //      remote_commands FK SET NULL 解绑）→ 第二遍 apply 幂等全零
  registerCase('fix-zcode-subagent-142: cleanup script on fixture db — dry-run previews exact counts with prefix-only list, apply deletes sessions/messages/session-scoped events/deliveries/session resource nodes/edges in one transaction while provider.health_changed and main-session data survive, remote_commands detached via FK SET NULL, second apply pass is an idempotent zero no-op', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const cleanupMod = await import(new URL('./cleanup-zcode-subagent-sessions.mjs', import.meta.url).href)

    await makeTempHome('devhub-fix-zc-clean-')
    const db = dbModule.getDatabase()
    try {
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('zcode', 'ZCode', ?, ?)").run(now, now)
      const provider = db.prepare("SELECT id FROM agent_providers WHERE provider = 'zcode'").get()
      const insSession = db.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (?, ?, 'observed', 'unknown', ?, ?)")
      insSession.run(provider.id, 'sess_main_real', now, now)
      insSession.run(provider.id, 'sess_subagent_agent_a', now, now)
      insSession.run(provider.id, 'sess_subagent_agent_b', now, now)
      const sidOf = (nativeId) => db.prepare('SELECT id FROM agent_sessions WHERE native_id = ?').get(nativeId).id
      const mainId = sidOf('sess_main_real')
      const subA = sidOf('sess_subagent_agent_a')
      const subB = sidOf('sess_subagent_agent_b')
      const insMsg = db.prepare('INSERT INTO agent_messages (session_id, native_msg_id, role, content_redacted, created_at) VALUES (?, ?, ?, ?, ?)')
      insMsg.run(mainId, 'm1', 'user', 'main message kept', now)
      insMsg.run(subA, 'c1', 'user', 'child message 1', now)
      insMsg.run(subB, 'c2', 'user', 'child message 2', now)
      const insEvent = db.prepare("INSERT INTO agent_events (provider_id, session_id, event_type, event_id, payload_json, delivery_state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
      insEvent.run(provider.id, subA, 'session.started', 'zcode:sess_subagent_agent_a:started', '{}', now)
      insEvent.run(provider.id, subA, 'message.appended', 'zcode:sess_subagent_agent_a:c1', '{}', now)
      insEvent.run(provider.id, subB, 'session.status_changed', 'zcode:sess_subagent_agent_b:unknown:failed', '{}', now)
      insEvent.run(provider.id, mainId, 'session.started', 'zcode:sess_main_real:started', '{}', now)
      insEvent.run(provider.id, null, 'provider.health_changed', 'degraded:1', '{}', now)
      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('dev', 'android', 'deadbeef', ?, ?, ?)").run(now, now, now)
      const device = db.prepare('SELECT id FROM remote_devices').get()
      const insDelivery = db.prepare("INSERT INTO event_deliveries (event_id, device_id, status, created_at) VALUES (?, ?, 'pending', ?)")
      for (const eid of ['zcode:sess_subagent_agent_a:started', 'zcode:sess_subagent_agent_a:c1', 'zcode:sess_subagent_agent_b:unknown:failed']) {
        insDelivery.run(db.prepare('SELECT id FROM agent_events WHERE event_id = ?').get(eid).id, device.id, now)
      }
      const insRes = db.prepare("INSERT INTO resources (resource_type, ref_id, display_name, created_at, updated_at) VALUES ('session', ?, ?, ?, ?)")
      insRes.run(subA, 'zcode:sess_subagent_agent_a', now, now)
      insRes.run(subB, 'zcode:sess_subagent_agent_b', now, now)
      insRes.run(mainId, 'zcode:sess_main_real', now, now)
      const agentRes = db.prepare("INSERT INTO resources (resource_type, ref_id, display_name, created_at, updated_at) VALUES ('agent', ?, 'zcode', ?, ?)").run(provider.id, now, now)
      const resIdOf = (displayName) => db.prepare("SELECT id FROM resources WHERE resource_type = 'session' AND display_name = ?").get(displayName).id
      const insEdge = db.prepare("INSERT INTO relationships (source_resource_id, target_resource_id, relation_type, created_at) VALUES (?, ?, 'exposes', ?)")
      insEdge.run(agentRes.lastInsertRowid, resIdOf('zcode:sess_subagent_agent_a'), now)
      insEdge.run(agentRes.lastInsertRowid, resIdOf('zcode:sess_subagent_agent_b'), now)
      insEdge.run(agentRes.lastInsertRowid, resIdOf('zcode:sess_main_real'), now)
      db.prepare("INSERT INTO remote_commands (command_id, idempotency_key, session_id, action, status, expires_at, created_at) VALUES ('cmd-1', 'key-1', ?, 'reply', 'executed', ?, ?)").run(subA, now + 600, now)

      // dry-run：预览计数 + 清单全前缀（不写库）
      const dry = cleanupMod.runZcodeSubagentCleanup({ db, apply: false })
      assert.equal(dry.subagentSessions.length, 2, 'dry-run finds the two subagent rows')
      assert.ok(dry.subagentSessions.every((s) => s.nativeId.startsWith('sess_subagent_agent_')), 'dry-run list is prefix-only')
      assert.equal(dry.mainSessionsKept, 1, 'main session kept in preview')
      assert.deepEqual(dry.counts, { sessions: 2, messages: 2, events: 3, deliveries: 3, resources: 2, relationships: 2, remoteCommandsDetached: 1 }, `dry-run counts precise, got ${JSON.stringify(dry.counts)}`)
      const stillThere = db.prepare("SELECT COUNT(*) AS c FROM agent_sessions WHERE native_id LIKE 'sess\\_subagent\\_agent\\_%' ESCAPE '\\'").get()
      assert.equal(stillThere.c, 2, 'dry-run is read-only (nothing deleted)')

      // apply：单事务删除；主会话数据与 provider.health_changed 事件存活
      const applied = cleanupMod.runZcodeSubagentCleanup({ db, apply: true })
      assert.deepEqual(applied.counts, { sessions: 2, messages: 2, events: 3, deliveries: 3, resources: 2, relationships: 2, remoteCommandsDetached: 1 }, `apply counts match preview, got ${JSON.stringify(applied.counts)}`)
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM agent_sessions WHERE native_id LIKE 'sess\\_subagent\\_agent\\_%' ESCAPE '\\'").get().c, 0, 'subagent sessions gone')
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get().c, 1, 'main session survives')
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM agent_messages WHERE session_id = ?").get(mainId).c, 1, 'main messages survive')
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM agent_messages WHERE session_id IN (?, ?)").get(subA, subB).c, 0, 'subagent messages gone')
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM agent_events WHERE event_id = 'degraded:1'").get().c, 1, 'provider.health_changed event untouched')
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM agent_events WHERE event_id = 'zcode:sess_main_real:started'").get().c, 1, 'main session.started untouched')
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM agent_events WHERE event_id LIKE 'zcode:sess_subagent_agent_%'").get().c, 0, 'session-scoped subagent events gone')
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM event_deliveries').get().c, 0, 'deliveries of deleted events gone')
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM resources WHERE resource_type = 'session'").get().c, 1, 'main session resource node survives')
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM relationships').get().c, 1, 'main edge survives, subagent edges gone')
      const cmd = db.prepare('SELECT session_id FROM remote_commands WHERE command_id = ?').get('cmd-1')
      assert.equal(cmd.session_id, null, 'remote_commands detached via FK SET NULL (row kept, not deleted)')

      // 幂等：第二遍 apply 全零（跑两遍结果一致）
      const again = cleanupMod.runZcodeSubagentCleanup({ db, apply: true })
      assert.equal(again.subagentSessions.length, 0, 'second pass finds nothing')
      assert.deepEqual(again.counts, { sessions: 0, messages: 0, events: 0, deliveries: 0, resources: 0, relationships: 0, remoteCommandsDetached: 0 }, `second apply is a zero no-op, got ${JSON.stringify(again.counts)}`)
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM agent_sessions').get().c, 1, 'second pass deletes nothing (idempotent)')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')



  // ------------------------------------------------------------------
  // ux 整改批 A（docs/17 §6 批次 A / §2 R1-R6/R8/R10；append-only 接续）。
  // 注：涉及「最新版本」的既有断言按 AC2 先例（docs/13 §3 授权的同一模式）
  // 就地更新 4→5，逐条已在批次报告单列，等母智能体裁决。
  // ------------------------------------------------------------------

  // 143. migration 005：全新库 user_version=5、新列/新索引齐全；v4 库升级路径
  //      保数据；幂等重跑；migrate.ts case-5 字面量注册（未注册版本显式抛错）
  registerCase('uxa-143: migration 005 — fresh db at user_version 5 with parent_session_id/archived_at/segments_json columns + parent index; hand-built v4 db upgrades preserving rows; idempotent re-run; setUserVersionLiteral case-5 literal registered (unknown version throws)', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const migrateMod = await import(new URL('../src/main/db/migrate.ts', import.meta.url).href)

    // -- 全新库：一次迁到 5；005 新列 + 索引存在
    const dir = mkdtempSync(join(tmpdir(), 'devhub-uxa-143-'))
    const db = dbModule.openDatabase(join(dir, 'fresh.db'))
    try {
      const applied = dbModule.migrate(db)
      assert.equal(applied, 7, '001..006+008 applied on fresh db (CP1 批次就地更新 6→7)')
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 8, 'user_version = 8 (CP1 批次就地更新 6→8)')
      const sessionCols = db.prepare('PRAGMA table_info(agent_sessions)').all().map((c) => c.name)
      assert.ok(sessionCols.includes('parent_session_id'), 'agent_sessions.parent_session_id present')
      assert.ok(sessionCols.includes('archived_at'), 'agent_sessions.archived_at present')
      const messageCols = db.prepare('PRAGMA table_info(agent_messages)').all().map((c) => c.name)
      assert.ok(messageCols.includes('segments_json'), 'agent_messages.segments_json present')
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_agent_sessions_parent'").all()
      assert.equal(indexes.length, 1, 'idx_agent_sessions_parent index created')
      const appliedAgain = dbModule.migrate(db)
      assert.equal(appliedAgain, 0, 'second migrate run applies nothing (idempotent)')
    } finally {
      db.close()
    }

    // -- 手工构造 v4 库（001..004 SQL + 手动 user_version=4）→ migrate 仅应用 005+006，数据保留
    const dir2 = mkdtempSync(join(tmpdir(), 'devhub-uxa-143-v4-'))
    const db2 = dbModule.openDatabase(join(dir2, 'v4.db'))
    try {
      for (const f of ['001_init.sql', '002_env_tools_unique.sql', '003_merge_legacy.sql', '004_agent_control.sql']) {
        db2.exec(readFileSync(new URL('../src/main/db/migrations/' + f, import.meta.url), 'utf8'))
      }
      db2.exec('PRAGMA user_version = 4') // 约束 #11 唯一例外；构造 v4 状态用
      const now = Math.floor(Date.now() / 1000)
      db2.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('zcode', 'ZCode', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (1, 'sess_v4_keep', 'observed', 'running', ?, ?)").run(now, now)
      const applied = dbModule.migrate(db2)
      assert.equal(applied, 3, 'only 005+006+008 apply to the v4 library (CP1 批次就地更新 2→3)')
      assert.equal(Number(db2.prepare('PRAGMA user_version').get().user_version), 8, 'v4 upgraded to 8 (CP1 批次就地更新 6→8)')
      const row = db2.prepare("SELECT native_id, parent_session_id, archived_at FROM agent_sessions WHERE native_id = 'sess_v4_keep'").get()
      assert.ok(row !== undefined, 'v4 session row survived the upgrade')
      assert.equal(row.parent_session_id, null, 'parent_session_id NULL for pre-005 rows')
      assert.equal(row.archived_at, null, 'archived_at NULL for pre-005 rows')
    } finally {
      db2.close()
    }

    // -- migrate.ts 字面量注册：case 5 生效；未注册版本显式抛错（T2 负向护栏延续）
    {
      const { mkdtempSync: mk2 } = await import('node:fs')
      const dir3 = mk2(join(tmpdir(), 'devhub-uxa-143-lit-'))
      const db3 = dbModule.openDatabase(join(dir3, 'lit.db'))
      try {
        migrateMod.setUserVersionLiteral(db3, 5)
        assert.equal(Number(db3.prepare('PRAGMA user_version').get().user_version), 5, 'case-5 literal statement works')
        migrateMod.setUserVersionLiteral(db3, 6) // c7b 批次：case-6 已注册，负向样例顺延 6→7
        assert.equal(Number(db3.prepare('PRAGMA user_version').get().user_version), 6, 'case-6 literal statement works (c7b 批次)')
        migrateMod.setUserVersionLiteral(db3, 8) // CP1 批次：case-8 已注册（007=LR1 未落地，case 7 保持未注册）
        assert.equal(Number(db3.prepare('PRAGMA user_version').get().user_version), 8, 'case-8 literal statement works (CP1 批次)')
        assert.throws(() => migrateMod.setUserVersionLiteral(db3, 7), /no literal user_version statement/, 'unregistered version throws (007=LR1)')
      } finally {
        db3.close()
      }
    }
  }, 'fast')

  // 144. R1/R8：zcode part 结构 → segments 投影（text/reasoning/tool 映射）；
  //      R8 plugin:// 标签化（segments 展示路径零原始 URI，contentRedacted 保留
  //      原文）；thinking 段脱敏；contentRedacted 向后兼容（仍只聚合 text 正文）；
  //      claude 转录 thinking 块 → thinking 段；损坏 segments_json 缺省不猜
  registerCase('uxa-144: R1/R8 segments projection — zcode part types map to text/thinking/toolInvocation segments, plugin:// labeled as short tag in segments but preserved in contentRedacted, thinking content redacted, corrupted segments_json degrades to no segments (never guesses), claude transcript thinking block maps to thinking segment, flat contentRedacted unchanged', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-uxa-144-'))
    const dbPath = join(dir, 'db.sqlite')
    const fdb = new DatabaseSync(dbPath)
    fdb.exec(`
      CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
      CREATE TABLE tool_usage (id TEXT, session_id TEXT, tool_name TEXT, approval_status TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
      CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, sequence INTEGER);
    `)
    const nowMs = 1788537360124
    fdb.prepare("INSERT INTO session (id, directory, title, time_created, time_updated, task_type) VALUES ('sess_uxa_seg', 'C:/ws/demo', 'Seg session', ?, ?, 'interactive')").run(nowMs, nowMs + 1000)
    fdb.prepare("INSERT INTO message (id, session_id, data, sequence, time_created) VALUES ('msg_seg_1', 'sess_uxa_seg', ?, 0, ?)").run(
      JSON.stringify({ role: 'assistant', time: { created: nowMs } }), nowMs)
    // parts：reasoning（含密钥形态文本）+ text（含 plugin:// markdown 引用）+ tool
    fdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('p1', 'msg_seg_1', ?, 0)").run(
      JSON.stringify({ type: 'reasoning', text: 'thinking token=uxathinksecret42 about the problem' }))
    fdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('p2', 'msg_seg_1', ?, 1)").run(
      JSON.stringify({ type: 'text', text: 'start [Android 模拟器](plugin://android-emulator@zcode-plugins-official) now' }))
    fdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('p3', 'msg_seg_1', ?, 2)").run(
      JSON.stringify({ type: 'tool', title: 'Bash', state: { status: 'running', input: { command: 'ls -la' }, description: 'list files' } }))
    fdb.close()

    await makeTempHome('devhub-uxa-144-')
    const db = dbModule.getDatabase()
    try {
      const provider = zcodeMod.createZcodeProvider({ zcodeDbPath: dbPath, tasksIndexPath: join(dir, 'absent.sqlite'), snapshotRoot: join(dir, 'snaps') })
      const page = await provider.readMessages({ providerId: 'zcode', nativeId: 'sess_uxa_seg' })
      assert.equal(page.messages.length, 1, 'one message projected')
      const msg = page.messages[0]
      // contentRedacted 向后兼容：仍只聚合 type=text 正文；保留原始 URI（兼容字段）
      assert.ok(msg.contentRedacted.includes('plugin://android-emulator@zcode-plugins-official'), 'contentRedacted keeps raw plugin URI (compat)')
      assert.ok(!msg.contentRedacted.includes('thinking'), 'contentRedacted unchanged: no reasoning text (flat text-parts only)')
      // segments：text/thinking/toolInvocation 三段；R8 标签化 + 脱敏
      assert.ok(Array.isArray(msg.segments) && msg.segments.length === 3, 'three segments, got ' + JSON.stringify(msg.segments && msg.segments.map((x) => x.kind)))
      const seg0 = msg.segments[0]
      const seg1 = msg.segments[1]
      const seg2 = msg.segments[2]
      // 夹具 part 顺序 = reasoning(0) / text(1) / tool(2) → segments 同序
      assert.equal(seg0.kind, 'thinking')
      assert.ok(seg0.content.includes('token=***'), 'thinking content redacted (token=***)')
      assert.ok(!seg0.content.includes('uxathinksecret42'), 'no plaintext secret in thinking segment')
      assert.equal(seg1.kind, 'text')
      assert.ok(seg1.content.includes('[插件] Android 模拟器'), 'link form labeled: ' + seg1.content)
      assert.ok(!seg1.content.includes('plugin://'), 'segments display path never carries raw plugin:// URI (R8)')
      assert.equal(seg2.kind, 'toolInvocation')
      assert.equal(seg2.label, 'Bash', 'toolInvocation label from part.title')
      assert.ok(seg2.content.includes('list files'), 'toolInvocation content from description')

      // 落库 → listAgentMessages 回读（segments_json 往返）
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('zcode', 'ZCode', ?, ?)").run(now, now)
      const persisted = svc.persistMessage('zcode', 'sess_uxa_seg', msg)
      assert.ok(persisted.recorded, 'message persisted')
      const listed = svc.listAgentMessages({ sessionId: persisted.sessionId, last: 10 })
      assert.equal(listed.items.length, 1)
      assert.equal(listed.items[0].segments.length, 3, 'segments round-trip via segments_json')
      assert.equal(listed.items[0].segments[0].kind, 'thinking', 'thinking segment survives persistence')

      // 损坏 segments_json → 缺省 segments（绝不猜）
      db.prepare('UPDATE agent_messages SET segments_json = ? WHERE native_msg_id = ?').run('not-json{', 'msg_seg_1')
      const degraded = svc.listAgentMessages({ sessionId: persisted.sessionId, last: 10 })
      assert.ok(!('segments' in degraded.items[0]), 'corrupted segments_json degrades to no segments')

      // claude 转录（真机块形 {type:'thinking',thinking:string}）→ thinking 段
      const { writeFileSync, mkdirSync: mkd } = await import('node:fs')
      const claudeHome = join(dir, 'claude-home')
      mkd(join(claudeHome, 'projects', 'F--uxa-fixture'), { recursive: true })
      const transcript = join(claudeHome, 'projects', 'F--uxa-fixture', 'uxa-seg-claude.jsonl')
      writeFileSync(transcript, [
        JSON.stringify({ type: 'user', uuid: 'cu1', timestamp: '2026-09-04T10:00:00Z', message: { role: 'user', content: 'hello claude' } }),
        JSON.stringify({ type: 'assistant', uuid: 'ca1', timestamp: '2026-09-04T10:00:05Z', message: { role: 'assistant', content: [
          { type: 'thinking', thinking: 'claude thinking token=uxaclaudethink77 deep' },
          { type: 'text', text: 'answer [PDF 工具](skill://pdf-tools) ready' },
        ] } }),
      ].join('\n') + '\n')
      const claudeMod = await import(new URL('../src/main/services/agentControl/providers/claudeProvider.ts', import.meta.url).href)
      const claude = claudeMod.createClaudeProvider({ claudeHome, claudeCmd: 'definitely-not-invoked' })
      const cPage = await claude.readMessages({ providerId: 'claude-code', nativeId: 'uxa-seg-claude' })
      assert.equal(cPage.messages.length, 2, 'claude transcript lines projected')
      const cMsg = cPage.messages[1]
      assert.ok(cMsg.segments !== undefined && cMsg.segments.length === 2, 'claude assistant message has thinking+text segments')
      assert.equal(cMsg.segments[0].kind, 'thinking')
      assert.ok(cMsg.segments[0].content.includes('token=***'), 'claude thinking segment redacted')
      assert.ok(!cMsg.segments[0].content.includes('uxaclaudethink77'), 'no plaintext claude secret')
      assert.equal(cMsg.segments[1].kind, 'text')
      assert.ok(cMsg.segments[1].content.includes('[技能] PDF 工具'), 'skill link labeled: ' + cMsg.segments[1].content)
      assert.ok(!cMsg.segments[1].content.includes('skill://'), 'no raw skill:// in segments')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 145. R10：messages 尾部取数（last/before + prevAfter 游标；after 正向不变；
  //      last/after/before 互斥 → BAD_PAYLOAD；nextAfter 语义不变）
  registerCase('uxa-145: R10 tail pagination — last=3 returns newest 3 ASC + prevAfter cursor, before=prevAfter walks older pages ASC until exhausted, after forward semantics unchanged, after/last/before mutually exclusive BAD_PAYLOAD', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    await makeTempHome('devhub-uxa-145-')
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('codex', 'Codex', ?, ?)").run(now, now)
      const info = db.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (1, 'sess_tail', 'observed', 'running', ?, ?)").run(now, now)
      const sessionId = Number(info.lastInsertRowid)
      for (let i = 1; i <= 10; i++) {
        db.prepare("INSERT INTO agent_messages (session_id, native_msg_id, role, content_redacted, occurred_at, created_at) VALUES (?, ?, 'user', ?, ?, ?)").run(
          sessionId, 'tail-' + i, 'message ' + i, now - 100 + i, now)
      }
      const registry = handlers.createHandlerRegistry({ appVersion: 'uxa-smoke' })
      const dispatch = (channel, payload) => handlers.dispatchGatewayRequest(registry, { channel, payload })

      // last=3 → 最新 3 条 ASC + prevAfter
      const tail = await dispatch('agents:messages', { sessionId, last: 3 })
      assert.deepEqual(tail.data.items.map((m) => m.id), [8, 9, 10], 'last=3 returns newest three ASC')
      assert.equal(tail.data.prevAfter, 8, 'prevAfter = oldest id of the page')
      assert.ok(!('nextAfter' in tail.data), 'no nextAfter on tail path')

      // before=prevAfter 续拉更早页；耗尽后无 prevAfter
      const older = await dispatch('agents:messages', { sessionId, before: tail.data.prevAfter, limit: 5 })
      assert.deepEqual(older.data.items.map((m) => m.id), [3, 4, 5, 6, 7], 'before page ASC')
      assert.equal(older.data.prevAfter, 3, 'prevAfter walks to oldest')
      const oldest = await dispatch('agents:messages', { sessionId, before: older.data.prevAfter, limit: 5 })
      assert.deepEqual(oldest.data.items.map((m) => m.id), [1, 2], 'final page')
      assert.ok(!('prevAfter' in oldest.data), 'no prevAfter when exhausted')

      // after 正向语义不变
      const fwd = await dispatch('agents:messages', { sessionId, after: 8, limit: 10 })
      assert.deepEqual(fwd.data.items.map((m) => m.id), [9, 10], 'after forward unchanged')
      assert.ok(!('nextAfter' in fwd.data), 'nextAfter only when page full')

      // 互斥 → BAD_PAYLOAD
      for (const bad of [{ sessionId, last: 3, after: 2 }, { sessionId, last: 3, before: 2 }, { sessionId, after: 2, before: 2 }]) {
        const res = await dispatch('agents:messages', bad)
        assert.equal(res.ok, false, 'mutually exclusive params rejected: ' + JSON.stringify(bad))
        assert.equal(res.error.code, 'BAD_PAYLOAD')
      }
      // last 页大小语义：limit 同时给定时二者取小
      const capped = await dispatch('agents:messages', { sessionId, last: 500, limit: 4 })
      assert.equal(capped.data.items.length, 4, 'last capped by limit (page size semantics)')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 146. R3：archive/unarchive 幂等 + DELETE 级联清理（子会话链连带；消息/事件/
  //      deliveries/资源边清零；remote_commands FK SET NULL 解绑；源文件零触碰
  //      ——物理只读断言；审计落库；重删 NOT_FOUND）
  registerCase('uxa-146: R3 archive/unarchive idempotent + delete cascades child chain (messages/events/deliveries/resources/relationships cleaned, remote_commands detached via FK, source fixture byte-identical), audit rows written, re-delete NOT_FOUND', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const lifecycle = await import(new URL('../src/main/services/agentControl/sessionLifecycle.ts', import.meta.url).href)

    await makeTempHome('devhub-uxa-146-')
    const db = dbModule.getDatabase()
    // 源文件零触碰的物理证据：临时"源转录"文件，删除后逐字节比对
    const sourceFixture = join(tmpdir(), 'devhub-uxa-146-src.jsonl')
    writeFileSync(sourceFixture, 'native transcript bytes -- never touched by devhub\n')
    try {
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('zcode', 'ZCode', ?, ?)").run(now, now)
      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('d', 'android', 'deadbeef', ?, ?, ?)").run(now, now, now)
      const insSession = db.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (1, ?, 'observed', 'running', ?, ?)")
      const mainId = Number(insSession.run('sess_arch_main', now, now).lastInsertRowid)
      const childId = Number(db.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, parent_session_id, created_at, updated_at) VALUES (1, 'sess_arch_child', 'observed', 'running', ?, ?, ?)").run(mainId, now, now).lastInsertRowid)
      assert.ok(childId > 0)
      for (const sid of [mainId, childId]) {
        db.prepare("INSERT INTO agent_messages (session_id, native_msg_id, role, content_redacted, created_at) VALUES (?, ?, 'user', 'm', ?)").run(sid, 'm-' + sid, now)
        db.prepare("INSERT INTO agent_events (provider_id, session_id, event_type, event_id, payload_json, delivery_state, created_at) VALUES (1, ?, 'message.appended', ?, '{}', 'pending', ?)").run(sid, 'ev-' + sid, now)
      }
      const eventIds = db.prepare('SELECT id FROM agent_events ORDER BY id').all().map((r) => r.id)
      for (const eid of eventIds) {
        db.prepare("INSERT INTO event_deliveries (event_id, device_id, status, created_at) VALUES (?, 1, 'pending', ?)").run(eid, now)
      }
      db.prepare("INSERT INTO resources (resource_type, ref_id, display_name, created_at, updated_at) VALUES ('session', ?, 'zcode:main', ?, ?)").run(mainId, now, now)
      const agentRes = Number(db.prepare("INSERT INTO resources (resource_type, ref_id, display_name, created_at, updated_at) VALUES ('agent', 1, 'zcode', ?, ?)").run(now, now).lastInsertRowid)
      const sessionRes = Number(db.prepare("SELECT id FROM resources WHERE resource_type = 'session' AND ref_id = ?").get(mainId).id)
      db.prepare("INSERT INTO relationships (source_resource_id, target_resource_id, relation_type, created_at) VALUES (?, ?, 'exposes', ?)").run(agentRes, sessionRes, now)
      db.prepare("INSERT INTO remote_commands (command_id, idempotency_key, session_id, action, status, expires_at, created_at) VALUES ('cmd-uxa-146', 'key-146', ?, 'reply', 'executed', ?, ?)").run(mainId, now + 600, now)

      // 归档：幂等（重复归档不刷新时间戳）
      const a1 = lifecycle.archiveSession(mainId)
      assert.equal(a1.archived, true)
      assert.ok(typeof a1.archivedAt === 'number')
      const a2 = lifecycle.archiveSession(mainId)
      assert.equal(a2.archivedAt, a1.archivedAt, 're-archive keeps the original archivedAt (idempotent)')
      assert.ok(db.prepare('SELECT archived_at FROM agent_sessions WHERE id = ?').get(mainId).archived_at !== null)
      // 取消归档：幂等
      assert.deepEqual(lifecycle.unarchiveSession(mainId), { sessionId: mainId, archived: false })
      assert.deepEqual(lifecycle.unarchiveSession(mainId), { sessionId: mainId, archived: false }, 'unarchive idempotent')
      assert.equal(db.prepare('SELECT archived_at FROM agent_sessions WHERE id = ?').get(mainId).archived_at, null)

      // 删除主会话 → 子会话连带级联；源文件逐字节不变
      const del = lifecycle.deleteSession(mainId)
      assert.equal(del.deleted, true)
      assert.equal(del.removed.sessions, 2, 'main + child sessions deleted')
      assert.equal(del.removed.messages, 2, 'both sessions messages deleted')
      assert.equal(del.removed.events, 2, 'session-scoped events deleted')
      assert.equal(del.removed.deliveries, 2, 'deliveries of deleted events deleted')
      assert.equal(del.removed.resources, 1, 'main session resource node deleted')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_sessions').get().c, 0, 'no session rows remain')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_messages').get().c, 0, 'no messages remain')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_events').get().c, 0, 'no session-scoped events remain')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM event_deliveries').get().c, 0, 'no deliveries remain')
      assert.equal(db.prepare("SELECT COUNT(*) c FROM resources WHERE resource_type = 'session'").get().c, 0, 'session resource nodes gone')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM relationships').get().c, 0, 'edges gone')
      const cmd = db.prepare("SELECT session_id FROM remote_commands WHERE command_id = 'cmd-uxa-146'").get()
      assert.equal(cmd.session_id, null, 'remote_commands detached (row kept)')
      // 源文件零触碰（红线物理证据）
      assert.equal(readFileSync(sourceFixture, 'utf8'), 'native transcript bytes -- never touched by devhub\n', 'source file byte-identical after delete')
      // 重删 → NOT_FOUND（结构化错误 code）
      let notFound = null
      try { lifecycle.deleteSession(mainId) } catch (e) { notFound = e }
      assert.ok(notFound !== null && notFound.code === 'NOT_FOUND', 're-delete structured NOT_FOUND')
      // 审计
      const actions = db.prepare("SELECT action FROM security_audit_logs WHERE category = 'session' ORDER BY id").all().map((r) => r.action)
      assert.deepEqual(actions, ['session_archived', 'session_unarchived', 'session_deleted'], 'session lifecycle audited: ' + JSON.stringify(actions))
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 147. R2：zcode 父子链端到端（fixture 带 parent_id 列）——子会话快照落库、
  //      默认列表隐藏、parentId= 过滤、sessionDetail childSessions、子会话消息
  //      可见、父不可解析的子会话仍排除；REST 面同构验证（含 includeArchived）。
  //      R4：providerKey/providerLabel 投影。
  // 147. R2/R4：父链端到端（REST 同构面）。
  //      CP1 批次档位归位（fast → full，2026-09-09）：本用例真实拉起 Gateway 并硬编码
  //      gwRequest(8746, ...) —— 按本文件头部归类口径（"拉起 Gateway、占监听端口 → full"）
  //      本就应属 full 档；观察窗内真实应用持有 8746 时，fast 档运行会把配对/读请求
  //      打到真实网关（已发生并单列上报）。断言本体零改动，仅回正档位标记。
  //      已知问题（本批不修，归属原批次）：startGateway 端口顺延 8747-8755 后，
  //      本用例硬编码的 8746 与实际监听口脱钩——8746 被占时即使 full 档也会失败。
  registerCase('uxa-147: R2/R4 parent chain end-to-end — zcode fixture with parent_id imports children via parentNativeSessionId (unresolvable-parent children stay excluded), default list keeps main only, parentId= filter returns children, sessionDetail carries childSessions + providerKey/providerLabel, child messages visible, REST surface isomorphic', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-uxa-147-'))
    const dbPath = join(dir, 'db.sqlite')
    const fdb = new DatabaseSync(dbPath)
    fdb.exec(`
      CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT, parent_id TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
      CREATE TABLE tool_usage (id TEXT, session_id TEXT, tool_name TEXT, approval_status TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
      CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, sequence INTEGER);
    `)
    const nowMs = 1788537360124
    const ins = fdb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('sess_uxa_parent', 'C:/ws/demo', 'Parent session', nowMs, nowMs + 9000, 'interactive', null)
    ins.run('sess_subagent_agent_u147a', 'C:/ws/demo', 'child A', nowMs + 1000, nowMs + 2000, 'subagent_child', 'sess_uxa_parent')
    ins.run('sess_subagent_agent_u147b', 'C:/ws/demo', 'child B', nowMs + 3000, nowMs + 4000, 'subagent_child', 'sess_uxa_parent')
    ins.run('sess_subagent_agent_u147x', 'C:/ws/demo', 'orphan child', nowMs + 5000, nowMs + 6000, 'subagent_child', null)
    fdb.prepare("INSERT INTO message (id, session_id, data, sequence, time_created) VALUES ('m-child-a', 'sess_subagent_agent_u147a', ?, 0, ?)").run(
      JSON.stringify({ role: 'user', time: { created: nowMs + 1500 } }), nowMs + 1500)
    fdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('mp1', 'm-child-a', ?, 0)").run(
      JSON.stringify({ type: 'text', text: 'child A message body' }))
    fdb.close()

    const m = await gwCaseSetup('devhub-uxa-147-')
    const db = m.dbModule.getDatabase()
    try {
      // 夹具 zcode provider 落库（refreshProviderSessions 全量路径）
      const provider = zcodeMod.createZcodeProvider({ zcodeDbPath: dbPath, tasksIndexPath: join(dir, 'absent.sqlite'), snapshotRoot: join(dir, 'snaps') })
      for (const pid of ['codex', 'claude-code', 'kimi', 'deepseek']) svc.setProviderOverride(pid, stubAgentProvider(pid))
      svc.setProviderOverride('zcode', provider)
      svc.ensureAgentProviderRows()
      await svc.refreshProviderSessions('zcode', true)
      // 子会话消息（子会话行已存在 → persistMessage 可直接投影）
      const childPage = await provider.readMessages({ providerId: 'zcode', nativeId: 'sess_subagent_agent_u147a' })
      assert.equal(childPage.messages.length, 1, 'child message projected at provider level')
      const persisted = svc.persistMessage('zcode', 'sess_subagent_agent_u147a', childPage.messages[0])
      assert.ok(persisted.recorded, 'child message persisted into L3')

      // 默认列表：只有主会话（父不可解析的 orphan 也不出现）
      const defaultList = svc.listAgentSessions({})
      assert.deepEqual(defaultList.sessions.map((s) => s.nativeId).sort(), ['sess_uxa_parent'], 'default list = main sessions only')
      // R4：providerKey/providerLabel 投影
      assert.equal(defaultList.sessions[0].providerKey, 'zcode', 'providerKey projected')
      assert.equal(defaultList.sessions[0].providerLabel, 'ZCode', 'providerLabel projected')
      // 库复核：父链落库 + orphan 排除
      const parentRow = db.prepare("SELECT id FROM agent_sessions WHERE native_id = 'sess_uxa_parent'").get()
      const childRows = db.prepare("SELECT id, parent_session_id FROM agent_sessions WHERE native_id LIKE 'sess\\_subagent\\_agent\\_u147%' ESCAPE '\\'").all()
      assert.equal(childRows.length, 2, 'two resolvable-parent children imported')
      assert.ok(childRows.every((r) => r.parent_session_id === parentRow.id), 'children linked to parent row')
      const orphan = db.prepare("SELECT COUNT(*) c FROM agent_sessions WHERE native_id = 'sess_subagent_agent_u147x'").get()
      assert.equal(orphan.c, 0, 'unresolvable-parent child stays excluded (never guesses parent)')

      // parentId= 过滤：子会话页（含已结束）
      const children = svc.listAgentSessions({ parentId: parentRow.id })
      assert.deepEqual(children.sessions.map((s) => s.nativeId).sort(), ['sess_subagent_agent_u147a', 'sess_subagent_agent_u147b'], 'parentId filter returns the two children')

      // sessionDetail：childSessions + providerKey/providerLabel；子会话消息可见
      const detail = svc.getAgentSessionDetail(parentRow.id)
      assert.ok(Array.isArray(detail.session.childSessions) && detail.session.childSessions.length === 2, 'childSessions present in detail view')
      assert.ok(detail.session.childSessions.every((c) => c.providerKey === 'zcode'), 'child sessions carry provider identity too')
      const childDetail = svc.getAgentSessionDetail(detail.session.childSessions[0].id)
      assert.ok(!('childSessions' in childDetail.session), 'childless session omits childSessions field')
      const childMsgs = svc.listAgentMessages({ sessionId: detail.session.childSessions[0].id })
      assert.equal(childMsgs.items.length, 1, 'child session messages visible')

      // REST 同构：默认隐藏子会话/归档可见性/childSessions
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'uxa-147-phone')
      const rAll = await gwRequest(8746, 'GET', '/v1/sessions', { token: dev.token, headers: replayHeaders() })
      assert.equal(rAll.json.sessions.length, 1, 'REST default list hides children')
      assert.equal(rAll.json.sessions[0].providerLabel, 'ZCode', 'REST providerLabel projected')
      const rKids = await gwRequest(8746, 'GET', '/v1/sessions?parentId=' + parentRow.id, { token: dev.token, headers: replayHeaders() })
      assert.equal(rKids.json.sessions.length, 2, 'REST parentId filter works')
      const rDetail = await gwRequest(8746, 'GET', '/v1/sessions/' + parentRow.id, { token: dev.token, headers: replayHeaders() })
      assert.deepEqual(Object.keys(rDetail.json).sort(), ['capabilities', 'session'], 'detail top-level shape unchanged')
      assert.equal(rDetail.json.session.childSessions.length, 2, 'REST detail carries childSessions')
      // 归档 + includeArchived（R3 端到端最小面）
      const lifecycle = await import(new URL('../src/main/services/agentControl/sessionLifecycle.ts', import.meta.url).href)
      lifecycle.archiveSession(parentRow.id)
      const rArchived = await gwRequest(8746, 'GET', '/v1/sessions', { token: dev.token, headers: replayHeaders() })
      assert.equal(rArchived.json.sessions.length, 0, 'archived session hidden by default (R3)')
      const rInc = await gwRequest(8746, 'GET', '/v1/sessions?includeArchived=1', { token: dev.token, headers: replayHeaders() })
      assert.equal(rInc.json.sessions.length, 1, 'includeArchived=1 reveals archived session')
      assert.ok(rInc.json.sessions[0].archivedAt > 0, 'archivedAt projected')
      // REST messages 尾部取数（R10 端到端最小面）
      lifecycle.unarchiveSession(parentRow.id)
      const rTail = await gwRequest(8746, 'GET', '/v1/sessions/' + detail.session.childSessions[0].id + '/messages?last=5', { token: dev.token, headers: replayHeaders() })
      assert.equal(rTail.status, 200)
      assert.equal(rTail.json.items.length, 1, 'REST last= tail works')
      assert.ok(!('sourceRef' in rTail.json.items[0]), 'REST items never carry sourceRef')
    } finally {
      await gwCaseTeardown(m)
    }
  }) // ← CP1 批次档位归位：'fast' → full（默认档），理由见用例上方注记

  // 148. R6：POST /v1/providers/{providerId}/sessions —— managed 门（managed→202、
  //      observed→403 COMMAND_NOT_EXECUTABLE、未验证→403 AGENT_CAPABILITY_MISSING、
  //      未知 provider→404、空 task→400）；幂等（同 key 原结果 / 异 payload 409）；
  //      四件套（无 Token 401）；command.result 事件 + 审计；数字 id 形态受理。
  registerCase('uxa-148: R6 managed-session spawn endpoint — managed gate (202 with sessionId/nativeId, observed 403 COMMAND_NOT_EXECUTABLE, unverified 403 AGENT_CAPABILITY_MISSING, unknown 404, empty task 400), idempotency (same key replays original, different payload 409 COMMAND_KEY_CONFLICT), bearer required 401, command.result event + audit trail, numeric provider id accepted', async () => {
    const m = await gwCaseSetup('devhub-uxa-148-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'uxa-148-phone')
      const now = Math.floor(Date.now() / 1000)
      // codex 行：managed 能力（已验证）；zcode 行：observed（已验证）；kimi：过期能力
      const capsManaged = JSON.stringify({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: now, evidence: 'fixture managed' })
      const capsObserved = JSON.stringify({ mode: 'observed', granted: [], verifiedAt: now, evidence: 'fixture observed' })
      const capsStale = JSON.stringify({ mode: 'managed', granted: ['reply'], verifiedAt: now - 400, evidence: 'stale fixture' })
      db.prepare("INSERT INTO agent_providers (provider, display_name, installed, health, capabilities_json, created_at, updated_at) VALUES ('codex', 'Codex', 1, 'ok', ?, ?, ?)").run(capsManaged, now, now)
      db.prepare("INSERT INTO agent_providers (provider, display_name, installed, health, capabilities_json, created_at, updated_at) VALUES ('zcode', 'ZCode', 1, 'ok', ?, ?, ?)").run(capsObserved, now, now)
      db.prepare("INSERT INTO agent_providers (provider, display_name, installed, health, capabilities_json, created_at, updated_at) VALUES ('kimi', 'Kimi Code', 1, 'ok', ?, ?, ?)").run(capsStale, now, now)
      // 托管启动夹具：经 sink 落快照（managed），返回 ok
      const startedTasks = []
      const spawnStub = (id) => ({
        ...stubAgentProvider(id),
        probeHealth: async () => ({ installed: true, health: 'ok' }),
        getCapabilities: async () => ({ mode: 'managed', granted: ['reply'], verifiedAt: now, evidence: 'fixture managed' }),
        startManagedSession: async (task, sink) => {
          startedTasks.push(task)
          sink.onSessionDiscovered?.(id, { nativeId: 'managed-' + id + '-1', mode: 'managed', lastActivityAt: now })
          return { ok: true, nativeId: 'managed-' + id + '-1', detail: 'fixture managed start' }
        },
      })
      m.svc.setProviderOverride('codex', spawnStub('codex'))
      m.svc.setProviderOverride('zcode', spawnStub('zcode'))

      const post = (path, body, opts = {}) => gwRequest(8746, 'POST', path, {
        body,
        token: opts.token === undefined ? dev.token : opts.token,
        headers: replayHeaders(),
      })

      // managed provider（业务键形态）→ 202 {commandId, status, sessionId, nativeId}
      const r1 = await post('/v1/providers/codex/sessions', { task: 'do the fixture turn', idempotencyKey: 'uxa-148-key-1' })
      assert.equal(r1.status, 202, 'managed spawn -> 202, got ' + r1.status + ' ' + r1.raw)
      assert.equal(r1.json.status, 'executed', 'synchronous managed start executes')
      assert.match(r1.json.commandId, /^cmd-/, 'commandId shape')
      assert.equal(r1.json.nativeId, 'managed-codex-1', 'nativeId returned')
      assert.ok(typeof r1.json.sessionId === 'number' && r1.json.sessionId > 0, 'sessionId resolved from the L3 upsert')
      assert.deepEqual(startedTasks, ['do the fixture turn'], 'provider received the task verbatim')
      // 会话行 managed + running；remote_commands 终态；审计与事件
      const sessRow = db.prepare('SELECT session_mode, status FROM agent_sessions WHERE id = ?').get(r1.json.sessionId)
      assert.equal(sessRow.session_mode, 'managed', 'session row lands as managed')
      assert.equal(sessRow.status, 'running', 'session advances to running')
      const cmdRow = db.prepare('SELECT action, status, result_json FROM remote_commands WHERE command_id = ?').get(r1.json.commandId)
      assert.equal(cmdRow.action, 'spawn', 'remote_commands action = spawn')
      assert.equal(cmdRow.status, 'executed', 'command row executed')
      assert.ok(cmdRow.result_json.includes('"sessionId"'), 'result_json carries sessionId for idempotent replay')
      const ev = db.prepare("SELECT event_type FROM agent_events WHERE event_type = 'command.result' ORDER BY id DESC LIMIT 1").get()
      assert.ok(ev !== undefined, 'command.result event recorded')
      const auditActions = db.prepare("SELECT action FROM security_audit_logs WHERE category = 'command' ORDER BY id").all().map((r) => r.action)
      assert.ok(auditActions.includes('command_accepted') && auditActions.includes('command_executed'), 'audit trail: ' + JSON.stringify(auditActions))

      // 同 key 重试 → 原命令原结果（不重复执行）
      const beforeCount = db.prepare('SELECT COUNT(*) c FROM agent_sessions').get().c
      const rRetry = await post('/v1/providers/codex/sessions', { task: 'do the fixture turn', idempotencyKey: 'uxa-148-key-1' })
      assert.equal(rRetry.status, 202)
      assert.equal(rRetry.json.commandId, r1.json.commandId, 'same key replays original commandId')
      assert.equal(rRetry.json.sessionId, r1.json.sessionId, 'same key replays original sessionId')
      assert.equal(startedTasks.length, 1, 'provider NOT invoked twice (idempotent)')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_sessions').get().c, beforeCount, 'no duplicate session rows')

      // 同 key 异 payload → 409 COMMAND_KEY_CONFLICT
      const rConflict = await post('/v1/providers/codex/sessions', { task: 'different task', idempotencyKey: 'uxa-148-key-1' })
      assert.equal(rConflict.status, 409)
      assert.equal(rConflict.json.error.code, 'COMMAND_KEY_CONFLICT')

      // observed provider → 403 COMMAND_NOT_EXECUTABLE
      const rObserved = await post('/v1/providers/zcode/sessions', { task: 'nope' })
      assert.equal(rObserved.status, 403, 'observed provider refused')
      assert.equal(rObserved.json.error.code, 'COMMAND_NOT_EXECUTABLE', 'COMMAND_NOT_EXECUTABLE for non-managed')
      // 能力过期 → 403 AGENT_CAPABILITY_MISSING
      const rStale = await post('/v1/providers/kimi/sessions', { task: 'nope' })
      assert.equal(rStale.status, 403)
      assert.equal(rStale.json.error.code, 'AGENT_CAPABILITY_MISSING', 'stale capabilities refused')
      // 未知 provider → 404；空 task → 400；无 Token → 401
      const rUnknown = await post('/v1/providers/nope/sessions', { task: 'x' })
      assert.equal(rUnknown.status, 404, 'unknown provider NOT_FOUND')
      const rEmpty = await post('/v1/providers/codex/sessions', { task: '  ' })
      assert.equal(rEmpty.status, 400, 'blank task BAD_PAYLOAD')
      assert.equal(rEmpty.json.error.code, 'BAD_PAYLOAD')
      const rNoAuth = await gwRequest(8746, 'POST', '/v1/providers/codex/sessions', { body: { task: 'x' }, headers: replayHeaders() })
      assert.equal(rNoAuth.status, 401, 'bearer required (four-piece security)')
      // 数字 id 形态受理
      const codexRowId = db.prepare("SELECT id FROM agent_providers WHERE provider = 'codex'").get().id
      const rNumeric = await post('/v1/providers/' + codexRowId + '/sessions', { task: 'numeric id form', idempotencyKey: 'uxa-148-key-2' })
      assert.equal(rNumeric.status, 202, 'numeric provider id accepted, got ' + rNumeric.status + ' ' + rNumeric.raw)
      assert.equal(rNumeric.json.nativeId, 'managed-codex-1', 'same underlying nativeId')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 149. R5/R5.1：自适应刷新节流纯函数（活跃 3s / 空闲 15s / 窗口边界）+
  //      延迟打点纯面（percentile / recordLatencySample / latencySnapshot / reset；
  //      环形封顶；负值折叠；零内容记录）
  registerCase('uxa-149: R5 adaptive refresh throttle pure function (active 3s / idle 15s / window boundaries) + R5.1 latency stats surface (percentile math, sample recording with negative clamp, ring cap, snapshot shape, reset)', async () => {
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const lat = await import(new URL('../src/main/services/agentControl/latencyStats.ts', import.meta.url).href)

    // 自适应节流：纯函数契约
    assert.equal(svc.SESSIONS_REFRESH_ACTIVE_SEC, 3, 'active interval 3s (task-book 2-5s window)')
    assert.equal(svc.SESSIONS_REFRESH_IDLE_SEC, 15, 'idle interval stays 15s')
    assert.equal(svc.PROVIDER_ACTIVE_WINDOW_SEC, 300, 'activity window 5 minutes')
    const now = 1_800_000_000
    assert.equal(svc.sessionsRefreshIntervalSec(now, now - 299), 3, 'recently active -> fast 3s')
    assert.equal(svc.sessionsRefreshIntervalSec(now, now - 300), 3, 'exactly at window boundary -> fast (<=)')
    assert.equal(svc.sessionsRefreshIntervalSec(now, now - 301), 15, 'just past window -> idle 15s')
    assert.equal(svc.sessionsRefreshIntervalSec(now, null), 15, 'no activity evidence -> idle 15s')
    assert.equal(svc.sessionsRefreshIntervalSec(now, 0), 15, 'zero activity -> idle 15s')
    assert.equal(svc.sessionsRefreshIntervalSec(now, now + 5), 3, 'future timestamp (clock skew) still within window')

    // 延迟打点：percentile 纯数学
    assert.equal(lat.percentile([], 50), 0, 'empty -> 0')
    assert.equal(lat.percentile([7], 95), 7, 'single sample')
    assert.equal(lat.percentile([1, 2, 3, 4], 50), 2, 'p50 of [1..4]')
    assert.equal(lat.percentile([1, 2, 3, 4], 100), 4, 'p100 = max')
    assert.equal(lat.percentile([10, 1, 5], 50), 5, 'unsorted input tolerated (sorted internally)')

    lat.resetLatencyStats()
    let snap = lat.latencySnapshot()
    assert.deepEqual(snap['source-to-db'], { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, lastMs: 0 }, 'zeroed snapshot shape')
    for (let i = 1; i <= 100; i++) lat.recordLatencySample('source-to-db', i)
    lat.recordLatencySample('source-to-db', -50) // 负值折叠 0
    lat.recordLatencySample('db-to-ws', 250)
    snap = lat.latencySnapshot()
    assert.equal(snap['source-to-db'].count, 101, 'count includes clamped sample')
    assert.equal(snap['source-to-db'].p95Ms, 95, 'p95 of 1..100 = 95 (nearest-rank)')
    assert.equal(snap['source-to-db'].maxMs, 100, 'max tracked')
    assert.equal(snap['source-to-db'].lastMs, 0, 'last = clamped 0')
    assert.equal(snap['db-to-ws'].count, 1, 'stages tracked independently')
    assert.equal(snap['db-to-ws'].p50Ms, 250, 'single db-to-ws sample')
    // 环形封顶
    for (let i = 0; i < 1000; i++) lat.recordLatencySample('db-to-ws', i)
    snap = lat.latencySnapshot()
    assert.equal(snap['db-to-ws'].count, 1001, 'total count keeps accumulating')
    assert.ok(snap['db-to-ws'].p50Ms > 400, 'ring keeps only the latest window (p50=' + snap['db-to-ws'].p50Ms + ')')
    lat.resetLatencyStats()
    assert.equal(lat.latencySnapshot()['source-to-db'].count, 0, 'reset clears everything')
  }, 'fast')

  // ==================================================================
  // 夜间#1 批次（服务端积压补齐，主控任务书授权）：nb1-150…nb1-154 追加。
  //  - nb1-150 docker:action remove（docs/09 §8.3 DOUBLE_CONFIRM 落地）
  //  - nb1-151 wsl:action shutdownAll（docs/09 §8.2 CONFIRM_REQUIRED + 二次确认文案）
  //  - nb1-152 versions:cancel（docs/09 §7.2 cancelled 分支主动取消）
  //  - nb1-153 agents:probeProvider（per-provider 单独重探正反，known-limitations §3.2）
  //  - nb1-154 WS delivery 修复（设备投递行 upsert + sendFrame 缓冲写语义）
  // 铁律：夹具化（makeTempHome / withIsolatedHome 同源模式）；绝不真删用户容器、
  // 绝不真停宿主 WSL（confirmed 段只做 argv 纯度 + 结构化断言，破坏性执行不进 smoke）。
  // ==================================================================

  // 150. docker remove：argv 纯度（rm 字面量、不带 -f）；枚举正反；daemon down 结构化降级；
  //      daemon up 时容器不存在 → NOT_FOUND（存在性先于确认门）；两段式 dry 门（绝不真删）
  registerCase('nb1-150: docker remove — argv purity (rm literal, no -f), enum round-trip, daemon-down degrade, NOT_FOUND before the gate, two-phase dry gate never deletes', async () => {
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const dockerService = await import(new URL('../src/main/services/dockerService.ts', import.meta.url).href)
    const dockerAdapter = await import(new URL('../src/main/adapters/docker.ts', import.meta.url).href)

    // 纯函数：remove 映射 docker CLI 字面量 `rm`，单参数数组、无 shell、无 -f（绝不静默强杀）
    assert.deepEqual(dockerService.containerActionArgs('remove', 'web'), ['rm', 'web'], 'remove argv is the rm literal')
    assert.deepEqual(dockerService.containerActionArgs('remove', 'abc123'), ['rm', 'abc123'], 'no shell, no flag injection surface')

    const registry = handlers.createHandlerRegistry({ appVersion: 'nb1-smoke' })
    // 反向：remove + 注入样式 name 仍走同一 BAD_PAYLOAD 校验
    for (const name of ['a; rm -rf /', '$(id)', '-9sh']) {
      const rejected = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:action', payload: { name, action: 'remove' } })
      assert.equal(rejected.ok, false, `injection-style name ${JSON.stringify(name)} must be rejected for remove`)
      assert.equal(rejected.error.code, 'BAD_PAYLOAD')
    }
    // 正向：remove 进枚举（s4-62 非法清单已按夜间#1 就地更新移出 remove）
    const info = await dockerAdapter.dockerInfo()

    const dryProbe = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:action', payload: { name: 'no-such-container-zz', action: 'remove' } })
    if (!info.daemonAvailable) {
      // daemon down → 结构化降级（envelope ok，未执行）
      assert.equal(dryProbe.ok, true, 'daemon down: remove degrades in-band')
      assert.equal(dryProbe.data.ok, false)
      assert.equal(dryProbe.data.degraded, true)
      envSkipNote('docker daemon down at run time: remove verified down to the degrade boundary only')
      return
    }
    // daemon up：容器不存在 → NOT_FOUND（存在性校验先于确认门，绝不泄露确认面）
    assert.equal(dryProbe.ok, false, 'daemon up + unknown container folds to NOT_FOUND')
    assert.equal(dryProbe.error.code, 'NOT_FOUND')

    const containers = await dockerAdapter.listContainers()
    if (containers.length === 0) {
      envSkipNote('no containers at run time: two-phase dry gate on a real container skipped')
      return
    }
    const target = containers[0]
    // 两段式 dry：不带 confirmed → confirmRequired + impacts（名/镜像/状态/note，ports 恒空），
    // 绝不执行删除 —— 绝不带 confirmed 重发（真删不进 smoke）
    const gate = await handlers.dispatchGatewayRequest(registry, { channel: 'docker:action', payload: { name: target.name, action: 'remove' } })
    assert.equal(gate.ok, true, `remove gate dispatches, error=${gate.ok ? '' : gate.error.message}`)
    assert.equal(gate.data.confirmRequired, true, 'two-phase gate returned')
    assert.equal(gate.data.impacts.name, target.name, 'impacts name')
    assert.equal(gate.data.impacts.image, target.image ?? undefined, 'impacts image')
    assert.deepEqual(gate.data.impacts.ports, [], 'remove impacts carry no ports (deletion is port-irrelevant)')
    assert.ok(gate.data.impacts.note !== undefined && gate.data.impacts.note.length > 0, 'remove impacts carry the data-impact note')
    const after = await dockerAdapter.listContainers()
    assert.ok(after.some((c) => c.dockerId === target.dockerId), 'dry gate must NOT delete the container (dry proof)')
  })

  // 151. wsl shutdownAll：argv 纯度（--shutdown 字面量）；payload 形状（带 distro → BAD_PAYLOAD；
  //      旧非法字面量 shutdown 仍 BAD_PAYLOAD）；两段式 dry 门（清单 = 实时发行版全集）+
  //      dry 证明（状态零变化）。绝不真停宿主 WSL —— confirmed 执行不进 smoke（破坏宿主 VM）
  registerCase('nb1-151: wsl shutdownAll — argv purity, payload shape (no distro param), two-phase dry gate lists every distro, dry proof (zero state change)', async () => {
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const wslService = await import(new URL('../src/main/services/wslService.ts', import.meta.url).href)
    const wslAdapter = await import(new URL('../src/main/adapters/wsl.ts', import.meta.url).href)

    // 纯函数：VM 级全停 = 单一 --shutdown 字面量（参数数组经 exec，绝不拼 shell）
    assert.deepEqual(wslService.shutdownAllArgs(), ['--shutdown'], 'shutdownAll argv is the --shutdown literal')

    const registry = handlers.createHandlerRegistry({ appVersion: 'nb1-smoke' })
    // 形状：shutdownAll 不接受 distro 参数（全停语义，防"单发行版关停"误导）
    const withDistro = await handlers.dispatchGatewayRequest(registry, { channel: 'wsl:action', payload: { distro: 'Ubuntu', action: 'shutdownAll' } })
    assert.equal(withDistro.ok, false, 'shutdownAll must reject a distro parameter')
    assert.equal(withDistro.error.code, 'BAD_PAYLOAD')
    // 旧非法字面量 shutdown 仍是 BAD_PAYLOAD（与 shutdownAll 严格区分）
    const badLiteral = await handlers.dispatchGatewayRequest(registry, { channel: 'wsl:action', payload: { action: 'shutdown' } })
    assert.equal(badLiteral.error.code, 'BAD_PAYLOAD', 'shutdown (without All) stays invalid')

    const distros = await wslAdapter.listDistros()
    if (distros.length === 0) {
      envSkipNote('wsl.exe -l -v returned no distros at run time (transient host state)')
      return
    }
    // 两段式 dry：confirmRequired + 全量清单 + docker-desktop 单列 + note；只读探测绝不唤醒已停发行版
    const gate = await handlers.dispatchGatewayRequest(registry, { channel: 'wsl:action', payload: { action: 'shutdownAll' } })
    assert.equal(gate.ok, true, `shutdownAll gate dispatches, error=${gate.ok ? '' : gate.error.message}`)
    assert.equal(gate.data.confirmRequired, true, 'two-phase gate returned')
    assert.equal(gate.data.impacts.distros.length, distros.length, 'impacts list every known distro (stop-all semantics)')
    assert.deepEqual(
      gate.data.impacts.distros.map((d) => d.name).sort(),
      distros.map((d) => d.name).sort(),
      'impacts names match the live list exactly',
    )
    assert.deepEqual(
      gate.data.impacts.dockerDesktopDistros,
      distros.filter((d) => d.name.toLowerCase().startsWith('docker-desktop')).map((d) => d.name),
      'docker-desktop distros listed separately',
    )
    assert.ok(gate.data.impacts.note.includes('--shutdown'), 'note names the wsl.exe --shutdown action')
    assert.ok(gate.data.impacts.note.toLowerCase().includes('not boot'), 'note states stopped distros are NOT booted')
    // dry 证明：gate 前后发行版状态逐一相同（列表探测零副作用）
    const after = await wslAdapter.listDistros()
    assert.deepEqual(
      after.map((d) => `${d.name}:${d.state}`).sort(),
      distros.map((d) => `${d.name}:${d.state}`).sort(),
      'dry gate must not change any distro state',
    )
    // confirmed 执行（wsl --shutdown 会停掉宿主整个 WSL VM）：绝不进 smoke，argv 纯度已断言
  })

  // 152. versions:cancel：无活跃任务 → 结构化空操作；长任务 killTree 中断 → cancelled 终态；
  //      多活跃任务无 jobId → BAD_PAYLOAD 消歧；未知 jobId → NOT_FOUND；已结束 → no-op；
  //      dispatch envelope 全链路
  registerCase('nb1-152: versions:cancel — structured no-op with zero running jobs, killTree interrupts a long update job to terminal cancelled, multi-running BAD_PAYLOAD without jobId, unknown NOT_FOUND, finished no-op, dispatch envelope', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const catalog = await import(new URL('../src/main/services/versionCenter/catalog.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/versionCenter/versionService.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)

    await makeTempHome('devhub-nb1-152-')
    // 长任务夹具命令：60s 心跳 setInterval（绝不自然结束，等 cancel killTree 收尾）
    const longArgs = ['-e', 'setInterval(() => {}, 60000)']
    try {
      // (a) 零活跃任务：结构化空操作（不抛）
      const idle = await svc.cancelUpdateJob()
      assert.equal(idle.cancelled, false, 'zero running jobs -> structured no-op')
      assert.ok(idle.note !== undefined && idle.note.length > 0, 'no-op carries a structured note')

      // (b) 长任务 → cancel(jobId) → killTree → cancelled 终态
      const kimi = catalog.findCatalogEntry('kimi-cli')
      const job = svc.startUpdateJob(kimi, { updateCommandOverride: { command: process.execPath, args: longArgs } })
      assert.equal(job.status, 'running', 'long job starts running')
      const stopped = await svc.cancelUpdateJob(job.jobId)
      assert.equal(stopped.cancelled, true, 'cancel reports a real cancellation')
      assert.equal(stopped.status, 'cancelled')
      assert.equal(stopped.entryId, 'kimi-cli')
      const snap = svc.jobSnapshot(job.jobId)
      assert.equal(snap.status, 'cancelled', 'job snapshot reaches terminal cancelled')
      assert.ok(snap.log.some((l) => l.includes('cancel')), 'job log records the cancellation')
      await new Promise((r) => setTimeout(r, 800)) // killTree 树杀收尾余量（不留孤儿 node 进程）

      // (c) 已取消任务再 cancel → no-op（终态不被改写）
      const again = await svc.cancelUpdateJob(job.jobId)
      assert.equal(again.cancelled, false, 're-cancel of a finished job is a no-op')
      assert.equal(again.status, 'cancelled', 'terminal state preserved')

      // (d) 未知 jobId → NOT_FOUND
      let missing = null
      try {
        await svc.cancelUpdateJob('vc-nope')
      } catch (err) {
        missing = err
      }
      assert.equal(missing?.code, 'NOT_FOUND')

      // (e) 双活跃任务 + 无 jobId → BAD_PAYLOAD 消歧（要求显式 jobId）
      const grok = catalog.findCatalogEntry('grok-cli')
      const j1 = svc.startUpdateJob(kimi, { updateCommandOverride: { command: process.execPath, args: longArgs } })
      const j2 = svc.startUpdateJob(grok, { updateCommandOverride: { command: process.execPath, args: longArgs } })
      let ambiguous = null
      try {
        await svc.cancelUpdateJob()
      } catch (err) {
        ambiguous = err
      }
      assert.equal(ambiguous?.code, 'BAD_PAYLOAD', 'multiple running jobs without jobId folds to BAD_PAYLOAD')
      const c1 = await svc.cancelUpdateJob(j1.jobId)
      const c2 = await svc.cancelUpdateJob(j2.jobId)
      assert.equal(c1.cancelled && c2.cancelled, true, 'both jobs cancellable by explicit jobId')
      await new Promise((r) => setTimeout(r, 800))

      // (f) dispatch envelope：registry 全链路（空任务 no-op / 空 jobId BAD_PAYLOAD / 未知 NOT_FOUND）
      const registry = handlers.createHandlerRegistry({ appVersion: 'nb1-smoke' })
      const envIdle = await handlers.dispatchGatewayRequest(registry, { channel: 'versions:cancel', payload: {} })
      assert.equal(envIdle.ok, true, 'versions:cancel dispatches')
      assert.equal(envIdle.data.cancelled, false, 'envelope no-op with zero running jobs')
      const envEmpty = await handlers.dispatchGatewayRequest(registry, { channel: 'versions:cancel', payload: { jobId: '' } })
      assert.equal(envEmpty.error.code, 'BAD_PAYLOAD', 'empty jobId folds to BAD_PAYLOAD')
      const envMissing = await handlers.dispatchGatewayRequest(registry, { channel: 'versions:cancel', payload: { jobId: 'vc-nope' } })
      assert.equal(envMissing.error.code, 'NOT_FOUND', 'unknown jobId folds to NOT_FOUND')
    } finally {
      dbModule.closeDatabase()
    }
  })

  // 153. agents:probeProvider：stub provider 单家重探（health 落库 + lastProbeAt 戳 +
  //      health_changed 事件 + 该家会话快照强刷）；二次重探无变化 → healthChanged:false；
  //      未注册 providerId → NOT_FOUND；形状非法 → BAD_PAYLOAD
  registerCase('nb1-153: agents:probeProvider — single-provider force probe persists health + refreshes that provider sessions + health_changed on change, second probe healthChanged:false, unknown NOT_FOUND, malformed BAD_PAYLOAD', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    await makeTempHome('devhub-nb1-153-')
    const registry = handlers.createHandlerRegistry({ appVersion: 'nb1-smoke' })
    const dispatch = (channel, payload) => handlers.dispatchGatewayRequest(registry, { channel, payload })
    try {
      // 五家全部夹具化（hermetic：真机探测绝不进 smoke，ac2-87 先例）
      svc.setProviderOverride('codex', stubAgentProvider('codex', { health: 'ok', installed: true, version: '1.2.3', sessions: [
        { nativeId: 'nb1-probe-sess', title: 'nb1 probe session', lastActivityAt: Math.floor(Date.now() / 1000) },
      ] }))
      svc.setProviderOverride('claude-code', stubAgentProvider('claude-code'))
      svc.setProviderOverride('kimi', stubAgentProvider('kimi'))
      svc.setProviderOverride('zcode', stubAgentProvider('zcode'))
      svc.setProviderOverride('deepseek', stubAgentProvider('deepseek'))

      // catalog ensure（probeProviderById 内部也会 ensure，这里顺带拿 codex 行 id）
      const providers = await dispatch('agents:providers', {})
      assert.equal(providers.ok, true, 'providers list dispatches (catalog ensured)')
      const codex = providers.data.providers.find((p) => p.displayName === 'Codex')
      assert.ok(codex !== undefined, 'codex row present')

      // 夹具态拨弄：list 轮询已触发过一次全量探测（unknown -> ok 已发事件），这里把
      // codex 行 health 直拨 'degraded'，让显式重探的「变化沿」可观测
      const db = dbModule.getDatabase()
      db.prepare("UPDATE agent_providers SET health = 'degraded', health_detail = 'nb1 fixture flip' WHERE provider = 'codex'").run()

      // 正向：单家重探 → 落库投影 + 会话强刷（stub listSessions 的快照落为会话行）
      const probe = await dispatch('agents:probeProvider', { providerId: codex.id })
      assert.equal(probe.ok, true, `probe dispatches, error=${probe.ok ? '' : probe.error.message}`)
      assert.equal(probe.data.provider.health, 'ok', 'stub health persisted and projected')
      assert.equal(probe.data.provider.version, '1.2.3', 'version persisted')
      assert.ok(probe.data.provider.lastProbeAt !== null, 'lastProbeAt stamped by the force probe')
      assert.equal(probe.data.healthChanged, true, 'degraded -> ok is a health change')
      const sess = db.prepare("SELECT id FROM agent_sessions WHERE native_id = 'nb1-probe-sess'").get()
      assert.ok(sess !== undefined, 'force probe refreshed that provider sessions (snapshot upserted)')
      const ev = db.prepare("SELECT id FROM agent_events WHERE event_type = 'provider.health_changed' AND payload_json LIKE '%codex%'").get()
      assert.ok(ev !== undefined, 'provider.health_changed event recorded on change')

      // 二次重探：health 无变化 → healthChanged:false（不再重复发事件）
      const probe2 = await dispatch('agents:probeProvider', { providerId: codex.id })
      assert.equal(probe2.ok, true)
      assert.equal(probe2.data.healthChanged, false, 'unchanged health records no event')

      // 反向：未注册 providerId → NOT_FOUND；形状非法 → BAD_PAYLOAD
      const unknown = await dispatch('agents:probeProvider', { providerId: 424242 })
      assert.equal(unknown.ok, false, 'unregistered provider folds to NOT_FOUND')
      assert.equal(unknown.error.code, 'NOT_FOUND')
      for (const bad of [{ providerId: 0 }, { providerId: -1 }, { providerId: 'x' }, {}]) {
        const rejected = await dispatch('agents:probeProvider', bad)
        assert.equal(rejected.ok, false, `malformed payload ${JSON.stringify(bad)} rejected`)
        assert.equal(rejected.error.code, 'BAD_PAYLOAD')
      }
    } finally {
      svc.clearProviderOverrides()
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  }, 'fast')

  // 154. WS delivery 修复（ux-final-report §4.3/§8 遗留）：设备投递行 upsert ——
  //      事件先于配对落库（零 deliveries 行）→ markEventDelivered 补建 delivered 行 +
  //      聚合推进；markEventAcked 补建 acked 行（delivered_at 补齐）；只前进不回退；
  //      ack 后移出补发集；sendFrame 把缓冲写（write=false）计为已发出
  registerCase('nb1-154: ws delivery repair — late-paired device gets an INSERTed delivered row on markEventDelivered and the aggregate advances, markEventAcked upserts acked (delivered_at backfilled), forward-only preserved, acked leaves the replay set, sendFrame counts a buffered (false) write as sent', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const ep = await import(new URL('../src/main/services/agentControl/eventPipeline.ts', import.meta.url).href)
    const wsMod = await import(new URL('../src/main/services/agentControl/gateway/ws.ts', import.meta.url).href)

    await makeTempHome('devhub-nb1-154-')
    const db = dbModule.getDatabase()
    try {
      const now = Math.floor(Date.now() / 1000)
      // 事件先落库（此刻零活跃设备 → 零 deliveries 行），设备后配对（late-paired）
      const rec1 = ep.recordEvent({ eventType: 'session.status_changed', providerKey: 'codex', nativeId: 'nb1-late', payload: { from: 'running', to: 'waiting_input' }, fingerprint: 'nb1-154-fp-1' })
      assert.equal(rec1.recorded, true)
      assert.equal(rec1.deliveries, 0, 'no active devices -> zero delivery rows at record time')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM event_deliveries WHERE event_id = ?').get(rec1.sequence).c, 0)

      const devInfo = db
        .prepare(
          "INSERT INTO remote_devices (device_name, platform, token_hash, token_version, status, paired_at, created_at, updated_at) VALUES ('nb1-late-phone', 'android', 'nb1-154-token-hash', 1, 'active', ?, ?, ?)",
        )
        .run(now, now, now)
      const deviceId = Number(devInfo.lastInsertRowid)

      // WS push / sync 补发真实送达 → markEventDelivered：旧行为零更新 → 现在补建 delivered 行，
      // 聚合不再恒 pending（修复点 1）
      const delivered = ep.markEventDelivered(rec1.sequence, deviceId)
      assert.equal(delivered.updated, true, 'delivery recorded for the late-paired device')
      assert.equal(delivered.state, 'delivered', 'aggregate advances to delivered')
      const dRow = db.prepare('SELECT status, delivered_at FROM event_deliveries WHERE event_id = ? AND device_id = ?').get(rec1.sequence, deviceId)
      assert.equal(dRow.status, 'delivered', 'delivered row INSERTed (was missing entirely)')
      assert.ok(dRow.delivered_at !== null, 'delivered_at stamped')

      // ack：可跳过 delivered 直达；同样补建行语义（修复点 1 的 ack 面）
      const rec2 = ep.recordEvent({ eventType: 'message.appended', providerKey: 'codex', nativeId: 'nb1-late', payload: { role: 'user' }, fingerprint: 'nb1-154-fp-2' })
      const acked = ep.markEventAcked(rec2.sequence, deviceId)
      assert.equal(acked.updated, true)
      assert.equal(acked.state, 'acked', 'ack advances the aggregate (pending -> acked direct)')
      const aRow = db.prepare('SELECT status, delivered_at, acked_at FROM event_deliveries WHERE event_id = ? AND device_id = ?').get(rec2.sequence, deviceId)
      assert.equal(aRow.status, 'acked', 'acked row INSERTed')
      assert.ok(aRow.delivered_at !== null && aRow.acked_at !== null, 'delivered_at backfilled on ack (semantic: delivered before acked)')

      // rec1 推进到 acked 后：只前进（delivered 拒绝回退）
      const acked1 = ep.markEventAcked(rec1.sequence, deviceId)
      assert.equal(acked1.state, 'acked')
      const regressed = ep.markEventDelivered(rec1.sequence, deviceId)
      assert.equal(regressed.updated, false, 'delivered-after-acked stays a forward-only no-op')
      assert.equal(regressed.state, 'acked', 'no regression')

      // ack 后移出补发集（未确认不删，ack 即移出——重连补发窗口语义不变）
      const page = ep.eventsSince(0, deviceId)
      assert.ok(page.events.every((e) => e.sequence !== rec1.sequence && e.sequence !== rec2.sequence), 'acked events leave the replay set')

      // 修复点 2：sendFrame 把「write 返回 false（已接受进缓冲，随后必然冲刷）」计为已发出，
      // 不再漏掉 markEventDelivered（慢链路/隧道背压场景）
      const fakeSocket = { write: () => false, on: () => {}, destroy: () => {} }
      const conn = new wsMod.GatewayWsConnection(deviceId, 'nb1-probe', fakeSocket, { onText() {}, onClosed() {} }, 30000, 10000)
      assert.equal(conn.sendFrame({ type: 'hello', sequence: 0, device: deviceId, heartbeatSec: 30 }), true, 'buffered write (write=false) counts as sent')
      conn.closed = true
      assert.equal(conn.sendFrame({ type: 'hello', sequence: 0, device: deviceId, heartbeatSec: 30 }), false, 'closed connection still reports not-sent')
    } finally {
      dbModule.closeDatabase()
    }
  }, 'fast')

  // ====================================================================
  // M2-R1 收尾批 — relay-client smoke 段（docs/19 §4 + docs/20 §2.1 R1 验收线①-⑧）。
  // 帧数据源 = ecs-relay/test/fixtures/frames.json（16 帧权威 fixture，逐字段对拍，
  // 禁止手抄帧——动态字段以 fixture 样本为底覆写）；内存 ECS Relay 桩（host 腿 WS）
  // 监听 127.0.0.1:18443 类段外端口（占用顺延，严禁碰 smoke 门禁段 8746-8755）。
  // 既有 156 用例零改动（append-only，约束 #27）。
  // ====================================================================
  const { writeFileSync, readFileSync, readdirSync } = await import('node:fs')
  const { join } = await import('node:path')

  /** fixture 只读装载（权威帧源，零手抄）。 */
  const r1Fixture = JSON.parse(readFileSync(new URL('../ecs-relay/test/fixtures/frames.json', import.meta.url), 'utf8'))

  /** 取 fixture 帧 #no 指定 leg 的样本深拷贝（动态字段由用例覆写，帧源仍是 fixture）。 */
  function r1FixtureFrame(no, leg) {
    const entry = r1Fixture.frames.find((f) => f.no === no)
    assert.ok(entry !== undefined, `fixture frame #${no} present`)
    const sample = leg === undefined ? entry.samples[0] : entry.samples.find((s) => s.leg === leg)
    assert.ok(sample !== undefined, `fixture frame #${no} leg "${leg}" present`)
    return JSON.parse(JSON.stringify(sample.frame))
  }

  /** 取 fixture hostControlFrames（16 帧之外的 host 腿控制面）指定 leg 样本深拷贝。 */
  function r1FixtureControlFrame(leg) {
    const entry = r1Fixture.hostControlFrames[0]
    assert.ok(entry !== undefined, 'fixture hostControlFrames entry present')
    const sample = entry.samples.find((s) => s.leg === leg)
    assert.ok(sample !== undefined, `fixture hostControlFrames leg "${leg}" present`)
    return JSON.parse(JSON.stringify(sample.frame))
  }

  /** 服务端视角解析一帧客户端帧（客户端帧必带掩码，RFC6455 §5.1）；返回一帧 + 余量。 */
  function r1ParseMaskedClientFrame(buf) {
    if (buf.length < 2) return { frame: null, rest: buf }
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < offset + 2) return { frame: null, rest: buf }
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) return { frame: null, rest: buf }
      len = Number(buf.readBigUInt64BE(offset))
      offset += 8
    }
    if (masked) {
      if (buf.length < offset + 4 + len) return { frame: null, rest: buf }
      const maskKey = buf.subarray(offset, offset + 4)
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len))
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
      return { frame: { opcode, masked, payload }, rest: buf.subarray(offset + 4 + len) }
    }
    if (buf.length < offset + len) return { frame: null, rest: buf }
    return { frame: { opcode, masked, payload: Buffer.from(buf.subarray(offset, offset + len)) }, rest: buf.subarray(offset + len) }
  }

  /**
   * 内存 ECS Relay 桩（host 腿 WS 服务端，ac6 自搓 WS 同源做法）：段外回环端口
   * 监听（18443 起 EADDRINUSE 顺延 +9，绝不占用 8746-8755 门禁段）；upgrade 头
   * 原样留档（凭据运输面审计数据源）；收帧必掩码、发帧必不掩码（RFC6455 §5.1
   * 对称面）；ping 即 pong；每次收到的协议帧留档 stub.log（红线扫描数据源）。
   */
  async function r1StartRelayStub(portHint = 18443) {
    const { createServer } = await import('node:http')
    const { createHash } = await import('node:crypto')
    const stub = { server: null, port: null, connections: [], upgrades: [], log: [] }
    const handleUpgrade = (req, socket) => {
      const key = req.headers['sec-websocket-key']
      const accept = createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
      socket.setNoDelay(true)
      const conn = { socket, received: [], closeCode: null, alive: true, headers: { authorization: req.headers.authorization ?? null } }
      stub.connections.push(conn)
      stub.upgrades.push(conn.headers)
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])
        while (true) {
          const parsed = r1ParseMaskedClientFrame(buffer)
          if (parsed.frame === null) break
          buffer = parsed.rest
          const { opcode, payload } = parsed.frame
          if (opcode === 0x8) {
            conn.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null
            conn.alive = false
            try { socket.destroy() } catch { /* 已关 */ }
            return
          }
          if (opcode === 0x9) {
            try { socket.write(encodeClientFrame(0xA, payload, { mask: false })) } catch { /* 已关 */ }
            continue
          }
          if (opcode === 0xA) continue
          if (opcode === 0x1 || opcode === 0x2) {
            const text = payload.toString('utf8')
            let json
            try { json = JSON.parse(text) } catch { json = undefined }
            conn.received.push({ opcode, text, json })
            stub.log.push({ conn, json, text })
          }
        }
      })
      socket.on('error', () => { conn.alive = false })
      socket.on('close', () => { conn.alive = false })
    }
    const tryListen = (port) =>
      new Promise((resolve, reject) => {
        const server = createServer()
        server.on('error', reject)
        server.on('upgrade', handleUpgrade)
        server.listen(port, '127.0.0.1', () => resolve(server))
      })
    let lastErr = null
    for (let p = portHint; p < portHint + 10; p += 1) {
      try {
        stub.server = await tryListen(p)
        stub.port = p
        return stub
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr ?? new Error('relay stub listen failed')
  }

  /** 桩向最新活跃连接发一帧服务端 JSON（不掩码，RFC6455 §5.1 服务端方向）。 */
  function r1StubSend(stub, obj, conn) {
    const target = conn ?? [...stub.connections].reverse().find((c) => c.alive)
    assert.ok(target !== undefined && target.alive, 'relay stub has an alive connection to send on')
    target.socket.write(encodeClientFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'), { mask: false }))
  }

  /** 轮询等待桩收到匹配帧（跨全部连接；等待期内新增连接也参与匹配）。 */
  async function r1StubWait(stub, predicate, timeoutMs = 3000, label = 'relay stub frame') {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const conn of stub.connections) {
        const hit = conn.received.find(predicate)
        if (hit !== undefined) {
          conn.received.splice(conn.received.indexOf(hit), 1)
          return { conn, ...hit }
        }
      }
      await sleep(20)
    }
    throw new Error(`relay stub waitFrame timeout: ${label}`)
  }

  /** 桩收尾（先毁全部连接再关监听；零孤儿端口）。 */
  async function r1StubClose(stub) {
    for (const conn of stub.connections) {
      conn.alive = false
      try { conn.socket.destroy() } catch { /* 已关 */ }
    }
    stub.connections.length = 0
    if (stub.server !== null) await new Promise((resolve) => stub.server.close(() => resolve()))
  }

  /**
   * nb-r1 全栈用例夹具（隔离 home + relay 模块单例清场 + 凭据文件 env 缝）：
   * ac6 gwCaseSetup 同款纪律 + relayClient 特有面（DEVHUB_RELAY_CREDENTIAL_FILE
   * 覆盖进临时 home，teardown 还原；监控关闭 hermetic，ac2-87 先例）。
   */
  async function r1CaseSetup(prefix) {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const settingsSvc = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
    const relay = await import(new URL('../src/main/services/agentControl/relayClient/index.ts', import.meta.url).href)
    const auth = await import(new URL('../src/main/services/agentControl/gateway/auth.ts', import.meta.url).href)
    const providerRegistry = await import(new URL('../src/main/services/agentControl/providerRegistry.ts', import.meta.url).href)
    const dir = await makeTempHome(prefix)
    dbModule.getDatabase()
      .prepare("INSERT INTO settings (key, value) VALUES ('agents_monitor_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'")
      .run()
    const prevCredFile = process.env.DEVHUB_RELAY_CREDENTIAL_FILE
    const credentialFile = join(dir, 'relay-credential.txt')
    process.env.DEVHUB_RELAY_CREDENTIAL_FILE = credentialFile
    return { dbModule, svc, settingsSvc, relay, auth, providerRegistry, credentialFile, prevCredFile }
  }

  /** nb-r1 用例收尾（relay 单例复位 → 配对内存态复位 → env 还原 → 关库）。 */
  async function r1CaseTeardown(m) {
    m.providerRegistry.clearProviderOverrides()
    m.svc.stopAllAgentControlRuntime()
    m.relay.resetRelayClientForSmoke()
    const pairing = await import(new URL('../src/main/services/agentControl/gateway/pairing.ts', import.meta.url).href)
    pairing.resetPairingState()
    if (m.prevCredFile === undefined) delete process.env.DEVHUB_RELAY_CREDENTIAL_FILE
    else process.env.DEVHUB_RELAY_CREDENTIAL_FILE = m.prevCredFile
    m.dbModule.closeDatabase()
  }

  /** 夹具设备行（remote_devices；token 明文仅内存流转，落库只有 sha256——红线）。 */
  function r1FixtureDevice(m, db, name, token) {
    const now = Math.floor(Date.now() / 1000)
    const info = db
      .prepare(
        'INSERT INTO remote_devices (device_name, platform, token_hash, token_version, status, paired_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
      )
      .run(name, 'android', m.auth.sha256Hex(token), 'active', now, now, now)
    return Number(info.lastInsertRowid)
  }

  /** 夹具 managed provider（能力门全授予 + sendReply 计数桩，ac6-128 同款缝）。 */
  async function r1FixtureManagedProvider(m, db, tag) {
    const providerId = fixtureProviderRow(db, 'kimi')
    db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE id = ?').run(
      JSON.stringify({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: Math.floor(Date.now() / 1000), evidence: 'fixture override' }),
      providerId,
    )
    const sessionId = fixtureSessionRow(db, providerId, `${tag}-sess`, 'managed')
    const calls = { reply: 0 }
    m.providerRegistry.setProviderOverride('kimi', {
      id: 'kimi',
      probeHealth: async () => ({ status: 'ok' }),
      listSessions: async () => [],
      readMessages: async () => ({ items: [] }),
      getCapabilities: async () => ({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: Math.floor(Date.now() / 1000), evidence: 'fixture override' }),
      sendReply: async () => { calls.reply += 1; return { ok: true, status: 'executed' } },
      pause: async () => ({ ok: false, status: 'unsupported', detail: 'fixture' }),
      resume: async () => ({ ok: false, status: 'unsupported', detail: 'fixture' }),
      startMonitor: () => ({ providerId: 'kimi', stop: async () => {} }),
      dispose: async () => {},
    })
    return { providerId, sessionId, calls }
  }

  /** 启用 relay 三件套（gateway_enabled 前提 + relay_enabled/endpoint）并装配凭据文件。 */
  function r1EnableRelay(m, stub, credential) {
    m.settingsSvc.setSetting('gateway_enabled', '1')
    m.settingsSvc.setSetting('relay_enabled', '1')
    m.settingsSvc.setSetting('relay_endpoint', `ws://127.0.0.1:${stub.port}`)
    writeFileSync(m.credentialFile, `${credential}\n`, 'utf8')
  }

  /** hello 握手（桩收到连接后发 fixture #1 host 腿样本；sequence 供回填对拍覆写）。 */
  async function r1HelloNewConnection(stub, { sequence = 0 } = {}) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const conn = stub.connections.find((c) => c.helloSent !== true)
      if (conn !== undefined) {
        conn.helloSent = true
        const hello = r1FixtureFrame(1, 'host')
        hello.sequence = sequence
        r1StubSend(stub, hello, conn)
        return conn
      }
      await sleep(20)
    }
    throw new Error('relay stub: no new connection to greet with hello')
  }

  // 155. 16 帧 round-trip 逐帧对拍 fixture（docs/20 §2.4 三线契约防漂移）：
  //      客户端 TX（encodeClientTextFrame 必掩码 → 桩视角掩码解析 → 字段同一性）×
  //      服务端 TX（不掩码 → RelayClientConnection 真实解析路径 → 字段同一性）双方向，
  //      16 帧型 + host 腿控制帧全样本；掩码方向对称红线（服务端帧带掩码 → 1002）。
  registerCase('nb-r1-155: relay 16-frame fixture round-trip — every fixture sample (16 frame types + host-leg control frames) survives client-TX masked encode/decode and server-TX parse with field identity; masking direction red line (masked server frame -> 1002)', async () => {
    assert.equal(r1Fixture.frames.length, 16, 'fixture carries the full 16-frame protocol table (docs/18 §3)')
    for (const entry of r1Fixture.frames) {
      assert.ok(entry.samples.length >= 1, `frame #${entry.no} ${entry.type} has samples`)
    }
    const samples = [
      ...r1Fixture.frames.flatMap((f) => f.samples.map((s) => ({ frameType: f.type, no: f.no, leg: s.leg, frame: s.frame }))),
      ...r1Fixture.hostControlFrames.flatMap((h) => h.samples.map((s) => ({ frameType: h.type, no: 'hostControl', leg: s.leg, frame: s.frame }))),
    ]
    assert.ok(samples.length >= 35, `fixture sample coverage, got ${samples.length}`)

    const wsMod = await import(new URL('../src/main/services/agentControl/relayClient/wsClient.ts', import.meta.url).href)
    let clientTx = 0
    let serverTx = 0
    for (const sample of samples) {
      // 客户端 TX：编码 → 必带掩码（RFC6455 §5.1）→ 桩视角掩码解析 → 字段同一性
      const wire = wsMod.encodeClientTextFrame(sample.frame)
      assert.equal((wire[1] & 0x80) !== 0, true, `client frame ${sample.frameType}/${sample.leg} MUST be masked`)
      const decoded = r1ParseMaskedClientFrame(wire)
      assert.ok(decoded.frame !== null, `client frame ${sample.frameType}/${sample.leg} decodes fully`)
      assert.equal(decoded.rest.length, 0, `client frame ${sample.frameType}/${sample.leg} consumes the whole buffer`)
      assert.equal(decoded.frame.masked, true, 'stub-side decode confirms the mask bit')
      assert.deepEqual(JSON.parse(decoded.frame.payload.toString('utf8')), sample.frame, `client-TX field identity: ${sample.frameType}/${sample.leg}`)
      clientTx += 1

      // 服务端 TX：不掩码编码 → RelayClientConnection 真实解析路径（分片收口/掩码拒绝语义）
      let receivedText = null
      const fakeSocket = { write: () => true, on: () => {}, destroy: () => {} }
      const conn = new wsMod.RelayClientConnection(fakeSocket, {
        onText: (_c, text) => { receivedText = text },
        onClosed: () => {},
      })
      const serverWire = encodeClientFrame(0x1, Buffer.from(JSON.stringify(sample.frame), 'utf8'), { mask: false })
      conn.feed(serverWire)
      assert.ok(receivedText !== null, `server frame ${sample.frameType}/${sample.leg} reaches hooks.onText`)
      assert.deepEqual(JSON.parse(receivedText), sample.frame, `server-TX field identity: ${sample.frameType}/${sample.leg}`)
      serverTx += 1
    }
    assert.equal(clientTx, samples.length)
    assert.equal(serverTx, samples.length)

    // 掩码方向对称红线：带掩码的「服务端帧」→ 客户端判 protocol error → close 1002
    const written = []
    const errSocket = { write: (b) => { written.push(Buffer.from(b)); return true }, on: () => {}, destroy: () => {} }
    const errConn = new wsMod.RelayClientConnection(errSocket, { onText: () => assert.fail('masked server frame must never reach onText'), onClosed: () => {} })
    const rogueSample = r1FixtureFrame(13, 'ecs-to-host')
    errConn.feed(encodeClientFrame(0x1, Buffer.from(JSON.stringify(rogueSample), 'utf8'))) // 客户端编码默认带掩码
    assert.equal(errConn.closed, true, 'masked server frame closes the connection')
    const closeFrames = written.map((b) => r1ParseMaskedClientFrame(b).frame).filter((f) => f !== null && f.opcode === 0x8)
    assert.ok(closeFrames.length >= 1, 'client answers the protocol violation with a close frame')
    assert.equal(closeFrames[0].payload.readUInt16BE(0), 1002, 'close code 1002 (protocol error)')

    // 分片收口路径：fixture 事件帧拆两片（FIN 分界）→ onText 收到完整帧
    const fragSample = r1FixtureFrame(6, 'host-to-ecs')
    const fragBytes = encodeClientFrame(0x1, Buffer.from(JSON.stringify(fragSample), 'utf8'), { mask: false })
    let fragText = null
    const fragSocket = { write: () => true, on: () => {}, destroy: () => {} }
    const fragConn = new wsMod.RelayClientConnection(fragSocket, { onText: (_c, text) => { fragText = text }, onClosed: () => {} })
    // 增量解析：整帧拆两段 TCP 段喂入（任意切分点）——前半只缓冲、后半收口分发
    const mid = Math.floor(fragBytes.length / 2)
    fragConn.feed(fragBytes.subarray(0, mid))
    assert.ok(fragText === null, 'partial frame stays buffered (no premature dispatch)')
    fragConn.feed(fragBytes.subarray(mid))
    assert.ok(fragText !== null, 'incremental parse completes on the tail bytes')
    assert.deepEqual(JSON.parse(fragText), fragSample, 'fragment reassembly field identity')
  }, 'fast')

  // 156. 重连退避参数（docs/19 §4.2，行为规格移植自 Android core/Backoff.kt）：
  //      1s→60s cap 倍增表 / ±20% jitter 边界（randomSource 注入缝固定值）/ 封顶后
  //      停止翻倍（Kotlin 同款 while 结构）/ 向零截断 / reset 归零 / 非法 attempt 拒绝。
  registerCase('nb-r1-156: reconnect backoff — 1s->2s->...->60s doubling table with cap-stop-doubling, +-20% jitter bounds via randomSource seam (fixed 0 / 0.5 / 1), truncation toward zero, reset-to-base, invalid attempt refused', async () => {
    const { BACKOFF_BASE_DELAY_MS, BACKOFF_MAX_DELAY_MS, BACKOFF_JITTER_FRACTION, BackoffCalculator } = await import(
      new URL('../src/main/services/agentControl/relayClient/backoff.ts', import.meta.url).href
    )
    assert.equal(BACKOFF_BASE_DELAY_MS, 1000, 'base 1s (docs/14 §B.2)')
    assert.equal(BACKOFF_MAX_DELAY_MS, 60000, 'cap 60s')
    assert.equal(BACKOFF_JITTER_FRACTION, 0.2, 'jitter +-20%')

    // 倍增表（r=0.5 → 因子 1.0）：1s→2s→4s→8s→16s→32s→60s 封顶，封顶后停止翻倍
    const mid = new BackoffCalculator({ randomSource: () => 0.5 })
    const table = []
    for (let i = 0; i < 9; i += 1) table.push(mid.nextDelayMs())
    assert.deepEqual(table, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000], 'doubling table with cap-stop-doubling (60s, no overflow)')
    assert.equal(mid.delayMsForAttempt(100), 60000, 'attempt 100 stays at the cap (Kotlin while-loop semantics)')
    assert.equal(mid.attempts, 9, 'attempts counter tracks nextDelayMs calls')

    // jitter 下界（r=0 → 因子 0.8）与上界（r=1 → 因子 1.2）
    const low = new BackoffCalculator({ randomSource: () => 0 })
    assert.equal(low.nextDelayMs(), 800, 'attempt 1 lower jitter bound = 800ms')
    for (let i = 0; i < 5; i += 1) low.nextDelayMs()
    assert.equal(low.nextDelayMs(), 48000, 'attempt 7 lower jitter bound = 60000*0.8')
    const high = new BackoffCalculator({ randomSource: () => 1 })
    assert.equal(high.nextDelayMs(), 1200, 'attempt 1 upper jitter bound = 1200ms')
    for (let i = 0; i < 5; i += 1) high.nextDelayMs()
    assert.equal(high.nextDelayMs(), 72000, 'attempt 7 upper jitter bound = 60000*1.2 (cap applies to base, not jitter)')

    // 向零截断（Kotlin toLong 语义）：r=0.75 → 因子 1.1 → 1100 整
    const trunc = new BackoffCalculator({ randomSource: () => 0.75 })
    assert.equal(trunc.nextDelayMs(), 1100, 'truncation toward zero (1100.000...|0)')
    const trunc2 = new BackoffCalculator({ randomSource: () => 0.5123 })
    assert.ok(Number.isInteger(trunc2.nextDelayMs()), 'delay is always an integer ms')

    // reset：连接成功归零，下次回到 base；零 jitter（fraction 0）时退化为确定 base 表
    const reset = new BackoffCalculator({ randomSource: () => 0.5 })
    reset.nextDelayMs()
    reset.nextDelayMs()
    assert.equal(reset.attempts, 2)
    reset.reset()
    assert.equal(reset.attempts, 0)
    assert.equal(reset.nextDelayMs(), 1000, 'after reset the next delay is base again')

    const zeroJitter = new BackoffCalculator({ jitterFraction: 0, randomSource: () => 0.999 })
    assert.deepEqual([zeroJitter.nextDelayMs(), zeroJitter.nextDelayMs()], [1000, 2000], 'fraction 0 collapses jitter to the pure doubling table')

    // 非法 attempt 拒绝（RangeError，绝不静默猜）
    assert.throws(() => mid.delayMsForAttempt(0), RangeError, 'attempt 0 refused')
    assert.throws(() => mid.delayMsForAttempt(-3), RangeError, 'negative attempt refused')
    assert.throws(() => mid.delayMsForAttempt(1.5), RangeError, 'non-integer attempt refused')

    // 随机源越界值被钳制（[0,1] 外仍产出合法延迟带）
    const clamped = new BackoffCalculator({ randomSource: () => 42 })
    assert.equal(clamped.nextDelayMs(), 1200, 'r>1 clamps to the upper jitter bound')
    const clampedLow = new BackoffCalculator({ randomSource: () => -7 })
    assert.equal(clampedLow.nextDelayMs(), 800, 'r<0 clamps to the lower jitter bound')
  }, 'fast')

  // 157. 断线回填幂等 + watermark 前向只进（docs/19 §4.3 三步恢复序① + §4.3 水位行）：
  //      离线期事件只落库 → hello 水位回填补推（投影对拍 fixture #6 裁定面）→ 同水位
  //      重回填零重发（幂等）→ 写失败即中止且水位只推进到已交付位 → 恢复续传 →
  //      水位恢复取大绝不回退（进程重启恢复语义）。
  registerCase('nb-r1-157: offline backfill idempotency — offline events stay db-only, hello-watermark backfill projects fixture event shape, same-watermark re-backfill is a zero-op, mid-backfill write failure stops at the last delivered sequence then resumes, watermark restore takes max and never regresses', async () => {
    const m = await r1CaseSetup('devhub-nb-r1-157-')
    const db = m.dbModule.getDatabase()
    try {
      const ep = await import(new URL('../src/main/services/agentControl/eventPipeline.ts', import.meta.url).href)
      const eventUplink = await import(new URL('../src/main/services/agentControl/relayClient/eventUplink.ts', import.meta.url).href)
      // provider 行（eventsSince LEFT JOIN agent_providers 的 provider 字段数据源）
      fixtureProviderRow(db, 'codex')
      let online = false
      const sent = []
      eventUplink.setEventUplinkHost({ isReady: () => online, sendEvent: (frame) => { sent.push(frame); return true } })

      // 离线期事件：COMMIT 落库、零投递（回填兜底）
      const e1 = ep.recordEvent({ eventType: 'session.waiting_input', providerKey: 'codex', nativeId: 'nb-r1-157', payload: { status: 'waiting_input' }, summary: 'offline waiting input', fingerprint: 'nb-r1-157-fp-1' })
      const e2 = ep.recordEvent({ eventType: 'message.appended', providerKey: 'codex', nativeId: 'nb-r1-157', payload: { role: 'assistant' }, summary: 'offline appended', fingerprint: 'nb-r1-157-fp-2' })
      const e3 = ep.recordEvent({ eventType: 'session.status_changed', providerKey: 'codex', nativeId: 'nb-r1-157', payload: { from: 'running', to: 'waiting_input' }, summary: 'offline status', fingerprint: 'nb-r1-157-fp-3' })
      assert.ok(e1.recorded && e2.recorded && e3.recorded, 'fixture events recorded')
      assert.equal(sent.length, 0, 'offline: zero frames while not ready')
      assert.equal(eventUplink.currentLastSentSeq(), 0, 'watermark untouched while offline')

      // hello 水位 0（ECS 空缓存）→ 回填全部三帧；投影对拍 fixture #6 host-to-ecs 裁定面
      online = true
      const r1 = eventUplink.backfillFromWatermark(0)
      assert.equal(r1.sent, 3, 'backfill sends every offline event')
      assert.ok(r1.pages >= 1, 'at least one page scanned')
      assert.equal(r1.scannedThrough, e3.sequence, 'scan reaches the newest sequence')
      const f1 = sent[0]
      assert.equal(f1.type, 'event', "discriminator type='event' (fixture 裁定)")
      assert.equal(f1.eventType, 'session.waiting_input', 'eventType carries the event type (fixture 裁定①)')
      assert.equal(f1.sequence, e1.sequence, 'seq -> sequence')
      assert.equal(f1.eventId, e1.eventId, 'eventId passthrough')
      assert.equal(f1.requiresUserAction, true, 'waiting_input whitelist -> requiresUserAction true (docs/18 §4.2)')
      assert.equal(f1.provider, 'codex')
      assert.equal(f1.summary, 'offline waiting input')
      assert.equal(f1.sessionId, undefined, 'absent sessionId is never fabricated')
      assert.equal(sent[1].requiresUserAction, false, 'message.appended is never requiresUserAction')
      assert.equal(eventUplink.currentLastSentSeq(), e3.sequence, 'watermark = highest delivered')
      assert.equal(m.settingsSvc.getSetting('relay_last_sent_seq'), String(e3.sequence), 'watermark persisted (docs/19 §4.3)')

      // 幂等：同水位重回填零重发（ECS 侧另有 sequence UNIQUE 去重双保险）
      const r2 = eventUplink.backfillFromWatermark(e3.sequence)
      assert.equal(r2.sent, 0, 'same-watermark re-backfill sends nothing')
      assert.equal(sent.length, 3, 'no duplicate frames on the wire')

      // 水位前向只进：持久值被 rogue 低位覆写后恢复仍取大（绝不回退）
      m.settingsSvc.setSetting('relay_last_sent_seq', '1')
      eventUplink.restoreLastSentSeq()
      assert.equal(eventUplink.currentLastSentSeq(), e3.sequence, 'restore takes max(persisted, memory)')

      // 断线再现 + 写失败：第二帧写失败即中止，水位只推进到已交付位
      online = false
      const e4 = ep.recordEvent({ eventType: 'message.appended', providerKey: 'codex', nativeId: 'nb-r1-157', payload: { role: 'user' }, summary: 'second outage a', fingerprint: 'nb-r1-157-fp-4' })
      const e5 = ep.recordEvent({ eventType: 'message.appended', providerKey: 'codex', nativeId: 'nb-r1-157', payload: { role: 'assistant' }, summary: 'second outage b', fingerprint: 'nb-r1-157-fp-5' })
      online = true
      let deliverCalls = 0
      eventUplink.setEventUplinkHost({ isReady: () => true, sendEvent: () => { deliverCalls += 1; return deliverCalls < 2 } })
      const r3 = eventUplink.backfillFromWatermark(e3.sequence)
      assert.equal(r3.sent, 1, 'write failure stops the backfill after the last success')
      assert.equal(eventUplink.currentLastSentSeq(), e4.sequence, 'watermark only advanced through the delivered event (never fabricates)')

      // 恢复续传：修好链路后从断点继续，不重发已交付窗口
      eventUplink.setEventUplinkHost({ isReady: () => true, sendEvent: (frame) => { sent.push(frame); return true } })
      const r4 = eventUplink.backfillFromWatermark(e4.sequence)
      assert.equal(r4.sent, 1, 'resume delivers exactly the remaining event')
      assert.equal(eventUplink.currentLastSentSeq(), e5.sequence, 'watermark converges to the newest')
      assert.ok(sent.every((f) => f.sequence !== e1.sequence || f === sent[0]), 'earlier window never re-sent')

      // 进程重启恢复：内存归零后从 settings 持久水位恢复（回填起点不回退 → 零重复回填）
      eventUplink.resetEventUplinkState()
      assert.equal(eventUplink.currentLastSentSeq(), 0)
      eventUplink.restoreLastSentSeq()
      assert.equal(eventUplink.currentLastSentSeq(), e5.sequence, 'restart recovery pulls the persisted high-water mark')
    } finally {
      await r1CaseTeardown(m)
    }
  }, 'fast')

  // 158. 命令排队→上线投递（docs/18 §3.9 queued 语义 + docs/19 §4.2 三步恢复序②）：
  //      host 离线期间 ECS 已受理排队的 command（fixture #8 帧形为底，动态字段覆写）
  //      → relayClient hello/ready 后投递 → auth（同源 Bearer + 防重放）→ action 翻译
  //      send_message≡reply → L3 submitRemoteCommand 执行 → command_result 回帧。
  //      fixture #1 host 腿 hello 为握手帧源。
  registerCase('nb-r1-158: command queued while host offline -> delivered after hello/ready, executed end-to-end (auth -> send_message==reply -> L3 submit -> command_result frame), accepted path never emits command_ack', async () => {
    const m = await r1CaseSetup('devhub-nb-r1-158-')
    const db = m.dbModule.getDatabase()
    const stub = await r1StartRelayStub()
    try {
      r1EnableRelay(m, stub, 'nb-r1-relay-cred-158')
      const { sessionId, calls } = await r1FixtureManagedProvider(m, db, 'nb-r1-158')
      const deviceToken = `nb-r1-dev-token-158-${randomBytes(8).toString('hex')}`
      r1FixtureDevice(m, db, 'nb-r1-158-phone', deviceToken)
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 50, maxDelayMs: 200 })

      // host 离线期间 ECS 已排队的命令（此刻 host 腿零连接）
      const nowSec = Math.floor(Date.now() / 1000)
      const queued = r1FixtureFrame(8, 'device-to-ecs')
      queued.requestId = 'nb-r1-q-req-1'
      queued.idempotencyKey = 'nb-r1-cmd-q-158'
      queued.sessionId = sessionId
      queued.payload = { text: 'queued while host offline' }
      queued.auth = { token: deviceToken, ts: nowSec, nonce: randomBytes(16).toString('hex') }
      queued.createdAt = nowSec

      m.relay.startRelayClient()
      await r1HelloNewConnection(stub) // fixture #1 host 腿 hello 握手
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'relay client ready after hello')
      assert.equal(m.relay.getRelayClientDiagnostics().hostId, 1, 'hello.hostId lands in diagnostics')

      // 上线投递排队命令
      r1StubSend(stub, queued)
      const result = await r1StubWait(stub, (f) => f.json?.type === 'command_result' && f.json.idempotencyKey === 'nb-r1-cmd-q-158', 4000, 'queued command result frame')
      assert.equal(result.json.status, 'executed', 'queued command executed end-to-end')
      assert.equal(result.json.action, 'send_message', 'command_result action uses the relay name (send_message)')
      assert.equal(result.json.sessionId, sessionId, 'result carries the session')
      assert.equal(calls.reply, 1, 'provider executed exactly once')
      const row = db.prepare('SELECT command_id, status FROM remote_commands WHERE idempotency_key = ?').get('nb-r1-cmd-q-158')
      assert.equal(result.json.commandId, row.command_id, 'result commandId matches the L3 row')
      assert.equal(row.status, 'executed', 'L3 row reaches terminal executed')
      assert.ok(!stub.log.some((e) => e.json?.type === 'command_ack'), 'accepted path emits no command_ack (terminal rides command_result)')
    } finally {
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      await r1CaseTeardown(m)
    }
  })

  // 159. 同幂等键重试返回原结果（docs/14 §B.5 + docs/18 §3.8 重试语义）：同 key 同
  //      payload 新 nonce 重试 → 原 commandId 原结果重放（command_result + command_ack
  //      accepted），零重复执行；同 key 异 payload → rejected COMMAND_KEY_CONFLICT；
  //      字面同帧重发（同 nonce）→ error AUTH_REPLAYED（防重放层按传输帧计）；错
  //      token → error AUTH_INVALID_TOKEN；approve → AGENT_CAPABILITY_MISSING（G6）；
  //      未知 action → BAD_PAYLOAD。
  registerCase('nb-r1-159: idempotent retry replays the original result — same key fresh nonce -> replayed command_result + accepted ack with zero re-execution; key/payload conflict rejected; literal same-frame resend -> AUTH_REPLAYED; wrong token -> AUTH_INVALID_TOKEN; approve -> AGENT_CAPABILITY_MISSING; unknown action -> BAD_PAYLOAD', async () => {
    const m = await r1CaseSetup('devhub-nb-r1-159-')
    const db = m.dbModule.getDatabase()
    const stub = await r1StartRelayStub()
    try {
      r1EnableRelay(m, stub, 'nb-r1-relay-cred-159')
      const { sessionId, calls } = await r1FixtureManagedProvider(m, db, 'nb-r1-159')
      const deviceToken = `nb-r1-dev-token-159-${randomBytes(8).toString('hex')}`
      r1FixtureDevice(m, db, 'nb-r1-159-phone', deviceToken)
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 50, maxDelayMs: 200 })
      m.relay.startRelayClient()
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'relay client ready')

      const authFrame = () => ({ token: deviceToken, ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('hex') })
      const cmd = r1FixtureFrame(8, 'device-to-ecs')
      cmd.requestId = 'nb-r1-159-req-1'
      cmd.idempotencyKey = 'nb-r1-key-159'
      cmd.sessionId = sessionId
      cmd.payload = { text: 'first transmission' }
      cmd.auth = authFrame()

      // 首发：202 语义 accepted → 异步执行 → command_result executed
      r1StubSend(stub, cmd)
      const first = await r1StubWait(stub, (f) => f.json?.type === 'command_result' && f.json.idempotencyKey === 'nb-r1-key-159', 4000, 'first command_result')
      assert.equal(first.json.status, 'executed')
      const firstCommandId = first.json.commandId
      assert.equal(calls.reply, 1, 'provider executed once')

      // 同 key 同 payload 重试（新 nonce）→ 原 commandId 原结果重放 + command_ack accepted，零重复执行
      const retry = { ...cmd, requestId: 'nb-r1-159-req-1-retry', auth: authFrame() }
      r1StubSend(stub, retry)
      const replayed = await r1StubWait(stub, (f) => f.json?.type === 'command_result' && f.json.idempotencyKey === 'nb-r1-key-159', 4000, 'replayed command_result')
      assert.equal(replayed.json.commandId, firstCommandId, 'retry replays the original commandId')
      assert.equal(replayed.json.status, 'executed', 'retry replays the original result')
      const ack = await r1StubWait(stub, (f) => f.json?.type === 'command_ack' && f.json.idempotencyKey === 'nb-r1-key-159', 4000, 'replay command_ack')
      assert.equal(ack.json.status, 'accepted', 'replay ack accepted')
      assert.equal(ack.json.commandId, firstCommandId, 'ack carries the original commandId')
      assert.equal(calls.reply, 1, 'no duplicate execution on retry')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM remote_commands WHERE idempotency_key = ?').get('nb-r1-key-159').c, 1, 'still exactly one command row')

      // 同 key 异 payload → 结构化拒绝 COMMAND_KEY_CONFLICT，不执行（新 nonce：防重放层按传输帧计，幂等层按 key+payload 计）
      r1StubSend(stub, { ...retry, requestId: 'nb-r1-159-req-1-conflict', payload: { text: 'a different text' }, auth: authFrame() })
      const conflict = await r1StubWait(stub, (f) => f.json?.type === 'command_ack' && f.json.errorCode === 'COMMAND_KEY_CONFLICT', 4000, 'conflict ack')
      assert.equal(conflict.json.status, 'rejected')
      assert.equal(calls.reply, 1, 'conflicting retry never executes')

      // 字面同帧重发（同 nonce）→ 防重放层 error AUTH_REPLAYED（按传输帧计）
      r1StubSend(stub, cmd)
      const replayedNonce = await r1StubWait(stub, (f) => f.json?.type === 'error' && f.json.code === 'AUTH_REPLAYED', 4000, 'replayed-nonce error frame')
      assert.equal(replayedNonce.json.requestId, cmd.requestId, 'error echoes the request id')

      // 错 token → AUTH_INVALID_TOKEN error 帧，绝不触达 L3
      r1StubSend(stub, { ...cmd, idempotencyKey: 'nb-r1-key-159-b', auth: { token: 'nb-r1-wrong-token', ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('hex') } })
      await r1StubWait(stub, (f) => f.json?.type === 'error' && f.json.code === 'AUTH_INVALID_TOKEN', 4000, 'invalid token error frame')

      // approve（G6 默认恒不授予）→ rejected AGENT_CAPABILITY_MISSING；未知 action → BAD_PAYLOAD
      const approve = { ...cmd, requestId: 'nb-r1-159-req-a', idempotencyKey: 'nb-r1-key-159-a', action: 'approve', auth: authFrame() }
      delete approve.payload
      r1StubSend(stub, approve)
      const approveAck = await r1StubWait(stub, (f) => f.json?.type === 'command_ack' && f.json.errorCode === 'AGENT_CAPABILITY_MISSING', 4000, 'approve rejection ack')
      assert.equal(approveAck.json.status, 'rejected')
      r1StubSend(stub, { ...cmd, requestId: 'nb-r1-159-req-d', idempotencyKey: 'nb-r1-key-159-d', action: 'dance', auth: authFrame() })
      const danceAck = await r1StubWait(stub, (f) => f.json?.type === 'command_ack' && f.json.errorCode === 'BAD_PAYLOAD', 4000, 'unknown action ack')
      assert.equal(danceAck.json.status, 'rejected')

      // 全程只落地一条命令行（拒绝路径不产生流水行）
      assert.equal(db.prepare('SELECT COUNT(*) c FROM remote_commands').get().c, 1, 'exactly one command row for the whole case')
    } finally {
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      await r1CaseTeardown(m)
    }
  })

  // 160. token_rotation 落库 + 宽限窗口（docs/18 §3.14 + docs/19 §4.6）：非 ready 前置门
  //      零副作用 → 全流程 L3 落库（sha256 覆盖 + version+1 + 审计零明文）→ 帧形对拍
  //      fixture #14 host-to-ecs（R2 裁定②必携 deviceId）→ 宽限登记 + heartbeat
  //      tokenVersion 确认信道（docs/18 §3.13）→ 版本不符合法 no-op → 短窗注入过期：
  //      维持新 Token（无回滚位）+ 审计；撤销/未知设备结构化拒绝。
  registerCase('nb-r1-160: token_rotation persisted + grace window — offline gate is zero-side-effect, dispatch lands sha256+version+1 in L3 with plaintext-free audit, frame matches fixture #14 (deviceId mandatory), heartbeat tokenVersion confirms, mismatch is a no-op, injected short window expires to keep-new-token with audit, revoked/unknown refused', async () => {
    const m = await r1CaseSetup('devhub-nb-r1-160-')
    const db = m.dbModule.getDatabase()
    try {
      const rotation = await import(new URL('../src/main/services/agentControl/relayClient/rotationBridge.ts', import.meta.url).href)
      const deviceToken = `nb-r1-dev-token-160-${randomBytes(8).toString('hex')}`
      const deviceId = r1FixtureDevice(m, db, 'nb-r1-160-phone', deviceToken)
      const captured = []

      // 离线前置门：两平面凭据同步只能在连接面进行 → 拒绝且零副作用（L3 不触达）
      rotation.setRotationBridgeHost({ isReady: () => false, sendTokenRotation: (f) => { captured.push(f); return true } })
      const offline = rotation.requestTokenRotation(deviceId, 'manual')
      assert.equal(offline.dispatched, false)
      assert.equal(offline.stage, 'offline')
      assert.equal(captured.length, 0, 'offline refusal sends no frame')
      assert.equal(Number(db.prepare('SELECT token_version FROM remote_devices WHERE id = ?').get(deviceId).token_version), 1, 'offline refusal never touches L3')
      assert.equal(db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action = 'token_rotated'").get().c, 0)

      // ready：L3 落库 → 帧发送 → 宽限登记
      rotation.setRotationBridgeHost({ isReady: () => true, sendTokenRotation: (f) => { captured.push(f); return true } })
      const first = rotation.requestTokenRotation(deviceId, 'post-pairing')
      assert.equal(first.stage, 'dispatched')
      assert.equal(first.tokenVersion, 2)
      assert.ok(first.requestId, 'dispatch carries a requestId')
      const frame = captured[0]
      const fixtureShape = r1FixtureFrame(14, 'host-to-ecs')
      assert.deepEqual(Object.keys(frame).sort(), Object.keys(fixtureShape).sort(), 'frame shape matches fixture #14 host-to-ecs (R2: deviceId present)')
      assert.equal(frame.type, 'token_rotation')
      assert.equal(frame.deviceId, deviceId, 'deviceId = Windows-side remote_devices.id (R2 裁定②)')
      assert.equal(frame.tokenVersion, 2)
      assert.equal(frame.reason, 'post-pairing')
      assert.match(frame.newToken, /^[A-Za-z0-9_-]{43}$/, 'newToken is a 256-bit base64url token')
      const row = db.prepare('SELECT token_hash, token_version FROM remote_devices WHERE id = ?').get(deviceId)
      assert.equal(row.token_hash, m.auth.sha256Hex(frame.newToken), 'token_hash overwritten with sha256(newToken)')
      assert.equal(row.token_version, 2, 'token_version incremented')
      const rotatedAudit = db.prepare("SELECT detail_json FROM security_audit_logs WHERE action = 'token_rotated' AND device_id = ? ORDER BY id DESC LIMIT 1").get(deviceId)
      assert.ok(rotatedAudit, 'token_rotated audited')
      assert.ok(!rotatedAudit.detail_json.includes(frame.newToken), 'audit never carries the token plaintext')

      // 宽限窗口：待确认登记 + heartbeat tokenVersion 确认信道（docs/18 §3.13）
      assert.equal(rotation.pendingRotationCount(), 1, 'dispatch registers a pending confirmation window')
      assert.equal(rotation.getPendingRotationVersion(deviceId), 2)
      assert.equal(rotation.noteTokenRotationConfirmed(99), false, 'version mismatch is a legal no-op (no cross-device misattribution)')
      assert.equal(rotation.getPendingRotationVersion(deviceId), 2)
      assert.equal(rotation.noteTokenRotationConfirmed(2), true, 'heartbeat tokenVersion confirms the pending rotation')
      assert.equal(rotation.pendingRotationCount(), 0, 'window cleared on confirmation')
      assert.ok(db.prepare("SELECT id FROM security_audit_logs WHERE action = 'token_rotation_confirmed' AND device_id = ?").get(deviceId), 'confirmation audited')

      // 宽限过期：短窗注入，未确认 → 维持新 Token（单哈希列无回滚位）+ 审计
      rotation.setRotationGraceWindowMs(120)
      const second = rotation.requestTokenRotation(deviceId, 'manual')
      assert.equal(second.stage, 'dispatched')
      assert.equal(second.tokenVersion, 3)
      await pollUntil(() => db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action = 'token_rotation_grace_expired' AND device_id = ?").get(deviceId).c === 1, 3000, 40, 'grace expiry audit')
      assert.equal(rotation.pendingRotationCount(), 0, 'window cleared on expiry')
      const rowAfter = db.prepare('SELECT token_hash, token_version FROM remote_devices WHERE id = ?').get(deviceId)
      assert.equal(rowAfter.token_version, 3, 'new token stays effective (no rollback bit)')
      assert.equal(rowAfter.token_hash, m.auth.sha256Hex(captured[1].newToken), 'hash matches the last dispatched token')

      // 撤销设备 → DEVICE_REVOKED；未知设备 → NOT_FOUND（零落库零帧）
      db.prepare("UPDATE remote_devices SET status = 'revoked' WHERE id = ?").run(deviceId)
      const revoked = rotation.requestTokenRotation(deviceId, 'manual')
      assert.equal(revoked.stage, 'refused')
      assert.equal(revoked.errorCode, 'DEVICE_REVOKED', 'revocation is final (docs/15 §4)')
      const missing = rotation.requestTokenRotation(424242, 'manual')
      assert.equal(missing.stage, 'refused')
      assert.equal(missing.errorCode, 'NOT_FOUND')
      assert.equal(captured.length, 2, 'refusals never sent frames')
    } finally {
      await r1CaseTeardown(m)
    }
  })

  // 161. 撤销踢线（docs/18 §3.15 / §9.5 撤销链路）：H→E 定点踢线（L3 revoke → 附加
  //      撤销监听 → disconnect{deviceId, reason:'revoked'}，帧形对拍 fixture #15）；
  //      E→H revoked → 状态机停止且绝不自动重连（对比 server_shutdown → 退避重连
  //      恢复 ready）；lastError 结构化零凭据。
  registerCase('nb-r1-161: revocation kick — L3 revoke emits the fixture-shaped disconnect{deviceId,revoked} frame, E->H revoked stops the state machine with zero auto-reconnect (contrast: server_shutdown reconnects to ready), structured credential-free lastError', async () => {
    const m = await r1CaseSetup('devhub-nb-r1-161-')
    const db = m.dbModule.getDatabase()
    const stub = await r1StartRelayStub()
    try {
      r1EnableRelay(m, stub, 'nb-r1-relay-cred-161')
      const deviceToken = `nb-r1-dev-token-161-${randomBytes(8).toString('hex')}`
      const deviceId = r1FixtureDevice(m, db, 'nb-r1-161-phone', deviceToken)
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 60, maxDelayMs: 250 })
      m.relay.startRelayClient()
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'initial ready')
      assert.equal(stub.connections.length, 1)

      // H→E 定点踢线：撤销链路 L3 revoke → disconnect 帧（deviceId = Windows 侧 id）
      m.svc.revokeDevice(deviceId, true, 'ipc')
      const kick = await r1StubWait(stub, (f) => f.json?.type === 'disconnect' && f.json.reason === 'revoked', 3000, 'H->E kick frame')
      assert.deepEqual(kick.json, { ...r1FixtureFrame(15, 'host-to-ecs'), deviceId }, 'kick frame matches fixture #15 host-to-ecs with the revoked deviceId')
      assert.equal(db.prepare('SELECT status FROM remote_devices WHERE id = ?').get(deviceId).status, 'revoked')
      assert.ok(db.prepare("SELECT id FROM security_audit_logs WHERE action = 'device_revoked' AND device_id = ?").get(deviceId), 'revocation audited')

      // E→H revoked：状态机停止，绝不自动重连（docs/18 §3.15）
      r1StubSend(stub, r1FixtureFrame(15, 'ecs-to-device-revoked'))
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'stopped', 3000, 30, 'stopped on revoked')
      assert.ok((m.relay.getRelayClientDiagnostics().lastError ?? '').includes('revoked'), 'structured lastError carries the revocation (zero credentials)')
      await sleep(500) // 注入退避 60-250ms：若仍有重连调度必已发生
      assert.equal(stub.connections.length, 1, 'no auto-reconnect after revoked')
      assert.equal(m.relay.getRelayClientDiagnostics().status, 'stopped')

      // 对比面：server_shutdown（非撤销）→ 关闭后退避重连 → hello → 恢复 ready
      m.relay.startRelayClient()
      await pollUntil(() => stub.connections.length === 2, 3000, 30, 'second connection after re-trigger')
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'ready again')
      r1StubSend(stub, r1FixtureFrame(15, 'ecs-to-device-server-shutdown'))
      await pollUntil(() => stub.connections.length === 3, 5000, 30, 'backoff reconnect fires for server_shutdown')
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'ready after reconnect (contrast with revoked)')
    } finally {
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      await r1CaseTeardown(m)
    }
  })

  // 162. 凭据零入日志/DB 抽样（docs/19 §2.2/§3 红线）：四个秘密（relay 凭据 / 配对码
  //      明文 / deviceToken / 轮换 newToken）× 全部非豁免面（帧 / settings / 
  //      remote_devices / 审计 / 事件 / 诊断投影）零出现；豁免面仅限 docs/19 §3 W-R3
  //      受控一次性过境（upgrade Authorization 头 / pair_accepted.deviceToken /
  //      token_rotation.newToken）；静态面：relayClient 模块零 console 输出。
  registerCase('nb-r1-162: credential zero-leak sweep — relay credential rides only the upgrade Authorization header, pairing code is hashed on-site (register_pairing), deviceToken/newToken transit once through pair_accepted/token_rotation, every other frame/settings/device-row/audit/event/diagnostic surface is free of all four secrets, relayClient sources contain zero console logging', async () => {
    const m = await r1CaseSetup('devhub-nb-r1-162-')
    const db = m.dbModule.getDatabase()
    const stub = await r1StartRelayStub()
    try {
      const statusProjector = await import(new URL('../src/main/services/agentControl/relayClient/statusProjector.ts', import.meta.url).href)
      const pairingBridge = await import(new URL('../src/main/services/agentControl/relayClient/pairingBridge.ts', import.meta.url).href)
      const relayCred = `nb-r1-RELAY-CRED-${randomBytes(12).toString('hex')}`
      r1EnableRelay(m, stub, relayCred)
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 50, maxDelayMs: 200 })
      m.relay.startRelayClient()
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'ready')
      assert.equal(stub.upgrades[stub.upgrades.length - 1].authorization, `Bearer ${relayCred}`, 'credential rides the upgrade Authorization header (sanctioned transport surface)')

      // 配对链全流程（register_pairing → ack → pair → pair_accepted → post-pairing 轮换）
      const created = await m.svc.createPairing('nb-r1-162-phone')
      const reg = await r1StubWait(stub, (f) => f.json?.type === 'register_pairing' && f.json.pairingId === created.pairingId, 3000, 'register_pairing')
      assert.deepEqual(Object.keys(reg.json).sort(), Object.keys(r1FixtureControlFrame('host-to-ecs')).sort(), 'register_pairing matches the fixture hostControlFrames shape')
      assert.equal(reg.json.codeHash, m.auth.sha256Hex(created.code), 'pairing code hashed on-site (sha256), plaintext never framed')
      assert.equal(reg.json.expiresAt, created.expiresAt)
      r1StubSend(stub, { ...r1FixtureControlFrame('ecs-to-host'), requestId: reg.json.requestId, pairingId: created.pairingId, accepted: true, expiresAt: created.expiresAt })
      await pollUntil(() => pairingBridge.getLastRegisterPairingAck()?.accepted === true, 2000, 30, 'register ack recorded (diagnostics without secrets)')
      r1StubSend(stub, { ...r1FixtureFrame(2, 'ecs-to-host'), requestId: 'nb-r1-162-pair-1', ecsDeviceId: 7, pairingId: created.pairingId, deviceName: 'nb-r1-162-phone', platform: 'android' })
      const accepted = await r1StubWait(stub, (f) => f.json?.type === 'pair_accepted' && f.json.requestId === 'nb-r1-162-pair-1', 3000, 'pair_accepted')
      const deviceToken = accepted.json.deviceToken
      assert.match(deviceToken, /^[A-Za-z0-9_-]{43}$/, 'deviceToken is a 256-bit base64url token (one-time transit)')
      const devRow = db.prepare('SELECT id, token_hash, token_version FROM remote_devices WHERE device_name = ?').get('nb-r1-162-phone')
      assert.ok(devRow, 'claim created the device row')
      assert.equal(Number(devRow.token_version), 2, 'claim (v1) + post-pairing rotation (v2) both landed — rotation runs in the paired callback before the wire')
      assert.equal(accepted.json.device.deviceId, devRow.id, 'pair_accepted carries the Windows-side device id')
      await pollUntil(() => m.relay.getRelayClientDiagnostics().mappedDevices === 1, 2000, 30, 'ecs->win device mapping registered')
      const rot = await r1StubWait(stub, (f) => f.json?.type === 'token_rotation' && f.json.deviceId === devRow.id, 3000, 'post-pairing token_rotation')
      const newToken = rot.json.newToken
      assert.match(newToken, /^[A-Za-z0-9_-]{43}$/)
      assert.equal(rot.json.reason, 'post-pairing', 'post-pairing rotation fired automatically (docs/19 §4.5)')
      assert.equal(rot.json.tokenVersion, 2)
      assert.equal(devRow.token_hash, m.auth.sha256Hex(newToken), 'db stores sha256(newToken) after rotation (hash material only)')

      // 红线扫描：四个秘密 × 非豁免面
      const secrets = [relayCred, created.code, deviceToken, newToken]
      // 受控一次性过境面（docs/19 §3 W-R3）只允许各自的 token 过境：其余两秘密仍禁
      for (const entry of stub.log) {
        if (entry.json?.type === 'pair_accepted' || entry.json?.type === 'token_rotation') {
          assert.ok(!entry.text.includes(relayCred) && !entry.text.includes(created.code), 'transit frames never carry the relay credential or the pairing code')
          continue
        }
        for (const secret of secrets) {
          assert.ok(!entry.text.includes(secret), `frame type=${entry.json?.type} never carries secret ${secret.slice(0, 12)}…`)
        }
      }
      for (const row of db.prepare('SELECT key, value FROM settings').all()) {
        for (const secret of secrets) assert.ok(!String(row.value).includes(secret), `settings ${row.key} is secret-free`)
      }
      for (const row of db.prepare('SELECT * FROM remote_devices').all()) {
        const blob = JSON.stringify(row)
        for (const secret of secrets) assert.ok(!blob.includes(secret), 'remote_devices carries hash material only')
      }
      for (const row of db.prepare('SELECT action, detail_json FROM security_audit_logs').all()) {
        const blob = `${row.action} ${row.detail_json ?? ''}`
        for (const secret of secrets) assert.ok(!blob.includes(secret), `audit ${row.action} is secret-free`)
      }
      for (const row of db.prepare('SELECT payload_json FROM agent_events').all()) {
        for (const secret of secrets) assert.ok(!row.payload_json.includes(secret), 'agent_events are secret-free')
      }
      const diagBlob = JSON.stringify(m.relay.getRelayClientDiagnostics()) + JSON.stringify(statusProjector.projectRelayStatus())
      for (const secret of secrets) assert.ok(!diagBlob.includes(secret), 'diagnostics/status projection is secret-free')

      // 静态面：relayClient 模块零 console 输出（凭据不入日志的结构保证）
      const relayDir = new URL('../src/main/services/agentControl/relayClient/', import.meta.url)
      for (const file of readdirSync(relayDir)) {
        if (!file.endsWith('.ts')) continue
        const src = readFileSync(new URL(file, relayDir), 'utf8')
        assert.ok(!/console\./.test(src), `relayClient/${file} never logs (structural no-leak guarantee)`)
      }
    } finally {
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      await r1CaseTeardown(m)
    }
  })

  // ====================================================================
  // M3-C1b 批 — relay TLS 信任装载 smoke 段（docs/19 §10 + docs/briefs/m3c1b-relay-wiring.md）。
  // 指纹文件归一化（hex/base64/大小写/注释空行/fail-fast 格式错）+ ca.pem 缺失结构化
  // 错误 + tls{ca,checkServerIdentity} 构造正负用例（临时自签 IP SAN 证书纯 node:crypto
  // 生成，零 openssl spawn；本地 TLS WS 桩监听 18543+ 段外回环端口，绝不碰 8746-8755
  // 门禁段）。既有 164 用例零改动（append-only，约束 #27）。
  // ====================================================================

  /** DER TLV（短/长度通用编码；证书生成唯一用，勿挪作他用）。 */
  function c1bDer(tag, body) {
    if (body.length < 0x80) return Buffer.concat([Buffer.from([tag]), Buffer.from([body.length]), body])
    const bytes = []
    for (let v = body.length; v > 0; v >>= 8) bytes.unshift(v & 0xff)
    return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length]), Buffer.from(bytes), body])
  }
  const c1bDerSeq = (...parts) => c1bDer(0x30, Buffer.concat(parts))
  const c1bDerInt = (buf) => c1bDer(0x02, buf)
  const c1bDerOid = (bytes) => c1bDer(0x06, bytes)
  const c1bDerUtc = (time) => {
    const p = (n) => String(n).padStart(2, '0')
    const s = `${p(time.getUTCFullYear() % 100)}${p(time.getUTCMonth() + 1)}${p(time.getUTCDate())}${p(time.getUTCHours())}${p(time.getUTCMinutes())}${p(time.getUTCSeconds())}Z`
    return c1bDer(0x17, Buffer.from(s, 'ascii'))
  }
  const C1B_OID_SHA256_ECDSA = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]) // 1.2.840.10045.4.3.2
  const C1B_OID_CN = Buffer.from([0x55, 0x04, 0x03]) // 2.5.4.3 commonName
  const C1B_OID_SAN = Buffer.from([0x55, 0x1d, 0x11]) // 2.5.29.17 subjectAltName
  const C1B_OID_BASIC = Buffer.from([0x55, 0x1d, 0x13]) // 2.5.29.19 basicConstraints

  const c1bName = (cn) =>
    c1bDerSeq(c1bDer(0x31, c1bDerSeq(c1bDerOid(C1B_OID_CN), c1bDer(0x0c, Buffer.from(cn, 'utf8')))))
  const c1bSanExt = (ips) =>
    c1bDerSeq(c1bDerOid(C1B_OID_SAN), c1bDer(0x04, c1bDerSeq(...ips.map((ip) => c1bDer(0x87, Buffer.from(ip.split('.').map(Number)))))))
  const c1bBasicExt = () => c1bDerSeq(c1bDerOid(C1B_OID_BASIC), c1bDer(0x04, c1bDerSeq(Buffer.from([0x01, 0x01, 0xff]))))
  const c1bToPem = (label, der) => {
    const lines = der.toString('base64').match(/.{1,64}/g) ?? []
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
  }

  /**
   * 临时自签 IP SAN 证书（EC P-256 / sha256WithECDSA / SAN 含 IP；与
   * docs/ecs-relay-deploy/gen-ip-cert.sh 产出同形态——SPKI SHA-256 即 pin 物料）。
   * 纯 node:crypto 手工 DER 组装，零 spawn（exec 外 spawn 禁令不触碰）。
   */
  async function c1bSelfSignedCert({ cn, ips }) {
    const { generateKeyPairSync, sign, createHash } = await import('node:crypto')
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' })
    const now = Date.now()
    const tbs = c1bDerSeq(
      c1bDer(0xa0, c1bDerInt(Buffer.from([0x02]))), // [0] EXPLICIT version v3
      c1bDerInt(Buffer.from([0x01])), // serialNumber = 1
      c1bDerSeq(c1bDerOid(C1B_OID_SHA256_ECDSA)), // signature algorithm
      c1bName(cn), // issuer（自签 = subject 同名）
      c1bDerSeq(c1bDerUtc(new Date(now - 3_600_000)), c1bDerUtc(new Date(now + 90 * 86_400_000))),
      c1bName(cn), // subject
      spkiDer, // subjectPublicKeyInfo（DER 已是 SEQUENCE，原样嵌入）
      c1bDer(0xa3, c1bDerSeq(c1bBasicExt(), c1bSanExt(ips))), // [3] EXPLICIT extensions
    )
    const certDer = c1bDerSeq(tbs, c1bDerSeq(c1bDerOid(C1B_OID_SHA256_ECDSA)), c1bDer(0x03, Buffer.concat([Buffer.from([0x00]), sign('sha256', tbs, privateKey)])))
    return {
      certDer,
      certPem: c1bToPem('CERTIFICATE', certDer),
      keyPem: privateKey.export({ type: 'sec1', format: 'pem' }).toString(),
      spkiHex: createHash('sha256').update(spkiDer).digest('hex'),
    }
  }

  /**
   * 本地 TLS WS 桩（host 腿，r1StartRelayStub 的 TLS 变体）：自签证书终结 TLS +
   * RFC6455 upgrade；18543 起 EADDRINUSE 顺延 +9（绝不占用 8746-8755 门禁段）。
   * 连接对象形状与 r1HelloNewConnection/r1StubSend/r1StubWait 兼容（复用段内夹具）。
   */
  async function c1bStartTlsRelayStub(certPem, keyPem, portHint = 18543) {
    const { createServer } = await import('node:https')
    const { createHash } = await import('node:crypto')
    const stub = { server: null, port: null, connections: [] }
    const handleUpgrade = (req, socket) => {
      const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
      socket.setNoDelay(true)
      const conn = { socket, received: [], closeCode: null, alive: true, helloSent: false, headers: { authorization: req.headers.authorization ?? null } }
      stub.connections.push(conn)
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])
        while (true) {
          const parsed = r1ParseMaskedClientFrame(buffer)
          if (parsed.frame === null) break
          buffer = parsed.rest
          const { opcode, payload } = parsed.frame
          if (opcode === 0x8) {
            conn.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null
            conn.alive = false
            try { socket.destroy() } catch { /* 已关 */ }
            return
          }
          if (opcode === 0x9) {
            try { socket.write(encodeClientFrame(0xa, payload, { mask: false })) } catch { /* 已关 */ }
            continue
          }
          if (opcode === 0xa) continue
          if (opcode === 0x1 || opcode === 0x2) {
            const text = payload.toString('utf8')
            let json
            try { json = JSON.parse(text) } catch { json = undefined }
            conn.received.push({ opcode, text, json })
          }
        }
      })
      socket.on('error', () => { conn.alive = false })
      socket.on('close', () => { conn.alive = false })
    }
    const tryListen = (port) =>
      new Promise((resolve, reject) => {
        const server = createServer({ cert: certPem, key: keyPem })
        server.on('tlsClientError', () => { /* 校验失败的握手：正负用例预期面 */ })
        server.on('error', reject)
        server.on('upgrade', handleUpgrade)
        server.listen(port, '127.0.0.1', () => resolve(server))
      })
    let lastErr = null
    for (let p = portHint; p < portHint + 10; p += 1) {
      try {
        stub.server = await tryListen(p)
        stub.port = p
        return stub
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr ?? new Error('tls relay stub listen failed')
  }

  /** 指纹/CA 夹具 env 缝装配（r1CaseSetup 的 credential 缝同款纪律；返回还原函数）。 */
  function c1bUseTrustEnv(fpPath, caPath) {
    const prevFp = process.env.DEVHUB_RELAY_FINGERPRINTS_FILE
    const prevCa = process.env.DEVHUB_RELAY_CA_FILE
    process.env.DEVHUB_RELAY_FINGERPRINTS_FILE = fpPath
    if (caPath === undefined) delete process.env.DEVHUB_RELAY_CA_FILE
    else process.env.DEVHUB_RELAY_CA_FILE = caPath
    return () => {
      if (prevFp === undefined) delete process.env.DEVHUB_RELAY_FINGERPRINTS_FILE
      else process.env.DEVHUB_RELAY_FINGERPRINTS_FILE = prevFp
      if (prevCa === undefined) delete process.env.DEVHUB_RELAY_CA_FILE
      else process.env.DEVHUB_RELAY_CA_FILE = prevCa
    }
  }

  // 163. 指纹归一化（docs/19 §10.2 + deploy README §2 形态）：sha256/{hex} 大小写
  //      不敏感 → 小写；裸 64 hex；sha256/{base64(32B)} 与裸 base64（标准/URL-safe
  //      字母表，解码恰 32 字节）；文件解析注释/空行/CRLF 跳过；格式错 fail-fast
  //      抛错（绝不产出半枚 pin 集），loadRelayTlsTrust 折叠为带路径的结构化错误。
  registerCase('nb-c1b-163: relay fingerprint normalization — sha256/<hex> case-insensitive to lowercase, bare hex, base64(32B) standard and URL-safe forms (with or without sha256/ prefix), file parsing skips comments/blank lines/CRLF, malformed line is fail-fast (throws; loader folds into a structured path-carrying error, never a partial pin set)', async () => {
    const m = await r1CaseSetup('devhub-nb-c1b-163-')
    try {
      const cfg = await import(new URL('../src/main/services/agentControl/relayClient/config.ts', import.meta.url).href)
      const hexLower = '0123456789abcdef'.repeat(4)
      // hex 形态：sha256/ 前缀可选 + 大小写归一化
      assert.equal(cfg.normalizeRelayFingerprint(`sha256/${hexLower}`), hexLower, 'sha256/<lower-hex> identity')
      assert.equal(cfg.normalizeRelayFingerprint(`sha256/${hexLower.toUpperCase()}`), hexLower, 'uppercase hex normalized to lowercase (dual-fingerprint window input form)')
      assert.equal(cfg.normalizeRelayFingerprint(hexLower.toUpperCase()), hexLower, 'bare uppercase hex accepted (no prefix)')
      // base64(32B) 形态：标准 + URL-safe 字母表，前缀可选，解码恰 32 字节
      const { randomBytes } = await import('node:crypto')
      const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd]), randomBytes(29)]) // 32B，base64 含 '+/' 字符
      const b64 = bytes.toString('base64')
      assert.equal(b64.length, 44, 'base64(32B) is 44 chars with padding')
      assert.ok(/[+/]/.test(b64), 'fixture base64 exercises the standard alphabet')
      const hexOfBytes = bytes.toString('hex')
      assert.equal(cfg.normalizeRelayFingerprint(`sha256/${b64}`), hexOfBytes, 'sha256/<base64(32B)> decodes to hex')
      assert.equal(cfg.normalizeRelayFingerprint(b64), hexOfBytes, 'bare base64 accepted')
      const b64url = b64.replaceAll('+', '-').replaceAll('/', '_')
      assert.equal(cfg.normalizeRelayFingerprint(b64url), hexOfBytes, 'URL-safe base64 accepted')
      // fail-fast：63 hex / md5 前缀 / 31B base64 / 空串 / 64 字符 base64（解码 48B ≠ 32B）
      for (const bad of [`sha256/${'ab'.repeat(31) + 'a'}`, `md5/${hexLower}`, Buffer.from('short').toString('base64'), '', 'z'.repeat(64)]) {
        assert.throws(() => cfg.normalizeRelayFingerprint(bad), /invalid relay SPKI fingerprint/, `fail-fast rejects ${JSON.stringify(bad.slice(0, 16))}…`)
      }
      // 文件解析：注释/空行/CRLF/首尾空白全部容忍，逐行归一化保持顺序
      const fpPath = join(m.credentialFile, '..', 'fingerprints')
      writeFileSync(fpPath, [`# devhub relay spki pins (public material)`, '', `  sha256/${hexLower.toUpperCase()}  `, `   # trailing comment line`, b64url, ''].join('\r\n'), 'utf8')
      assert.deepEqual(cfg.parseRelayFingerprintFile(readFileSync(fpPath, 'utf8')), [hexLower, hexOfBytes], 'CRLF + comments + blanks + whitespace tolerated, order preserved, all normalized')
      assert.deepEqual(cfg.parseRelayFingerprintFile('# only comments\n\n'), [], 'comments-only file parses to an empty pin list')
      // 装载折叠：格式错 → 带路径的结构化错误（绝不抛、绝不出半枚 pin 集）
      writeFileSync(fpPath, `${hexLower}\nnot-a-fingerprint\n`, 'utf8')
      const restore = c1bUseTrustEnv(fpPath, join(fpPath, '..', 'ca.pem'))
      try {
        const bad = cfg.loadRelayTlsTrust()
        assert.equal(bad.ok, false, 'malformed line never loads a partial pin set')
        assert.equal(bad.reason, 'fingerprints-malformed')
        assert.match(bad.error ?? '', /fingerprints/, 'structured error carries the file path (public material)')
        assert.match(bad.error ?? '', /invalid relay SPKI fingerprint/)
      } finally {
        restore()
      }
    } finally {
      await r1CaseTeardown(m)
    }
  }, 'fast')

  // 164. 信任物料装载与投影（docs/19 §10「不采用仅 pin 绕链验证」）：指纹齐备 +
  //      ca.pem 齐备 → ok{fingerprints,ca}；指纹文件缺失/空 → 结构化失败；ca.pem
  //      缺失 → 结构化错误提示补放（错误携带路径）；statusProjector：wss + 信任物
  //      缺失 → 结构化告警（不静默零连接也不崩）；ws:// loopback 时间盒不告警；
  //      disabled → null 投影零噪声。
  registerCase('nb-c1b-164: TLS trust load + projection — ready fingerprints+ca.pem load ok, missing/empty fingerprints and missing ca.pem are structured failures (ca-missing error prompts provision and states pin-only bypass is not adopted), statusProjector warns only for secure (wss) endpoints when trust is missing, tls status row always projected while enabled, disabled projects null', async () => {
    const m = await r1CaseSetup('devhub-nb-c1b-164-')
    try {
      const cfg = await import(new URL('../src/main/services/agentControl/relayClient/config.ts', import.meta.url).href)
      const statusProjector = await import(new URL('../src/main/services/agentControl/relayClient/statusProjector.ts', import.meta.url).href)
      const hexOld = 'ab'.repeat(32)
      const hexNew = Buffer.concat([Buffer.from([0xcd, 0xef]), (await import('node:crypto')).randomBytes(30)]).toString('hex')
      const dir = join(m.credentialFile, '..')
      const fpPath = join(dir, 'fingerprints')
      const caPath = join(dir, 'ca.pem')
      const caPem = `-----BEGIN CERTIFICATE-----\n${'c1b'.repeat(4)}\n-----END CERTIFICATE-----\n` // 形态夹具（握手正例用真证书，见 165）
      // 双指纹窗口物料（旧 hex + 新 base64 形态）
      writeFileSync(fpPath, `sha256/${hexOld}\nsha256/${Buffer.from(hexNew, 'hex').toString('base64')}\n`, 'utf8')
      writeFileSync(caPath, caPem, 'utf8')
      const restore = c1bUseTrustEnv(fpPath, caPath)
      try {
        // 齐备 → ok
        const ok = cfg.loadRelayTlsTrust()
        assert.equal(ok.ok, true, 'fingerprints + ca.pem ready')
        assert.deepEqual(ok.trust?.fingerprints, [hexOld, hexNew], 'dual-fingerprint window normalized (hex + base64 forms)')
        assert.equal(ok.trust?.ca, caPem.trim(), 'ca.pem content passed through')
        assert.deepEqual(cfg.readRelayTlsTrustStatus(), { ok: true, pins: 2, source: 'fingerprints' }, 'fingerprint status row data: pins + source filename')
        // 指纹缺失 → 结构化
        process.env.DEVHUB_RELAY_FINGERPRINTS_FILE = join(dir, 'absent-fingerprints')
        const fpMissing = cfg.loadRelayTlsTrust()
        assert.equal(fpMissing.ok, false)
        assert.equal(fpMissing.reason, 'fingerprints-missing')
        assert.match(fpMissing.error ?? '', /provision/, 'missing fingerprints error suggests provisioning')
        // 全注释空 pin 集 → 结构化 empty（env 缝先指回刚写入的文件）
        writeFileSync(fpPath, '# nothing here\n', 'utf8')
        process.env.DEVHUB_RELAY_FINGERPRINTS_FILE = fpPath
        const fpEmpty = cfg.loadRelayTlsTrust()
        assert.equal(fpEmpty.ok, false)
        assert.equal(fpEmpty.reason, 'fingerprints-empty')
        // ca.pem 缺失 → 结构化错误提示补放（仅 pin 绕默认链验证不采用）
        writeFileSync(fpPath, `sha256/${hexOld}\n`, 'utf8')
        process.env.DEVHUB_RELAY_CA_FILE = join(dir, 'absent-ca.pem')
        const caMissing = cfg.loadRelayTlsTrust()
        assert.equal(caMissing.ok, false)
        assert.equal(caMissing.reason, 'ca-missing')
        assert.match(caMissing.error ?? '', /provision .*ca\.pem/, 'structured error names the ca.pem path to provision')
        assert.match(caMissing.error ?? '', /pin-only bypass of chain verification is not adopted/, 'docs/19 §10: no pin-only mode')

        // 投影面（gateway_enabled 种子 0 → 其告警行共存；只断言 TLS 文本有无）
        m.settingsSvc.setSetting('relay_enabled', '1')
        m.settingsSvc.setSetting('relay_endpoint', 'wss://59.110.149.11/relay/host')
        // 信任缺失 + wss → 结构化告警 + tls 状态行（ok:false 只读展示）
        let view = statusProjector.projectRelayStatus()
        assert.ok(view !== null && view.tls !== undefined, 'tls status row projected while relay enabled')
        assert.equal(view.tls.ok, false)
        assert.match(view.warning ?? '', /TLS trust material not loaded/, 'structured warning projected (never silent)')
        assert.match(view.tls.error ?? '', /ca\.pem/)
        // 信任齐备 → 无 TLS 告警，tls 状态行就绪
        process.env.DEVHUB_RELAY_FINGERPRINTS_FILE = fpPath
        process.env.DEVHUB_RELAY_CA_FILE = caPath
        view = statusProjector.projectRelayStatus()
        assert.equal(view?.tls.ok, true)
        assert.equal(view?.tls.pins, 1, 'single-pin steady state')
        assert.ok(!(view?.warning ?? '').includes('TLS trust material'), 'no TLS warning once trust is ready')
        // ws:// loopback（docs/19 §11 时间盒）+ 信任缺失 → 不告警（TLS 与明文无关）
        process.env.DEVHUB_RELAY_CA_FILE = join(dir, 'absent-ca.pem')
        m.settingsSvc.setSetting('relay_endpoint', 'ws://127.0.0.1:18443')
        view = statusProjector.projectRelayStatus()
        assert.ok(!(view?.warning ?? '').includes('TLS trust material'), 'loopback ws timebox does not trigger TLS warnings')
        assert.equal(view?.tls.ok, false, 'status row still shows the raw trust state')
        // disabled → null 投影（零噪声向后兼容）
        m.settingsSvc.setSetting('relay_enabled', '0')
        assert.equal(statusProjector.projectRelayStatus(), null, 'disabled projects null')
      } finally {
        restore()
      }
    } finally {
      await r1CaseTeardown(m)
    }
  }, 'fast')

  // 165. tls{ca, checkServerIdentity} 构造正负用例（真实 TLS 栈，临时自签 IP SAN
  //      证书 + 本地 TLS WS 桩段外端口）：对指纹通过（upgrade + 掩码帧双向）；错
  //      指纹拒绝（pin mismatch 结构化）；双指纹窗口任一命中即过；默认规则先行——
  //      IP SAN 不匹配即拒（pin 正确也不兜底，SAN 与指纹双保险 docs/19 §10.1）。
  registerCase('nb-c1b-165: relay TLS wiring positive/negative over a real handshake — matching SPKI pin upgrades and frames flow masked both ways, wrong pin refused with structured pin mismatch, dual-fingerprint window passes on either pin, and default rules run first (IP SAN mismatch refuses even with the correct pin — SAN and pin are independent guards)', async () => {
    const m = await r1CaseSetup('devhub-nb-c1b-165-')
    const wsClient = await import(new URL('../src/main/services/agentControl/relayClient/wsClient.ts', import.meta.url).href)
    const relayIndex = await import(new URL('../src/main/services/agentControl/relayClient/index.ts', import.meta.url).href)
    const good = await c1bSelfSignedCert({ cn: 'devhub-c1b-good', ips: ['127.0.0.1'] })
    const wrongSan = await c1bSelfSignedCert({ cn: 'devhub-c1b-wrongsan', ips: ['10.9.9.9'] })
    let stubA = null
    let stubB = null
    try {
      stubA = await c1bStartTlsRelayStub(good.certPem, good.keyPem)
      const hooks = { onText: () => {}, onClosed: () => {} }
      const endpoint = `wss://127.0.0.1:${stubA.port}`
      // 对指纹通过：upgrade 成功 + 客户端掩码帧抵达桩 + Bearer 头同源
      const okResult = await wsClient.openRelayConnection(
        { endpoint, credential: 'nb-c1b-cred-165', tls: { ca: good.certPem, checkServerIdentity: relayIndex.buildRelayTlsCheckServerIdentity([good.spkiHex]) } },
        hooks,
      )
      assert.equal(okResult.upgraded, true, `matching pin upgrades over the real TLS stack (${okResult.upgraded ? '' : okResult.error})`)
      assert.ok(stubA.connections.length >= 1, 'TLS stub saw the upgraded connection')
      okResult.connection.sendFrame({ type: 'heartbeat', ts: 1, lastSentSeq: 0 })
      await pollUntil(() => (stubA.connections[0]?.received.length ?? 0) >= 1, 3000, 20, 'masked client frame arrives over TLS')
      assert.equal(stubA.connections[0].received[0].json?.type, 'heartbeat', 'WS frame semantics intact over wss')
      okResult.connection.close(1000, 'c1b positive done')
      // 错指纹拒绝：结构化 pin mismatch
      const badPin = await wsClient.openRelayConnection(
        { endpoint, credential: 'nb-c1b-cred-165', tls: { ca: good.certPem, checkServerIdentity: relayIndex.buildRelayTlsCheckServerIdentity(['f'.repeat(64)]) } },
        hooks,
      )
      assert.equal(badPin.upgraded, false, 'wrong pin refused')
      assert.match(badPin.error ?? '', /pin mismatch/, 'structured pin mismatch error')
      // 双指纹窗口：旧+新任一命中即过（新指纹列前，旧指纹命中）
      const dual = await wsClient.openRelayConnection(
        { endpoint, credential: 'nb-c1b-cred-165', tls: { ca: good.certPem, checkServerIdentity: relayIndex.buildRelayTlsCheckServerIdentity(['e'.repeat(64), good.spkiHex]) } },
        hooks,
      )
      assert.equal(dual.upgraded, true, `dual-fingerprint window passes on either pin (${dual.upgraded ? '' : dual.error})`)
      dual.connection.close(1000, 'c1b dual-window done')
      // 默认规则先行：IP SAN 不匹配即拒（pin 正确也不兜底）
      stubB = await c1bStartTlsRelayStub(wrongSan.certPem, wrongSan.keyPem, 18553)
      const sanResult = await wsClient.openRelayConnection(
        { endpoint: `wss://127.0.0.1:${stubB.port}`, credential: 'nb-c1b-cred-165', tls: { ca: wrongSan.certPem, checkServerIdentity: relayIndex.buildRelayTlsCheckServerIdentity([wrongSan.spkiHex]) } },
        hooks,
      )
      assert.equal(sanResult.upgraded, false, 'IP SAN mismatch refused even with the matching pin')
      assert.doesNotMatch(sanResult.error ?? '', /pin mismatch/, 'default rules fire BEFORE the pin check')
      assert.match(sanResult.error ?? '', /altnames|does not match/i, 'refusal is the default IP SAN verdict')
    } finally {
      if (stubA !== null) await r1StubClose(stubA)
      if (stubB !== null) await r1StubClose(stubB)
      await r1CaseTeardown(m)
    }
  })

  // 166. 状态机 wss 端到端 + 信任物缺失 fail-closed + 补放自愈（index.ts 接线）：
  //      信任物缺失 + relay_enabled=1 → 连接流仍以缺省校验尝试（自签证书被默认链
  //      验证拒绝 = fail-closed，lastError 结构化可见，绝不静默零连接也不崩）；
  //      补放指纹/CA（env 缝）→ applyRelaySettings → tls 注入 → hello → ready；
  //      statusProjector 告警随之消除。
  registerCase('nb-c1b-166: state machine over wss end-to-end — missing trust material fails closed under default verification (structured lastError, reconnecting, warning projected, never crash), then provisioning fingerprints+ca.pem heals on the next apply without restart (tls injected, hello, ready, warning cleared)', async () => {
    const m = await r1CaseSetup('devhub-nb-c1b-166-')
    const statusProjector = await import(new URL('../src/main/services/agentControl/relayClient/statusProjector.ts', import.meta.url).href)
    const dir = join(m.credentialFile, '..')
    const fpPath = join(dir, 'fingerprints')
    const caPath = join(dir, 'ca.pem')
    const { certPem, keyPem, spkiHex } = await c1bSelfSignedCert({ cn: 'devhub-c1b-e2e', ips: ['127.0.0.1'] })
    writeFileSync(fpPath, `sha256/${spkiHex}\n`, 'utf8')
    writeFileSync(caPath, certPem, 'utf8')
    const stub = await c1bStartTlsRelayStub(certPem, keyPem, 18563)
    const restoreEnv = c1bUseTrustEnv(join(dir, 'absent-fingerprints'), join(dir, 'absent-ca.pem'))
    try {
      m.settingsSvc.setSetting('gateway_enabled', '1')
      m.settingsSvc.setSetting('relay_enabled', '1')
      m.settingsSvc.setSetting('relay_endpoint', `wss://127.0.0.1:${stub.port}`)
      writeFileSync(m.credentialFile, 'nb-c1b-RELAY-CRED-166\n', 'utf8')
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 50, maxDelayMs: 200 })
      // 阶段一：信任物缺失 → 缺省校验 fail-closed（自签证书被拒），结构化可见
      m.relay.startRelayClient()
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'waiting-retry', 6000, 30, 'fail-closed waiting-retry (default verification refuses the self-signed cert)')
      const diag = m.relay.getRelayClientDiagnostics()
      assert.match(diag.lastError ?? '', /relay connect failed/, 'structured lastError carries the TLS refusal')
      assert.match(statusProjector.projectRelayStatus()?.warning ?? '', /TLS trust material not loaded/, 'trust-missing warning stays visible while connecting')
      // 阶段二：补放信任物（env 缝指向真物料）→ settings 收敛 → tls 注入 → ready
      restoreEnv()
      const restoreReady = c1bUseTrustEnv(fpPath, caPath)
      try {
        await m.relay.applyRelaySettings()
        await r1HelloNewConnection(stub)
        await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 6000, 30, 'ready after trust provisioning (no restart)')
        const view = statusProjector.projectRelayStatus()
        assert.equal(view?.connected, true, 'connected over wss with injected tls options')
        assert.deepEqual(view?.tls, { ok: true, pins: 1, source: 'fingerprints' }, 'fingerprint status row ready (pins + source)')
        assert.ok(!(view?.warning ?? '').includes('TLS trust material'), 'trust warning cleared once provisioned')
      } finally {
        restoreReady()
      }
    } finally {
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      restoreEnv()
      await r1CaseTeardown(m)
    }
  })

  // 167. M3-C6a：REST POST /v1/pairing/create 统一走 L3 签发缝（agentControlService.createPairing，
  //      与 IPC agents:pairingCreate 同源）——回环 REST 签发即触发 notifyPairingIssued →
  //      pairingBridge register_pairing（码现场 sha256 上帧，明文绝不上线/落审计），
  //      响应契约（201 {pairingId, code, expiresAt}）与回环/防重放/TTL/审计面零变化。
  //      C2b 实证缺口回归面：C2b 批 5 次实测 REST 签发 pairing_codes 停在 Windows 侧、
  //      无 pairing_code_registered（httpServer 直调 gateway/pairing 绕过 L3）。
  registerCase('nb-c6a-167: REST pairing/create rides the L3 issuance seam — loopback create syncs register_pairing onto the relay (code hashed on-site, plaintext never framed), response contract unchanged (201 {pairingId, 8-char Crockford code, expiresAt ~ now+300}), pairing_code_created audit intact', async () => {
    const m = await r1CaseSetup('devhub-nb-c6a-167-')
    const gw = await import(new URL('../src/main/services/agentControl/gateway/httpServer.ts', import.meta.url).href)
    const db = m.dbModule.getDatabase()
    const stub = await r1StartRelayStub()
    try {
      const relayCred = `nb-c6a-RELAY-CRED-${randomBytes(12).toString('hex')}`
      r1EnableRelay(m, stub, relayCred)
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 50, maxDelayMs: 200 })
      m.relay.startRelayClient()
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'relay ready')
      const started = await gw.startGateway()
      assert.equal(started.running, true, 'gateway listening for the REST create')
      assert.equal(started.actualPort, 8746, 'gateway on default port')

      // 回环 REST 签发（与 ac6-122 pairingCreateHttp 同形：防重放头必带）
      const r = await gwRequest(8746, 'POST', '/v1/pairing/create', { body: { deviceName: 'nb-c6a-phone' }, headers: replayHeaders() })
      assert.equal(r.status, 201, `pairing/create -> 201, got ${r.status} ${r.raw}`)
      // 响应契约不变：{pairingId, 8 位 Crockford 码, expiresAt ≈ now+300}
      assert.match(r.json.pairingId, /^pair-/, 'pairingId shape unchanged')
      assert.match(r.json.code, /^[0-9A-HJ-NP-TV-Z]{8}$/, '8-char Crockford code unchanged')
      assert.ok(Math.abs(r.json.expiresAt - (Math.floor(Date.now() / 1000) + 300)) <= 5, 'TTL 300s unchanged')

      // L3 签发同步被调：relay 桩收到 register_pairing（pairingId 对齐 + 码现场哈希 + TTL 透传）
      const reg = await r1StubWait(stub, (f) => f.json?.type === 'register_pairing' && f.json.pairingId === r.json.pairingId, 3000, 'register_pairing')
      assert.equal(reg.json.codeHash, m.auth.sha256Hex(r.json.code), 'code hashed on-site (sha256), plaintext never framed')
      assert.equal(reg.json.expiresAt, r.json.expiresAt, 'expiresAt carried to the ECS sync frame')

      // 审计路径完好：pairing_code_created 落库且零码明文（docs/15 §2）
      const audit = db.prepare("SELECT detail_json FROM security_audit_logs WHERE category='pairing' AND action='pairing_code_created' ORDER BY id DESC LIMIT 1").get()
      assert.ok(audit, 'pairing_code_created audited')
      assert.ok(!audit.detail_json.includes(r.json.code), 'audit carries no code plaintext')
    } finally {
      await gw.resetGatewayInMemoryState()
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      await r1CaseTeardown(m)
    }
  })

  // ====================================================================
  // M3-C7b 桌面修复批 — nb-c7b 段（任务书 docs/briefs/m3c7b-host-leg.md）：
  // ① host 腿只读投影三处理器（agent_list/session_list/message，docs/18 §7.1 G5）
  // ② 轮换宽限桌面镜像三态（migration 006 append-only，docs/18 §3.14）
  // ③ 命令拒绝设备向回程（docs/18 error 跨腿空白点的最小实现）
  // 既有 169 用例零改动（append-only，约束 #27）。
  // ====================================================================

  // 168. 轮换宽限镜像三态（docs/18 §3.14 + migration 006）：无轮换恒认（态三）/
  //      窗内 v1 仍认（态一）/ 窗外 v1 拒（态二）；撤销即拒对宽限/新值同等生效；
  //      rotateDeviceToken 落库 previous_token_hash/rotated_at 成对登记（零明文）；
  //      migration 006 append-only 到位（user_version=6 + 新列存在）。
  registerCase('nb-c7b-168: rotation grace mirror three-state — no-rotation accepts current token only, in-window old token still accepted (row identity, current version projected), out-of-window old token rejected, revocation dominates both hashes; migration 006 lands user_version=6 with previous_token_hash/rotated_at columns, rotateDeviceToken pairs them with zero plaintext', async () => {
    const m = await r1CaseSetup('devhub-nb-c7b-168-')
    const db = m.dbModule.getDatabase()
    try {
      // migration 006 append-only 到位
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 8, 'migration 006/008 registered (user_version=8, CP1 批次就地更新 6→8)')
      const cols = db.prepare("SELECT name FROM pragma_table_info('remote_devices')").all().map((r) => r.name)
      assert.ok(cols.includes('previous_token_hash'), 'previous_token_hash column exists')
      assert.ok(cols.includes('rotated_at'), 'rotated_at column exists')

      const v1 = `nb-c7b-168-v1-${randomBytes(8).toString('hex')}`
      const deviceId = r1FixtureDevice(m, db, 'nb-c7b-168-phone', v1)

      // 态三（无轮换）：当前 token 恒认；无关 token 拒
      assert.equal(m.auth.authenticateBearerToken(v1).id, deviceId, 'no-rotation: current token accepted')
      assert.throws(() => m.auth.authenticateBearerToken('nb-c7b-168-wrong-token'), (err) => err.code === 'AUTH_INVALID_TOKEN', 'no-rotation: unknown token rejected')

      // 轮换：v2 落库 + previous_token_hash/rotated_at 成对登记（哈希非明文）
      const rotated = m.svc.rotateDeviceToken(deviceId, 'manual')
      assert.equal(rotated.tokenVersion, 2, 'rotation bumps token_version')
      const row = db.prepare('SELECT previous_token_hash, rotated_at, token_hash, token_version FROM remote_devices WHERE id = ?').get(deviceId)
      assert.equal(row.previous_token_hash, m.auth.sha256Hex(v1), 'previous hash = sha256(v1)')
      assert.equal(row.token_hash, m.auth.sha256Hex(rotated.token), 'current hash = sha256(v2)')
      assert.ok(Math.abs(Number(row.rotated_at) - Math.floor(Date.now() / 1000)) <= 5, 'rotated_at lands at rotation moment')

      // 态一（窗内）：v1 仍认（同一设备行；tokenVersion 投影行现值 v2，绝不伪造 v1）
      const grace = m.auth.authenticateBearerToken(v1)
      assert.equal(grace.id, deviceId, 'in-window: v1 accepted')
      assert.equal(grace.tokenVersion, 2, 'in-window: row current version projected')
      assert.equal(m.auth.authenticateBearerToken(rotated.token).id, deviceId, 'in-window: v2 accepted')

      // 态二（窗外 301s）：v1 拒；v2 认
      db.prepare('UPDATE remote_devices SET rotated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 301, deviceId)
      assert.throws(() => m.auth.authenticateBearerToken(v1), (err) => err.code === 'AUTH_INVALID_TOKEN', 'out-of-window: v1 rejected')
      assert.equal(m.auth.authenticateBearerToken(rotated.token).id, deviceId, 'out-of-window: v2 accepted')

      // 撤销即拒优先（docs/15 §4）：窗内宽限也绝不复活撤销设备；新值同样拒
      // （ rotated_at 回到窗内——撤销设备只剩 DEVICE_REVOKED，绝不 AUTH_INVALID_TOKEN 冒充）
      db.prepare('UPDATE remote_devices SET rotated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), deviceId)
      db.prepare("UPDATE remote_devices SET status = 'revoked' WHERE id = ?").run(deviceId)
      assert.throws(() => m.auth.authenticateBearerToken(v1), (err) => err.code === 'DEVICE_REVOKED', 'revoked: grace never revives')
      assert.throws(() => m.auth.authenticateBearerToken(rotated.token), (err) => err.code === 'DEVICE_REVOKED', 'revoked: new hash never revives')
    } finally {
      await r1CaseTeardown(m)
    }
  }, 'fast')

  // 169. host 腿只读投影三处理器正路径（docs/18 §3.4/§3.5/§3.7 + §7.1 G5，M3-C7b 修 ①）：
  //      agent_list → REST 四字段投影（本机面字段绝不出境）；session_list（providerId
  //      业务键形态）→ stale:false + SessionView；message → items 投影绝无 sourceRef、
  //      segments/occurredAt 可选携带；requestId 原样回显（R2 裁定④）。
  registerCase('nb-c7b-169: host-leg read-only projection frames over the stub — agent_list mirrors the REST four-field provider shape (no local-only fields), session_list answers stale:false with the SessionView (business-key providerId resolves), message items carry contentRedacted/occurredAt/segments and never sourceRef, requestIds echoed', async () => {
    const m = await r1CaseSetup('devhub-nb-c7b-169-')
    const db = m.dbModule.getDatabase()
    const stub = await r1StartRelayStub()
    try {
      r1EnableRelay(m, stub, 'nb-c7b-relay-cred-169')
      const { providerId, sessionId } = await r1FixtureManagedProvider(m, db, 'nb-c7b-169')
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_messages (session_id, native_msg_id, role, content_redacted, occurred_at, created_at) VALUES (?, ?, 'user', ?, ?, ?)")
        .run(sessionId, 'nb-c7b-169-m1', '第一条（脱敏投影）', now - 10, now - 10)
      db.prepare("INSERT INTO agent_messages (session_id, native_msg_id, role, content_redacted, segments_json, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)")
        .run(sessionId, 'nb-c7b-169-m2', '第二条（脱敏投影）', JSON.stringify([{ kind: 'thinking', label: '推理', content: '…' }]), now - 5)
      r1FixtureDevice(m, db, 'nb-c7b-169-phone', `nb-c7b-169-dev-${randomBytes(6).toString('hex')}`)
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 50, maxDelayMs: 200 })
      m.relay.startRelayClient()
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'relay ready')

      // agent_list（fixture #4 为底）
      const agentReq = r1FixtureFrame(4, 'device-to-ecs')
      agentReq.requestId = 'nb-c7b-169-agents'
      r1StubSend(stub, agentReq)
      const agents = await r1StubWait(stub, (f) => f.json?.type === 'agent_list' && f.json.requestId === 'nb-c7b-169-agents', 4000, 'agent_list response')
      assert.ok(Array.isArray(agents.json.providers), 'providers array')
      const mine = agents.json.providers.find((p) => p.id === providerId)
      assert.ok(mine !== undefined, 'fixture provider projected')
      assert.equal(mine.displayName, 'kimi fixture')
      assert.equal(mine.health, 'ok')
      assert.ok(typeof mine.capabilities === 'object' && mine.capabilities !== null, 'capabilities object rides')
      assert.ok(!('exePath' in mine) && !('lastProbeAt' in mine) && !('installed' in mine), 'local-only fields never leave (REST four-field shape)')

      // session_list（fixture #5 为底；providerId 业务键 = fixture #5 样本形态）
      const sessReq = r1FixtureFrame(5, 'device-to-ecs')
      sessReq.requestId = 'nb-c7b-169-sessions'
      sessReq.query = { providerId: 'kimi', limit: 100 }
      r1StubSend(stub, sessReq)
      const sessions = await r1StubWait(stub, (f) => f.json?.type === 'session_list' && f.json.requestId === 'nb-c7b-169-sessions', 4000, 'session_list response')
      assert.equal(sessions.json.stale, false, 'host online answers stale:false')
      const sessMine = sessions.json.sessions.find((s) => s.id === sessionId)
      assert.ok(sessMine !== undefined, 'fixture session projected')
      assert.equal(sessMine.status, 'running')

      // message（fixture #7 为底）
      const msgReq = r1FixtureFrame(7, 'device-to-ecs')
      msgReq.requestId = 'nb-c7b-169-messages'
      msgReq.sessionId = sessionId
      msgReq.last = 10
      msgReq.limit = 10
      r1StubSend(stub, msgReq)
      const messages = await r1StubWait(stub, (f) => f.json?.type === 'message' && f.json.requestId === 'nb-c7b-169-messages', 4000, 'message response')
      assert.equal(messages.json.items.length, 2, 'both messages projected')
      assert.equal(messages.json.items[0].contentRedacted, '第一条（脱敏投影）', 'ASC order content')
      assert.ok(messages.json.items.every((it) => !('sourceRef' in it)), 'sourceRef never crosses the leg (docs/15 §6)')
      assert.ok(!('prevAfter' in messages.json), 'no prevAfter without older rows')
      assert.ok(Array.isArray(messages.json.items[1].segments), 'segments ride when structured')
      assert.equal(messages.json.items[1].occurredAt, undefined, 'occurredAt optional (absent when null)')
    } finally {
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      await r1CaseTeardown(m)
    }
  })

  // 170. host 腿校验折叠 + 命令拒绝设备向回程（M3-C7b 修 ③）：非法 query/未知资源/
  //      互斥取数 → error 帧原码（BAD_PAYLOAD/NOT_FOUND）；缺 requestId → error 不回显；
      // command 拒绝（错 token / 结构缺字段）→ error + command_ack{rejected,errorCode}
      // 双帧回程（docs/18 error 跨腿空白点最小实现，中继=是；缺幂等键仅 error）。
  registerCase('nb-c7b-170: host-leg validation folds + device-ward rejection return — bad query/unknown resource/mutually-exclusive paging fold to error frames with echoed ids, missing requestId errors without echo, wrong-token and malformed commands return BOTH the H->E error frame and the relayable command_ack{rejected,errorCode} (docs/18 blank-spot minimal return), missing idempotencyKey emits error only (no routable ack)', async () => {
    const m = await r1CaseSetup('devhub-nb-c7b-170-')
    const db = m.dbModule.getDatabase()
    const stub = await r1StartRelayStub()
    try {
      r1EnableRelay(m, stub, 'nb-c7b-relay-cred-170')
      const { sessionId } = await r1FixtureManagedProvider(m, db, 'nb-c7b-170')
      const deviceToken = `nb-c7b-170-dev-${randomBytes(8).toString('hex')}`
      r1FixtureDevice(m, db, 'nb-c7b-170-phone', deviceToken)
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 50, maxDelayMs: 200 })
      m.relay.startRelayClient()
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'relay ready')

      // A) session_list 非法 status → BAD_PAYLOAD（requestId 回显）
      const badStatus = r1FixtureFrame(5, 'device-to-ecs')
      badStatus.requestId = 'nb-c7b-170-req-1'
      badStatus.query = { status: 'bogus' }
      r1StubSend(stub, badStatus)
      const badStatusErr = await r1StubWait(stub, (f) => f.json?.type === 'error' && f.json.requestId === 'nb-c7b-170-req-1', 4000, 'bad status error')
      assert.equal(badStatusErr.json.code, 'BAD_PAYLOAD')

      // B) session_list 未知业务键 → NOT_FOUND（绝不猜空结果）
      const ghost = r1FixtureFrame(5, 'device-to-ecs')
      ghost.requestId = 'nb-c7b-170-req-2'
      ghost.query = { providerId: 'ghost-provider' }
      r1StubSend(stub, ghost)
      const ghostErr = await r1StubWait(stub, (f) => f.json?.type === 'error' && f.json.requestId === 'nb-c7b-170-req-2', 4000, 'ghost provider error')
      assert.equal(ghostErr.json.code, 'NOT_FOUND')

      // C) message 未知会话 → NOT_FOUND
      const unknownSession = r1FixtureFrame(7, 'device-to-ecs')
      unknownSession.requestId = 'nb-c7b-170-req-3'
      unknownSession.sessionId = 999999
      r1StubSend(stub, unknownSession)
      const unknownErr = await r1StubWait(stub, (f) => f.json?.type === 'error' && f.json.requestId === 'nb-c7b-170-req-3', 4000, 'unknown session error')
      assert.equal(unknownErr.json.code, 'NOT_FOUND')

      // D) message after+last 互斥 → BAD_PAYLOAD（ux A R10 同参）
      const exclusive = r1FixtureFrame(7, 'device-to-ecs')
      exclusive.requestId = 'nb-c7b-170-req-4'
      exclusive.sessionId = sessionId
      exclusive.after = 1
      exclusive.last = 5
      r1StubSend(stub, exclusive)
      const exclusiveErr = await r1StubWait(stub, (f) => f.json?.type === 'error' && f.json.requestId === 'nb-c7b-170-req-4', 4000, 'exclusive paging error')
      assert.equal(exclusiveErr.json.code, 'BAD_PAYLOAD')

      // E) agent_list 缺 requestId → BAD_PAYLOAD 且不回显（无关联键不伪造）
      r1StubSend(stub, { type: 'agent_list' })
      const noReqErr = await r1StubWait(stub, (f) => f.json?.type === 'error' && f.json.code === 'BAD_PAYLOAD' && !('requestId' in f.json), 4000, 'missing requestId error')

      // F) command 错 token → error AUTH_INVALID_TOKEN + command_ack rejected（修 ③ 回程）
      const nowSec = Math.floor(Date.now() / 1000)
      const wrongToken = r1FixtureFrame(8, 'device-to-ecs')
      wrongToken.requestId = 'nb-c7b-170-req-6'
      wrongToken.idempotencyKey = 'nb-c7b-170-key-6'
      wrongToken.sessionId = sessionId
      wrongToken.payload = { text: 'wrong token probe' }
      wrongToken.auth = { token: 'nb-c7b-170-wrong-token', ts: nowSec, nonce: randomBytes(16).toString('hex') }
      r1StubSend(stub, wrongToken)
      const wtErr = await r1StubWait(stub, (f) => f.json?.type === 'error' && f.json.requestId === 'nb-c7b-170-req-6', 4000, 'wrong token error frame')
      assert.equal(wtErr.json.code, 'AUTH_INVALID_TOKEN')
      const wtAck = await r1StubWait(stub, (f) => f.json?.type === 'command_ack' && f.json.requestId === 'nb-c7b-170-req-6', 4000, 'wrong token device-ward ack')
      assert.equal(wtAck.json.status, 'rejected')
      assert.equal(wtAck.json.errorCode, 'AUTH_INVALID_TOKEN')
      assert.equal(wtAck.json.idempotencyKey, 'nb-c7b-170-key-6')

      // G) command 缺 sessionId（幂等键合法）→ error + ack rejected BAD_PAYLOAD
      const noSession = r1FixtureFrame(8, 'device-to-ecs')
      noSession.requestId = 'nb-c7b-170-req-7'
      noSession.idempotencyKey = 'nb-c7b-170-key-7'
      noSession.payload = { text: 'no session probe' }
      delete noSession.sessionId
      noSession.auth = { token: deviceToken, ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('hex') }
      r1StubSend(stub, noSession)
      const nsAck = await r1StubWait(stub, (f) => f.json?.type === 'command_ack' && f.json.requestId === 'nb-c7b-170-req-7', 4000, 'no-session device-ward ack')
      assert.equal(nsAck.json.status, 'rejected')
      assert.equal(nsAck.json.errorCode, 'BAD_PAYLOAD')

      // H) command 缺 idempotencyKey → 仅 error（回程帧无处路由，不伪造 ack）
      const noKey = r1FixtureFrame(8, 'device-to-ecs')
      noKey.requestId = 'nb-c7b-170-req-8'
      noKey.sessionId = sessionId
      noKey.payload = { text: 'no key probe' }
      delete noKey.idempotencyKey
      noKey.auth = { token: deviceToken, ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('hex') }
      r1StubSend(stub, noKey)
      const nkErr = await r1StubWait(stub, (f) => f.json?.type === 'error' && f.json.requestId === 'nb-c7b-170-req-8', 4000, 'no-key error frame')
      assert.equal(nkErr.json.code, 'BAD_PAYLOAD')
      assert.ok(!stub.log.some((e) => e.json?.type === 'command_ack' && e.json.requestId === 'nb-c7b-170-req-8'), 'no routable ack without idempotencyKey')

      // 全程拒绝路径零命令流水行
      assert.equal(db.prepare('SELECT COUNT(*) c FROM remote_commands').get().c, 0, 'rejection paths never land command rows')
    } finally {
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      await r1CaseTeardown(m)
    }
  })

  // ====================================================================
  // M3-E1 批次（设备自管理通道 + App managed spawn，docs/18 §5.3 + docs/20 §3
  // R-B5/R-B8 修订判据，用户裁决 2026-09-07 #9=B）：m3e1-spawn / m3e1-revoke 两条追加。
  // 全程夹具 Relay 桩（127.0.0.1 随机高端口，零联网零 8746）；临时库隔离；fast 档。
  // ====================================================================

  // 171. spawn_session 下行（§2.2.1/§2.2.2/§2.2.4）：帧校验（providerId 非空 + task
  //      非空 ≤4000）→ 授权矩阵预分类（observed → COMMAND_NOT_EXECUTABLE）→ L3 既有
  //      spawn 托管通道（幂等行/能力门复用）→ command_ack(accepted) + command_result
  //      (executed, sessionId, action='spawn_session')；nativeId 仅经 command.result
  //      事件 payload 回流（§5.3 帧形零扩展）；拒绝映射：未验证/过期 →
  //      AGENT_CAPABILITY_MISSING、spawn 特有（provider 无托管通道）→ SPAWN_REJECTED
  //      （新码）、未知 provider → NOT_FOUND、坏 payload → BAD_PAYLOAD；拒绝路径零流水行。
  registerCase('m3e1-spawn: spawn_session downlink — happy path (ack accepted + command_result executed with sessionId, action=spawn_session, remote_commands action=spawn, nativeId flows via command.result event payload), idempotent retry replays without duplicate execution, rejection mapping (observed -> COMMAND_NOT_EXECUTABLE, stale caps -> AGENT_CAPABILITY_MISSING, no managed channel -> SPAWN_REJECTED, unknown provider -> NOT_FOUND, bad payload -> BAD_PAYLOAD) with zero rows on rejections', async () => {
    const m = await r1CaseSetup('devhub-m3e1-spawn-')
    const db = m.dbModule.getDatabase()
    const stub = await r1StartRelayStub()
    try {
      r1EnableRelay(m, stub, 'm3e1-relay-cred-spawn')
      const now = Math.floor(Date.now() / 1000)
      // 四 provider 行：kimi=managed 新鲜（正路）/ zcode=observed（矩阵不允许）/
      // kimi-stale=managed 过期（能力门）/ kimi-nochannel=managed 新鲜但桩未实现托管通道
      const capsManaged = JSON.stringify({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: now, evidence: 'fixture managed' })
      const capsObserved = JSON.stringify({ mode: 'observed', granted: [], verifiedAt: now, evidence: 'fixture observed' })
      const capsStale = JSON.stringify({ mode: 'managed', granted: ['reply'], verifiedAt: now - 400, evidence: 'stale fixture' })
      fixtureProviderRow(db, 'kimi')
      fixtureProviderRow(db, 'zcode')
      fixtureProviderRow(db, 'kimi-stale')
      fixtureProviderRow(db, 'kimi-nochannel')
      db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE provider = ?').run(capsManaged, 'kimi')
      db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE provider = ?').run(capsObserved, 'zcode')
      db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE provider = ?').run(capsStale, 'kimi-stale')
      db.prepare('UPDATE agent_providers SET capabilities_json = ? WHERE provider = ?').run(capsManaged, 'kimi-nochannel')
      const spawnCalls = []
      m.providerRegistry.setProviderOverride('kimi', {
        ...stubAgentProvider('kimi'),
        probeHealth: async () => ({ installed: true, health: 'ok' }),
        getCapabilities: async () => ({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: now, evidence: 'fixture managed' }),
        startManagedSession: async (task, sink) => {
          spawnCalls.push(task)
          sink.onSessionDiscovered?.('kimi', { nativeId: 'managed-kimi-m3e1-1', mode: 'managed', lastActivityAt: now })
          return { ok: true, nativeId: 'managed-kimi-m3e1-1', detail: 'fixture managed start' }
        },
      })
      // kimi-nochannel：桩刻意不带 startManagedSession（provider 无托管通道 → SPAWN_REJECTED）
      m.providerRegistry.setProviderOverride('kimi-nochannel', {
        ...stubAgentProvider('kimi-nochannel'),
        getCapabilities: async () => ({ mode: 'managed', granted: ['reply'], verifiedAt: now, evidence: 'fixture managed (no channel)' }),
      })
      const deviceToken = `m3e1-dev-token-spawn-${randomBytes(8).toString('hex')}`
      r1FixtureDevice(m, db, 'm3e1-spawn-phone', deviceToken)
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 50, maxDelayMs: 200 })
      m.relay.startRelayClient()
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'relay ready')

      const authFrame = () => ({ token: deviceToken, ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('hex') })
      const spawnFrame = (reqKey, key, payload, action = 'spawn_session') => {
        const f = r1FixtureFrame(8, 'device-to-ecs')
        f.requestId = reqKey
        f.idempotencyKey = key
        f.action = action
        delete f.sessionId // §5.3 帧形：尚无会话 → sessionId 缺省
        f.payload = payload
        f.auth = authFrame()
        f.createdAt = Math.floor(Date.now() / 1000)
        return f
      }

      // 正路：ack accepted + command_result executed(sessionId)
      r1StubSend(stub, spawnFrame('m3e1-spawn-req-1', 'm3e1-spawn-key-1', { providerId: 'kimi', task: 'm3e1 fixture turn' }))
      const ack = await r1StubWait(stub, (f) => f.json?.type === 'command_ack' && f.json.idempotencyKey === 'm3e1-spawn-key-1', 4000, 'spawn ack')
      assert.equal(ack.json.status, 'accepted')
      assert.match(ack.json.commandId, /^cmd-/, 'ack carries the L3 commandId')
      const result = await r1StubWait(stub, (f) => f.json?.type === 'command_result' && f.json.idempotencyKey === 'm3e1-spawn-key-1', 4000, 'spawn result')
      assert.equal(result.json.action, 'spawn_session', 'command_result uses the relay action name')
      assert.equal(result.json.status, 'executed')
      assert.ok(typeof result.json.sessionId === 'number' && result.json.sessionId > 0, 'result carries the new sessionId')
      assert.ok(!('nativeId' in result.json), 'nativeId never rides the command_result frame (§5.3: event payload only)')
      assert.deepEqual(spawnCalls, ['m3e1 fixture turn'], 'provider startManagedSession invoked once with the verbatim task')
      const sessRow = db.prepare('SELECT session_mode, status FROM agent_sessions WHERE id = ?').get(result.json.sessionId)
      assert.equal(sessRow.session_mode, 'managed', 'session row lands as managed')
      assert.equal(sessRow.status, 'running', 'session advances to running')
      const cmdRow = db.prepare('SELECT action, status, result_json FROM remote_commands WHERE command_id = ?').get(ack.json.commandId)
      assert.equal(cmdRow.action, 'spawn', 'remote_commands reuses the spawn idempotent row (REST 同源通道)')
      assert.equal(cmdRow.status, 'executed')
      const ev = db.prepare("SELECT payload_json FROM agent_events WHERE event_type = 'command.result' ORDER BY id DESC LIMIT 1").get()
      assert.ok(ev !== undefined, 'command.result event recorded')
      assert.ok(ev.payload_json.includes('"nativeId"'), 'nativeId flows via the command.result event payload (§5.3)')

      // 幂等重试：同 key 同 payload 新 nonce → 原 commandId 原结果，零重复执行
      const retry = spawnFrame('m3e1-spawn-req-1r', 'm3e1-spawn-key-1', { providerId: 'kimi', task: 'm3e1 fixture turn' })
      retry.auth = authFrame()
      r1StubSend(stub, retry)
      const replayAck = await r1StubWait(stub, (f) => f.json?.type === 'command_ack' && f.json.idempotencyKey === 'm3e1-spawn-key-1', 4000, 'replay ack')
      assert.equal(replayAck.json.commandId, ack.json.commandId, 'retry replays the original commandId')
      assert.equal(replayAck.json.requestId, 'm3e1-spawn-req-1r', 'replay ack echoes the retry requestId')
      const replayResult = await r1StubWait(stub, (f) => f.json?.type === 'command_result' && f.json.idempotencyKey === 'm3e1-spawn-key-1', 4000, 'replayed result')
      assert.equal(replayResult.json.commandId, ack.json.commandId, 'retry replays the original commandId')
      assert.equal(replayResult.json.sessionId, result.json.sessionId, 'retry replays the original sessionId')
      assert.equal(spawnCalls.length, 1, 'no duplicate managed start on retry')

      // 拒绝映射（§2.2.2；拒绝路径零流水行）
      const expectRejection = async (reqKey, key, payload, provider, expectCode) => {
        const f = spawnFrame(reqKey, key, payload)
        if (provider !== undefined) f.payload = { ...payload, providerId: provider }
        r1StubSend(stub, f)
        const r = await r1StubWait(stub, (x) => x.json?.type === 'command_ack' && x.json.idempotencyKey === key, 4000, `rejection ${expectCode}`)
        assert.equal(r.json.status, 'rejected', `${expectCode} rejection status`)
        assert.equal(r.json.errorCode, expectCode, `${expectCode} mapping`)
      }
      await expectRejection('m3e1-spawn-req-o', 'm3e1-spawn-key-o', { providerId: 'zcode', task: 'x' }, undefined, 'COMMAND_NOT_EXECUTABLE')
      await expectRejection('m3e1-spawn-req-s', 'm3e1-spawn-key-s', { providerId: 'kimi-stale', task: 'x' }, undefined, 'AGENT_CAPABILITY_MISSING')
      await expectRejection('m3e1-spawn-req-n', 'm3e1-spawn-key-n', { providerId: 'kimi-nochannel', task: 'x' }, undefined, 'SPAWN_REJECTED')
      await expectRejection('m3e1-spawn-req-u', 'm3e1-spawn-key-u', { providerId: 'ghost', task: 'x' }, undefined, 'NOT_FOUND')
      await expectRejection('m3e1-spawn-req-b', 'm3e1-spawn-key-b', { providerId: 'kimi', task: '   ' }, undefined, 'BAD_PAYLOAD')
      await expectRejection('m3e1-spawn-req-p', 'm3e1-spawn-key-p', { task: 'no provider' }, undefined, 'BAD_PAYLOAD')
      assert.equal(spawnCalls.length, 1, 'rejections never reach the provider')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM remote_commands').get().c, 1, 'exactly one command row (rejections never land rows)')
    } finally {
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      await r1CaseTeardown(m)
    }
  }, 'fast')

  // 172. revoke_device 下行（§2.2.3/§2.3.3）：目标 = auth Token 对应 deviceId（自指；
  //      payload 一概不解释——「代撤销他设备」语义零承载面）；ack(accepted) 先于
  //      disconnect(revoked) 出帧（wire 序）；L3 撤销链自动接管（踢线帧 + 注册表
  //      revoked + 401 语义由 ECS/Windows 双侧承接）；commandId 终态照常落库
  //      （action='revoke_device'，executed）；同 key 重试零重复撤销；他设备行不受扰。
  registerCase('m3e1-revoke: revoke_device downlink — self-target only (delegating payload ignored), ack accepted precedes disconnect{deviceId,revoked} on the wire, remote_commands terminal executed with commandId, audit via relay-self, other device row untouched, idempotent replay never re-kicks', async () => {
    const m = await r1CaseSetup('devhub-m3e1-revoke-')
    const db = m.dbModule.getDatabase()
    const stub = await r1StartRelayStub()
    try {
      r1EnableRelay(m, stub, 'm3e1-relay-cred-revoke')
      const tokenA = `m3e1-dev-token-A-${randomBytes(8).toString('hex')}`
      const tokenB = `m3e1-dev-token-B-${randomBytes(8).toString('hex')}`
      const deviceA = r1FixtureDevice(m, db, 'm3e1-revoke-phone-A', tokenA)
      const deviceB = r1FixtureDevice(m, db, 'm3e1-revoke-phone-B', tokenB)
      m.relay.configureRelayClientRuntime({ helloTimeoutMs: 3000, baseDelayMs: 50, maxDelayMs: 200 })
      m.relay.startRelayClient()
      await r1HelloNewConnection(stub)
      await pollUntil(() => m.relay.getRelayClientDiagnostics().status === 'ready', 5000, 30, 'relay ready')

      const f = r1FixtureFrame(8, 'device-to-ecs')
      f.requestId = 'm3e1-revoke-req-1'
      f.idempotencyKey = 'm3e1-revoke-key-1'
      f.action = 'revoke_device'
      delete f.sessionId
      // 越权探针：payload 携带他设备目标——协议无目标字段，Windows 一概不解释（绝不代撤销）
      f.payload = { deviceId: deviceB, target: 'please revoke the other device' }
      f.auth = { token: tokenA, ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('hex') }
      f.createdAt = Math.floor(Date.now() / 1000)
      r1StubSend(stub, f)

      // 等踢线帧落桩日志（stub.log 保序 → 事后取 index 断言 wire 序）
      await pollUntil(() => stub.log.some((e) => e.json?.type === 'disconnect' && e.json.reason === 'revoked'), 4000, 20, 'kick frame')
      const ackIdx = stub.log.findIndex((e) => e.json?.type === 'command_ack' && e.json.idempotencyKey === 'm3e1-revoke-key-1')
      assert.ok(ackIdx >= 0, 'revoke command_ack observed')
      assert.equal(stub.log[ackIdx].json.status, 'accepted')
      assert.match(stub.log[ackIdx].json.commandId, /^cmd-/, 'revoke ack carries the L3 commandId')
      const kickIdx = stub.log.findIndex((e) => e.json?.type === 'disconnect' && e.json.reason === 'revoked')
      assert.ok(kickIdx > ackIdx, 'wire order: ack precedes disconnect{revoked} (docs/18 §5.3 受理先于踢线)')
      assert.equal(stub.log[kickIdx].json.deviceId, deviceA, 'kick targets the authed device only')

      // commandId 终态照常落库（§5.3 终态收口 = disconnect，回帧不保证送达——本面不发 result 帧）
      const row = db.prepare('SELECT action, status, device_id FROM remote_commands WHERE command_id = ?').get(stub.log[ackIdx].json.commandId)
      assert.equal(row.action, 'revoke_device', 'terminal row uses the relay action name')
      assert.equal(row.status, 'executed', 'terminal state recorded (docs/18 §5.3 commandId 终态照常落库)')
      assert.equal(row.device_id, deviceA)
      const audit = db.prepare("SELECT detail_json FROM security_audit_logs WHERE category = 'device' AND action = 'device_revoked' ORDER BY id DESC LIMIT 1").get()
      assert.ok(audit !== undefined && audit.detail_json.includes('relay-self'), 'audit records the relay-command source (via=relay-self)')
      // 他设备零扰（自指红线）
      const rowB = db.prepare('SELECT status FROM remote_devices WHERE id = ?').get(deviceB)
      assert.equal(rowB.status, 'active', 'payload-delegated target device B is NOT revoked')
      const rowA = db.prepare('SELECT status FROM remote_devices WHERE id = ?').get(deviceA)
      assert.equal(rowA.status, 'revoked', 'authed device A revoked')

      // 同 key 重试：原 commandId 原受理，零重复踢线
      const kickBefore = stub.log.filter((e) => e.json?.type === 'disconnect' && e.json.reason === 'revoked').length
      r1StubSend(stub, { ...f, requestId: 'm3e1-revoke-req-1r', auth: { ...f.auth, nonce: randomBytes(16).toString('hex') } })
      await pollUntil(() => stub.log.some((e) => e.json?.type === 'command_ack' && e.json.idempotencyKey === 'm3e1-revoke-key-1' && e.json.requestId === 'm3e1-revoke-req-1r'), 4000, 30, 'replay ack')
      const kickAfter = stub.log.filter((e) => e.json?.type === 'disconnect' && e.json.reason === 'revoked').length
      assert.equal(kickAfter, kickBefore, 'idempotent replay never re-kicks')
      const rowAgain = db.prepare('SELECT COUNT(*) c FROM remote_commands WHERE action = ?').get('revoke_device')
      assert.equal(rowAgain.c, 1, 'still exactly one revoke_device row')
    } finally {
      m.relay.resetRelayClientForSmoke()
      await r1StubClose(stub)
      await r1CaseTeardown(m)
    }
  }, 'fast')

  // ====================================================================
  // CP1 批次（ContestPin，docs/22 §2/§3 + docs/04「ContestPin 追加」节）：
  // contestService CRUD / 节点精度 / 资源边。全部 makeTempHome 临时库隔离
  // （零进程零端口，fast 档）；迁移断言与 7 表存在性已并入 step3/step5 既有用例
  // （cp1-migration-fresh，就地扩展），本段只新增用例、不动既有用例本体。
  // ====================================================================

  registerCase(
    'cp1-crud: contestService create→get→update→archive→list（query/status/archived 过滤）→delete 两段式（confirmRequired+impacts → confirmed 级联删+资源节点清理）+ settings 3 键白名单',
    async () => {
      const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
      const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
      const svc = await import(new URL('../src/main/services/contestpin/contestService.ts', import.meta.url).href)

      await makeTempHome('devhub-cp1-crud-')
      try {
        // settings 白名单 3 键（CP1 批次追加）：写入不再拒绝，读写闭环
        settings.setSetting('contestpin_default_mode', 'two_stage')
        settings.setSetting('contestpin_overlay_enabled', '1')
        settings.setSetting('contestpin_overlay_state', '{"bounds":{"x":1,"y":2},"collapsed":false}')
        assert.equal(settings.getSetting('contestpin_overlay_state'), '{"bounds":{"x":1,"y":2},"collapsed":false}', 'overlay_state runtime key round-trips')
        assert.throws(() => settings.setSetting('contestpin_not_a_key', 'x'), /not allowed/, 'non-whitelisted key still rejected')

        // create + 校验链
        const created = svc.createContest({
          name: 'ICPC Asia Regional',
          year: 2026,
          status: 'registered',
          officialSite: 'https://icpc.example.com',
          signupUrl: 'http://signup.example.com/register',
        })
        assert.ok(Number.isSafeInteger(created.id) && created.id >= 1, 'created row id')
        assert.equal(created.status, 'registered')
        assert.equal(created.archived, false)
        assert.equal(created.nodeCount, 0)
        assert.equal(created.officialSite, 'https://icpc.example.com')
        assert.throws(() => svc.createContest({ name: '' }), /non-empty name/, 'name required non-empty')
        assert.throws(() => svc.createContest({ name: 'x', year: 1989 }), /year must be an integer within/, 'year below 1990 rejected')
        assert.throws(() => svc.createContest({ name: 'x', year: 2101 }), /year must be an integer within/, 'year above 2100 rejected')
        assert.throws(() => svc.createContest({ name: 'x', officialSite: 'ftp://bad.example' }), /must be an http\(s\) URL/, 'non-http(s) URL rejected')
        assert.throws(() => svc.createContest({ name: 'x', status: 'bogus' }), /status must be one of/, 'unknown status rejected')

        // get：空 nodes/materials/reminders（真实空集，无 mock）
        const detail = svc.getContest(created.id)
        assert.equal(detail.name, 'ICPC Asia Regional')
        assert.deepEqual(detail.nodes, [], 'nodes empty on fresh contest')
        assert.deepEqual(detail.materials, [], 'materials empty on fresh contest')
        assert.deepEqual(detail.reminders, [], 'reminders empty on fresh contest')
        assert.equal(detail.project, null, 'no linked project')

        // update（改名同步 resource display_name）
        const updated = svc.updateContest({ id: created.id, patch: { name: 'ICPC Asia 2026', note: 'revised' } })
        assert.equal(updated.name, 'ICPC Asia 2026')
        assert.equal(updated.note, 'revised')
        const db = dbModule.getDatabase()
        const resRow = db.prepare("SELECT display_name FROM resources WHERE resource_type = 'contest' AND ref_id = ?").get(created.id)
        assert.ok(resRow, 'contest resource node registered on create')
        assert.equal(resRow.display_name, 'ICPC Asia 2026', 'resource display_name synced on rename')

        // archive：缺省列表排除已归档
        const archived = svc.archiveContest({ id: created.id, archived: true })
        assert.equal(archived.archived, true)
        const c2 = svc.createContest({ name: 'Codeforces Round', year: 2025 })
        assert.equal(svc.listContests({}).total, 1, 'archived excluded by default')
        assert.equal(svc.listContests({ archived: true }).total, 2, 'archived:true includes both')
        assert.equal(svc.listContests({ status: 'watching' }).items[0].id, c2.id, 'status filter')
        assert.equal(svc.listContests({ status: 'registered', archived: true }).items[0].id, created.id, 'status filter over archived set')
        assert.equal(svc.listContests({ query: 'forces' }).items[0].id, c2.id, 'name fuzzy query')
        assert.equal(svc.listContests({ query: '2026', archived: true }).items[0].id, created.id, 'year text query')

        // delete 两段式：先 impacts（1 节点），后 confirmed 级联删
        svc.upsertNode({ contestId: created.id, node: { label: '提交截止', kind: 'submit_deadline', precision: 'date', startAt: 1790000000 } })
        const start = svc.deleteContest({ id: created.id })
        assert.equal(start.confirmRequired, true, 'first phase asks for confirmation')
        assert.equal(start.impacts.nodes, 1, 'impacts.nodes counts')
        assert.equal(start.impacts.materials, 0, 'impacts.materials counts')
        assert.equal(start.impacts.reminders, 0, 'impacts.reminders counts')
        const done = svc.deleteContest({ id: created.id, confirmed: true })
        assert.equal(done.confirmRequired, undefined, 'result branch discriminator')
        assert.equal(done.removed, true, 'confirmed delete removes')
        assert.throws(() => svc.getContest(created.id), /not found/, 'deleted contest is NOT_FOUND')
        assert.equal(db.prepare('SELECT COUNT(*) c FROM contest_nodes WHERE contest_id = ?').get(created.id).c, 0, 'nodes cascade-deleted')
        assert.equal(db.prepare("SELECT COUNT(*) c FROM resources WHERE resource_type = 'contest' AND ref_id = ?").get(created.id).c, 0, 'contest resource node removed')
        assert.throws(() => svc.deleteContest({ id: 999999 }), /contest 999999 not found/, 'unknown contest NOT_FOUND')
      } finally {
        dbModule.closeDatabase()
      }
    },
    'fast',
  )

  registerCase(
    'cp1-nodes: nodeUpsert 精度校验四分支（tbd 强制 null / date 允许无时刻 / 缺 start_at 拒绝 / date→exact 无 raw_text 拒绝）+ done 标记 + nodeDelete 两段式',
    async () => {
      const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
      const svc = await import(new URL('../src/main/services/contestpin/contestService.ts', import.meta.url).href)

      await makeTempHome('devhub-cp1-nodes-')
      try {
        const contest = svc.createContest({ name: 'Node Fixture Contest' })

        // 分支 1：tbd 强制 null——带 startAt 拒绝；不带时刻通过且 start/end 恒 null
        assert.throws(
          () => svc.upsertNode({ contestId: contest.id, node: { label: '时间待定', precision: 'tbd', startAt: 1790000000 } }),
          /precision='tbd' requires startAt\/endAt to be null/,
          'tbd with startAt rejected',
        )
        const tbd = svc.upsertNode({ contestId: contest.id, node: { label: '时间待定', precision: 'tbd' } })
        assert.equal(tbd.precision, 'tbd')
        assert.equal(tbd.startAt, null, 'tbd startAt null')
        assert.equal(tbd.endAt, null, 'tbd endAt null')
        assert.equal(tbd.source, 'manual', 'source defaults to manual in CP1')
        assert.equal(tbd.kind, 'custom', 'kind defaults to custom')

        // 分支 2：date 允许无时刻（存当日 00:00 unix 秒即可，不要求 end）
        const dated = svc.upsertNode({
          contestId: contest.id,
          node: { label: '报名截止', kind: 'signup_deadline', precision: 'date', startAt: 1790000000 },
        })
        assert.equal(dated.precision, 'date')
        assert.equal(dated.startAt, 1790000000)
        assert.equal(dated.endAt, null, 'end optional')

        // 分支 3：exact/month 缺 start_at 拒绝；end_at < start_at 拒绝
        assert.throws(() => svc.upsertNode({ contestId: contest.id, node: { label: '无时刻' } }), /requires startAt/, 'exact without startAt rejected')
        assert.throws(() => svc.upsertNode({ contestId: contest.id, node: { label: '月', precision: 'month' } }), /requires startAt/, 'month without startAt rejected')
        assert.throws(
          () => svc.upsertNode({ contestId: contest.id, node: { label: '坏区间', startAt: 1790000000, endAt: 1780000000 } }),
          /endAt must be >= startAt/,
          'endAt < startAt rejected',
        )

        // 分支 4：date→exact 提升无 raw_text 拒绝；显式携带原文依据放行
        assert.throws(
          () => svc.upsertNode({ contestId: contest.id, node: { id: dated.id, precision: 'exact' } }),
          /requires explicit rawText evidence/,
          'date→exact without rawText rejected',
        )
        const promoted = svc.upsertNode({
          contestId: contest.id,
          node: { id: dated.id, precision: 'exact', rawText: '2026年9月12日 09:00 截止报名' },
        })
        assert.equal(promoted.precision, 'exact', 'promotion allowed with rawText evidence')
        assert.ok(promoted.rawText.includes('09:00'), 'rawText persisted')

        // 更新侧 tbd：不清 startAt 拒绝；显式清空放行；done 转换记 done_at
        assert.throws(
          () => svc.upsertNode({ contestId: contest.id, node: { id: promoted.id, precision: 'tbd' } }),
          /precision='tbd' requires startAt\/endAt to be null/,
          'update to tbd keeping startAt rejected',
        )
        const detbd = svc.upsertNode({ contestId: contest.id, node: { id: promoted.id, precision: 'tbd', startAt: null, endAt: null } })
        assert.equal(detbd.startAt, null, 'update to tbd with explicit null passes')

        const donable = svc.upsertNode({ contestId: contest.id, node: { label: '缴费', kind: 'payment_deadline', precision: 'date', startAt: 1790000000, done: true } })
        assert.equal(donable.done, true)
        assert.ok(typeof donable.doneAt === 'number', 'doneAt stamped on done')

        // label 规则：kind='custom' 必填非空（先给足 start_at 以触达 label 校验）；未知 contest NOT_FOUND
        assert.throws(
          () => svc.upsertNode({ contestId: contest.id, node: { kind: 'custom', startAt: 1790000000 } }),
          /label is required/,
          'custom without label rejected',
        )
        assert.throws(() => svc.upsertNode({ contestId: 999999, node: { label: 'x' } }), /contest 999999 not found/, 'unknown contest NOT_FOUND')

        // nodeDelete 两段式（impacts.reminders 计数；reminders CASCADE）
        const delStart = svc.deleteNode({ id: donable.id })
        assert.equal(delStart.confirmRequired, true, 'nodeDelete first phase')
        assert.equal(delStart.impacts.reminders, 0, 'impacts.reminders counts node reminders')
        const delDone = svc.deleteNode({ id: donable.id, confirmed: true })
        assert.equal(delDone.removed, true, 'nodeDelete confirmed removes')
        assert.throws(() => svc.deleteNode({ id: donable.id }), /not found/, 'deleted node NOT_FOUND')

        // nodeCount 投影跟随
        const view = svc.updateContest({ id: contest.id, patch: {} })
        assert.equal(view.nodeCount, 2, 'nodeCount follows node lifecycle')
      } finally {
        dbModule.closeDatabase()
      }
    },
    'fast',
  )

  registerCase(
    'cp1-resource-edge: linkProject 建 uses 边→get 返回关联→unlink 删边→delete contest 后 resource 节点与边均不存在',
    async () => {
      const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
      const svc = await import(new URL('../src/main/services/contestpin/contestService.ts', import.meta.url).href)

      await makeTempHome('devhub-cp1-edge-')
      try {
        const db = dbModule.getDatabase()
        // 夹具项目行（s1-40 同款直接 SQL 夹具；projects:add 需真实目录，本用例只测边）
        db.prepare(
          "INSERT INTO projects (name, slug, win_path, created_at, updated_at) VALUES ('proj-a', 'proj-a', 'F:/tmp/proj-a', 1700000000, 1700000000)",
        ).run()
        const contest = svc.createContest({ name: 'Edge Fixture Contest' })

        const countEdges = () =>
          Number(
            db
              .prepare(
                "SELECT COUNT(*) c FROM relationships rel JOIN resources rs ON rs.id = rel.source_resource_id JOIN resources rt ON rt.id = rel.target_resource_id WHERE rs.resource_type = 'contest' AND rt.resource_type = 'project' AND rel.relation_type = 'uses' AND rs.ref_id = ?",
              )
              .get(contest.id).c,
          )

        assert.equal(svc.linkProject({ contestId: contest.id, projectId: 1 }).linked, true, 'link reports linked')
        assert.equal(countEdges(), 1, 'uses edge created')
        // node:sqlite 行为 null-prototype 对象，逐字段断言
        const linkedProject = svc.getContest(contest.id).project
        assert.ok(linkedProject !== null && linkedProject.id === 1 && linkedProject.name === 'proj-a', 'detail carries linked project')

        // 幂等：重复 link 不重复建边（INSERT OR IGNORE）
        svc.linkProject({ contestId: contest.id, projectId: 1 })
        assert.equal(countEdges(), 1, 're-link stays single edge')

        // projectId 不存在 → NOT_FOUND
        assert.throws(() => svc.linkProject({ contestId: contest.id, projectId: 424242 }), /project 424242 not found/, 'unknown project NOT_FOUND')

        // unlink：null 删边
        assert.equal(svc.linkProject({ contestId: contest.id, projectId: null }).linked, false, 'unlink reports unlinked')
        assert.equal(countEdges(), 0, 'uses edge removed')
        assert.equal(svc.getContest(contest.id).project, null, 'detail project cleared')

        // 重建边后 delete contest：resource 节点与边经显式删除 + CASCADE 消失
        svc.linkProject({ contestId: contest.id, projectId: 1 })
        assert.equal(svc.deleteContest({ id: contest.id, confirmed: true }).removed, true, 'contest deleted')
        assert.equal(db.prepare("SELECT COUNT(*) c FROM resources WHERE resource_type = 'contest' AND ref_id = ?").get(contest.id).c, 0, 'contest resource node removed')
        assert.equal(countEdges(), 0, 'uses edge removed with contest')
      } finally {
        dbModule.closeDatabase()
      }
    },
    'fast',
  )

  // ====================================================================
  // CP2 批次（ContestPin 悬浮窗，docs/22 §4 + 任务书 §2.3）：overlay 状态往返 /
  // URL 校验 / due-node 投影。全部 makeTempHome 临时库隔离（零网络零端口零进程，
  // fast 档）；通道计数断言 4 处（step1/step6/s4-68/ac2-84）已就地更新 79→84。
  // ====================================================================

  registerCase(
    'cp2-overlay-state: overlayStateService save/get 往返 + 非法 JSON/形状回默认 + enabled 开关持久化 + setOverlayCollapsed 往返（applier 未注入 = 结构化 no-op）',
    async () => {
      const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
      const settings = await import(new URL('../src/main/services/settingsService.ts', import.meta.url).href)
      const svc = await import(new URL('../src/main/services/contestpin/overlayStateService.ts', import.meta.url).href)

      await makeTempHome('devhub-cp2-state-')
      try {
        // 默认态：未持久化 → bounds null + collapsed false + enabled false（种子 '0'）
        const def = svc.getOverlayState()
        assert.equal(def.bounds, null, 'no persisted state → bounds null (wire centers on primary display)')
        assert.equal(def.collapsed, false, 'default collapsed false')
        assert.equal(def.enabled, false, 'default enabled false (008 seed contestpin_overlay_enabled=0)')

        // enabled 开关持久化（service 半边；无 wire applier → 仅持久化，零 electron）
        assert.equal(svc.setOverlayEnabled(true).enabled, true, 'setOverlayEnabled(true)')
        assert.equal(settings.getSetting('contestpin_overlay_enabled'), '1', 'enabled persisted to settings')
        assert.equal(svc.getOverlayState().enabled, true, 'state reflects enabled')
        assert.equal(svc.isOverlayEnabled(), true, 'isOverlayEnabled true')

        // save/get 往返
        svc.saveOverlayState({ x: 10, y: 20, width: 320, height: 420 }, false)
        let st = svc.getOverlayState()
        assert.deepEqual(st.bounds, { x: 10, y: 20, width: 320, height: 420 }, 'bounds round-trip')
        assert.equal(st.collapsed, false, 'collapsed round-trip')

        // 非法 JSON → 回默认（拒绝脏数据不抛）
        settings.setSetting('contestpin_overlay_state', '{not-json')
        st = svc.getOverlayState()
        assert.equal(st.bounds, null, 'malformed JSON → default bounds')
        assert.equal(st.collapsed, false, 'malformed JSON → default collapsed')

        // 形状非法（bounds 缺字段 / 类型错 / 负尺寸；collapsed 非布尔）→ 逐项回默认
        settings.setSetting('contestpin_overlay_state', JSON.stringify({ bounds: { x: 'a', y: 2, width: 3, height: 4 }, collapsed: false }))
        assert.equal(svc.getOverlayState().bounds, null, 'non-numeric x → default bounds')
        settings.setSetting('contestpin_overlay_state', JSON.stringify({ bounds: { x: 1, y: 2, width: -3, height: 4 }, collapsed: false }))
        assert.equal(svc.getOverlayState().bounds, null, 'negative width → default bounds')
        settings.setSetting('contestpin_overlay_state', JSON.stringify({ bounds: null, collapsed: 'yes' }))
        st = svc.getOverlayState()
        assert.equal(st.bounds, null, 'explicit null bounds preserved as null')
        assert.equal(st.collapsed, false, 'non-boolean collapsed → default false')

        // save 入参非法 → BAD_PAYLOAD
        assert.throws(
          () => svc.saveOverlayState({ x: 0, y: 0, width: -5, height: 100 }, false),
          /bounds must be \{x, y, width>0, height>0\}/,
          'save rejects negative width',
        )
        assert.throws(
          () => svc.saveOverlayState({ x: 0, y: 0, width: 100, height: 100 }, 'nope'),
          /collapsed must be a boolean/,
          'save rejects non-boolean collapsed',
        )

        // collapsed 往返（applier 未注入 → 结构化 no-op，持久化照常）；且 collapsed=true
        // 时持久化 bounds.height 语义=展开态高度（service 侧不重写高度；wire 层
        // 「折叠态重启恢复=建窗即折叠高度」由 overlayWire 保证，BrowserWindow 无法纯 Node 测）
        svc.saveOverlayState({ x: 1, y: 2, width: 320, height: 420 }, false)
        assert.equal(svc.setOverlayCollapsed(true).collapsed, true, 'setOverlayCollapsed(true)')
        const collapsedState = svc.getOverlayState()
        assert.equal(collapsedState.collapsed, true, 'collapsed persisted')
        assert.deepEqual(collapsedState.bounds, { x: 1, y: 2, width: 320, height: 420 }, 'collapsed=true keeps bounds.height as expanded height')
        assert.equal(svc.setOverlayCollapsed(false).collapsed, false, 'setOverlayCollapsed(false)')

        // openContestInMain 无 applier → 结构化 no-op（opened:false，非错误）
        assert.equal(svc.openContestInMain(1).opened, false, 'openInMain without applier is structured no-op')
      } finally {
        dbModule.closeDatabase()
      }
    },
    'fast',
  )

  registerCase(
    'cp2-openlink-guard: validateExternalUrl 仅 http/https —— javascript:/file:/ftp:/空白/相对路径/不可解析拒绝；大小写 scheme 与空白环绕放行并规范化',
    async () => {
      const svc = await import(new URL('../src/main/services/contestpin/overlayStateService.ts', import.meta.url).href)

      // 正例：http/https 放行（new URL 规范化：补尾斜杠、scheme 小写、去环绕空白）
      assert.equal(svc.validateExternalUrl('https://icpc.example.com/a?b=1'), 'https://icpc.example.com/a?b=1', 'https URL with query passes')
      assert.equal(svc.validateExternalUrl('http://signup.example.com'), 'http://signup.example.com/', 'http URL normalized (trailing slash)')
      assert.equal(svc.validateExternalUrl('  HTTPS://Example.COM/Path  '), 'https://example.com/Path', 'surrounding whitespace stripped + scheme lowercased')
      assert.equal(svc.validateExternalUrl('http://192.168.1.10:8080/register'), 'http://192.168.1.10:8080/register', 'host with port passes')

      // 反例：非 http(s) scheme / 空白 / 相对路径 / 不可解析 → BAD_PAYLOAD
      assert.throws(() => svc.validateExternalUrl('javascript:alert(1)'), /must be an http\(s\) URL \(got scheme: javascript:\)/, 'javascript: rejected')
      assert.throws(() => svc.validateExternalUrl('file:///C:/Windows/System32'), /got scheme: file:/, 'file: rejected')
      assert.throws(() => svc.validateExternalUrl('ftp://files.example.com'), /got scheme: ftp:/, 'ftp: rejected')
      assert.throws(() => svc.validateExternalUrl('data:text/html;base64,AAA'), /got scheme: data:/, 'data: rejected')
      assert.throws(() => svc.validateExternalUrl('   '), /must be a non-empty http\(s\) URL/, 'blank rejected')
      assert.throws(() => svc.validateExternalUrl(''), /must be a non-empty http\(s\) URL/, 'empty rejected')
      assert.throws(() => svc.validateExternalUrl('/relative/path'), /absolute http\(s\) URL/, 'relative path rejected')
      assert.throws(() => svc.validateExternalUrl('not a url at all'), /absolute http\(s\) URL/, 'unparseable rejected')

      // openExternalLink：service 校验先行（非法即抛）；无 applier → opened:false
      assert.throws(() => svc.openExternalLink('javascript:x'), /http\(s\)/, 'openExternalLink validates before applier')
      assert.equal(svc.openExternalLink('https://ok.example.com').opened, false, 'no applier (pure Node context) → structured no-op')
    },
    'fast',
  )

  registerCase(
    'cp2-due-node: computeDueNodes 纯逻辑（临近优先/全过期 overdue:true/done 推进/tbd 排后/空集 null）+ list/get 投影携带 dueNode/nextNode + 行投影携带三链接',
    async () => {
      const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
      const svc = await import(new URL('../src/main/services/contestpin/contestService.ts', import.meta.url).href)

      await makeTempHome('devhub-cp2-due-')
      try {
        const NOW = 1_800_000_000
        const DAY = 86_400
        const contest = svc.createContest({
          name: 'Due Fixture Contest',
          officialSite: 'https://due.example.com',
          signupUrl: 'http://signup.due.example.com/join',
        })

        // 空节点 → 双 null
        assert.deepEqual(svc.computeDueNodes([], NOW), { dueNode: null, nextNode: null }, 'empty nodes → null/null')
        const emptyDetail = svc.getContest(contest.id)
        assert.deepEqual(emptyDetail.dueNode, null, 'detail dueNode null on fresh contest')
        assert.deepEqual(emptyDetail.nextNode, null, 'detail nextNode null on fresh contest')

        const past = svc.upsertNode({ contestId: contest.id, node: { kind: 'signup_deadline', label: '报名截止', precision: 'date', startAt: NOW - 10 * DAY } })
        const near = svc.upsertNode({ contestId: contest.id, node: { kind: 'contest_start', label: '比赛开始', precision: 'exact', startAt: NOW + 3_600 } })
        const far = svc.upsertNode({ contestId: contest.id, node: { kind: 'submit_deadline', label: '提交截止', precision: 'date', startAt: NOW + 30 * DAY } })
        const tbd = svc.upsertNode({ contestId: contest.id, node: { kind: 'custom', label: '复审时间待定', precision: 'tbd' } })

        // 临近优先：最近的未来节点为 dueNode，其后为 far；tbd 排最后
        let proj = svc.computeDueNodes(svc.getContest(contest.id).nodes, NOW)
        assert.equal(proj.dueNode.nodeId, near.id, 'nearest future node wins')
        assert.equal(proj.dueNode.overdue, false, 'future dueNode not overdue')
        assert.equal(proj.dueNode.precision, 'exact', 'precision carried to display layer')
        assert.equal(proj.nextNode.nodeId, far.id, 'nextNode follows dueNode in start_at order')

        // 全过期：最近的过去未 done 节点带 overdue:true；next 推进到 tbd
        proj = svc.computeDueNodes(svc.getContest(contest.id).nodes, NOW + 60 * DAY)
        assert.equal(proj.dueNode.nodeId, far.id, 'all past → latest past node')
        assert.equal(proj.dueNode.overdue, true, 'past dueNode flagged overdue')
        assert.equal(proj.nextNode.nodeId, tbd.id, 'tbd ranked last but still surfaces as next')

        // done 推进：完成 near 后 dueNode 前移到 far（未来语义恢复）
        svc.upsertNode({ contestId: contest.id, node: { id: near.id, done: true } })
        proj = svc.computeDueNodes(svc.getContest(contest.id).nodes, NOW)
        assert.equal(proj.dueNode.nodeId, far.id, 'done advances dueNode to next candidate')
        assert.equal(proj.dueNode.overdue, false, 'advanced dueNode is future again')

        // 全部 timed 完成（near/far/past 依次 done）→ 只剩 tbd 作 dueNode
        // （无 start_at 排最后、仅无时刻候选时才充当）
        svc.upsertNode({ contestId: contest.id, node: { id: far.id, done: true } })
        svc.upsertNode({ contestId: contest.id, node: { id: past.id, done: true } })
        proj = svc.computeDueNodes(svc.getContest(contest.id).nodes, NOW)
        assert.equal(proj.dueNode.nodeId, tbd.id, 'tbd-only candidates → tbd dueNode')
        assert.equal(proj.dueNode.startAt, null, 'tbd dueNode has null startAt')
        assert.equal(proj.nextNode, null, 'nothing after last tbd')

        // tbd 也完成 → 双 null
        svc.upsertNode({ contestId: contest.id, node: { id: tbd.id, done: true } })
        proj = svc.computeDueNodes(svc.getContest(contest.id).nodes, NOW)
        assert.equal(proj.dueNode, null, 'all done → null dueNode')

        // 恢复 far 与 tbd 为未完成（past 保持 done），验证 list/get 投影与行内三链接
        // （CP2 悬浮窗数据源）；done 节点不参与候选，dueNode 不会回退到已完成节点
        svc.upsertNode({ contestId: contest.id, node: { id: far.id, done: false } })
        svc.upsertNode({ contestId: contest.id, node: { id: tbd.id, done: false } })
        const item = svc.listContests({}).items.find((i) => i.id === contest.id)
        assert.ok(item, 'list contains fixture contest')
        assert.equal(item.dueNode.nodeId, far.id, 'list projection carries dueNode')
        assert.equal(item.nextNode.nodeId, tbd.id, 'list projection carries nextNode')
        assert.equal(item.officialSite, 'https://due.example.com', 'list row carries officialSite (overlay entry buttons)')
        assert.equal(item.signupUrl, 'http://signup.due.example.com/join', 'list row carries signupUrl')

        // done 节点不参与候选（past 已 done，未来 far → due，不回退到过期节点）
        assert.notEqual(item.dueNode.nodeId, past.id, 'done past node excluded from candidates')
        assert.equal(past.done, false, 'past node still open — full-overdue branch covered in cp2 fixture above')
      } finally {
        dbModule.closeDatabase()
      }
    },
    'fast',
  )

  // ====================================================================
  // CP3a 批次（ContestPin 识别配置 + OpenAI 兼容客户端，docs/22 §6 +
  // docs/04「ContestPin 追加」节 CP3a 四行）。三个 fast 用例全部经
  // setChatTransport 注入 fake transport —— 零真实网络（时窗红线）；
  // finally 恢复默认传输（setChatTransport(null)，默认实现仅生产可达）。
  // ====================================================================

  registerCase(
    'cp3a-config-crud: recognitionConfigService save（key envelope 落库非明文）/list 掩码（无明文无 sealed）/UNIQUE(name,role) 冲突/空 key 保持与无鉴权新建/testConfig 落 last_test_*（fake transport）/delete 两段式（impacts.importJobs）',
    async () => {
      const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
      const keyStore = await import(new URL('../src/main/services/apihub/keyStore.ts', import.meta.url).href)
      const client = await import(new URL('../src/main/services/contestpin/openaiClient.ts', import.meta.url).href)
      const svc = await import(new URL('../src/main/services/contestpin/recognitionConfigService.ts', import.meta.url).href)

      await makeTempHome('devhub-cp3a-crud-')
      // plaintext 夹具显式注入（生产 = keyStoreWire safeStorage；smoke 场景同款降级实现）
      keyStore.setKeyCrypto(keyStore.plaintextKeyCrypto())
      // fake transport：200 + usage；捕获 url/headers/body 供断言（零联网）
      const seen = []
      client.setChatTransport(async (url, init) => {
        seen.push({ url, headers: init.headers, body: String(init.body) })
        return {
          status: 200,
          bodyText: JSON.stringify({
            choices: [{ message: { content: 'pong' } }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          }),
        }
      })
      const db = dbModule.getDatabase()
      try {
        // save（带 key）：掩码视图 + 落库 envelope
        const saved = await svc.saveConfig({
          name: 'vis-main',
          role: 'vision',
          baseUrl: 'https://api.example.com/v1',
          model: 'vl-model',
          apiKey: 'sk-test-abcd1234',
          timeoutMs: 5000,
        })
        assert.equal(saved.apiKeySet, true)
        assert.equal(saved.apiKeyTail, '1234', 'masked tail = last 4')
        assert.equal(saved.apiKeyLen, 'sk-test-abcd1234'.length, 'masked len')
        const viewJson = JSON.stringify(saved)
        assert.ok(!viewJson.includes('sk-test-abcd1234'), 'view never carries plaintext key')
        assert.ok(!viewJson.includes('sealed') && !viewJson.includes('keySealed'), 'view never carries sealed envelope fields')
        const rawRow = db.prepare('SELECT key_sealed FROM contestpin_configs WHERE id = ?').get(saved.id)
        const envelope = JSON.parse(String(rawRow.key_sealed))
        assert.equal(envelope.v, 1, 'envelope v=1 (profileStore shape)')
        assert.equal(envelope.plainStore, true, 'plaintext fixture marks plainStore:true')
        assert.ok(!String(rawRow.key_sealed).includes('sk-test-abcd1234'), 'stored form is not plaintext')

        // list：掩码视图整体无明文/无 sealed 键
        const listed = await svc.listConfigs()
        assert.equal(listed.configs.length, 1)
        assert.ok(!JSON.stringify(listed).includes('sk-test-abcd1234'), 'list view zero plaintext')

        // 编辑空 apiKey = 保持既有；UNIQUE 只对 (name, role) 联合唯一
        const edited = await svc.saveConfig({ id: saved.id, name: 'vis-main', role: 'vision', baseUrl: 'https://api.example.com/v1', model: 'vl-model-2', apiKey: '' })
        assert.equal(edited.apiKeyTail, '1234', 'empty apiKey keeps existing key')
        assert.equal(edited.model, 'vl-model-2', 'model updated')
        await assert.rejects(
          () => svc.saveConfig({ name: 'vis-main', role: 'vision', baseUrl: 'https://x.example.com', model: 'm' }),
          /识别配置已存在/,
          'UNIQUE(name,role) duplicate rejected',
        )
        const sameNameOtherRole = await svc.saveConfig({ name: 'vis-main', role: 'text', baseUrl: 'https://api.example.com/v1', model: 'txt-model' })
        assert.equal(sameNameOtherRole.apiKeySet, false, 'create without key = keyless endpoint allowed')
        assert.equal(db.prepare('SELECT key_sealed FROM contestpin_configs WHERE id = ?').get(sameNameOtherRole.id).key_sealed, null, 'keyless row stores NULL')

        // testConfig（vision，带 key）：ok + 实测 usage 落库
        seen.length = 0
        const test1 = await svc.testConfig(saved.id)
        assert.equal(test1.ok, true)
        assert.equal(typeof test1.latencyMs, 'number')
        assert.equal(test1.usage.total_tokens, 7, 'measured usage returned')
        const persisted = db.prepare('SELECT last_test_ok, last_test_usage_json FROM contestpin_configs WHERE id = ?').get(saved.id)
        assert.equal(persisted.last_test_ok, 1, 'last_test_ok stamped')
        assert.equal(JSON.parse(persisted.last_test_usage_json).total_tokens, 7, 'measured usage persisted as JSON')
        assert.equal(seen[0].url, 'https://api.example.com/v1/chat/completions', 'configTest hits normalized URL')
        assert.equal(seen[0].headers.Authorization, 'Bearer sk-test-abcd1234', 'bearer header present for keyed config')
        assert.ok(seen[0].body.includes('image_url') && seen[0].body.includes('data:image/png;base64,'), 'vision probe carries image_url data URL')

        // testConfig（text，无 key）：Authorization 缺省 + ping 探针
        seen.length = 0
        const test2 = await svc.testConfig(sameNameOtherRole.id)
        assert.equal(test2.ok, true)
        assert.equal(seen[0].headers.Authorization, undefined, 'keyless config sends no Authorization')
        assert.ok(seen[0].body.includes('"content":"ping"'), 'text probe sends ping')

        // 服务端 429 → 分类限流 + last_test_ok=0 + usage 清空（不残留旧实测）
        client.setChatTransport(async () => ({ status: 429, bodyText: 'rate limited' }))
        const test3 = await svc.testConfig(saved.id)
        assert.equal(test3.ok, false)
        assert.equal(test3.error.kind, 'RATE_LIMIT')
        assert.ok(test3.error.message.includes('限流'), 'rate-limit copy for 429')
        const persistedFail = db.prepare('SELECT last_test_ok, last_test_usage_json FROM contestpin_configs WHERE id = ?').get(saved.id)
        assert.equal(persistedFail.last_test_ok, 0, 'failure stamped')
        assert.equal(persistedFail.last_test_usage_json, null, 'no stale measured usage after failure')

        // IMAGE_UNSUPPORTED 派生：服务端错误摘要含 image 字样（HTTP 400 → HTTP_ERROR 基类）
        client.setChatTransport(async () => ({ status: 400, bodyText: 'this endpoint does not support image input' }))
        const test4 = await svc.testConfig(saved.id)
        assert.equal(test4.error.kind, 'IMAGE_UNSUPPORTED', 'image keyword derives IMAGE_UNSUPPORTED')

        // delete 两段式：impacts.importJobs 计数引用任务；confirmed 后删除（jobs 行保留、引用置空）
        db.prepare(
          "INSERT INTO contest_import_jobs (mode, stage, vision_config_id, created_at, updated_at) VALUES ('two_stage', 'imported', ?, 0, 0)",
        ).run(saved.id)
        const delStart = svc.deleteConfig({ id: saved.id })
        assert.equal(delStart.confirmRequired, true)
        assert.equal(delStart.impacts.importJobs, 1, 'impacts counts referencing import jobs')
        const delDone = svc.deleteConfig({ id: saved.id, confirmed: true })
        assert.equal(delDone.confirmRequired, undefined)
        assert.equal(delDone.removed, true)
        const jobAfter = db.prepare('SELECT vision_config_id FROM contest_import_jobs').get()
        assert.equal(jobAfter.vision_config_id, null, 'job row survives with NULLed reference (FK SET NULL)')
        assert.throws(() => svc.deleteConfig({ id: saved.id }), /not found/, 'unknown config NOT_FOUND')
      } finally {
        client.setChatTransport(null) // 恢复默认传输（后续用例零联网）
        dbModule.closeDatabase()
      }
    },
    'fast',
  )

  registerCase(
    'cp3a-client-taxonomy: chatCompletion 错误六分类与 usage 捕获（fake transport：401/403→AUTH、429→RATE_LIMIT、500→HTTP_ERROR 带 status、非 JSON 与缺 choices→BAD_RESPONSE、2xx 无 usage→unknown、带 usage→实测、AbortError/TimeoutError→TIMEOUT、reject→NETWORK）+ 错误摘要不含 key',
    async () => {
      const client = await import(new URL('../src/main/services/contestpin/openaiClient.ts', import.meta.url).href)
      const zlib = await import('node:zlib')
      const cfg = { baseUrl: 'https://tax.example.com/v1', model: 'tax-model', apiKey: 'sk-secret-xyz-9999', timeoutMs: 1000 }

      async function runWith(fake) {
        client.setChatTransport(fake)
        return client.chatCompletion(cfg, [{ role: 'user', content: 'ping' }])
      }

      // 401/403 → AUTH；429 → RATE_LIMIT；500 → HTTP_ERROR（带 status）
      let r = await runWith(async () => ({ status: 401, bodyText: 'Unauthorized' }))
      assert.equal(r.ok === false && r.failure.kind, 'AUTH', '401 → AUTH')
      r = await runWith(async () => ({ status: 403, bodyText: 'Forbidden' }))
      assert.equal(r.ok === false && r.failure.kind, 'AUTH', '403 → AUTH')
      r = await runWith(async () => ({ status: 429, bodyText: 'slow down' }))
      assert.equal(r.ok === false && r.failure.kind, 'RATE_LIMIT', '429 → RATE_LIMIT')
      r = await runWith(async () => ({ status: 500, bodyText: 'boom' }))
      assert.equal(r.ok === false && r.failure.kind, 'HTTP_ERROR', '500 → HTTP_ERROR')
      assert.equal(r.ok === false && r.failure.status, 500, 'HTTP_ERROR carries status')

      // 服务端错误体回显 key → 摘要打码（密钥红线在错误出口兜底）
      r = await runWith(async () => ({ status: 401, bodyText: 'Incorrect API key provided: sk-secret-xyz-9999.' }))
      assert.equal(r.ok === false && r.failure.message.includes('sk-secret-xyz-9999'), false, 'server-echoed key is masked out of failure message')

      // 非 JSON / 缺 choices / 缺 content → BAD_RESPONSE
      r = await runWith(async () => ({ status: 200, bodyText: '<html>not json</html>' }))
      assert.equal(r.ok === false && r.failure.kind, 'BAD_RESPONSE', 'non-JSON 2xx → BAD_RESPONSE')
      r = await runWith(async () => ({ status: 200, bodyText: '{"choices":[]}' }))
      assert.equal(r.ok === false && r.failure.kind, 'BAD_RESPONSE', 'empty choices → BAD_RESPONSE')
      r = await runWith(async () => ({ status: 200, bodyText: '{"choices":[{"message":{}}]}' }))
      assert.equal(r.ok === false && r.failure.kind, 'BAD_RESPONSE', 'missing content → BAD_RESPONSE')

      // 2xx 无 usage → 'unknown'；带 usage → 实测；content 透传
      r = await runWith(async () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) }))
      assert.equal(r.ok === true && r.usage, 'unknown', 'no usage field → unknown (never faked)')
      r = await runWith(async () => ({ status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } }) }))
      assert.equal(r.ok === true && r.content, 'hi', 'content passed through')
      assert.equal(r.ok === true && r.usage.total_tokens, 11, 'measured usage captured')

      // TIMEOUT：AbortError / TimeoutError；NETWORK：其他 reject
      r = await runWith(async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      })
      assert.equal(r.ok === false && r.failure.kind, 'TIMEOUT', 'AbortError → TIMEOUT')
      r = await runWith(async () => {
        throw Object.assign(new Error('expired'), { name: 'TimeoutError' })
      })
      assert.equal(r.ok === false && r.failure.kind, 'TIMEOUT', 'TimeoutError → TIMEOUT')
      r = await runWith(async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:443')
      })
      assert.equal(r.ok === false && r.failure.kind, 'NETWORK', 'fetch reject → NETWORK')

      // probeConfig：text = ping；vision = 1x1 红 PNG data URL + 一词描述指令；
      // stream:false 与 model 在请求体；Authorization 仅带 key 时存在
      const seen = []
      client.setChatTransport(async (url, init) => {
        seen.push({ url, headers: init.headers, body: String(init.body) })
        return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: 'red' } }] }) }
      })
      await client.probeConfig(cfg, 'text')
      assert.ok(seen[0].body.includes('"content":"ping"'), 'text probe body')
      assert.ok(seen[0].body.includes('"stream":false') && seen[0].body.includes('"model":"tax-model"'), 'body carries model + stream:false')
      assert.equal(seen[0].headers.Authorization, 'Bearer sk-secret-xyz-9999', 'bearer header from apiKey')
      await client.probeConfig({ baseUrl: cfg.baseUrl, model: cfg.model }, 'vision')
      assert.equal(seen[1].headers.Authorization, undefined, 'no Authorization without apiKey')
      assert.ok(seen[1].body.includes('image_url') && seen[1].body.includes('data:image/png;base64,'), 'vision probe carries data URL')
      assert.ok(seen[1].body.includes('Describe this image in one word.'), 'vision probe instruction')

      // 探针 PNG 语义锚定：1x1、8bit truecolor、扫描线 = filter 0 + RGB(255,0,0)
      const png = Buffer.from(client.PROBE_PNG_BASE64, 'base64')
      assert.equal(png.length < 128, true, 'probe png ~100 bytes')
      assert.equal(png.readUInt32BE(16), 1, 'width 1')
      assert.equal(png.readUInt32BE(20), 1, 'height 1')
      const idatLen = png.readUInt32BE(33)
      const raw = zlib.inflateSync(png.subarray(41, 41 + idatLen))
      assert.deepEqual([...raw], [0, 255, 0, 0], 'scanline = no-filter + pure red pixel')

      client.setChatTransport(null)
    },
    'fast',
  )

  registerCase(
    'cp3a-baseurl-normalize: baseUrl 三形态 URL 断言（https://x/v1、https://x/v1/、已带 /chat/completions 原样；补零路径形态）——经 fake transport 捕获 url，零联网',
    async () => {
      const client = await import(new URL('../src/main/services/contestpin/openaiClient.ts', import.meta.url).href)
      const captured = []
      client.setChatTransport(async (url) => {
        captured.push(url)
        return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }
      })
      try {
        const messages = [{ role: 'user', content: 'ping' }]
        await client.chatCompletion({ baseUrl: 'https://x/v1', model: 'm' }, messages)
        await client.chatCompletion({ baseUrl: 'https://x/v1/', model: 'm' }, messages)
        await client.chatCompletion({ baseUrl: 'https://x/v1/chat/completions', model: 'm' }, messages)
        await client.chatCompletion({ baseUrl: 'https://x', model: 'm' }, messages)
        assert.deepEqual(captured, [
          'https://x/v1/chat/completions',
          'https://x/v1/chat/completions',
          'https://x/v1/chat/completions',
          'https://x/chat/completions',
        ], 'all baseUrl spellings converge on <base>/chat/completions; already-suffixed URL untouched')
        // 纯函数面直接断言（含多余尾斜杠与环绕空白归一）
        assert.equal(client.normalizeChatCompletionsUrl('  https://y/v1//  '), 'https://y/v1/chat/completions')
      } finally {
        client.setChatTransport(null)
      }
    },
    'fast',
  )

  await run(parseTierArg())
}
