/**
 * pdfService.ts — ContestPin 本地 PDF/图片预处理（CP3b 批次，任务书 §2.2）。
 *
 * - electron-free 纯 Node 模块；两个外部依赖均为**动态 import**（main 构建
 *   externalizeDepsPlugin 外置，运行期从 node_modules 解析）：
 *     · pdfjs-dist（legacy build，纯 JS）—— 每页文本 + 注释超链接（URI）提取；
 *     · @napi-rs/canvas（预编译原生二进制）—— PDF 页渲染 JPEG data URL（视觉
 *       阶段扫描件路径）+ 大图等比缩放。
 * - **依赖裁决（worktree 内实测，Node 24.15 / win32 x64）**：pdfjs-dist
 *   6.3.289 文本+链接往返通过；@napi-rs/canvas 1.0.9 页渲染 JPEG 通过。
 *   任一依赖加载/调用失败走**结构化降级**，绝不抛裸异常拖垮管线：
 *     · 页转图不可用 → isPageRenderAvailable()=false；扫描 PDF（无本地文字）
 *       的视觉阶段由 importPipeline 记 error_json PAGE_RENDER_UNAVAILABLE
 *       （已知限制，不阻塞其余材料/任务）；文字 PDF 直接以本地提取文字进
 *       文本阶段（docs/22 §5 降级面）。
 *     · 图片缩放不可用 → 原样返回（>10MB 图片在 materialService 导入侧拒收）。
 * - **测试钩子**：setPageRenderAvailabilityOverride(false) 供 smoke 断言降级
 *   路径（不触达真实依赖可用性）；传 null 恢复实测。
 * - 零网络：pdfjs/canvas 全程本地；本模块绝不发起任何出站请求。
 */

import { ServiceError } from '../internal.ts'

// ---------------------------------------------------------------------------
// pdfjs-dist 最小结构类型（legacy build 的 .d.mts 覆盖不全，这里只声明本模块
// 用到的面；真实形状以运行期为准，绝不猜测超出用面的行为）
// ---------------------------------------------------------------------------

interface PdfjsTextItem {
  str?: string
  hasEOL?: boolean
}

interface PdfjsAnnotation {
  subtype?: string
  url?: string
  unsafeUrl?: string
}

interface PdfjsViewport {
  width: number
  height: number
}

interface PdfjsPage {
  getViewport(params: { scale: number }): PdfjsViewport
  getTextContent(): Promise<{ items: PdfjsTextItem[] }>
  getAnnotations(params?: { intent?: string }): Promise<PdfjsAnnotation[]>
  render(params: { canvasContext: unknown; viewport: PdfjsViewport; canvas?: unknown }): { promise: Promise<void> }
}

interface PdfjsDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfjsPage>
}

interface PdfjsModule {
  getDocument(params: { data: Uint8Array; useSystemFonts?: boolean; isEvalSupported?: boolean }): {
    promise: Promise<PdfjsDocument>
  }
  version: string
}

/** @napi-rs/canvas 本模块用到的最小面。 */
interface CanvasModule {
  createCanvas(width: number, height: number): {
    width: number
    height: number
    getContext(kind: '2d'): {
      fillStyle: string
      fillRect(x: number, y: number, w: number, h: number): void
      drawImage(img: unknown, dx: number, dy: number, dw: number, dh: number): void
    }
    toBuffer(fmt: 'image/jpeg', quality?: number): Buffer
  }
  loadImage(src: Buffer): Promise<{ width: number; height: number }>
}

async function loadPdfjs(): Promise<PdfjsModule> {
  const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsModule
  if (typeof mod?.getDocument !== 'function') {
    throw new Error('pdfjs-dist legacy build missing getDocument')
  }
  return mod
}

let canvasModulePromise: Promise<CanvasModule> | null = null

