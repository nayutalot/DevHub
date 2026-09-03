// AC5 acceptance CDP driver: evaluate JS in the DevHub page via --remote-debugging-port.
// Usage: node ac5-cdp.mjs "<expression>"
// Prints JSON result of Runtime.evaluate (byValue).
const PORT = 9222

async function main() {
  const expr = process.argv[2]
  if (!expr) { console.error('usage: node ac5-cdp.mjs "<js>"'); process.exit(1) }
  // find page target
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
  const result = await new Promise((res, rej) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === 1) res(msg)
    }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
    setTimeout(() => rej(new Error('cdp timeout')), 30000)
  })
  console.log(JSON.stringify(result.result?.result?.value ?? result.result?.result ?? result.result, null, 1))
  ws.close()
}
main().catch((e) => { console.error('CDP_ERROR: ' + e.message); process.exit(3) })
