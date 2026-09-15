// UX-Z2 走查临时脚本（不入库）：全新 DEVHUB_HOME 播种夹具数据 + 启动新代码网关。
// 用后即弃：进程为走查临时载体，走查完成后 taskkill，绝不留常驻。
import * as dbm from '../../src/main/db/index.ts'
const getDatabase = dbm.getDatabase
import * as svc from '../../src/main/services/agentControl/agentControlService.ts'
import * as gw from '../../src/main/services/agentControl/gateway/httpServer.ts'
import * as settings from '../../src/main/services/settingsService.ts'
const setSetting = settings.setSetting

const now = Math.floor(Date.now() / 1000)
const db = getDatabase()

// provider 目录行（catalog 五家）+ zcode 置 managed 能力（走查夹具：本地假 caps，
// 与真实 provider 探测无关——本 home 无真实 CLI 绑定）
svc.ensureAgentProviderRows()
const caps = JSON.stringify({
  mode: 'managed',
  granted: ['reply', 'pause', 'resume'],
  verifiedAt: now,
  evidence: 'uxz2 walkthrough fixture (local gateway)',
  workspace: 'C:/code/devhub',
})
db.prepare("UPDATE agent_providers SET capabilities_json = ?, health = 'ok', installed = 1 WHERE provider = 'zcode'").run(caps)
db.prepare("UPDATE agent_providers SET health = 'ok', installed = 1 WHERE provider IN ('codex','claude-code','kimi','deepseek')").run()

// zcode row id
const zpid = db.prepare("SELECT id FROM agent_providers WHERE provider = 'zcode'").get().id

// 播种会话（workdir 三组 + 未分组一组；时间：分钟级前 → 「更新于 N 分钟前」）
const ins = db.prepare(`INSERT INTO agent_sessions
  (provider_id, native_id, session_mode, workdir, title, status, started_at, last_activity_at, updated_at, created_at)
  VALUES (?, ?, 'managed', ?, ?, ?, ?, ?, ?, ?)`)
const seed = [
  ['uxz2-a1', 'C:/code/devhub', 'DevHub 气泡组件重构讨论', 'running', now - 60],
  ['uxz2-a2', 'C:/code/devhub', '修一下 smoke 的端口回退', 'waiting_input', now - 300],
  ['uxz2-a3', 'C:/code/devhub', '解读 agentControlService 投影', 'completed', now - 5400],
  ['uxz2-b1', 'C:/code/contestpin', '悬浮窗拖拽边界修正', 'running', now - 120],
  ['uxz2-b2', 'C:/code/contestpin', '材料导入去重逻辑', 'waiting_input', now - 7200],
  ['uxz2-c1', 'D:/ws/blog', '写一篇 DevHub 架构博文', 'completed', now - 172800],
]
for (const [nid, wd, title, status, la] of seed) {
  ins.run(zpid, nid, wd, title, status, la - 600, la, la, la - 700)
}
// 未分组样例（workdir NULL → 「未分组」组尾部）
ins.run(zpid, 'uxz2-n1', null, '早期历史对话（无工作目录）', 'completed', now - 200000, now - 200000, now - 200000, now - 200000)

// settings：网关开 + 固定口 + managed 模型键（可选面态；停用态由走查中改行切换）
setSetting('agents_monitor_enabled', '0')
setSetting('gateway_enabled', '1')
setSetting('gateway_port', '18790')
setSetting('zcode_managed_model', 'zcode/glm-5-turbo')

const status = await gw.startGateway()
console.log('gateway listening', JSON.stringify({ actualPort: status.actualPort, running: status.running }))
setInterval(() => {}, 60_000)
