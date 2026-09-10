// CP6 acceptance CDP driver: evaluate JS / capture screenshot on the DevHub page.
// Usage:
//   node cdp.mjs eval "<js expression>"          -> prints JSON result (byValue)
//   node cdp.mjs shot "<outfile.png>"            -> saves page screenshot
const PORT = 9222
const mode = process.argv[2]
const arg = process.argv[3]

async function connect() {
  let targets = null
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      targets = await r.json()
      const pages = targets.filter((t) => t.type === 'page')
      if (pages.length > 0) return pages
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no page target')
}

function rpc(ws) {
  let id = 0
  return (method, params) =>
    new Promise((res, rej) => {
      const mid = ++id
      const on = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id === mid) {
          ws.removeEventListener('message', on)
          if (msg.error) rej(new Error(JSON.stringify(msg.error)))
          else res(msg.result)
        }
      }
      ws.addEventListener('message', on)
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => rej(new Error('rpc timeout: ' + method)), 30000)
    })
}

async function main() {
  const pages = await connect()
  // prefer the page whose url is NOT the overlay
  const page = pages.find((t) => !t.url.includes('#overlay')) ?? pages[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const call = rpc(ws)

  if (mode === 'eval') {
    const r = await call('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true })
    console.log(JSON.stringify(r.result?.result ?? r.result, null, 1))
  } else if (mode === 'click') {
    // arg = JS expression returning the element (must be usable with getBoundingClientRect)
    const r = await call('Runtime.evaluate', {
      expression: `(() => { const el = ${arg}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
      returnByValue: true,
    })
    const pos = r.result?.value
    if (!pos) throw new Error('element not found for click; raw=' + JSON.stringify(r.result).slice(0, 300))
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await call('Input.dispatchMouseEvent', {
        type,
        x: pos.x,
        y: pos.y,
        button: 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      })
      await new Promise((res) => setTimeout(res, 120))
    }
    console.log('clicked at ' + JSON.stringify(pos))
  } else if (mode === 'shot') {
    await call('Page.enable')
    await call('Page.bringToFront').catch(() => {})
    await new Promise((r) => setTimeout(r, 600))
    const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(arg, Buffer.from(r.data, 'base64'))
    console.log('saved: ' + arg + ' bytes=' + Buffer.from(r.data, 'base64').length)
  } else {
    throw new Error('mode must be eval|shot')
  }
  ws.close()
}
main().catch((e) => { console.error('CDP_ERROR: ' + e.message); process.exit(3) })
