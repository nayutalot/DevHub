#!/usr/bin/env node
/**
 * manifest-sha256.mjs — 交付物 SHA-256 清单生成/校验（AC9 文档批次交付物）。
 *
 * 用法：
 *   node scripts/manifest-sha256.mjs           # 生成 acceptance/agents-mobile/SHA-256-SUMS.txt
 *   node scripts/manifest-sha256.mjs --check   # 重算比对，报告缺失/不匹配（不一致退出码 1）
 *
 * 扫描范围（相对仓库根，自动去重）：
 *   1. acceptance 目录（递归）下全部 .png   —— 全部验收截图
 *   2. acceptance/agents-mobile 全目录     —— Agent Control/Mobile 全部证据（任意扩展名）
 *   3. android/app/build/outputs/apk/debug/app-debug.apk —— APK（存在才纳入）
 *   4. docs/*.md                           —— 文档（docs 顶层）
 *   5. scripts/*.mjs                       —— 关键脚本
 * 排除：清单文件本身（SHA-256-SUMS.txt，自引用不可行）。
 *
 * 输出格式：`<sha256>  <相对路径>`（两空格，兼容 `sha256sum -c` 惯例），
 * 按相对路径升序排序；头部 `#` 注释含生成时间（UTC ISO）。
 *
 * 纪律：零依赖（node:crypto / node:fs / node:path）；系统 Node 24 直跑；
 * 只读扫描（唯一写入 = 清单文件本身）；路径一律 POSIX 风格正斜杠保证跨
 * 平台确定性。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_REL = 'acceptance/agents-mobile/SHA-256-SUMS.txt'
const MANIFEST_PATH = join(REPO_ROOT, ...MANIFEST_REL.split('/'))
const APK_REL = 'android/app/build/outputs/apk/debug/app-debug.apk'

/** 递归收集目录下全部文件（POSIX 风格相对路径），按路径升序。 */
function walkFiles(relDir) {
  const absDir = join(REPO_ROOT, relDir)
  if (!existsSync(absDir)) return []
  const out = []
  const stack = [absDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile()) out.push(relative(REPO_ROOT, abs).split(sep).join('/'))
    }
  }
  return out
}

/** 组装扫描范围（去重 + 排序 + 排除清单自身）。 */
function collectTargets() {
  const set = new Set()
  // 1. acceptance/**/*.png
  for (const p of walkFiles('acceptance')) if (p.endsWith('.png')) set.add(p)
  // 2. acceptance/agents-mobile/**（全部文件）
  for (const p of walkFiles('acceptance/agents-mobile')) set.add(p)
  // 3. APK（存在才纳入）
  if (existsSync(join(REPO_ROOT, ...APK_REL.split('/')))) set.add(APK_REL)
  // 4. docs/*.md（docs 顶层）
  for (const p of walkFiles('docs')) if (p.startsWith('docs/') && p.endsWith('.md') && !p.slice(5).includes('/')) set.add(p)
  // 5. scripts/*.mjs
  for (const p of walkFiles('scripts')) if (p.startsWith('scripts/') && p.endsWith('.mjs')) set.add(p)

  set.delete(MANIFEST_REL)
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function sha256File(absPath) {
  const hash = createHash('sha256')
  hash.update(readFileSync(absPath))
  return hash.digest('hex')
}

function generate() {
  const targets = collectTargets()
  if (targets.length === 0) throw new Error('no files matched the manifest scan scope')
  const lines = [
    '# DevHub deliverables SHA-256 manifest',
    `# Generated: ${new Date().toISOString()}`,
    '# Tool: scripts/manifest-sha256.mjs (zero-dependency, node:crypto)',
    '# Format: <sha256>  <path relative to repo root>  (sorted by path)',
    '# Verify: node scripts/manifest-sha256.mjs --check',
    '',
  ]
  for (const rel of targets) lines.push(`${sha256File(join(REPO_ROOT, ...rel.split('/')))}  ${rel}`)
  writeFileSync(MANIFEST_PATH, lines.join('\n') + '\n', 'utf8')
  console.log(`manifest written: ${MANIFEST_REL} (${targets.length} files)`)
}

function check() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`CHECK FAILED: manifest missing: ${MANIFEST_REL} (run without --check to generate)`)
    process.exitCode = 1
    return
  }
  const manifestLines = readFileSync(MANIFEST_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0 && !l.startsWith('#'))
  const entries = new Map()
  for (const line of manifestLines) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line)
    if (m === null) {
      console.error(`CHECK FAILED: malformed manifest line: ${line}`)
      process.exitCode = 1
      return
    }
    entries.set(m[2], m[1])
  }

  let missing = 0
  let mismatched = 0
  for (const [rel, expected] of entries) {
    const abs = join(REPO_ROOT, ...rel.split('/'))
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      console.error(`MISSING: ${rel}`)
      missing += 1
    } else {
      const actual = sha256File(abs)
      if (actual !== expected) {
        console.error(`MISMATCH: ${rel} (manifest ${expected} != actual ${actual})`)
        mismatched += 1
      }
    }
  }
  const total = entries.size
  if (missing === 0 && mismatched === 0) {
    console.log(`CHECK OK: ${total}/${total} files match ${MANIFEST_REL}`)
  } else {
    console.error(`CHECK FAILED: ${total - missing - mismatched}/${total} ok, ${missing} missing, ${mismatched} mismatched`)
    process.exitCode = 1
  }
}

const mode = process.argv.slice(2)
if (mode.includes('--check')) check()
else if (mode.length === 0) generate()
else {
  console.error('usage: node scripts/manifest-sha256.mjs [--check]')
  process.exitCode = 2
}
