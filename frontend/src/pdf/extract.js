// PDF/SVG -> drawing objects, entirely in the browser (mupdf.js = MuPDF as
// WebAssembly, the same engine PyMuPDF wraps). Port of the former backend
// module backend/api/api_pdf_extraction.py; the output format is unchanged:
//
//   { type: 'mbox', w, h }                         page size (mm)
//   { type: 'l', x1, y1, x2, y2, color, pid }      stroked line
//   { type: 'c', x1..y4, color, pid }              stroked cubic bezier
//   { type: 'fp', fill, path: [{cmd: M|L|C|Z ...}] } filled path (text too)
//   { type: 'img', x, y, w, h, alpha, colorspace, data } embedded bitmap
//
// Coordinates in mm, origin = TOP-LEFT of the page, x right, y DOWN NEGATIVE
// (Three.js y-up space). Objects inside a watermark text line carry wm: true.
//
// The module takes the mupdf namespace as a parameter so it runs unchanged in
// the web worker (pdfWorker.js) and in Node (docs/calib scripts).

import { parseSvg } from './svg.js'

export const MM_PER_PT = 25.4 / 72

const r3 = (v) => Math.round(v * 1000) / 1000
const nx = (x) => r3(x * MM_PER_PT)
const ny = (y) => r3(-y * MM_PER_PT)
const mm = (v) => r3(v * MM_PER_PT)

const tx = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

