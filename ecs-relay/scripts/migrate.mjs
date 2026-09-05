#!/usr/bin/env node
/**
 * scripts/migrate.mjs — devhub-relay 独立迁移脚本（docs/19 §5.2/§5.3，G9）。
 *
 * 用法：
 *   node scripts/migrate.mjs                       # 使用 RELAY_DB_PATH 或 ./data/relay.db
 *   RELAY_DB_PATH=/var/lib/devhub-relay/relay.db node scripts/migrate.mjs
 *
 * 幂等：按 relay_meta.schema_version 增量应用 sql/NNNN_*.sql。服务启动亦会
 * 自检并应用同一序列（store.ensureSchema），本脚本供部署/升级显式执行与 CI 校验。
 */
import { Store, ensureSchema, SCHEMA_DIR } from '../src/store.ts'

const dbPath = process.env.RELAY_DB_PATH ?? 'data/relay.db'
const store = new Store({ path: dbPath })
try {
  const applied = ensureSchema(store, SCHEMA_DIR)
  const version = store.metaGet('schema_version') ?? '0'
  if (applied.length === 0) {
    console.log(`[migrate] ${dbPath}: already at schema_version=${version} (no pending migrations)`)
  } else {
    console.log(`[migrate] ${dbPath}: applied ${applied.length} migration(s): ${applied.join(', ')} → schema_version=${version}`)
  }
} finally {
  store.close()
}
