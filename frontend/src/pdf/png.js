// Minimal PNG encoder (8 bit gray / RGB / RGBA), deflate via fflate (MIT).
// pdf.js hands images over as raw pixels; the rest of the app (viewer, ink
// analysis, PDF export) works with PNG data URIs, as before.
import { zlibSync } from 'fflate'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes, start, end) {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

/**
 * @param pixels   Uint8Array/Uint8ClampedArray, `channels` bytes per pixel, row-major
 * @param channels 1 (gray), 3 (RGB) or 4 (RGBA)
 * @returns Uint8Array PNG file
 */
export function encodePng(pixels, width, height, channels) {
  const colorType = { 1: 0, 3: 2, 4: 6 }[channels]
  if (colorType === undefined) throw new Error(`PNG: ${channels} channels not supported`)
  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)        // filter byte 0 per row
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width); dv.setUint32(4, height)
  ihdr[8] = 8; ihdr[9] = colorType
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

// Width/height/gray of a PNG or JPEG from its header - enough for SVG <image>
// placement (preserveAspectRatio) without decoding the picture.
export function imageInfo(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {                    // PNG
    const dv = new DataView(bytes.buffer, bytes.byteOffset)
    const ct = bytes[25]
    return { type: 'png', width: dv.getUint32(16), height: dv.getUint32(20), gray: ct === 0 || ct === 4,
             alpha: ct === 4 || ct === 6 }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {                    // JPEG: find SOFn
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue }
      const m = bytes[i + 1]
      const len = (bytes[i + 2] << 8) | bytes[i + 3]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { type: 'jpeg', height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8],
                 gray: bytes[i + 9] === 1 }
      }
      i += 2 + len
    }
    return { type: 'jpeg', width: 0, height: 0, gray: false }
  }
  return null
}