// Same as the old Python rgb_to_hex: components 0-1, truncated to 0-255.
function toHex(colorspace, color) {
  if (!color) return null
  const n = colorspace ? colorspace.getNumberOfComponents() : color.length
  let r, g, b
  if (n === 1) { r = g = b = color[0] }
  else if (n === 4) {          // CMYK, naive conversion (SVG round trip is RGB anyway)
    const [c, m, y, k] = color
    r = (1 - c) * (1 - k); g = (1 - m) * (1 - k); b = (1 - y) * (1 - k)
  } else { [r, g, b] = color }
  const h = (v) => Math.max(0, Math.min(255, Math.trunc(v * 255))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

// ── SVG style-conflict normalisation ─────────────────────────────────────────
// By the CSS cascade an inline style="stroke:..." wins over a stroke="..."
// attribute on the same element. MuPDF's SVG reader keeps the ATTRIBUTE. Editors
// like Inkscape write style= and often leave a stale attribute behind, which
// silently turned red engrave lines into blue cuts. Fix: overwrite the attribute
// with the style value wherever both exist. Works on the raw text (tag by tag),
// so it needs no DOM and also runs in a worker.
function normalizeSvgStyleConflicts(text) {
  let changed = 0
  const out = text.replace(/<([a-zA-Z][\w:.-]*)(\s[^<>]*?)(\/?)>/g, (all, tag, attrs, close) => {
    const sm = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/.exec(attrs)
    if (!sm) return all
    const decls = {}
    for (const d of (sm[2] ?? sm[3]).split(';')) {
      const i = d.indexOf(':')
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim()
    }
    let a = attrs
    for (const prop of ['stroke', 'fill']) {
      if (!(prop in decls)) continue
      const re = new RegExp(`(\\s${prop}\\s*=\\s*)("([^"]*)"|'([^']*)')`)
      const m = re.exec(a)
      const val = decls[prop].replace(/"/g, '&quot;')
      if (m) {
        if ((m[3] ?? m[4]) !== decls[prop]) { a = a.replace(re, `$1"${val}"`); changed++ }
      } else {
        a += ` ${prop}="${val}"`; changed++
      }
    }
    return `<${tag}${a}${close}>`
  })
  return changed ? out : text
}

// ── Watermarks ───────────────────────────────────────────────────────────────
// Box (mm) of every TEXT LINE that contains a watermark phrase - the whole line:
// "PRODUCED BY AN AUTODESK STUDENT VERSION" must go completely.
function watermarkBoxes(page, phrases) {
  const ps = (phrases || []).map((p) => (p || '').trim().toLowerCase()).filter(Boolean)
  if (!ps.length) return []
  const boxes = []
  try {
    const st = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON())
    for (const block of st.blocks || []) {
      for (const ln of block.lines || []) {
        const text = (ln.text || '').toLowerCase()
        const compact = text.replace(/ /g, '')
        if (!ps.some((p) => text.includes(p) || compact.includes(p.replace(/ /g, '')))) continue
        const { x, y, w, h } = ln.bbox
        const xs = [nx(x), nx(x + w)].sort((a, b) => a - b)
        const ys = [ny(y), ny(y + h)].sort((a, b) => a - b)
        boxes.push([xs[0] - 0.5, ys[0] - 0.5, xs[1] + 0.5, ys[1] + 0.5])
      }
    }
  } catch (e) {
    console.warn('[watermark] text scan failed', e)
  }
  return boxes
}

function objCenter(o) {
  if (o.type === 'l') return [(o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2]
  if (o.type === 'c') return [(o.x1 + o.x2 + o.x3 + o.x4) / 4, (o.y1 + o.y2 + o.y3 + o.y4) / 4]
  if (o.type === 'fp') {
    const xs = o.path.filter((c) => 'x' in c).map((c) => c.x)
    const ys = o.path.filter((c) => 'y' in c).map((c) => c.y)
    if (!xs.length) return null
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
  }
  return null
}

const inWatermark = (o, boxes) => {
  const c = objCenter(o)
  return !!c && boxes.some(([x0, y0, x1, y1]) => c[0] >= x0 && c[0] <= x1 && c[1] >= y0 && c[1] <= y1)
}

// Archicad educational exports carry an invisible white "GSEducationalVersion"
// (a watermark phrase) and a visible "ARCHICAD BILDUNGSVERSION" stamp that is a
// small transparent PNG. The image is only tagged when the marker text is on
// the same page.
const ARCHICAD_EDU_MARKER = 'GSEducationalVersion'

// ── Path geometry ────────────────────────────────────────────────────────────
// Walk a path with its transform applied. Sub-paths: arrays of segments
// ['l', [x0,y0], [x1,y1]] | ['c', p0, p1, p2, p3] in PDF points. closePath adds
// the closing line when the end is not already at the start (as get_drawings).
function walkSubpaths(path, ctm) {
  const subs = []
  let cur = null, start = null, segs = null
  path.walk({
    moveTo(x, y) {
      start = cur = tx(ctm, x, y)
      segs = []
      subs.push(segs)
    },
    lineTo(x, y) {
      const p = tx(ctm, x, y)
      if (!segs) { segs = []; subs.push(segs); start = cur }
      segs.push(['l', cur, p]); cur = p
    },
    curveTo(x1, y1, x2, y2, x3, y3) {
      const p = tx(ctm, x3, y3)
      if (!segs) { segs = []; subs.push(segs); start = cur }
      segs.push(['c', cur, tx(ctm, x1, y1), tx(ctm, x2, y2), p]); cur = p
    },
    closePath() {
      if (segs && start && cur && (cur[0] !== start[0] || cur[1] !== start[1])) {
        segs.push(['l', cur, start])
      }
      cur = start
    },
  })
  return subs.filter((s) => s.length)
}

function buildFp(subs, fill) {
  // A 'Z' before every new sub-path so the viewer's ShapePath finds holes
  // (counters of O, g, B). Same rules as the old _build_fp.
  const path = []
  let last = null, open = false
  for (const segs of subs) {
    for (const s of segs) {
      const [sx, sy] = s[1]
      if (!last || Math.abs(sx - last[0]) > 0.01 || Math.abs(sy - last[1]) > 0.01) {
        if (open) path.push({ cmd: 'Z' })
        path.push({ cmd: 'M', x: nx(sx), y: ny(sy) })
        open = true
      }
      if (s[0] === 'l') {
        path.push({ cmd: 'L', x: nx(s[2][0]), y: ny(s[2][1]) }); last = s[2]
      } else {
        path.push({ cmd: 'C', x1: nx(s[2][0]), y1: ny(s[2][1]), x2: nx(s[3][0]), y2: ny(s[3][1]),
                    x: nx(s[4][0]), y: ny(s[4][1]) })
        last = s[4]
      }
    }
  }
  if (open) path.push({ cmd: 'Z' })
  return path.length ? { type: 'fp', fill, path } : null
}

function pushStrokes(objects, subs, color, pid) {
  for (const segs of subs) {
    for (const s of segs) {
      if (s[0] === 'l') {
        objects.push({ type: 'l', x1: nx(s[1][0]), y1: ny(s[1][1]), x2: nx(s[2][0]), y2: ny(s[2][1]),
                       color, pid })
      } else {
        objects.push({ type: 'c', x1: nx(s[1][0]), y1: ny(s[1][1]), x2: nx(s[2][0]), y2: ny(s[2][1]),
                       x3: nx(s[3][0]), y3: ny(s[3][1]), x4: nx(s[4][0]), y4: ny(s[4][1]), color, pid })
      }
    }
  }
}

// ── Images ───────────────────────────────────────────────────────────────────
function bytesToBase64(u8) {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}

function imageEntry(mupdf, image, ctm, box = [0, 0, 1, 1]) {
  const [x0, y0, x1, y1] = mupdf.Rect.transform(box, ctm)
  const wMm = Math.abs(x1 - x0) * MM_PER_PT, hMm = Math.abs(y1 - y0) * MM_PER_PT
  if (wMm < 0.5 || hMm < 0.5) return null
  const cs = image.getColorSpace()
  const comps = cs ? cs.getNumberOfComponents() : 1
  let pix = image.toPixmap()
  const pcs = pix.getColorSpace()
  const pn = pcs ? pcs.getNumberOfComponents() : 0
  if (pn !== 1 && pn !== 3) pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB)
  let alpha = pix.getAlpha() > 0
  const mask = image.getMask()
  if (mask) {
    // Apply the soft mask, so a transparent image (Archicad's "BILDUNGSVERSION"
    // stamp) shows as itself instead of its opaque base on a black box.
    try {
      const mp = mask.toPixmap()
      if (mp.getWidth() === pix.getWidth() && mp.getHeight() === pix.getHeight()) {
        const n = pix.getNumberOfComponents(), W = pix.getWidth(), H = pix.getHeight()
        const out = new mupdf.Pixmap(pix.getColorSpace(), [0, 0, W, H], true)
        const src = pix.getPixels(), m = mp.getPixels(), dst = out.getPixels()
        const sStride = pix.getStride(), mStride = mp.getStride(), dStride = out.getStride()
        const sn = n + pix.getAlpha(), mn = mp.getNumberOfComponents() + mp.getAlpha()
        for (let yy = 0; yy < H; yy++) {
          for (let xx = 0; xx < W; xx++) {
            const si = yy * sStride + xx * sn, di = yy * dStride + xx * (n + 1)
            const a = m[yy * mStride + xx * mn]
            for (let k = 0; k < n; k++) dst[di + k] = Math.round((src[si + k] * a) / 255)  // premultiplied
            dst[di + n] = a
          }
        }
        pix = out
        alpha = true
      }
    } catch (e) {
      console.warn('[extract] image mask failed', e)
    }
  }
  return {
    entry: {
      alpha, type: 'img',
      x: nx(Math.min(x0, x1)), y: ny(Math.min(y0, y1)),   // top-left corner
      w: r3(wMm), h: r3(hMm),
      colorspace: comps === 1 ? 1 : 3,                    // 1 = grayscale, 3 = rgb
      data: `data:image/png;base64,${bytesToBase64(pix.asPNG())}`,
    },
    stamp: !!mask && hMm > 0 && wMm <= 150 && wMm / hMm >= 3,   // small, wide, transparent
  }
}

// <image> of a user SVG: decode the data URI, honour preserveAspectRatio.
function svgImageEntry(mupdf, op) {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(op.href.trim())
  if (!m) return null                         // external files: not reachable here
  const raw = m[1] ? base64ToBytes(m[2]) : new TextEncoder().encode(decodeURIComponent(m[2]))
  const image = new mupdf.Image(raw)
  const [x, y, w, h] = op.box
  const iw = image.getWidth(), ih = image.getHeight()
  let box = [x, y, x + w, y + h]
  const par = String(op.par || 'xMidYMid meet').trim()
  if (!par.startsWith('none') && iw > 0 && ih > 0) {
    const s = /slice/.test(par) ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih)
    const al = /x(Min|Mid|Max)Y(Min|Mid|Max)/.exec(par) || [null, 'Mid', 'Mid']
    const f = { Min: 0, Mid: 0.5, Max: 1 }
    const dx = (w - iw * s) * f[al[1]], dy = (h - ih * s) * f[al[2]]
    box = [x + dx, y + dy, x + dx + iw * s, y + dy + ih * s]
  }
  return imageEntry(mupdf, image, op.ctm, box)
}

function base64ToBytes(b64) {
  const s = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// ── SVG text -> outlines ─────────────────────────────────────────────────────
// mupdf.js has no SVG reader (and so no SVG text engine). <text> is set here
// with MuPDF's built-in fonts (Helvetica / Times / Courier, like most viewers
// substitute unknown fonts), sent through the SVG writer with text=path and
// read back - the same trick that turns PDF text into outlines.
const fontCache = new Map()
function baseFont(mupdf, sp) {
  const fam = sp.family
  const mono = /mono|courier|consolas/.test(fam)
  const serif = !mono && /times|georgia|garamond|(^|[\s,'"])serif/.test(fam) && !/sans/.test(fam)
  const bold = /bold|bolder|[6-9]00/.test(sp.weight)
  const base = mono ? 'Courier' : serif ? 'Times' : 'Helvetica'
  let name = base
  if (base === 'Times') name = bold && sp.italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : sp.italic ? 'Times-Italic' : 'Times-Roman'
  else if (bold || sp.italic) name = `${base}-${bold ? 'Bold' : ''}${sp.italic ? 'Oblique' : ''}`
  if (!fontCache.has(name)) fontCache.set(name, new mupdf.Font(name))
  return fontCache.get(name)
}

const rgb01 = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

function textOutlineOps(mupdf, op) {
  // Lay out: chunks start at every absolute x; text-anchor shifts each chunk.
  const chunks = []
  let pen = [0, 0], chunk = null
  for (const sp of op.spans) {
    if (sp.x != null || !chunk) {
      if (sp.x != null) pen = [sp.x, pen[1]]
      chunk = { anchor: sp.anchor, items: [], start: pen[0] }
      chunks.push(chunk)
    }
    if (sp.y != null) pen = [pen[0], sp.y]
    pen = [pen[0] + (sp.dx || 0), pen[1] + (sp.dy || 0)]
    if (!sp.str || sp.hidden || (!sp.fill && !sp.stroke)) {
      if (sp.str) pen[0] += advance(mupdf, sp)
      continue
    }
    chunk.items.push({ sp, at: pen.slice() })
    pen[0] += advance(mupdf, sp)
  }
  const buf = new mupdf.Buffer()
  const writer = new mupdf.DocumentWriter(buf, 'svg', 'text=path')
  const dev = writer.beginPage([0, 0, 1e5, 1e5])
  for (const ch of chunks) {
    if (!ch.items.length) continue
    const last = ch.items[ch.items.length - 1]
    const width = last.at[0] + advance(mupdf, last.sp) - ch.start
    const shift = ch.anchor === 'middle' ? -width / 2 : ch.anchor === 'end' ? -width : 0
    for (const { sp, at } of ch.items) {
      const text = new mupdf.Text()
      text.showString(baseFont(mupdf, sp), [sp.size, 0, 0, -sp.size, at[0] + shift, at[1]], sp.str)
      if (sp.fill) dev.fillText(text, op.ctm, mupdf.ColorSpace.DeviceRGB, rgb01(sp.fill), 1)
      if (sp.stroke) {
        dev.strokeText(text, new mupdf.StrokeState({ lineWidth: 1, lineCap: 'Butt', lineJoin: 'Miter', miterLimit: 10 }),
                       op.ctm, mupdf.ColorSpace.DeviceRGB, rgb01(sp.stroke), 1)
      }
    }
  }
  writer.endPage()
  writer.close()
  return parseSvg(buf.asString(), { images: false }).ops
}

function advance(mupdf, sp) {
  const font = baseFont(mupdf, sp)
  let w = 0
  for (const ch of sp.str) w += font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)))
  return w * sp.size
}

// Paint operations from parseSvg() -> drawing objects
function pushOps(mupdf, objects, ops, state) {
  for (const op of ops) {
    if (op.kind === 'text') {
      try {
        pushOps(mupdf, objects, textOutlineOps(mupdf, op), state)
      } catch (e) {
        console.warn('[extract] SVG text failed', e)
        state.textFailed = (state.textFailed || 0) + 1
      }
      continue
    }
    if (op.kind === 'fill') {
      const fp = buildFp(op.subs, op.color)
      if (fp) objects.push(fp)
    } else if (op.kind === 'stroke') {
      state.pid++
      pushStrokes(objects, op.subs, op.color, state.pid)
    } else if (op.kind === 'image') {
      try {
        const res = svgImageEntry(mupdf, op)
        if (res) objects.push(res.entry)
      } catch (e) {
        console.warn('[extract] SVG image failed', e)
      }
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
/**
 * @param mupdf      the mupdf.js namespace
 * @param bytes      Uint8Array / ArrayBuffer of the file
 * @param filename   used for the type (.pdf / .svg)
 * @param watermarks watermark phrases (see watermarks.js)
 */
export function extractDocument(mupdf, bytes, filename, watermarks = []) {
  const name = (filename || '').toLowerCase()
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (name.endsWith('.svg')) return extractSvg(mupdf, data)
  if (!name.endsWith('.pdf')) throw new Error('Nur PDF- und SVG-Dateien werden unterstützt')

  const doc = mupdf.Document.openDocument(data, 'application/pdf')
  const objects = []
  const warnings = []
  try {
    const n = doc.countPages()
    if (!n) return { success: false, lines: [], line_count: 0 }
    const [mx0, my0, mx1, my1] = doc.loadPage(0).getBounds('MediaBox')
    objects.push({ type: 'mbox', w: mm(mx1 - mx0), h: mm(my1 - my0) })

    const state = { pid: 0 }
    for (let pn = 0; pn < n; pn++) {
      const page = doc.loadPage(pn)
      const wmBoxes = watermarkBoxes(page, watermarks)
      const edu = page.search(ARCHICAD_EDU_MARKER).length > 0
      const start = objects.length

      // Vectors + text: MuPDF's SVG writer with text as paths, read back with
      // our SVG reader - glyphs come back as filled outlines in their colour.
      // (Same round trip as the old backend's get_svg_image(text_as_path).)
      try {
        const buf = new mupdf.Buffer()
        const writer = new mupdf.DocumentWriter(buf, 'svg', 'text=path')
        const dev = writer.beginPage(page.getBounds())
        page.run(dev, mupdf.Matrix.identity)
        writer.endPage()
        writer.close()
        pushOps(mupdf, objects, parseSvg(buf.asString(), { images: false }).ops, state)
      } catch (e) {
        console.warn('[extract] SVG round trip failed, using raw drawings', e)
        objects.length = start
        const raw = new mupdf.Device({
          fillPath(path, evenOdd, ctm, cs, color) {
            const fp = buildFp(walkSubpaths(path, ctm), toHex(cs, color))
            if (fp) objects.push(fp)
          },
          strokePath(path, stroke, ctm, cs, color) {
            state.pid++
            pushStrokes(objects, walkSubpaths(path, ctm), toHex(cs, color), state.pid)
          },
        })
        page.run(raw, mupdf.Matrix.identity)
        raw.close()
      }

      // Raster images (engraving bitmaps) - from the ORIGINAL page.
      try {
        const imgDev = new mupdf.Device({
          fillImage(image, ctm) {
            const res = imageEntry(mupdf, image, ctm)
            if (!res) return
            if (edu && res.stamp) res.entry.wm = true
            objects.push(res.entry)
          },
        })
        page.run(imgDev, mupdf.Matrix.identity)
        imgDev.close()
      } catch (e) {
        console.warn('[extract] image extraction failed', e)
      }

      if (wmBoxes.length) {
        for (let i = start; i < objects.length; i++) {
          const o = objects[i]
          if ((o.type === 'l' || o.type === 'c' || o.type === 'fp') && inWatermark(o, wmBoxes)) o.wm = true
        }
      }
    }
  } finally {
    doc.destroy?.()
  }
  return { success: true, line_count: objects.length, lines: objects, warnings }
}

function extractSvg(mupdf, data) {
  const text = normalizeSvgStyleConflicts(new TextDecoder('utf-8').decode(data))
  const svg = parseSvg(text, { images: true })
  const objects = [{ type: 'mbox', w: mm(svg.width), h: mm(svg.height) }]
  const state = { pid: 0 }
  pushOps(mupdf, objects, svg.ops, state)
  const warnings = []
  if (state.textFailed) warnings.push('svgText')     // text that could not be set
  return { success: true, line_count: objects.length, lines: objects, warnings }
}