/** 惰性加载 @napi-rs/canvas；加载失败（缺二进制/平台不符）返回 null 走降级。 */
async function loadCanvas(): Promise<CanvasModule | null> {
  if (canvasModulePromise === null) {
    canvasModulePromise = (async () =>
      (await import('@napi-rs/canvas')) as unknown as CanvasModule)().catch(() => {
      canvasModulePromise = null
      return null as unknown as CanvasModule
    })
  }
  try {
    const mod = await canvasModulePromise
    return mod ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 页转图可用性（实测 + 测试 override）
// ---------------------------------------------------------------------------

let renderOverride: boolean | null = null
let renderProbeResult: boolean | null = null

/**
 * smoke 用降级路径注入：false = 强制视为不可用；null = 清除 override 回实测
 * （同时重置 memo，下一次探测重新实测——否则 override 会经 memo 泄漏到后续
 * 生产路径）。绝不在生产路径调用（生产永远实测）。
 */
export function setPageRenderAvailabilityOverride(available: boolean | null): void {
  renderOverride = available
  if (available !== null) renderProbeResult = available
  else renderProbeResult = null
}

/** canvas 可用性探测（模块加载 + createCanvas 冒烟）；结果 memo，override 优先。 */
export async function isPageRenderAvailable(): Promise<boolean> {
  if (renderOverride !== null) return renderOverride
  if (renderProbeResult !== null) return renderProbeResult
  const canvas = await loadCanvas()
  if (canvas === null || typeof canvas.createCanvas !== 'function') {
    renderProbeResult = false
    return false
  }
  try {
    const probe = canvas.createCanvas(1, 1)
    renderProbeResult = probe.getContext('2d') !== undefined
  } catch {
    renderProbeResult = false
  }
  return renderProbeResult
}

// ---------------------------------------------------------------------------
// PDF 文本 + 超链接提取
// ---------------------------------------------------------------------------

export interface PdfExtractedLink {
  /** 注释 URI 原文（绝对/相对均原样；形状校验归管线校验阶段）。 */
  uri: string
  page: number
}

export interface PdfPageText {
  page: number
  text: string
  links: PdfExtractedLink[]
}

export interface PdfExtractResult {
  /** 真实总页数（doc.numPages）。 */
  pageCount: number
  /** maxPages 截断标记（pageCount > 实际提取页数）。 */
  truncatedByLimit: boolean
  pages: PdfPageText[]
}

/** 行内空白压平（文本行拼接产物），保留换行结构。 */
function normalizePageText(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && idx < arr.length - 1))
    .join('\n')
    .trim()
}

/**
 * 提取 PDF 每页文本 + 注释超链接。maxPages 缺省不限（调用方传 materialService
 * 的页上限）；超限只提取前 maxPages 页并置 truncatedByLimit（绝不解析越限内容）。
 * 非法 PDF → ServiceError('BAD_PAYLOAD')（损坏文件在导入/预处理期结构化拒绝）。
 */
export async function extractPdfContent(data: Buffer, opts: { maxPages?: number } = {}): Promise<PdfExtractResult> {
  const pdfjs = await loadPdfjs().catch(() => null)
  if (pdfjs === null) {
    throw new ServiceError('INTERNAL', 'pdfjs-dist 加载失败（依赖缺失），无法本地提取 PDF 文本')
  }
  let doc: PdfjsDocument
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, isEvalSupported: false }).promise
  } catch (err) {
    throw new ServiceError('BAD_PAYLOAD', `PDF 解析失败（文件损坏或非 PDF）：${err instanceof Error ? err.message : String(err)}`)
  }
  const pageCount = doc.numPages
  const maxPages = opts.maxPages !== undefined && Number.isSafeInteger(opts.maxPages) && opts.maxPages > 0 ? opts.maxPages : pageCount
  const pageLimit = Math.min(pageCount, maxPages)
  const pages: PdfPageText[] = []
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
    const page = await doc.getPage(pageNumber)
    const content = await page.getTextContent()
    let raw = ''
    for (const item of content.items) {
      if (typeof item.str === 'string') raw += item.str
      if (item.hasEOL === true) raw += '\n'
      else if (typeof item.str === 'string' && item.str.length > 0 && !item.str.endsWith(' ')) raw += ' '
    }
    const annotations = await page.getAnnotations({ intent: 'display' })
    const links: PdfExtractedLink[] = []
    for (const annotation of annotations) {
      if (annotation.subtype !== 'Link') continue
      const uri = typeof annotation.url === 'string' && annotation.url.length > 0 ? annotation.url : (annotation.unsafeUrl ?? '')
      if (uri.length === 0) continue
      links.push({ uri, page: pageNumber })
    }
    pages.push({ page: pageNumber, text: normalizePageText(raw), links })
  }
  return { pageCount, truncatedByLimit: pageCount > pageLimit, pages }
}

// ---------------------------------------------------------------------------
// PDF 页 → JPEG data URL（视觉阶段扫描件路径）
// ---------------------------------------------------------------------------

const PAGE_RENDER_MAX_DIM = 2048
const PAGE_RENDER_JPEG_QUALITY = 80

