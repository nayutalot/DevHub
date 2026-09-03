/**
 * connection.ts — node:sqlite DatabaseSync 封装（docs/03 §1）。
 *
 * 打开即设置 WAL、外键、busy_timeout；PRAGMA 一律字面量（无参数可绑定的
 * 语句，且不属于约束 #11 唯一例外的 user_version 语义范围）。
 */

import { DatabaseSync } from 'node:sqlite'

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  return db
}
