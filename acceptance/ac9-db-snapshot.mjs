// AC9 acceptance: read-only snapshot of the codex row in agent_providers from the
// real DevHub database (WAL mode). Tries direct read-only open first; on failure
// falls back to the three-file copy snapshot (db + wal + shm into a temp dir).
// Read-only discipline: never writes the real database.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = process.env.APPDATA
const db = join(home, 'devhub', 'devhub.db')
const wal = db + '-wal'
const shm = db + '-shm'

function query(d) {
  const row = d.prepare("SELECT id, provider, display_name, version, capabilities_json, health, updated_at FROM agent_providers WHERE provider = 'codex'").get()
  if (!row) { console.error('codex row not found'); process.exit(4) }
  console.log(JSON.stringify(row, null, 2))
}

for (const f of [db]) {
  if (!existsSync(f)) { console.error('db missing: ' + f); process.exit(2) }
}
console.log('db files: db=' + existsSync(db) + ' wal=' + existsSync(wal) + ' shm=' + existsSync(shm))

try {
  const d = new DatabaseSync(db, { readOnly: true })
  query(d)
  d.close()
  console.log('mode: direct read-only open')
} catch (e) {
  console.log('direct read-only open failed: ' + e.message)
  const tmp = mkdtempSync(join(tmpdir(), 'devhub-ac9-snap-'))
  copyFileSync(db, join(tmp, 'devhub.db'))
  if (existsSync(wal)) copyFileSync(wal, join(tmp, 'devhub.db-wal'))
  if (existsSync(shm)) copyFileSync(shm, join(tmp, 'devhub.db-shm'))
  const d = new DatabaseSync(join(tmp, 'devhub.db'))
  query(d)
  d.close()
  rmSync(tmp, { recursive: true, force: true })
  console.log('mode: three-file copy snapshot')
}
