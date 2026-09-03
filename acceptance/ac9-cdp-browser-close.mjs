// AC9 acceptance: invoke Browser.close on the DevHub browser target via CDP.
// If Electron maps Browser.close to app.quit(), the before-quit requestQuit
// teardown chain runs (same sink as the tray "退出 DevHub" menu item).
const PORT = 9222

async function main() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
  const v = await r.json()
  const wsUrl = v.webSocketDebuggerUrl
  if (!wsUrl) { console.error('no browser ws url'); process.exit(2) }
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const result = await new Promise((res, rej) => {
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === 1) res(msg)
    }
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }))
    setTimeout(() => res({ id: 1, timeout: true }), 8000)
  })
  console.log(JSON.stringify(result))
  ws.close()
}
main().catch((e) => { console.error('CDP_ERROR: ' + e.message); process.exit(3) })
