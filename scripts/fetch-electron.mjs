#!/usr/bin/env node
// Download the Electron binary through the npmmirror mirror.
// GitHub direct download fails on this network (locked decision, docs/02).
//
// Usage: node scripts/fetch-electron.mjs   (after npm install)

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPkgDir = path.join(root, 'node_modules', 'electron')
const installJs = path.join(electronPkgDir, 'install.js')

if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}

console.log(`[fetch-electron] ELECTRON_MIRROR=${process.env.ELECTRON_MIRROR}`)

if (!existsSync(installJs)) {
  console.error(`[fetch-electron] missing ${installJs} — run npm install first`)
  process.exit(1)
}

const result = spawnSync(process.execPath, [installJs], {
  stdio: 'inherit',
  cwd: electronPkgDir,
  env: process.env
})

process.exit(result.status ?? 1)
