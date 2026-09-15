// UX-Z3 走查临时脚本（不入库为运行件；与 gateway-runner.mjs 同批留档）：全新 DEVHUB_HOME
// 播种夹具数据 + 启动新代码网关（18790）+ 回环控制面（18791）——走查中按需触发真实
// applySessionStatus / persistMessage（与桌面 managed 面同一落库+事件管道 → 真实 WS 推送
// → App 锚点登记/消息回流）。用后即弃：走查完成 taskkill，绝不留常驻。
import * as dbm from '../../src/main/db/index.ts'
const getDatabase = dbm.getDatabase
import * as svc from '../../src/main/services/agentControl/agentControlService.ts'
import * as gw from '../../src/main/services/agentControl/gateway/httpServer.ts'
import * as settings from '../../src/main/services/settingsService.ts'
const setSetting = settings.setSetting
import http from 'node:http'

const now = Math.floor(Date.now() / 1000)
const db = getDatabase()

// provider 目录行 + zcode 置 managed 能力（走查夹具：本地假 caps，与真实 provider 探测无关）
svc.ensureAgentProviderRows()
const caps = JSON.stringify({
  mode: 'managed',
  granted: ['reply', 'pause', 'resume'],
  verifiedAt: now,
  evidence: 'uxz3 walkthrough fixture (local gateway)',
  workspace: 'C:/code/devhub',
})
db.prepare("UPDATE agent_providers SET capabilities_json = ?, health = 'ok', installed = 1 WHERE provider = 'zcode'").run(caps)
db.prepare("UPDATE agent_providers SET health = 'ok', installed = 1 WHERE provider IN ('codex','claude-code','kimi','deepseek')").run()
const zpid = db.prepare("SELECT id FROM agent_providers WHERE provider = 'zcode'").get().id

// 播种会话：
// A uxz3-a1 managed waiting_input（正常走查主体：起沿/走字/pill/停沿全在此）
// B uxz3-b1 managed running（App 首观测即在跑 → 锚点不可考降级「运行中…」路径）
// C uxz3-c1 observed running（observed 双门：整块不显计时器/pill）
const ins = db.prepare(`INSERT INTO agent_sessions
  (provider_id, native_id, session_mode, workdir, title, status, status_detail, started_at, last_activity_at, updated_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
ins.run(zpid, 'uxz3-a1', 'managed', 'C:/code/devhub', 'UXZ3 计时器与工具活动走查', 'waiting_input', null, now - 600, now - 300, now - 300, now - 610)
ins.run(zpid, 'uxz3-b1', 'managed', 'C:/code/devhub', 'UXZ3 降级态样例（进详情时已在跑）', 'running', 'turn/start (seq 1)', now - 1800, now - 60, now - 60, now - 1810)
ins.run(zpid, 'uxz3-c1', 'observed', 'C:/code/devhub', 'UXZ3 仅查看会话（observed）', 'running', 'turn/start (seq 3)', now - 900, now - 30, now - 30, now - 910)

// settings：网关开 + 固定口 + managed 模型键
setSetting('agents_monitor_enabled', '0')
setSetting('gateway_enabled', '1')
setSetting('gateway_port', '18790')
setSetting('zcode_managed_model', 'zcode/glm-5-turbo')

const status = await gw.startGateway()
console.log('gateway listening', JSON.stringify({ actualPort: status.actualPort, running: status.running }))

// —— 回环控制面（仅 127.0.0.1；走查驱动用）——
// GET /running?native=N[&detail=D]   真实开始沿（applySessionStatus → WS 推送）
// GET /msguser?native=N&text=T       user 行
// GET /msg?native=N&labels=a,b[&detail=1]  assistant 行 toolInvocation 段（labels 逗号分隔）
// GET /stop?native=N&status=S&detail=D     停沿（waiting_input/failed/paused/connection_lost）
// GET /pair                                  签发配对码（走查输入用；码只进键盘不进截图）
const sid = (native) => db.prepare('SELECT id FROM agent_sessions WHERE native_id = ?').get(native)?.id ?? null
let msgSeq = 100
const control = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const q = u.searchParams
  const native = q.get('native')
  try {
    if (u.pathname === '/running') {
      const id = sid(native)
      if (id === null) throw new Error('no session ' + native)
      const detail = q.get('detail') ?? 'zcode event: turn.started'
      svc.applySessionStatus('zcode', native, 'running', detail)
      res.writeHead(200).end(JSON.stringify({ ok: true, id, detail }))
    } else if (u.pathname === '/msguser') {
      const text = q.get('text') ?? '继续'
      svc.persistMessage('zcode', native, {
        nativeMsgId: `uxz3-user-${msgSeq++}`,
        role: 'user',
        contentRedacted: text,
        sourceRef: `uxz3-fixture#seq=${msgSeq}`,
        occurredAt: Math.floor(Date.now() / 1000),
      })
      res.writeHead(200).end(JSON.stringify({ ok: true }))
    } else if (u.pathname === '/msg') {
      const labels = (q.get('labels') ?? '').split(',').filter(Boolean)
      const segments = labels.map((l) => ({ kind: 'toolInvocation', label: l, content: `{"fixture":"${l}"}` }))
      svc.persistMessage('zcode', native, {
        nativeMsgId: `uxz3-tool-${msgSeq++}`,
        role: 'assistant',
        contentRedacted: '[tool_call fixture]',
        sourceRef: `uxz3-fixture#seq=${msgSeq}`,
        occurredAt: Math.floor(Date.now() / 1000),
        ...(segments.length > 0 ? { segments } : {}),
      })
      res.writeHead(200).end(JSON.stringify({ ok: true, labels }))
    } else if (u.pathname === '/stop') {
      const to = q.get('status') ?? 'waiting_input'
      const detail = q.get('detail') ?? 'turn completed (resultType: success)'
      svc.applySessionStatus('zcode', native, to, detail)
      res.writeHead(200).end(JSON.stringify({ ok: true, to, detail }))
    } else if (u.pathname === '/pair') {
      const created = await svc.createPairing('uxz3-walkthrough')
      res.writeHead(201).end(JSON.stringify(created))
    } else {
      res.writeHead(404).end('not found')
    }
  } catch (err) {
    res.writeHead(500).end(JSON.stringify({ error: String(err && err.message ? err.message : err) }))
  }
})
control.listen(18791, '127.0.0.1', () => console.log('control on 18791'))
setInterval(() => {}, 60_000)
