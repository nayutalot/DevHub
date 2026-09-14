#!/usr/bin/env node
// build-updates-feed.mjs — App 自更新 feed 装配脚本（X-U 批，docs/briefs/xu-updater.md
// §1 #4；X11 收官批直接消费本脚本产出 /updates/ 布局，上传至 ECS caddy 静态根）。
//
// 用法：
//   node scripts/build-updates-feed.mjs [--dist <distDir>] [--out <updatesDir>] [--check]
//
//   --dist   electron-builder 产物根（默认 ./dist；即 npm run dist 的 output 目录）
//   --out    装配输出目录（默认 ./dist-updates；其内容整体上传为站点 /updates/ 路径）
//   --check  仅校验不写盘（对 dist 产物 + latest.yml 做一致性断言后退出，校验类用法）
//
// 行为：
//   1. 读 <dist>/latest.yml（electron-builder 生成；缺文件即报错退出）；
//   2. 解析 version / path / files[].url / sha512 / size（src/main/services/
//      updateCenter/updateFeed.ts 的 parseLatestYml 同一实现，零 YAML 依赖）；
//   3. **一致性断言（任务书硬性要求）**：latest.yml 引用的每个文件（顶层 path +
//      files[].url）必须在 dist 根核对到实际文件——精确同名优先，否则按归一化
//      形态匹配（HANDOFF 注记：electron-builder 把产物名中的空格改写为连字符，
//      如实际 `DevHub Setup 0.1.0.exe` vs path `DevHub-Setup-0.1.0.exe`；点分隔
//      形态同样兼容）。核对不到 / 归一化撞名多份 / sha512 不符 / size 不符 →
//      报错退出（exit 1），绝不带病装配；
//   4. 装配：latest.yml 原样 + 引用文件按 latest.yml 引用名（即 electron-updater
//      实际请求的 URL 文件名）复制进 <out>——空格形态与连字符形态在此对齐，feed
//      内文件名与 latest.yml path 字段恒一致；
//   5. 打印装配清单（版本 / 逐文件映射 / 字节数 / 最终目录列表）。
//
// 零凭据零网络（纯本地文件装配 + 哈希校验）；X11 部署面（上传 ECS /updates/）
// 不在本脚本范围。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseLatestYml, resolveAssetFileName } from '../src/main/services/updateCenter/updateFeed.ts'

// --- CLI 参数 -----------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dist: 'dist', out: 'dist-updates', check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dist') opts.dist = argv[++i] ?? ''
    else if (a === '--out') opts.out = argv[++i] ?? ''
    else if (a === '--check') opts.check = true
    else {
      console.error(`[build-updates-feed] unknown argument: ${a}`)
      process.exit(2)
    }
  }
  if (opts.dist.length === 0 || opts.out.length === 0) {
    console.error('[build-updates-feed] --dist / --out must not be empty')
    process.exit(2)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(scriptRoot, opts.dist)
const outDir = resolve(scriptRoot, opts.out)

function fail(message) {
  console.error(`[build-updates-feed] FAIL: ${message}`)
  process.exit(1)
}

function sha512OfFile(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

// --- 主流程 -------------------------------------------------------------------

if (!existsSync(distDir)) fail(`dist 目录不存在: ${distDir}`)
const latestPath = join(distDir, 'latest.yml')
if (!existsSync(latestPath)) fail(`dist 根缺 latest.yml（electron-builder 产物不完整？）: ${latestPath}`)

let info
try {
  info = parseLatestYml(readFileSync(latestPath, 'utf8'))
} catch (err) {
  fail(`latest.yml 解析失败: ${err instanceof Error ? err.message : String(err)}`)
}

const distFiles = readdirSync(distDir).filter((f) => statSync(join(distDir, f)).isFile())
console.log(`[build-updates-feed] dist=${distDir}`)
console.log(`[build-updates-feed] latest.yml: version=${info.version} path="${info.path}" releaseDate=${info.releaseDate ?? '-'}`)
console.log(`[build-updates-feed] dist 根文件 ${distFiles.length} 个: ${distFiles.join(', ')}`)

// latest.yml 引用集（顶层 path + files[].url，去重保序）
const referenced = []
for (const url of info.files.map((f) => f.url)) {
  if (!referenced.includes(url)) referenced.push(url)
}
if (!referenced.includes(info.path)) referenced.unshift(info.path)

// 一致性断言：引用名 ↔ 实际文件（精确同名优先 → 连字符/点/空格形态归一化匹配）
const resolved = new Map() // referencedName -> actualDistFile
for (const ref of referenced) {
  const actual = resolveAssetFileName(ref, distFiles)
  if (actual === null) {
    fail(
      `latest.yml 引用文件 "${ref}" 在 dist 根核对不到实际文件（连字符/点/空格形态均无匹配）——` +
        `electron-builder 产物与 latest.yml 不一致，拒绝装配`,
    )
  }
  resolved.set(ref, actual)

  // sha512 / size 断言（yml 声明 ↔ 实际字节）
  const actualPath = join(distDir, actual)
  const fileMeta = info.files.find((f) => f.url === ref)
  const expectSha = fileMeta?.sha512 ?? info.sha512
  const expectSize = fileMeta?.size ?? null
  const actualSize = statSync(actualPath).size
  if (expectSize !== null && expectSize !== undefined && actualSize !== expectSize) {
    fail(`"${actual}" size 不一致: latest.yml 声明 ${expectSize}，实际 ${actualSize}`)
  }
  if (expectSha) {
    const actualSha = sha512OfFile(actualPath)
    if (actualSha !== expectSha) {
      fail(`"${actual}" sha512 不一致：latest.yml 声明 ${expectSha}，实际 ${actualSha}`)
    }
  }
}

console.log('[build-updates-feed] 一致性断言通过（引用名↔实际文件 / sha512 / size）:')
for (const [ref, actual] of resolved) {
  console.log(`  latest.yml "${ref}" ↔ dist "${actual}"${ref === actual ? '' : '（形态对齐后装配）'}`)
}

if (opts.check) {
  console.log(`[build-updates-feed] --check 校验通过（未写盘）: version=${info.version}`)
  process.exit(0)
}

// --- 装配 ---------------------------------------------------------------------

mkdirSync(outDir, { recursive: true })
copyFileSync(latestPath, join(outDir, 'latest.yml'))
for (const [ref, actual] of resolved) {
  copyFileSync(join(distDir, actual), join(outDir, ref))
}

console.log(`[build-updates-feed] 装配完成 → ${outDir}（整体上传为站点 /updates/ 路径）`)
console.log('[build-updates-feed] 装配清单:')
const outFiles = readdirSync(outDir)
  .filter((f) => statSync(join(outDir, f)).isFile())
  .sort()
for (const f of outFiles) {
  const st = statSync(join(outDir, f))
  console.log(`  ${f}  (${st.size} bytes)`)
}
console.log(`[build-updates-feed] feed URL = https://<relay-基址>/updates/latest.yml （version=${info.version}）`)
