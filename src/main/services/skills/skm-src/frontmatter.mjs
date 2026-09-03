/**
 * skills/skm-src/frontmatter.mjs — companion 内联的 frontmatter 解析。
 * 与 src/main/services/skills/frontmatter.ts 逐语义一致（移植源：Skill-Manager
 * src/shared/frontmatter.ts，DevHub 双端各持一份等价实现，companion 由 esbuild
 * 打成单文件随包分发，不能 import 主进程 TS 模块）。
 */

export function parseFrontmatter(mdText) {
  const text = String(mdText ?? '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i >= lines.length || lines[i].trim() !== '---') return {}
  i++
  const out = {}
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') return out
    const m = line.match(/^(name|description)[ \t]*:[ \t]*(.*)$/)
    if (m === null) continue
    const key = m[1]
    if (out[key] !== undefined) continue
    const raw = m[2].trim()
    if (/^[|>][+-]?$/.test(raw)) {
      const { text: block, next } = collectBlockScalar(lines, i + 1, raw)
      i = next - 1
      if (block) out[key] = stripQuotes(block)
    } else {
      const v = stripQuotes(stripTrailingComment(raw))
      if (v) out[key] = v
    }
  }
  return {}
}

function stripQuotes(v) {
  if (v.length >= 2) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return v.slice(1, -1)
  }
  return v
}

function stripTrailingComment(v) {
  const hash = v.indexOf(' #')
  return (hash >= 0 ? v.slice(0, hash) : v).trim()
}

function collectBlockScalar(lines, start, indicator) {
  const folded = indicator[0] === '>'
  const parts = []
  let j = start
  for (; j < lines.length; j++) {
    const l = lines[j]
    if (l.trim() === '---') break
    if (l.trim() === '') {
      parts.push('')
      continue
    }
    if (/^[ \t]/.test(l)) {
      parts.push(l.trim())
      continue
    }
    break
  }
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  let text = ''
  for (let k = 0; k < parts.length; k++) {
    if (k > 0) text += folded ? (parts[k] === '' || parts[k - 1] === '' ? '\n' : ' ') : '\n'
    text += parts[k]
  }
  return { text: text.trim(), next: j }
}
