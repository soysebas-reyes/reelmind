// SPDX-License-Identifier: GPL-3.0-or-later
// Generates build/icon.ico + build/icon.icns (+ build/icon.png reference) from Reelo, the 8-bit
// clapperboard mascot (src/renderer/src/ui/Reelo.tsx), with zero dependencies: the pixel grid is
// rendered per size (nearest-neighbor for >=32px, a simplified glyph for 16/24px), PNG-encoded by
// hand (node:zlib deflate + CRC32) and packed into a PNG-in-ICO container (Windows Vista+) and a
// PNG-in-ICNS container (macOS). The mac variant floats a rounded tile on a transparent margin
// (Big Sur convention); Windows keeps the full-bleed tile.
// Run once (node scripts/make-icon.mjs) and commit the output; electron-builder picks these up via
// win.icon / mac.icon in electron-builder.yml.

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')

// ── Palette (mirror of Reelo.tsx) ──────────────────────────────────────────────────────────────
const C = {
  1: '#2f2f37', // slate body
  2: '#191920', // slate shadow / outline
  3: '#f3f2ee', // chalk
  5: '#ff453a', // rec red
  6: '#0a0a0c', // pupil
  9: '#3a3a44' // slate light edge
}
const BG = '#15151a' // app canvas color (BrowserWindow backgroundColor) — brand-consistent tile

function rgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

// ── Mascot grid (static pose: REC on, clap closed — reads as a clapperboard at a glance) ───────
const GW = 22
const GH = 24
const CLAP = 0

function buildMascotGrid() {
  const g = Array.from({ length: GH }, () => new Array(GW).fill(0))
  const px = (x, y, c) => {
    if (x >= 0 && x < GW && y >= 0 && y < GH && c) g[y][x] = c
  }
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(x, y, c)
  }

  // feet
  rect(6, 21, 8, 22, 2)
  rect(13, 21, 15, 22, 2)
  // body slate + light top edge + outline
  rect(4, 6, 17, 20, 1)
  rect(4, 6, 17, 6, 9)
  for (let x = 4; x <= 17; x++) px(x, 20, 2)
  for (let y = 6; y <= 20; y++) {
    px(4, y, 2)
    px(17, y, 2)
  }
  // chalk "scale" baseline with tick marks
  for (let x = 5; x <= 16; x++) px(x, 18, 3)
  for (let x = 5; x <= 16; x += 2) px(x, 17, 3)
  // REC dot
  rect(14, 8, 15, 9, 5)
  // eyes: chalk whites + pupil (straight gaze)
  const eye = (ex, ey) => {
    rect(ex, ey, ex + 2, ey + 2, 3)
    px(ex + 1, ey + 1, 6)
  }
  eye(6, 9)
  eye(12, 9)
  // mouth (flat pose — the animated smile reads as loose dots when frozen)
  rect(9, 15, 12, 15, 3)
  // clap stick: hinged at left, sheared up on the right
  for (let x = 3; x <= 19; x++) {
    const t = (x - 3) / (19 - 3)
    const lift = Math.round(CLAP * t * 6)
    for (let y = 3; y <= 5; y++) {
      // Chalk over light slate (not shadow): the dark stripes vanish against the dark tile bg.
      const stripe = (x + y) % 4 < 2 ? 3 : 9
      px(x, y - lift, stripe)
    }
    if (lift > 0) px(x, 6, 2)
  }
  px(3, 4, 9)
  px(3, 5, 9)
  return g
}

const MASCOT = buildMascotGrid()
// Logical square canvas the mascot floats in (centers it with even margins).
const L = 26
const OFF_X = 2
const OFF_Y = 1

