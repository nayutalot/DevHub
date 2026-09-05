/**
 * test/ws.test.mjs — WS 编解码单测（gateway/ws.ts 移植等价性）+ 16 帧 fixture round-trip。
 * 契约 fixture = test/fixtures/frames.json（docs/20 §5：三批对拍共用，防漂移）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RelayConnection, computeAcceptKey, WS_MAX_MESSAGE_BYTES } from '../src/ws.ts'
import { encodeClientFrame } from './helpers.mjs'

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'frames.json'), 'utf8'))

/** 捕获写的假 socket（feed 驱动；不经过真实传输）。 */
function fakeSocket() {
  return {
    chunks: [],
    destroyed: false,
    write(p) {
      this.chunks.push(Buffer.from(p))
      return true
    },
    destroy() {
      this.destroyed = true
    },
    on() {},
  }
}

function parseServerFrame(buf) {
  const opcode = buf[0] & 0x0f
  let length = buf[1] & 0x7f
  let offset = 2
  if (length === 126) {
    length = buf.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    length = Number(buf.readBigUInt64BE(offset))
    offset += 8
  }
  return { opcode, payload: buf.subarray(offset, offset + length), raw: buf.subarray(0, offset + length) }
}

/** 直接驱动 RelayConnection：返回 {conn, received, closeFrames}。 */
function makeConn({ heartbeatMs = 60000, pongMs = 5000 } = {}) {
  const received = []
  const socket = fakeSocket()
  const conn = new RelayConnection(
    { side: 'device', bare: true, remoteIp: '127.0.0.1' },
    socket,
    {
      onText: (c, text) => {
        received.push(JSON.parse(text))
      },
      onClosed: () => {},
    },
    heartbeatMs,
    pongMs,
  )
  return { conn, received, socket }
}

