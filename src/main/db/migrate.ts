/**
 * migrate.ts — migration runner（docs/03 §4，约束 #21 只追加）。
 *
 * - 版本读取 PRAGMA user_version；
 * - 按 migrations/*.sql 文件名序号升序，应用所有序号 > 当前版本的文件，
 *   每个文件在单个事务内执行；
 * - user_version 更新只允许字面量赋值（SQLite PRAGMA 不支持参数绑定，
 *   约束 #11 唯一例外），每个已注册版本对应 switch 中一条固定语句；
 * - 已应用的 migration 文件永不修改，schema 变更一律新增递增序号文件。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { getProjectRoot } from '../core/paths.ts'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * migrations 目录定位，兼容两种运行形态：
 *  - 源码直跑（系统 Node smoke / electron-vite dev 前源码态）：本模块位于
 *    src/main/db/，migrations 就在旁边；
 *  - electron-vite 打包后（out/main/）：回退到 <项目根>/src/main/db/migrations
 *    （项目根经 package.json 向上定位，与 cwd 无关）。
 */
export function migrationsDir(): string {
  const sibling = join(MODULE_DIR, 'migrations')
  if (existsSync(sibling)) return sibling
  return join(getProjectRoot(), 'src', 'main', 'db', 'migrations')
}

function readCurrentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as
    | { user_version: number | bigint }
    | undefined
  return Number(row?.user_version ?? 0)
}

function parseMigrationVersion(fileName: string): number | null {
  const match = fileName.match(/^(\d+)_.*\.sql$/)
  if (match === null) return null
  const version = Number.parseInt(match[1], 10)
  return Number.isFinite(version) ? version : null
}

/**
 * 约束 #11：user_version 只能字面量赋值。每新增一个 migration 文件，
 * 必须在此 switch 中补一条对应的字面量语句（编译期遗漏会在运行期显式报错）。
 * 导出仅为 smoke T2 负向护栏（未注册版本断言 throw）与版本赋值行为直测；
 * 行为与 docs/13 §3 代码草案逐字一致（AC2 批次新增 case 4）。
 */
export function setUserVersionLiteral(db: DatabaseSync, version: number): void {
  switch (version) {
    case 1:
      db.exec('PRAGMA user_version = 1')
      return
    case 2:
      db.exec('PRAGMA user_version = 2')
      return
    case 3:
      db.exec('PRAGMA user_version = 3')
      return
    case 4:
      db.exec('PRAGMA user_version = 4') // ← 004 批次（AC2）新增
      return
    case 5:
      db.exec('PRAGMA user_version = 5') // ← 005 批次（ux 整改批 A）新增
      return
    case 6:
      db.exec('PRAGMA user_version = 6') // ← 006 批次（M3-C7b 轮换宽限镜像）新增
      return
    default:
      throw new Error(`no literal user_version statement registered for migration version ${version}`)
  }
}

/**
 * 应用所有待执行的 migration，返回本次应用的文件数。
 * 任一文件失败即回滚该文件事务并抛错（migration 状态不可回滚到旧版本语义，
 * 失败必须显式暴露，禁止静默半应用）。
 */
export function migrate(db: DatabaseSync): number {
  const dir = migrationsDir()
  const current = readCurrentVersion(db)

  const pending = readdirSync(dir)
    .map((name) => ({ name, version: parseMigrationVersion(name) }))
    .filter((f): f is { name: string; version: number } => f.version !== null && f.version > current)
    .sort((a, b) => a.version - b.version)

  let applied = 0
  for (const file of pending) {
    const sql = readFileSync(join(dir, file.name), 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      setUserVersionLiteral(db, file.version)
      db.exec('COMMIT')
      applied += 1
    } catch (err) {
      db.exec('ROLLBACK')
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`migration ${file.name} failed: ${message}`)
    }
  }
  return applied
}
