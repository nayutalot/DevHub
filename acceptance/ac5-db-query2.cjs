// AC5 acceptance: read-only snapshot queries (run against a copied db snapshot).
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[2] + '/devhub.db')
const special = db.prepare("SELECT s.id, s.provider_id, s.native_id, s.status, s.session_mode, (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id=s.id) msgs, (SELECT COUNT(*) FROM agent_events e WHERE e.session_id=s.id) evs FROM agent_sessions s WHERE s.status IN ('running','waiting_input') ORDER BY s.id").all()
const codexTop = db.prepare('SELECT s.id, s.native_id, s.status, (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id=s.id) msgs FROM agent_sessions s WHERE s.provider_id=1 ORDER BY s.last_activity_at DESC LIMIT 3').all()
console.log(JSON.stringify({ special, codexTop }, null, 1))
db.close()
