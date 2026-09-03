# AC5 acceptance: fresh DB snapshot + max ids (read-only; copy then query, S6 precedent)
param([string]$Tag = 'x')
$tmp = Join-Path $env:TEMP ("ac5snap-" + $Tag + "-" + [guid]::NewGuid().ToString('N').Substring(0,6))
New-Item -ItemType Directory -Path $tmp | Out-Null
Copy-Item "$env:APPDATA\devhub\devhub.db" "$tmp\" -Force
Copy-Item "$env:APPDATA\devhub\devhub.db-wal" "$tmp\" -Force -ErrorAction SilentlyContinue
Copy-Item "$env:APPDATA\devhub\devhub.db-shm" "$tmp\" -Force -ErrorAction SilentlyContinue
$js = @'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2] + "/devhub.db");
const ev = db.prepare("SELECT MAX(id) m, COUNT(*) c FROM agent_events").get();
const se = db.prepare("SELECT MAX(last_probe_at) p FROM agent_providers").get();
const sy = db.prepare("SELECT MAX(id) m, COUNT(*) c FROM agent_sessions").get();
const msg = db.prepare("SELECT COUNT(*) c FROM agent_messages").get();
console.log(JSON.stringify({ maxEvent: ev.m, eventCount: ev.c, lastProbe: se.p, maxSession: sy.m, sessionCount: sy.c, msgCount: msg.c }));
db.close();
'@
$path = Join-Path $tmp "q.cjs"
Set-Content -Path $path -Value $js -Encoding UTF8
node $path $tmp
Write-Output "snapshot-dir=$tmp"