// ── Rasterizers ────────────────────────────────────────────────────────────────────────────────
/** Rounded-tile alpha with cheap edge smoothing. */
function tileAlpha(i, j, S, radius) {
  const r = radius ?? Math.max(2, Math.round(S * 0.19))
  const cx = i + 0.5
  const cy = j + 0.5
  let dx = 0
  let dy = 0
  if (cx < r) dx = r - cx
  else if (cx > S - r) dx = cx - (S - r)
  if (cy < r) dy = r - cy
  else if (cy > S - r) dy = cy - (S - r)
  if (!dx && !dy) return 255
  const d = Math.sqrt(dx * dx + dy * dy)
  return Math.max(0, Math.min(1, r - d + 0.5)) * 255
}

/** Full mascot, nearest-neighbor sampled from the logical grid (sizes >= 32). */
function drawFull(S) {
  const buf = Buffer.alloc(S * S * 4)
  const bg = rgb(BG)
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const a = tileAlpha(i, j, S)
      const gx = Math.floor((i * L) / S) - OFF_X
      const gy = Math.floor((j * L) / S) - OFF_Y
      const c = gx >= 0 && gx < GW && gy >= 0 && gy < GH ? MASCOT[gy][gx] : 0
      const [r, g, b] = c ? rgb(C[c]) : bg
      const o = (j * S + i) * 4
      buf[o] = r
      buf[o + 1] = g
      buf[o + 2] = b
      buf[o + 3] = Math.round(a)
    }
  }
  return buf
}

/** macOS variant: the tile floats on a transparent ~10% margin with Big Sur-ish corner rounding
 *  (~22% of the tile), so the icon sits at the same visual size as its Dock neighbors. */
function drawMacTile(S) {
  const buf = Buffer.alloc(S * S * 4) // transparent canvas
  const bg = rgb(BG)
  const margin = Math.round(S * 0.1)
  const T = S - margin * 2
  const radius = Math.max(2, Math.round(T * 0.22))
  for (let j = 0; j < T; j++) {
    for (let i = 0; i < T; i++) {
      const a = tileAlpha(i, j, T, radius)
      if (a <= 0) continue
      const gx = Math.floor((i * L) / T) - OFF_X
      const gy = Math.floor((j * L) / T) - OFF_Y
      const c = gx >= 0 && gx < GW && gy >= 0 && gy < GH ? MASCOT[gy][gx] : 0
      const [r, g, b] = c ? rgb(C[c]) : bg
      const o = ((j + margin) * S + (i + margin)) * 4
      buf[o] = r
      buf[o + 1] = g
      buf[o + 2] = b
      buf[o + 3] = Math.round(a)
    }
  }
  return buf
}

/** Simplified clapperboard glyph for tiny sizes (16/24): stripes + body + eyes read at a glance. */
function drawSimple(S) {
  const buf = Buffer.alloc(S * S * 4)
  const put = (i, j, hex) => {
    if (i < 0 || j < 0 || i >= S || j >= S) return
    const a = tileAlpha(i, j, S)
    if (a <= 0) return
    const [r, g, b] = rgb(hex)
    const o = (j * S + i) * 4
    buf[o] = r
    buf[o + 1] = g
    buf[o + 2] = b
    buf[o + 3] = Math.round(a)
  }
  const fill = (x0, y0, x1, y1, hex) => {
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) put(i, j, hex)
  }
  // tile
  fill(0, 0, S - 1, S - 1, BG)
  const pad = Math.max(1, Math.round(S * 0.09))
  // clap stick with diagonal stripes
  const stickTop = Math.round(S * 0.12)
  const stickBot = Math.round(S * 0.3)
  const stripe = Math.max(2, Math.round(S * 0.14))
  for (let j = stickTop; j <= stickBot; j++) {
    for (let i = pad; i <= S - pad - 1; i++) {
      put(i, j, Math.floor((i + j) / stripe) % 2 === 0 ? C[3] : C[2])
    }
  }
  // body
  const bodyTop = Math.round(S * 0.38)
  const bodyBot = S - pad - 1
  fill(pad, bodyTop, S - pad - 1, bodyBot, C[1])
  // eyes
  const eyeW = Math.max(2, Math.round(S * 0.17))
  const eyeY = bodyTop + Math.max(1, Math.round(S * 0.1))
  const inner = S - 2 * pad
  const e1 = pad + Math.round(inner * 0.18)
  const e2 = S - pad - Math.round(inner * 0.18) - eyeW
  fill(e1, eyeY, e1 + eyeW - 1, eyeY + eyeW - 1, C[3])
  fill(e2, eyeY, e2 + eyeW - 1, eyeY + eyeW - 1, C[3])
  if (eyeW >= 3) {
    put(e1 + (eyeW >> 1), eyeY + (eyeW >> 1), C[6])
    put(e2 + (eyeW >> 1), eyeY + (eyeW >> 1), C[6])
  }
  // mouth
  const mouthY = eyeY + eyeW + Math.max(1, Math.round(S * 0.08))
  const mouthW = Math.max(2, Math.round(S * 0.2))
  const mx = Math.round(S / 2 - mouthW / 2)
  fill(mx, mouthY, mx + mouthW - 1, mouthY, C[3])
  return buf
}

