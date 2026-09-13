// cdp.mjs — D-Aud 桌面走查 CDP 助手（零 OS 输入注入：hash 导航 + Page.captureScreenshot
// + Runtime.evaluate DOM 级交互抽样）。用法：
//   node cdp.mjs shot <hash> <outfile> [settleMs]
//   node cdp.mjs eval '<js expression>'
//   node cdp.mjs scrollfps <hash>   # Agents 会话表滚动帧率
//   node cdp.mjs mem                # Performance.getMetrics
//   node cdp.mjs dump <hash>        # 视图可达性探测（title/panel 计数）
const PORT = 9222

async function getMainTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`)
  const targets = await res.json()
  // 主窗口 = file://...renderer/index.html 且非 overlay
  const page = targets.find((t) => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url) && !/#overlay/.test(t.url))
  if (page === undefined) throw new Error('main window target not found: ' + JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url }))))
  return page
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res2, rej2) => {
            const mid = ++id
            pending.set(mid, { res2, rej2 })
            ws.send(JSON.stringify({ id: mid, method, params }))
          })
        },
        close: () => ws.close(),
      })
    ws.onerror = reject
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res2, rej2 } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error !== undefined) rej2(new Error(msg.error.message))
        else res2(msg.result)
      }
    }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withPage(fn) {
  const target = await getMainTarget()
  const cdp = await connect(target.webSocketDebuggerUrl)
  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    return await fn(cdp)
  } finally {
    cdp.close()
  }
}

async function gotoView(cdp, target, settleMs) {
  // target = '#hash'（仅 agents/contest 有 hash 路由）或 nav 标签（DOM click 导航）。
  // 全程 DOM 级事件，零 OS 输入注入。
  if (target.startsWith('#')) {
    await cdp.send('Runtime.evaluate', { expression: `location.hash = '${target}'`, returnByValue: true })
  } else {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.trim() === '${target}'); if (b === undefined) return 'nav-not-found'; b.click(); return 'clicked'; })()`,
      returnByValue: true,
    })
    if (r.result.value !== 'clicked') console.error(r.result.value)
  }
  await sleep(settleMs ?? 1200)
}

const [, , cmd, ...args] = process.argv

if (cmd === 'shot') {
  const [hash, outfile, settle] = args
  await withPage(async (cdp) => {
    await gotoView(cdp, hash, settle === undefined ? undefined : Number(settle))
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(outfile, Buffer.from(shot.data, 'base64'))
    // 附带回执：当前 hash + 标题 + 视图标题文本
    const probe = await cdp.send('Runtime.evaluate', {
      expression: "JSON.stringify({hash: location.hash, viewTitle: document.querySelector('.view-title')?.textContent ?? null, topbarView: document.querySelector('.topbar-view')?.textContent ?? null})",
      returnByValue: true,
    })
    console.log(`saved ${outfile} -> ${probe.result.value}`)
  })
} else if (cmd === 'eval') {
  const [expr] = args
  await withPage(async (cdp) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    console.log(JSON.stringify(r.result.value ?? r.result, null, 2))
  })
} else if (cmd === 'mem') {
  await withPage(async (cdp) => {
    const m = await cdp.send('Performance.getMetrics')
    const pick = ['JSHeapUsedSize', 'JSHeapTotalSize', 'Documents', 'Nodes', 'JSEventListeners']
    const out = {}
    for (const { name, value } of m.metrics) if (pick.includes(name)) out[name] = value
    console.log(JSON.stringify(out))
  })
} else if (cmd === 'scrollfps') {
  const [hash] = args
  await withPage(async (cdp) => {
    await gotoView(cdp, hash, 2500)
    // 帧率探针：滚动 Agents 会话表容器 3 秒，rAF 计数 + 长帧统计
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const wrap = document.querySelector('.table-wrap')
        if (wrap === null) return JSON.stringify({ error: 'no .table-wrap' })
        const start = performance.now()
        let frames = 0
        let longFrames = 0
        let last = start
        let scrolling = true
        const raf = () => {
          frames++
          const now = performance.now()
          if (now - last > 32) longFrames++
          last = now
          if (scrolling) requestAnimationFrame(raf)
        }
        requestAnimationFrame(raf)
        const t0 = performance.now()
        let dir = 1
        while (performance.now() - t0 < 3000) {
          wrap.scrollTop += dir * 220
          if (wrap.scrollTop >= wrap.scrollHeight - wrap.clientHeight) dir = -1
          if (wrap.scrollTop <= 0) dir = 1
          await new Promise((r2) => setTimeout(r2, 16))
        }
        scrolling = false
        await new Promise((r2) => setTimeout(r2, 100))
        const dur = (performance.now() - start) / 1000
        return JSON.stringify({ fps: +(frames / dur).toFixed(1), longFrames, rows: wrap.querySelectorAll('tbody tr').length, scrollHeight: wrap.scrollHeight })
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    console.log(r.result.value)
  })
} else if (cmd === 'dump') {
  const [hash] = args
  await withPage(async (cdp) => {
    await gotoView(cdp, hash, 2500)
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        hash: location.hash,
        title: document.querySelector('.view-title')?.textContent ?? null,
        loading: !!document.querySelector('.loading'),
        error: document.querySelector('.error-box')?.textContent?.slice(0, 160) ?? null,
        empty: document.querySelector('.empty-title')?.textContent ?? null,
        tables: document.querySelectorAll('.table-wrap').length,
        rows: document.querySelectorAll('.table tbody tr').length,
        badges: document.querySelectorAll('.badge').length,
        buttons: document.querySelectorAll('button').length,
        toasts: document.querySelectorAll('.toast').length,
        degraded: [...document.querySelectorAll('.degraded-banner')].map((d) => d.textContent.slice(0, 80)),
      })`,
      returnByValue: true,
    })
    console.log(r.result.value)
  })
} else {
  console.log('unknown cmd')
  process.exit(1)
}
