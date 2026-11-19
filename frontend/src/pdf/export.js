// Drawing objects -> PDF, in the browser, with pdf-lib (MIT).
//
// Takes the same object list extractDocument() produces (l / c / fp / img /
// mbox), usually after the edit tools ran, and writes one PDF page with
// everything the source had (vectors, text outlines, images), just corrected.
import { PDFDocument } from 'pdf-lib'
import { MM_PER_PT } from './extract.js'

// Default stroke width for cut/engrave lines (the extraction does not keep the
// original widths). Thin so the geometry stays faithful.
const STROKE_WIDTH_PT = 0.5

const f = (v) => {
  const s = (Math.round(v * 10000) / 10000).toString()
  return s === '-0' ? '0' : s
}
const rgb = (hex) => {
  const c = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#000000'
  return [1, 3, 5].map((i) => f(parseInt(c.slice(i, i + 2), 16) / 255)).join(' ')
}

function base64ToBytes(b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** @returns {Promise<Uint8Array>} the PDF file */
export async function buildPdf(objects) {
  // Page size from the mbox entry (mm -> pt); A4 if absent.
  let W = 595, H = 842
  const mbox = objects.find((o) => o.type === 'mbox')
  if (mbox) { W = mbox.w / MM_PER_PT; H = mbox.h / MM_PER_PT }

  // viewer mm (origin top-left, y negative downward) -> PDF user space
  // (origin bottom-left, y up)
  const X = (xmm) => f(xmm / MM_PER_PT)
  const Y = (ymm) => f(H + ymm / MM_PER_PT)

  const doc = await PDFDocument.create()
  const page = doc.addPage([W, H])
  const ops = []

  // Images first (background), then vector geometry on top.
  for (const o of objects) {
    if (o.type !== 'img' || !(o.data || '').includes(',')) continue
    try {
      const [head, b64] = o.data.split(',', 2)
      const bytes = base64ToBytes(b64)
      const image = /jpe?g/i.test(head) ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)
      const name = page.node.newXObject('Im', image.ref)
      const w = o.w / MM_PER_PT, h = o.h / MM_PER_PT
      ops.push(`q ${f(w)} 0 0 ${f(h)} ${X(o.x)} ${f(H + o.y / MM_PER_PT - h)} cm ${name.toString()} Do Q`)
    } catch (e) {
      console.warn('[save_pdf] image failed', e)
    }
  }

  // Consecutive strokes that share a pid (one source path, or one chain from
  // "Kurven verbinden") go out as ONE path object. Writing every piece as its
  // own path is exactly what makes a laser treat a smooth contour as thousands
  // of separate vectors.
  let group = null       // [pid, color] of the open stroke path
  let last = null        // current point, as formatted strings
  const flush = () => {
    if (group) ops.push('S Q')
    group = null
    last = null
  }

  for (const o of objects) {
    if (o.type === 'fp') {
      flush()
      const sub = []
      let cur = null
      for (const c of o.path || []) {
        if (c.cmd === 'M') {
          if (sub.length) sub.push('h')
          cur = [X(c.x), Y(c.y)]
          sub.push(`${cur[0]} ${cur[1]} m`)
        } else if (c.cmd === 'L' && cur) {
          cur = [X(c.x), Y(c.y)]; sub.push(`${cur[0]} ${cur[1]} l`)
        } else if (c.cmd === 'C' && cur) {
          cur = [X(c.x), Y(c.y)]
          sub.push(`${X(c.x1)} ${Y(c.y1)} ${X(c.x2)} ${Y(c.y2)} ${cur[0]} ${cur[1]} c`)
        }
      }
      // even-odd, so holes (letter counters) render regardless of winding
      if (sub.some((s) => s.endsWith(' l') || s.endsWith(' c'))) ops.push(`q ${rgb(o.fill)} rg`, ...sub, 'h f* Q')
    } else if (o.type === 'l' || o.type === 'c') {
      const key = [o.pid, o.color || '#000000']
      if (!group || key[0] == null || key[0] !== group[0] || key[1] !== group[1]) {
        flush()
        group = key
        ops.push(`q ${rgb(key[1])} RG ${f(STROKE_WIDTH_PT)} w`)
      }
      const start = [X(o.x1), Y(o.y1)]
      if (!last || last[0] !== start[0] || last[1] !== start[1]) ops.push(`${start[0]} ${start[1]} m`)
      if (o.type === 'l') {
        last = [X(o.x2), Y(o.y2)]
        ops.push(`${last[0]} ${last[1]} l`)
      } else {
        last = [X(o.x4), Y(o.y4)]
        ops.push(`${X(o.x2)} ${Y(o.y2)} ${X(o.x3)} ${Y(o.y3)} ${last[0]} ${last[1]} c`)
      }
    }
  }
  flush()

  page.node.addContentStream(doc.context.register(doc.context.flateStream(ops.join('\n'))))
  return doc.save()
}
