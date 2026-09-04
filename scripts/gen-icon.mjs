/**
 * gen-icon.mjs — 从 resources/tray@2x.png 生成 build/icon.ico（打包交付）。
 *
 * 零依赖：Node 内置 zlib 完成 PNG 解码/重编码；ICO 容器内嵌 PNG 载荷
 * （Vista+ 合法格式，Windows Terminal / VS Code 同款做法）。
 *
 * 源图为 64×64 RGBA PNG（resources/tray@2x.png，docs/12 §10 托盘图标 @2x）。
 * electron-builder 的 Windows icon 校验要求 ico 含 256×256 尺寸，因此导出
 * 256/64/32/16 四档（均为 64 的整数倍关系，最近邻缩放无插值残差）：
 *   - 256：NSIS 安装包 UI / 资源管理器大图标（electron-builder 硬性下限）；
 *   - 64 ：原生分辨率，任务栏/alt-tab；
 *   - 32/16：标题栏/小图标，整除采样保持边缘干净。
 *
 * 用法：node scripts/gen-icon.mjs（幂等，产物 build/icon.ico 不入库的
 * 前置目录按需创建；build/ 下产物入库以便免网络复现打包）。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'resources', 'tray@2x.png')
const OUT = join(ROOT, 'build', 'icon.ico')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32（PNG chunk 校验用，IEEE 多项式 0xEDB88320，表驱动）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * 解码 PNG（仅支持本项目源图形态：8-bit depth、colorType 6 RGBA、
 * non-interlaced；其余形态显式报错，不做隐式转换）。
 */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idatParts = []
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idatParts.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`unsupported PNG form: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`)
  }
  const raw = inflateSync(Buffer.concat(idatParts))
  const stride = width * 4
  const pixels = Buffer.alloc(height * stride)
  // unfilter（PNG spec §6：None/Sub/Up/Average/Paeth，bpp=4）
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const out = y * stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? pixels[out + x - 4] : 0 // left
      const b = y > 0 ? pixels[out - stride + x] : 0 // up
      const c = x >= 4 && y > 0 ? pixels[out - stride + x - 4] : 0 // up-left
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[out + x] = value & 0xff
    }
  }
  return { width, height, pixels }
}

/** PNG 编码（RGBA 8-bit，filter 0 逐行 + deflate；渲染端为 Windows GDI/NSIS，兼容）。 */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: None
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 最近邻缩放（源与目标为 RGBA；放大/缩小同一采样逻辑）。 */
function resize(img, target) {
  const out = Buffer.alloc(target * target * 4)
  for (let y = 0; y < target; y += 1) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / target))
    for (let x = 0; x < target; x += 1) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / target))
      const s = (sy * img.width + sx) * 4
      const d = (y * target + x) * 4
      out[d] = img.pixels[s]
      out[d + 1] = img.pixels[s + 1]
      out[d + 2] = img.pixels[s + 2]
      out[d + 3] = img.pixels[s + 3]
    }
  }
  return out
}

/** 组装 ICO：ICONDIR + 条目表 + 各尺寸 PNG 载荷（width 字节 256→0）。 */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  const payloads = []
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // palette count
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(entry)
    payloads.push(png)
  }
  return Buffer.concat([header, ...entries, ...payloads])
}

const source = decodePng(readFileSync(SRC))
if (source.width !== 64 || source.height !== 64) {
  throw new Error(`unexpected source size ${source.width}x${source.height} (expected 64x64)`)
}
const sizes = [256, 64, 32, 16]
const ico = buildIco(sizes.map((size) => ({ size, png: encodePng(size, size, resize(source, size)) })))
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, ico)
console.log(`icon written: ${OUT} (${ico.length} bytes, sizes=${sizes.join('/')})`)
