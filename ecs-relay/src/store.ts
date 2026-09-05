/**
 * store.ts — node:sqlite 访问层（docs/19 §5.2）。
 *
 * - relay.db 独立库（WAL，busy_timeout 5000），绝不进 DevHub migration 序列（G9）；
 * - schema 由 sql/0001_init.sql 承载；启动时 ensureSchema 幂等应用（与
 *   scripts/migrate.mjs 共用同一目录与版本登记 relay_meta.schema_version）；
 * - 一切运行期 SQL 全参数绑定（约束 #11）；本模块不做业务判断。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql')

/** 迁移文件名约定：NNNN_name.sql（按字典序应用）。 */
const MIGRATION_PATTERN = /^(\d{4})_[a-z_]+\.sql$/

export interface StoreOptions {
  /** 数据库文件路径；':memory:' 供测试。 */
  path: string
}

export class Store {
  readonly db: DatabaseSync
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>()

  constructor(options: StoreOptions) {
    if (options.path !== ':memory:') {
      mkdirSync(dirname(options.path), { recursive: true })
    }
    this.db = new DatabaseSync(options.path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA foreign_keys = ON;')
  }

  /** 预编译语句缓存（同 SQL 复用；参数一律 ? 绑定）。 */
  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    const cached = this.statements.get(sql)
    if (cached !== undefined) return cached
    const stmt = this.db.prepare(sql)
    this.statements.set(sql, stmt)
    return stmt
  }

  run(sql: string, ...params: (string | number | bigint | null)[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.prepare(sql).run(...params)
  }

  get<T = Record<string, unknown>>(sql: string, ...params: (string | number | bigint | null)[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined
  }

  all<T = Record<string, unknown>>(sql: string, ...params: (string | number | bigint | null)[]): T[] {
    return this.prepare(sql).all(...params) as T[]
  }

  /** 读 relay_meta 单键。 */
  metaGet(key: string): string | null {
    const row = this.get<{ value: string }>('SELECT value FROM relay_meta WHERE key = ?', key)
    return row?.value ?? null
  }

  /** 写 relay_meta 单键（upsert）。 */
  metaSet(key: string, value: string): void {
    this.run(
      'INSERT INTO relay_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    )
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      /* 已损坏/已关闭场景以关闭为主（缓存可重建，PR10） */
    }
    this.db.close()
  }
}

/**
 * 幂等应用 sql/ 目录全部待应用迁移（版本登记 relay_meta.schema_version）。
 * 服务启动与 scripts/migrate.mjs 共用；返回已应用的文件名列表。
 */
export function ensureSchema(store: Store, schemaDir: string = SCHEMA_DIR): string[] {
  const applied: string[] = []
  // 版本登记表先行（与 0001 定义同形）——空库首次迁移时 relay_meta 尚不存在
  store.db.exec('CREATE TABLE IF NOT EXISTS relay_meta (key TEXT PRIMARY KEY, value TEXT)')
  const current = Number.parseInt(store.metaGet('schema_version') ?? '0', 10) || 0
  const files = readdirSync(schemaDir)
    .filter((name) => MIGRATION_PATTERN.test(name))
    .sort()
  for (const name of files) {
    const version = Number.parseInt(name.slice(0, 4), 10)
    if (version <= current) continue
    const sqlText = readFileSync(join(schemaDir, name), 'utf8')
    store.db.exec(sqlText) // DDL 幂等性由版本号保证（半途失败无版本登记 → 下次重放整文件）
    store.metaSet('schema_version', String(version))
    store.metaSet(`schema_file_${version}`, basename(name))
    applied.push(name)
  }
  return applied
}