/**
 * 渲染指定页为 JPEG data URL（等比，最长边 ≤2048px）。canvas 不可用 →
 * ServiceError('PAGE_RENDER_UNAVAILABLE')（importPipeline 捕获落 error_json，
 * 文字 PDF 走本地文本降级面——见文件头）。
 */
export async function renderPdfPageToJpegDataUrl(
  data: Buffer,
  pageNumber: number,
  opts: { scale?: number } = {},
): Promise<string> {
  const canvas = await isPageRenderAvailable().then(async (ok) => (ok ? loadCanvas() : null))
  if (canvas === null) {
    throw new ServiceError('PAGE_RENDER_UNAVAILABLE', 'PDF 页转图依赖（@napi-rs/canvas）不可用，扫描件视觉识别降级为已知限制')
  }
  const pdfjs = await loadPdfjs().catch(() => null)
  if (pdfjs === null) {
    throw new ServiceError('PAGE_RENDER_UNAVAILABLE', 'pdfjs-dist 加载失败，PDF 页转图不可用')
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, isEvalSupported: false }).promise
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new ServiceError('BAD_PAYLOAD', `PDF 页码越界：${pageNumber}（1..${doc.numPages}）`)
  }
  const page = await doc.getPage(pageNumber)
  const scale = opts.scale ?? 1.5
  const viewport = page.getViewport({ scale })
  let width = Math.max(1, Math.round(viewport.width))
  let height = Math.max(1, Math.round(viewport.height))
  const longest = Math.max(width, height)
  if (longest > PAGE_RENDER_MAX_DIM) {
    const shrink = PAGE_RENDER_MAX_DIM / longest
    width = Math.max(1, Math.round(width * shrink))
    height = Math.max(1, Math.round(height * shrink))
  }
  const canv = canvas.createCanvas(width, height)
  const ctx = canv.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  await page.render({ canvasContext: ctx, viewport, canvas: canv }).promise
  const jpeg = canv.toBuffer('image/jpeg', PAGE_RENDER_JPEG_QUALITY)
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

// ---------------------------------------------------------------------------
// 图片材料：尺寸读取 / 等比缩放（>2048px）/ data URL 组装
// ---------------------------------------------------------------------------

export interface PreparedImage {
  dataUrl: string
  width: number | null
  height: number | null
  scaled: boolean
}

/** 图片魔数嗅探（buffer 导入的 kind 判定 + 扩展名缺失兜底）。 */
export function sniffImageMime(data: Buffer): string | null {
  if (data.length < 12) return null
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.subarray(0, 6).toString('latin1') === 'GIF89a' || data.subarray(0, 6).toString('latin1') === 'GIF87a') return 'image/gif'
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp'
  return null
}

/**
 * 图片 → data URL：>maxDim（缺省 2048px）且 canvas 可用时等比缩放；缩放不可用
 * 原样返回（超 10MB 的图片在导入侧已拒收，此处不再拒）。非图片 buffer →
 * ServiceError('BAD_PAYLOAD')。
 */
export async function prepareImageDataUrl(data: Buffer, mime: string, opts: { maxDim?: number } = {}): Promise<PreparedImage> {
  if (sniffImageMime(data) === null && mime !== 'image/png' && mime !== 'image/jpeg') {
    throw new ServiceError('BAD_PAYLOAD', '图片材料内容非法（魔数嗅探非 PNG/JPEG/GIF/WebP/BMP）')
  }
  const canvas = await loadCanvas()
  const maxDim = opts.maxDim ?? PAGE_RENDER_MAX_DIM
  if (canvas === null) {
    return { dataUrl: `data:${mime};base64,${data.toString('base64')}`, width: null, height: null, scaled: false }
  }
  let image: { width: number; height: number }
  try {
    image = await canvas.loadImage(data)
  } catch {
    // 解码失败（坏图）→ 原样返回由服务端视觉阶段报错，本地不阻塞
    return { dataUrl: `data:${mime};base64,${data.toString('base64')}`, width: null, height: null, scaled: false }
  }
  const longest = Math.max(image.width, image.height)
  if (longest <= maxDim) {
    return { dataUrl: `data:${mime};base64,${data.toString('base64')}`, width: image.width, height: image.height, scaled: false }
  }
  const shrink = maxDim / longest
  const width = Math.max(1, Math.round(image.width * shrink))
  const height = Math.max(1, Math.round(image.height * shrink))
  const canv = canvas.createCanvas(width, height)
  const ctx = canv.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)
  const jpeg = canv.toBuffer('image/jpeg', PAGE_RENDER_JPEG_QUALITY)
  return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width, height, scaled: true }
}