test('computeAcceptKey 符合 RFC 6455 示例向量', () => {
  assert.equal(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('掩码文本帧 round-trip（小/中/大载荷三档长度边界）', () => {
  for (const size of [10, 125, 126, 65535, 65536, 200000]) {
    const { conn, received } = makeConn()
    const text = JSON.stringify({ type: 'event', blob: 'x'.repeat(size) })
    conn.feed(encodeClientFrame(0x1, Buffer.from(text, 'utf8')))
    assert.equal(received.length, 1, `size=${size}`)
    assert.equal(received[0].blob.length, size)
  }
})

test('客户端帧未掩码 → close 1002（RFC 6455 §5.1 / ws.ts 纪律）', () => {
  const { conn, socket } = makeConn()
  const payload = Buffer.from(JSON.stringify({ type: 'hello' }), 'utf8')
  const unmasked = Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  conn.feed(unmasked)
  assert.equal(conn.closed, true)
  const closeFrame = parseServerFrame(Buffer.concat(socket.chunks))
  assert.equal(closeFrame.opcode, 0x8)
  assert.equal(closeFrame.payload.readUInt16BE(0), 1002)
})

test('RSV ≠ 0 → close 1002', () => {
  const { conn } = makeConn()
  const payload = Buffer.from('{}')
  const frame = Buffer.alloc(6 + payload.length)
  frame[0] = 0x81 | 0x40 // RSV1 置位
  frame[1] = 0x80 | payload.length
  cryptoMaskInto(frame, 2, payload)
  conn.feed(frame)
  assert.equal(conn.closed, true)
  assert.match(conn.debugCloseReason() ?? '', /protocol error/)
})

function cryptoMaskInto(buf, offset, payload) {
  const mask = Buffer.from([1, 2, 3, 4])
  mask.copy(buf, offset)
  for (let i = 0; i < payload.length; i += 1) {
    buf[offset + 4 + i] = payload[i] ^ mask[i % 4]
  }
}

test('二进制帧 → close 1003（JSON text only，docs/18 §1.3）', () => {
  const { conn } = makeConn()
  conn.feed(encodeClientFrame(0x2, Buffer.from([1, 2, 3])))
  assert.equal(conn.closed, true)
  assert.match(conn.debugCloseReason() ?? '', /1003|binary/)
})

test('超 1MB 帧 → close 1009', () => {
  const { conn } = makeConn()
  conn.feed(encodeClientFrame(0x1, Buffer.alloc(WS_MAX_MESSAGE_BYTES + 1, 0x61)))
  assert.equal(conn.closed, true)
  assert.match(conn.debugCloseReason() ?? '', /1MB/)
})

test('分片文本帧（FIN=0 + continuation FIN=1）→ 聚合后送达', () => {
  const { conn, received } = makeConn()
  const whole = Buffer.from('{"type":"pair","code":"A3K7M9XY"}', 'utf8')
  const mid = Math.floor(whole.length / 2)
  // 分片 1：FIN=0 opcode=1
  const f1 = encodeFragment(0x1, false, whole.subarray(0, mid))
  // 分片 2：FIN=1 opcode=0
  const f2 = encodeFragment(0x0, true, whole.subarray(mid))
  conn.feed(Buffer.concat([f1, f2]))
  assert.deepEqual(received, [{ type: 'pair', code: 'A3K7M9XY' }])
})

function encodeFragment(opcode, fin, payload) {
  const mask = Buffer.from([9, 9, 9, 9])
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
  const header = Buffer.alloc(6)
  header[0] = (fin ? 0x80 : 0x00) | opcode
  header[1] = 0x80 | payload.length
  mask.copy(header, 2)
  return Buffer.concat([header, masked])
}

test('ping → pong 回显；close → 回显 close 后断开', () => {
  const { conn, socket } = makeConn()
  conn.feed(encodeClientFrame(0x9, Buffer.from('ping123')))
  conn.feed(encodeClientFrame(0x8, (() => { const b = Buffer.alloc(2); b.writeUInt16BE(1000); return b })()))
  const frames = []
  let buf = Buffer.concat(socket.chunks)
  while (buf.length > 0) {
    const f = parseServerFrame(buf)
    frames.push(f)
    buf = buf.subarray(f.raw.length)
  }
  assert.equal(frames[0].opcode, 0xa) // pong
  assert.equal(frames[0].payload.toString('utf8'), 'ping123')
  assert.equal(frames[1].opcode, 0x8)
  assert.equal(frames[1].payload.readUInt16BE(0), 1000) // 回显客户端 code
})

test('未知 opcode → close 1002', () => {
  const { conn } = makeConn()
  conn.feed(encodeClientFrame(0x3, Buffer.from('x')))
  assert.equal(conn.closed, true)
  assert.match(conn.debugCloseReason() ?? '', /unknown opcode/)
})

test('16 帧 fixture 全样例 round-trip（帧一致性对拍基线，docs/20 §5）', () => {
  assert.equal(fixture.frames.length, 16, 'fixture 必须覆盖 16 帧')
  const types = new Set(fixture.frames.map((f) => f.type))
  for (const expected of ['hello', 'pair', 'pair_accepted', 'agent_list', 'session_list', 'event', 'message', 'command', 'command_ack', 'command_result', 'sync_request', 'sync_response', 'heartbeat', 'token_rotation', 'disconnect', 'error']) {
    assert.ok(types.has(expected), `缺帧: ${expected}`)
  }
  let sampleCount = 0
  for (const entry of fixture.frames) {
    assert.ok(entry.source && entry.source.includes('docs/18'), `帧 ${entry.no} ${entry.type} 缺 docs/18 出处标注`)
    for (const sample of entry.samples) {
      sampleCount += 1
      const { conn, received } = makeConn()
      conn.feed(encodeClientFrame(0x1, Buffer.from(JSON.stringify(sample.frame), 'utf8')))
      assert.equal(received.length, 1, `帧 ${entry.no} ${entry.type}[${sample.leg}] 解析失败`)
      assert.deepEqual(received[0], sample.frame, `帧 ${entry.no} ${entry.type}[${sample.leg}] round-trip 不一致`)
      assert.equal(received[0].type !== undefined, true)
    }
  }
  assert.ok(sampleCount >= 25, `fixture 样例数过少: ${sampleCount}`)
})

test('fixture hostControlFrames（register_pairing，docs/19 §4.5）round-trip', () => {
  for (const entry of fixture.hostControlFrames) {
    for (const sample of entry.samples) {
      const { conn, received } = makeConn()
      conn.feed(encodeClientFrame(0x1, Buffer.from(JSON.stringify(sample.frame), 'utf8')))
      assert.deepEqual(received, [sample.frame])
    }
  }
})
