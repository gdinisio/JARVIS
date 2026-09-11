/**
 * Generates the application and tray icons as real PNG files.
 *
 * Written by hand with zlib rather than pulled from a dependency so the build
 * has no image toolchain: the JARVIS mark is a set of concentric arcs around a
 * crimson core, drawn into an RGBA buffer and encoded below.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'resources')
mkdirSync(out, { recursive: true })

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([length, typeBuf, data, crc])
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Soft-edged ring mask: 1 inside the band, falling off over ~1.5px. */
function ring(distance, radius, width, feather = 1.6) {
  const edge = Math.abs(distance - radius)
  if (edge <= width / 2) return 1
  return Math.max(0, 1 - (edge - width / 2) / feather)
}

function draw(size, { mono = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4, 0)
  const centre = (size - 1) / 2
  const unit = size / 64

  const put = (x, y, r, g, b, a) => {
    if (a <= 0) return
    const i = (y * size + x) * 4
    const existing = rgba[i + 3] / 255
    const alpha = Math.min(1, a + existing * (1 - a))
    rgba[i] = Math.round((r * a + rgba[i] * existing * (1 - a)) / (alpha || 1))
    rgba[i + 1] = Math.round((g * a + rgba[i + 1] * existing * (1 - a)) / (alpha || 1))
    rgba[i + 2] = Math.round((b * a + rgba[i + 2] * existing * (1 - a)) / (alpha || 1))
    rgba[i + 3] = Math.round(alpha * 255)
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centre
      const dy = y - centre
      const distance = Math.hypot(dx, dy)
      const angle = Math.atan2(dy, dx)

      // Outer ring, broken into four arcs.
      const segment = ((angle + Math.PI * 2) % (Math.PI / 2)) / (Math.PI / 2)
      const outerGap = segment > 0.86 ? 0 : 1
      let alpha = ring(distance, 27 * unit, 2.2 * unit) * outerGap * 0.95

      // Inner ring.
      alpha = Math.max(alpha, ring(distance, 19 * unit, 1.5 * unit) * 0.8)

      // Core: a saturated centre falling to the deeper crimson of the rings.
      let coreMix = 0
      if (distance < 11 * unit) {
        const falloff = Math.max(0, 1 - distance / (11 * unit))
        coreMix = Math.pow(falloff, 0.7)
        alpha = Math.max(alpha, 0.62 + coreMix * 0.38)
      }

      if (alpha <= 0.01) continue
      if (mono) {
        put(x, y, 255, 255, 255, Math.min(1, alpha))
      } else if (coreMix > 0) {
        put(
          x, y,
          Math.round(200 + coreMix * 55),
          Math.round(16 + coreMix * 90),
          Math.round(46 + coreMix * 74),
          Math.min(1, alpha)
        )
      } else {
        put(x, y, 224, 31, 61, Math.min(1, alpha))
      }
    }
  }
  return rgba
}

writeFileSync(join(out, 'icon.png'), png(512, 512, draw(512)))
writeFileSync(join(out, 'trayTemplate.png'), png(32, 32, draw(32, { mono: true })))
writeFileSync(join(out, 'tray.png'), png(32, 32, draw(32)))
console.log('icons written to resources/')