// ── PNG encoder (RGBA, 8-bit, no filter) ───────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, S) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0)
  ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(S * (S * 4 + 1))
  for (let j = 0; j < S; j++) {
    raw[j * (S * 4 + 1)] = 0
    rgba.copy(raw, j * (S * 4 + 1) + 1, j * S * 4, (j + 1) * S * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ── ICO container (PNG entries) ────────────────────────────────────────────────────────────────
function packIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dirs = []
  const blobs = []
  let offset = 6 + entries.length * 16
  for (const { size, png } of entries) {
    const d = Buffer.alloc(16)
    d[0] = size >= 256 ? 0 : size
    d[1] = size >= 256 ? 0 : size
    d[2] = 0 // palette
    d[3] = 0 // reserved
    d.writeUInt16LE(1, 4) // planes
    d.writeUInt16LE(32, 6) // bpp
    d.writeUInt32LE(png.length, 8)
    d.writeUInt32LE(offset, 12)
    dirs.push(d)
    blobs.push(png)
    offset += png.length
  }
  return Buffer.concat([header, ...dirs, ...blobs])
}

// ── ICNS container (PNG entries) ───────────────────────────────────────────────────────────────
// Layout: magic "icns" + total length (u32BE), then chunks of [OSType (4 ascii)][length incl. this
// 8-byte header (u32BE)][raw PNG]. PNG payloads are valid for the ic* types since 10.7.
const ICNS_TYPES = [
  ['ic11', 32], // 16pt@2x
  ['ic12', 64], // 32pt@2x
  ['ic07', 128],
  ['ic13', 256], // 128pt@2x
  ['ic08', 256],
  ['ic14', 512], // 256pt@2x
  ['ic09', 512],
  ['ic10', 1024] // 512pt@2x
]

function packIcns(chunks) {
  const bodies = chunks.map(({ type, png }) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'ascii')
    h.writeUInt32BE(8 + png.length, 4)
    return Buffer.concat([h, png])
  })
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(8 + bodies.reduce((n, b) => n + b.length, 0), 4)
  return Buffer.concat([header, ...bodies])
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const entries = SIZES.map((size) => ({
  size,
  png: encodePng(size < 32 ? drawSimple(size) : drawFull(size), size)
}))

const macPngBySize = new Map()
for (const [, size] of ICNS_TYPES) {
  if (!macPngBySize.has(size)) macPngBySize.set(size, encodePng(drawMacTile(size), size))
}
const icnsChunks = ICNS_TYPES.map(([type, size]) => ({ type, png: macPngBySize.get(size) }))

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'icon.ico'), packIco(entries))
writeFileSync(join(outDir, 'icon.icns'), packIcns(icnsChunks))
// 1024px reference/fallback (electron-builder can derive platform icons from a >=512px png).
writeFileSync(join(outDir, 'icon.png'), encodePng(drawFull(1024), 1024))
console.log(
  `[make-icon] build/icon.ico (${SIZES.join(', ')} px) + build/icon.icns (${[...macPngBySize.keys()].join(', ')} px) + build/icon.png (1024) listos`
)
