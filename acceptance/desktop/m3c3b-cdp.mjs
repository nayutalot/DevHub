// M3-C3b acceptance CDP driver: evaluate JS in the DevHub page via --remote-debugging-port.
// Usage: node m3c3b-cdp.mjs "<expression>"   (mirror of acceptance/ac5-cdp.mjs, page-target scoped)
const PORT = 9222

async function main() {
  const expr = process.argv[2]
  if (!expr) { console.error('usage: node m3c3b-cdp.mjs "<js>"'); process.exit(1) }
  let targets = null
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      targets = await r.json()
      if (targets.some((t) => t.type === 'page')) break
    } catch { }
    await new Promise((r) => setTimeout(r, 500))
  }
  const page = targets.find((t) => t.type === 'page')
  if (!page) { console.error('no page target'); process.exit(2) }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const call = (method, params) => new Promise((res, rej) => {
    const mid = ++id
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === mid) res(msg)
    }
    ws.send(JSON.stringify({ id: mid, method, params }))
    setTimeout(() => rej(new Error('cdp timeout: ' + method)), 30000)
  })
  const result = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  console.log(JSON.stringify(result.result?.result?.value ?? result.result?.result ?? result.result, null, 1))
  ws.close()
}
main().catch((e) => { console.error('CDP_ERROR: ' + e.message); process.exit(3) })
