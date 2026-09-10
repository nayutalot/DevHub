// M-batch CDP driver (extends CP6 precedent): target-aware eval/click/shot.
// Usage:
//   node cdp.mjs targets
//   node cdp.mjs eval  main|overlay "<js>"        -> JSON result
//   node cdp.mjs click main|overlay "<el-expr>"   -> clicks element center
//   node cdp.mjs shot  main|overlay "<out.png>"   -> page screenshot
const PORT = 9222
const mode = process.argv[2]
const targetName = process.argv[3]
const arg = process.argv[4]

async function connect() {
  let pages = null
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await r.json()
      pages = targets.filter((t) => t.type === 'page')
      if (pages.length > 0) return pages
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('no page target')
}

function pick(pages) {
  if (targetName === 'overlay') {
    return pages.find((t) => t.url.includes('#overlay')) ?? null
  }
  if (targetName === 'main') {
    return pages.find((t) => !t.url.includes('#overlay')) ?? null
  }
  return pages[0]
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
  if (mode === 'targets') {
    for (const p of pages) console.log(JSON.stringify({ url: p.url, title: p.title }))
    return
  }
  const page = pick(pages)
  if (!page) throw new Error(`target '${targetName}' not found; have: ` + pages.map((p) => p.url).join(' | '))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  const call = rpc(ws)

  if (mode === 'eval') {
    const r = await call('Runtime.evaluate', { expression: arg, returnByValue: true, awaitPromise: true })
    console.log(JSON.stringify(r.result?.result ?? r.result, null, 1))
  } else if (mode === 'click') {
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
    throw new Error('mode must be targets|eval|click|shot')
  }
  ws.close()
}
main().catch((e) => { console.error('CDP_ERROR: ' + e.message); process.exit(3) })
