// cdp-d5.mjs — D5 批 CDP 运行时验证台本（零 OS 鼠标键盘注入；D-Aud 先例同法：
// DevTools 协议 hash 导航 / DOM 级事件 / Input.dispatchKeyEvent 均为页面内事件）。
// 用法：node cdp-d5.mjs <cmd>
//   probe       — 等待主窗口 target 可达
//   seedadd     — invoke projects:add 注册夹具项目（临时 DEVHUB_HOME 库）
//   main        — 临时库全套断言（快捷键/toast 队列/四处浏览…/A6/A7/A8/折叠/hash 深链/确认弹窗 Esc）
//   relwait     — relativeTime 等「刚刚」→「N 分钟前」翻转（≤100s 轮询）
//   real        — 在役 asar 旧实现实例：toast 重叠阳性对照 + 真库回归点
const PORT = 9222

async function getMainTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`)
  const targets = await res.json()
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

async function evalJson(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails !== undefined) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result.value
}

async function gotoHash(cdp, hash, settleMs) {
  await cdp.send('Runtime.evaluate', { expression: `location.hash = '${hash}'`, returnByValue: true })
  await sleep(settleMs ?? 900)
}

async function key(cdp, { key, code, vk, ctrl = false }) {
  const modifiers = ctrl ? 2 : 0
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
}

const out = (label, value) => console.log(`[${label}] ${JSON.stringify(value)}`)

const [, , cmd] = process.argv

if (cmd === 'probe') {
  for (let i = 0; i < 40; i++) {
    try {
      await getMainTarget()
      out('probe', 'main-window-ready')
      process.exit(0)
    } catch {
      await sleep(500)
    }
  }
  console.error('[probe] timeout')
  process.exit(1)
} else if (cmd === 'seedadd') {
  const fixture = process.argv[2]
  await withPage(async (cdp) => {
    const v = await evalJson(cdp, `window.devhub.invoke('projects:add', { winPath: ${JSON.stringify(fixture)} }).then(r => JSON.stringify(r))`)
    out('seedadd', v)
  })
} else if (cmd === 'main') {
  const results = {}

  // ---- T1a Ctrl+2 → projects（含 keydown 探针记录 defaultPrevented）----
  await withPage(async (cdp) => {
    await evalJson(cdp, "(() => { window.__keylog = []; window.addEventListener('keydown', (e) => window.__keylog.push({ key: e.key, ctrl: e.ctrlKey, prevented: e.defaultPrevented })); return 'probe-installed' })()")
    await key(cdp, { key: '2', code: 'Digit2', vk: 50, ctrl: true })
    await sleep(700)
    results.ctrl2 = await evalJson(cdp, "JSON.stringify({ hash: location.hash, topbar: document.querySelector('.topbar-view')?.textContent, log: window.__keylog })")

    // ---- T1b Ctrl+1 → dashboard ----
    await key(cdp, { key: '1', code: 'Digit1', vk: 49, ctrl: true })
    await sleep(700)
    results.ctrl1 = await evalJson(cdp, "JSON.stringify({ hash: location.hash, topbar: document.querySelector('.topbar-view')?.textContent })")

    // ---- T1c F5 → refreshAll（preventDefault + 无重载）----
    const navBefore = await evalJson(cdp, "performance.getEntriesByType('navigation')[0].type")
    await key(cdp, { key: 'F5', code: 'F5', vk: 116 })
    await sleep(700)
    results.f5 = await evalJson(cdp, `JSON.stringify({ log: window.__keylog, navType: performance.getEntriesByType('navigation')[0].type, navBefore: ${JSON.stringify(navBefore)}, hash: location.hash })`)

    // ---- T1d '/' 聚焦搜索框 + 输入聚焦时不抢占 ----
    await gotoHash(cdp, '#services', 1500)
    await key(cdp, { key: '/', code: 'Slash', vk: 191 })
    await sleep(400)
    const focusAfterSlash = await evalJson(cdp, "document.activeElement?.className ?? 'none'")
    // 输入框聚焦时 '/' 必须保持字面输入（不抢占、不跳焦点）
    await key(cdp, { key: '/', code: 'Slash', vk: 191 })
    await sleep(300)
    const guardState = await evalJson(cdp, "JSON.stringify({ active: document.activeElement?.className, value: document.activeElement?.value ?? null })")
    results.slash = { focusAfterSlash, guardState }
  })

  // ---- T3a relativeTime 起点（种子=now-50s，此刻应为「刚刚」）----
  await withPage(async (cdp) => {
    await gotoHash(cdp, '#dashboard', 1500)
    results.relStart = await evalJson(cdp, "JSON.stringify({ text: document.querySelector('.recent-time')?.textContent ?? null, all: [...document.querySelectorAll('.recent-time')].map(e => e.textContent) })")
  })

  // ---- T2 toast 队列并发 ≥2 不重叠 ----
  await withPage(async (cdp) => {
    await gotoHash(cdp, '#contest', 1800)
    const r = await evalJson(cdp, `(() => {
      const zone = document.querySelector('.add-form')
      if (zone === null) return JSON.stringify({ error: 'drop-zone-not-found' })
      const mk = () => {
        const dt = new DataTransfer()
        dt.items.add(new File(['x'], 'cdp-fake.txt', { type: 'text/plain' }))
        return new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
      }
      zone.dispatchEvent(mk())
      zone.dispatchEvent(mk())
      return 'dropped-2'
    })()`)
    results.toastDrop = r
    await sleep(600)
    results.toastQueue = await evalJson(cdp, `(() => {
      const host = document.querySelector('.toast-stack')
      const toasts = host === null ? [] : [...host.querySelectorAll('.toast')]
      const rects = toasts.map((t) => { const r = t.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right } })
      let overlapArea = null
      if (rects.length >= 2) {
        const a = rects[0], b = rects[1]
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        overlapArea = Math.max(0, w) * Math.max(0, h)
      }
      return JSON.stringify({ count: toasts.length, overlapArea, rects, texts: toasts.map(t => t.textContent.slice(0, 24)) })
    })()`)
    // TTL 3200ms 后应排空
    await sleep(4000)
    results.toastDrained = await evalJson(cdp, "JSON.stringify({ count: document.querySelectorAll('.toast').length })")
  })

  // ---- T4 四处「浏览…」+ dialog:pickPath 通道断言 ----
  await withPage(async (cdp) => {
    const patch = await evalJson(cdp, `(() => {
      try {
        const orig = window.devhub.invoke
        window.__pickLog = []
        window.devhub.invoke = (channel, payload) => {
          if (channel === 'dialog:pickPath') { window.__pickLog.push({ channel, payload }); return Promise.resolve({ ok: true, data: { canceled: true, path: null } }) }
          return orig(channel, payload)
        }
        return 'patched'
      } catch (e) { return 'patch-failed: ' + e.message }
    })()`)
    results.pickPatch = patch
    if (patch === 'patched') {
      // ① BackupPanel destDir
      await gotoHash(cdp, '#contest', 1200)
      const r1 = await evalJson(cdp, `(async () => {
        const bar = document.querySelector('[data-testid="contest-backup-panel"]')
        if (bar === null || !bar.classList.contains('recog-collapsed')) return JSON.stringify({ error: 'backup-panel-state', collapsed: bar?.classList.contains('recog-collapsed') ?? null })
        const expand = [...bar.querySelectorAll('button')].find(b => b.textContent.includes('备份与恢复'))
        expand.click()
        await new Promise(r => setTimeout(r, 300))
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '浏览…' && b.closest('.panel')?.querySelector('#cp-backup-dir') !== undefined)
        if (btn === undefined) return JSON.stringify({ error: 'browse-btn-not-found' })
        btn.click()
        await new Promise(r => setTimeout(r, 400))
        return JSON.stringify({ ok: true, input: document.querySelector('#cp-backup-dir')?.value ?? null })
      })()`)
      results.pickBackup = r1
      // ② MaterialImport manual_pack destDir
      const r2 = await evalJson(cdp, `(async () => {
        const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'manual_pack'))
        if (sel === undefined) return JSON.stringify({ error: 'mode-select-not-found' })
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
        setter.call(sel, 'manual_pack')
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise(r => setTimeout(r, 300))
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '浏览…' && b.closest('.panel')?.querySelector('#cp-imp-pack-dir') !== undefined)
        if (btn === undefined) return JSON.stringify({ error: 'browse-btn-not-found' })
        btn.click()
        await new Promise(r => setTimeout(r, 400))
        return JSON.stringify({ ok: true })
      })()`)
      results.pickMaterial = r2
      // ③ Skills importDialog sourceDir
      await gotoHash(cdp, '#skills', 1500)
      const r3 = await evalJson(cdp, `(async () => {
        const open = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '导入')
        if (open === undefined) return JSON.stringify({ error: 'import-btn-not-found' })
        open.click()
        await new Promise(r => setTimeout(r, 300))
        const dlg = document.querySelector('.import-overlay')
        if (dlg === null) return JSON.stringify({ error: 'import-dialog-not-open' })
        const btn = [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === '浏览…')
        if (btn === undefined) return JSON.stringify({ error: 'browse-btn-not-found' })
        btn.click()
        await new Promise(r => setTimeout(r, 400))
        return JSON.stringify({ ok: true, input: dlg.querySelector('input')?.value ?? null })
      })()`)
      results.pickSkills = r3
      // ④ Archive destRoot
      await gotoHash(cdp, '#archive', 1500)
      const r4 = await evalJson(cdp, `(async () => {
        const input = document.querySelector('#archive-dest-root')
        if (input === null) return JSON.stringify({ error: 'dest-root-not-found' })
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '浏览…' && b.closest('.archive-settings-bar') !== undefined)
        if (btn === undefined) return JSON.stringify({ error: 'browse-btn-not-found' })
        btn.click()
        await new Promise(r => setTimeout(r, 400))
        return JSON.stringify({ ok: true })
      })()`)
      results.pickArchive = r4
      results.pickLog = await evalJson(cdp, "JSON.stringify(window.__pickLog)")
      // 取消语义：path=null → 输入框维持原值不报错（由上面 input 值断言 + 无 error 态佐证）
      await evalJson(cdp, "(() => { delete window.__pickLog; return 'done' })()")
    }
  })

  // ---- T5a A8 Versions unknown+null 禁用 ----
  await withPage(async (cdp) => {
    await gotoHash(cdp, '#versions', 1500)
  results.a8 = await evalJson(cdp, `(() => {
    const rows = [...document.querySelectorAll('.table tbody tr')]
    const ups = rows.map((tr) => {
      const btn = [...tr.querySelectorAll('button')].find(b => b.textContent.trim() === '更新')
      if (btn === undefined) return null
      return { disabled: btn.disabled, title: btn.title }
    }).filter(Boolean)
    return JSON.stringify({ rows: rows.length, updates: ups, allDisabledOrHinted: ups.every(u => u.disabled) })
  })()`)

  // ---- T5b A6 空态中性图标（斜杠圆已退役）----
  results.a6 = await evalJson(cdp, `(() => {
    const icon = document.querySelector('.empty-icon svg')
    if (icon === null) return JSON.stringify({ icon: null })
    const paths = [...icon.querySelectorAll('path,line,circle')].map(p => ({ tag: p.tagName, d: p.getAttribute('d') ?? null }))
    const hasSlashLine = [...icon.querySelectorAll('line')].some(l => { const x1 = +l.getAttribute('x1'), y1 = +l.getAttribute('y1'), x2 = +l.getAttribute('x2'), y2 = +l.getAttribute('y2'); return x1 !== x2 && y1 !== y2 })
    return JSON.stringify({ paths, hasSlashLine })
  })()`)

  // ---- T5c A7 过渡（.12s 且只 background-color/border-color）----
  results.a7 = await evalJson(cdp, `(() => {
    const btn = document.querySelector('.btn')
    const cs = getComputedStyle(btn)
    const nav = document.querySelector('.nav-item')
    const csNav = getComputedStyle(nav)
    return JSON.stringify({ btnTransition: cs.transition, navTransition: csNav.transition })
  })()`)
  })

  // ---- T5d hash 深链 12/12 ----
  await withPage(async (cdp) => {
    const wanted = [
      ['#dashboard', '仪表盘'], ['#projects', '项目'], ['#environment', '环境'], ['#services', '服务'],
      ['#skills', '技能'], ['#apihub', 'ApiHub'], ['#versions', '版本'], ['#docker', 'Docker'],
      ['#archive', '归档'], ['#agents', 'Agents'], ['#contest', '比赛'], ['#contest:1', '比赛'],
    ]
    const got = []
    for (const [h, label] of wanted) {
      await gotoHash(cdp, h, 700)
      const t = await evalJson(cdp, "document.querySelector('.topbar-view')?.textContent ?? 'none'")
      got.push({ h, label, t, ok: t === label })
    }
    results.deepLinks = { pass: got.filter(g => g.ok).length, total: got.length, got }
  })

  // ---- T5e 确认弹窗（A5）：Skills 同步 → 应用内确认 → Esc 取消不发起 IPC ----
  await withPage(async (cdp) => {
    await gotoHash(cdp, '#skills', 1500)
    const probe = await evalJson(cdp, `(() => {
      const orig = window.devhub.invoke
      window.__ipcLog = []
      window.devhub.invoke = (channel, payload) => { window.__ipcLog.push(channel); return orig(channel, payload) }
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('同步'))
      if (btn === undefined) return 'sync-btn-not-found'
      btn.click()
      return 'clicked'
    })()`)
    await sleep(500)
    const dlgOpen = await evalJson(cdp, `JSON.stringify({ dialog: document.querySelector('[data-testid="confirm-dialog"]')?.textContent.slice(0, 60) ?? null })`)
    await key(cdp, { key: 'Escape', code: 'Escape', vk: 27 })
    await sleep(400)
    const after = await evalJson(cdp, `JSON.stringify({ dialogGone: document.querySelector('[data-testid="confirm-dialog"]') === null, ipc: (window.__ipcLog ?? []).filter(c => c === 'skills:sync').length })`)
    results.a5confirm = { probe, dlgOpen, after }
    // 还原 invoke
    await evalJson(cdp, `(() => { const orig = window.devhub.invoke; window.devhub.invoke = (c, p) => { window.devhub.invoke = orig; return orig(c, p) }; delete window.__ipcLog; return 'restored-once' })()`)
  })

  out('main', results)
} else if (cmd === 'relwait') {
  await withPage(async (cdp) => {
    const t0 = Date.now()
    for (let i = 0; i < 50; i++) {
      const v = await evalJson(cdp, "JSON.stringify({ text: document.querySelector('.recent-time')?.textContent ?? null, hash: location.hash })")
      const parsed = JSON.parse(v)
      if (parsed.text !== null && /^\d+ 分钟前$/.test(parsed.text)) {
        out('relwait', { flipped: true, text: parsed.text, waitedMs: Date.now() - t0, hash: parsed.hash })
        process.exit(0)
      }
      await sleep(2000)
    }
    out('relwait', { flipped: false })
    process.exit(1)
  })
} else if (cmd === 'real') {
  const results = {}
  await withPage(async (cdp) => {
    // ---- 阳性对照：旧实现（在役 X10 asar 渲染层）.toast 为 fixed 同坐标 → 两枚必然重叠 ----
    const old = await evalJson(cdp, `(() => {
      const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules].map(r => r.cssText) } catch { return [] } }).find(t => t.includes('.toast') && t.includes('position: fixed'))
      const a = document.createElement('div'); a.className = 'toast toast-ok'; a.textContent = '阳性对照A'
      const b = document.createElement('div'); b.className = 'toast toast-err'; b.textContent = '阳性对照B'
      document.body.appendChild(a); document.body.appendChild(b)
      const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect()
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      const overlap = Math.max(0, w) * Math.max(0, h)
      a.remove(); b.remove()
      return JSON.stringify({ toastCssFixed: css !== undefined, overlapArea: overlap, raTop: ra.top, rbTop: rb.top })
    })()`)
    results.oldToastOverlap = old
  })
  // ---- 会话行 role=button + 焦点环（真库）----
  await withPage(async (cdp) => {
    await gotoHash(cdp, '#agents', 2500)
    const rows = await evalJson(cdp, `(() => {
      const rows = [...document.querySelectorAll('.table tbody tr[role="button"]')]
      return JSON.stringify({ roleButtonRows: rows.length, sample: rows[0]?.getAttribute('aria-label')?.slice(0, 40) ?? null })
    })()`)
    results.sessionRows = rows
    // loadMore 真追加：找含 ≥100 消息的会话——点第一行会话 → 详情 → 找「加载更多」
    const clickRow = await evalJson(cdp, `(async () => {
      const row = document.querySelector('.table tbody tr[role="button"]')
      if (row === null) return 'no-rows'
      row.click()
      await new Promise(r => setTimeout(r, 1800))
      return 'clicked'
    })()`)
    results.clickRow = clickRow
    const lm = await evalJson(cdp, `(async () => {
      const countRows = () => document.querySelectorAll('.table tbody tr').length
      const before = countRows()
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('加载更多'))
      if (btn === undefined) return JSON.stringify({ loadMore: false, before })
      btn.click()
      await new Promise(r => setTimeout(r, 1800))
      const after = countRows()
      return JSON.stringify({ loadMore: true, before, after, appended: after > before })
    })()`)
    results.loadMore = lm
  })
  // ---- BackupPanel 默认折叠 + Docker 状态（真库）----
  await withPage(async (cdp) => {
    await gotoHash(cdp, '#contest', 1800)
    results.backupCollapsed = await evalJson(cdp, `JSON.stringify({ collapsed: document.querySelector('[data-testid="contest-backup-panel"]')?.classList.contains('recog-collapsed') ?? null, listVisible: document.querySelectorAll('.table tbody tr').length > 0 })`)
    await gotoHash(cdp, '#docker', 2500)
    results.docker = await evalJson(cdp, `JSON.stringify({ daemonOnline: !!document.querySelector('.docker-online'), degraded: document.querySelector('.degraded-banner')?.textContent.slice(0, 60) ?? null })`)
  })
  out('real', results)
} else {
  console.error('unknown cmd')
  process.exit(1)
}
