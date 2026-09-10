// Read-only settings snapshot: copy DB (+wal/shm) to evidence dir, then read the COPY.
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const src = 'C:/Users/sakuya/AppData/Roaming/devhub/devhub.db'
const outDir = 'F:/Active_Project/DevHub/acceptance/ui-verify-20260910-2300'
for (const ext of ['', '-wal', '-shm']) {
  if (existsSync(src + ext)) copyFileSync(src + ext, outDir + '/db-copy' + ext)
}
const db = new DatabaseSync(outDir + '/db-copy', { readOnly: true })
const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE '%overlay%' OR key LIKE 'login_autostart%' OR key LIKE 'agents_monitor%'").all()
console.log(JSON.stringify(rows, null, 1))
db.close()
