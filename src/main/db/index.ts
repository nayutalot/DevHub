/**
 * db 门面（docs/02 §1）——惰性单例数据库连接。
 *
 * 只有 Service 层允许写库（约束 #20）；Adapter 与 IPC 层不得直接读写。
 * openDatabase / migrate 额外具名导出供 smoke 测试使用。
 */

import { mkdirSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { getDataDir, getDbPath } from '../core/paths.ts'
import { openDatabase } from './connection.ts'
import { migrate } from './migrate.ts'

export { openDatabase, migrate }

let instance: DatabaseSync | null = null

/** 取全局单例；首次调用时确保数据目录存在、打开库并跑完 migration。 */
export function getDatabase(): DatabaseSync {
  if (instance === null) {
    mkdirSync(getDataDir(), { recursive: true })
    instance = openDatabase(getDbPath())
    migrate(instance)
  }
  return instance
}

/** 释放单例连接（不删除数据库文件）；供优雅退出与测试使用。 */
export function closeDatabase(): void {
  if (instance !== null) {
    instance.close()
    instance = null
  }
}
