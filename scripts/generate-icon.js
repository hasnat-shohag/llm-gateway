'use strict'
/**
 * Generates build-resources/icon.png — the app icon electron-builder feeds to
 * every Linux target (it derives the smaller sizes itself from a 1024px source).
 *
 * Hand-rolled rather than pulled from a drawing library: the icon is three dots
 * and three lines, and a generator keeps the repo free of an opaque binary blob
 * nobody can edit. Shapes are signed-distance functions sampled 3x3 per pixel,
 * which is what gives the edges their antialiasing.
 */
const { deflateSync } = require('node:zlib')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const SIZE = 1024
const SAMPLES = 3

const BG = [0x14, 0x18, 0x21]
const ACCENT = [0x6a, 0xd0, 0xa8]
const SPOKE = [0x3f, 0x8d, 0x76]

// --- signed distance functions (negative = inside) ---------------------------

function roundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius)
  const dy = Math.abs(y - cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

function circle(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) - radius
}

/** Capsule: a segment thickened by `radius`, so the line caps are round. */
function segment(x, y, ax, ay, bx, by, radius) {
  const vx = bx - ax
  const vy = by - ay
  const len2 = vx * vx + vy * vy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2))
  return Math.hypot(x - (ax + vx * t), y - (ay + vy * t)) - radius
}

// --- scene -------------------------------------------------------------------

const HUB = { x: SIZE * 0.3, y: SIZE * 0.5, r: SIZE * 0.085 }
const NODES = [0.28, 0.5, 0.72].map((fraction) => ({
  x: SIZE * 0.735,
  y: SIZE * fraction,
  r: SIZE * 0.058,
}))
const SPOKE_WIDTH = SIZE * 0.022

/** Coverage of the plate, the spokes and the dots at one sample point. */
function sample(x, y) {
  const plate = roundedRect(x, y, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, SIZE * 0.2)
  if (plate > 0) return null

  let dots = circle(x, y, HUB.x, HUB.y, HUB.r)
  let spokes = Infinity
  for (const node of NODES) {
    dots = Math.min(dots, circle(x, y, node.x, node.y, node.r))
    spokes = Math.min(spokes, segment(x, y, HUB.x, HUB.y, node.x, node.y, SPOKE_WIDTH))
  }

  if (dots <= 0) return ACCENT
  if (spokes <= 0) return SPOKE
  return BG
}

function render() {
  // One filter byte (0 = None) then RGBA per pixel, per PNG scanline layout.
  const stride = SIZE * 4 + 1
  const raw = Buffer.alloc(stride * SIZE)
  const step = 1 / SAMPLES
  const perPixel = SAMPLES * SAMPLES

  for (let py = 0; py < SIZE; py++) {
    const rowStart = py * stride
    raw[rowStart] = 0
    for (let px = 0; px < SIZE; px++) {
      let r = 0
      let g = 0
      let b = 0
      let hits = 0

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = sample(px + (sx + 0.5) * step, py + (sy + 0.5) * step)
          if (!color) continue
          r += color[0]
          g += color[1]
          b += color[2]
          hits++
        }
      }

      const offset = rowStart + 1 + px * 4
      if (hits === 0) continue // fully outside the plate: leave it transparent
      // Premultiplication is not wanted here; average the covered samples only and
      // let alpha carry the plate's edge coverage.
      raw[offset] = Math.round(r / hits)
      raw[offset + 1] = Math.round(g / hits)
      raw[offset + 2] = Math.round(b / hits)
      raw[offset + 3] = Math.round((hits / perPixel) * 255)
    }
  }

  return raw
}

// --- PNG container -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

function png(raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const outDir = join(__dirname, '..', 'build-resources')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'icon.png')
writeFileSync(outPath, png(render()))
console.log(`[generate-icon] wrote ${outPath} (${SIZE}x${SIZE})`)
