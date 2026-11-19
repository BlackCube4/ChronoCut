// PDF/SVG -> drawing objects, entirely in the browser. Built on pdf.js
// (Mozilla, Apache 2.0) for reading PDFs and opentype.js (MIT) for turning
// text into outlines - permissive licences only, so ChronoCut can stay
// closed source if wanted. Output format (unchanged since the Python backend):
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
// pdf.js is passed in (the worker and the Node scripts load it differently);
// `loadAsset(dir, file)` delivers pdf.js' standard fonts / wasm decoders.
// explicit ESM build: the package's main/browser entry is UMD
import { parse as parseFont } from 'opentype.js/dist/opentype.mjs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { parseSvg } from './svg.js'
import { encodePng, imageInfo } from './png.js'

export const MM_PER_PT = 25.4 / 72

const r3 = (v) => Math.round(v * 1000) / 1000
const nx = (x) => r3(x * MM_PER_PT)
const ny = (y) => r3(-y * MM_PER_PT)
const mm = (v) => r3(v * MM_PER_PT)

// 2x3 affine matrices [a b c d e f]; mul(a, b) = apply a, then b
const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
]
const tx = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
const IDENT = [1, 0, 0, 1, 0, 0]

// ── SVG style-conflict normalisation ─────────────────────────────────────────
// By the CSS cascade an inline style="stroke:..." wins over a stroke="..."
// attribute on the same element; some readers keep the attribute. Editors
// like Inkscape write style= and often leave a stale attribute behind, which
// once turned red engrave lines into blue cuts. Make the two agree.
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
// Box (mm) of every TEXT LINE that contains a watermark phrase - the whole
// line: "PRODUCED BY AN AUTODESK STUDENT VERSION" must go completely.
function textLines(textContent, vpT) {
  const lines = []
  let cur = null
  const flush = () => { if (cur && cur.text.trim()) lines.push(cur); cur = null }
  for (const it of textContent.items) {
    if (typeof it.str !== 'string') continue
    const [a, b, c, d, e, f] = it.transform
    const lenX = Math.hypot(a, b) || 1, lenY = Math.hypot(c, d) || 1
    const ux = [a / lenX, b / lenX], uy = [c / lenY, d / lenY]
    const h = it.height || lenY, w = it.width || 0
    const corners = [[0, -0.25 * h], [w, -0.25 * h], [w, h], [0, h]]
      .map(([s, t]) => tx(vpT, e + ux[0] * s + uy[0] * t, f + ux[1] * s + uy[1] * t))
    const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1])
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    if (cur && Math.abs(box[1] - cur.box[1]) > h * 0.6 && Math.abs(box[3] - cur.box[3]) > h * 0.6) flush()
    if (!cur) cur = { text: '', box }
    cur.text += it.str
    cur.box = [Math.min(cur.box[0], box[0]), Math.min(cur.box[1], box[1]),
               Math.max(cur.box[2], box[2]), Math.max(cur.box[3], box[3])]
    if (it.hasEOL) flush()
  }
  flush()
  return lines
}

function watermarkBoxes(lines, phrases) {
  const ps = (phrases || []).map((p) => (p || '').trim().toLowerCase()).filter(Boolean)
  if (!ps.length) return []
  const boxes = []
  for (const ln of lines) {
    const text = ln.text.toLowerCase()
    const compact = text.replace(/ /g, '')
    if (!ps.some((p) => text.includes(p) || compact.includes(p.replace(/ /g, '')))) continue
    const [x0, y0, x1, y1] = ln.box
    const xs = [nx(x0), nx(x1)].sort((p, q) => p - q), ys = [ny(y0), ny(y1)].sort((p, q) => p - q)
    boxes.push([xs[0] - 0.5, ys[0] - 0.5, xs[1] + 0.5, ys[1] + 0.5])
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
// small transparent image. The image is only tagged when the marker text is on
// the same page.
const ARCHICAD_EDU_MARKER = 'GSEducationalVersion'

// ── Geometry -> objects ──────────────────────────────────────────────────────
// Sub-paths: arrays of segments ['l', p0, p1] | ['c', p0, p1, p2, p3] in PDF
// points, page space (origin top-left, y down).
function buildFp(subs, fill) {
  // A 'Z' before every new sub-path so the viewer finds holes (counters of O,
  // g, B).
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

const quadToCubic = (p0, q, p) => ['c', p0, [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])],
                                   [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p]

// pdf.js path data: [op, args..., op, args...] with DrawOPS moveTo 0,
// lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4. closePath adds the
// closing line when the end is not already at the start.
function pathSubs(data, m) {
  const subs = []
  let segs = null, cur = null, start = null
  const begin = () => { if (!segs) { segs = []; subs.push(segs); start = cur } }
  for (let i = 0; i < data.length;) {
    const op = data[i++]
    if (op === 0) {
      cur = start = tx(m, data[i], data[i + 1]); i += 2
      segs = []; subs.push(segs)
    } else if (op === 1) {
      const p = tx(m, data[i], data[i + 1]); i += 2
      begin(); segs.push(['l', cur, p]); cur = p
    } else if (op === 2) {
      const p1 = tx(m, data[i], data[i + 1]), p2 = tx(m, data[i + 2], data[i + 3]), p = tx(m, data[i + 4], data[i + 5])
      i += 6
      begin(); segs.push(['c', cur, p1, p2, p]); cur = p
    } else if (op === 3) {
      const q = tx(m, data[i], data[i + 1]), p = tx(m, data[i + 2], data[i + 3]); i += 4
      begin(); segs.push(quadToCubic(cur, q, p)); cur = p
    } else if (op === 4) {
      if (segs && start && cur && (cur[0] !== start[0] || cur[1] !== start[1])) segs.push(['l', cur, start])
      cur = start
    } else {
      break                                   // unknown op: stop rather than misread
    }
  }
  return subs.filter((s) => s.length)
}

// ── Images ───────────────────────────────────────────────────────────────────
function bytesToBase64(u8) {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}
function base64ToBytes(b64) {
  const s = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// pdf.js image kinds: 1 = 1 bit gray (packed), 2 = RGB, 3 = RGBA (soft mask
// already applied)
function pdfImageEntry(img, ctm) {
  if (!img || !img.data || !(img.width > 0) || !(img.height > 0)) return null
  const xs = [], ys = []
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { const p = tx(ctm, u, v); xs.push(p[0]); ys.push(p[1]) }
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const wMm = (x1 - x0) * MM_PER_PT, hMm = (y1 - y0) * MM_PER_PT
  if (wMm < 0.5 || hMm < 0.5) return null

  const { width: W, height: H, kind, data } = img
  let px, ch
  if (kind === 1) {                                  // unpack 1 bit gray
    ch = 1; px = new Uint8Array(W * H)
    const rowBytes = (W + 7) >> 3
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) px[y * W + x] = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
    }
  } else if (kind === 2) { ch = 3; px = data } else { ch = 4; px = data }

  // gray? transparent? (decides the "colour image" note and the Archicad stamp)
  let gray = ch === 1, alpha = false
  if (ch > 1) {
    gray = true
    for (let i = 0; i < px.length; i += ch) {
      if (gray && (px[i] !== px[i + 1] || px[i] !== px[i + 2])) gray = false
      if (ch === 4 && px[i + 3] !== 255) alpha = true
      if (!gray && (alpha || ch === 3)) break
    }
  }
  let outPx = px, outCh = ch
  if (ch === 4 && !alpha) {                          // opaque: drop the alpha channel
    outPx = new Uint8Array((px.length / 4) * 3)
    for (let i = 0, o = 0; i < px.length; i += 4, o += 3) { outPx[o] = px[i]; outPx[o + 1] = px[i + 1]; outPx[o + 2] = px[i + 2] }
    outCh = 3
  }
  return {
    entry: {
      alpha, type: 'img',
      x: nx(x0), y: ny(y0),                          // top-left corner
      w: r3(wMm), h: r3(hMm),
      colorspace: gray ? 1 : 3,                      // 1 = grayscale, 3 = rgb
      data: `data:image/png;base64,${bytesToBase64(encodePng(outPx, W, H, outCh))}`,
    },
    stamp: alpha && wMm <= 150 && hMm > 0 && wMm / hMm >= 3,   // small, wide, transparent
  }
}

// <image> of a user SVG: keep the original PNG/JPEG, honour preserveAspectRatio
function svgImageEntry(op) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(op.href.trim())
  if (!m) return null                         // external files: not reachable here
  const bytes = m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]))
  const info = imageInfo(bytes)
  if (!info) return null                      // only PNG and JPEG
  const [x, y, w, h] = op.box
  let box = [x, y, x + w, y + h]
  const par = String(op.par || 'xMidYMid meet').trim()
  if (!par.startsWith('none') && info.width > 0 && info.height > 0) {
    const s = /slice/.test(par) ? Math.max(w / info.width, h / info.height) : Math.min(w / info.width, h / info.height)
    const al = /x(Min|Mid|Max)Y(Min|Mid|Max)/.exec(par) || [null, 'Mid', 'Mid']
    const f = { Min: 0, Mid: 0.5, Max: 1 }
    const dx = (w - info.width * s) * f[al[1]], dy = (h - info.height * s) * f[al[2]]
    box = [x + dx, y + dy, x + dx + info.width * s, y + dy + info.height * s]
  }
  const pts = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(([u, v]) => tx(op.ctm, u, v))
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs), y0 = Math.min(...ys)
  const wMm = (Math.max(...xs) - x0) * MM_PER_PT, hMm = (Math.max(...ys) - y0) * MM_PER_PT
  if (wMm < 0.5 || hMm < 0.5) return null
  return { type: 'img', alpha: !!info.alpha, x: nx(x0), y: ny(y0), w: r3(wMm), h: r3(hMm),
           colorspace: info.gray ? 1 : 3, data: `data:image/${info.type};base64,${bytesToBase64(bytes)}` }
}

// ── Text -> outlines ─────────────────────────────────────────────────────────
// pdf.js converts every font (TrueType, Type 1, CFF; embedded or one of its
// bundled standard fonts) to an OpenType file; opentype.js reads the glyph
// outlines from it. Positions follow pdf.js' own canvas showText().
function fontOutlines(font, cache) {
  if (cache.has(font)) return cache.get(font)
  let ot = null
  try {
    if (font.data && !font.isType3Font) {
      const d = font.data
      ot = parseFont(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
    }
  } catch (e) {
    console.warn('[extract] font outlines unavailable', font.name, e)
  }
  const entry = { ot, glyphs: new Map() }
  cache.set(font, entry)
  return entry
}

// Glyph outline as sub-paths in "em" units (1 = font size), y up
function glyphEm(entry, ch, font) {
  if (entry.glyphs.has(ch)) return entry.glyphs.get(ch)
  let subs = []
  const ot = entry.ot
  if (ot) {
    const g = ot.charToGlyph(ch)
    // CFF outlines are in FontMatrix units, TrueType in unitsPerEm
    const k = ot.outlinesFormat === 'cff' && font.fontMatrix ? font.fontMatrix[0] : 1 / ot.unitsPerEm
    let segs = null, cur = null, start = null
    for (const c of g?.path?.commands || []) {
      if (c.type === 'M') { cur = start = [c.x * k, c.y * k]; segs = []; subs.push(segs) }
      else if (c.type === 'L') { const p = [c.x * k, c.y * k]; segs.push(['l', cur, p]); cur = p }
      else if (c.type === 'C') {
        const p = [c.x * k, c.y * k]
        segs.push(['c', cur, [c.x1 * k, c.y1 * k], [c.x2 * k, c.y2 * k], p]); cur = p
      } else if (c.type === 'Q') {
        const p = [c.x * k, c.y * k]
        segs.push(quadToCubic(cur, [c.x1 * k, c.y1 * k], p)); cur = p
      } else if (c.type === 'Z') {
        if (segs && cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) segs.push(['l', cur, start])
        cur = start
      }
    }
    subs = subs.filter((s) => s.length)
  }
  entry.glyphs.set(ch, subs)
  return subs
}

// ── Operator list -> objects ─────────────────────────────────────────────────
function walkPage(pdfjs, page, opList, vpT, fontCache, state, objects, onImage) {
  const OPS = pdfjs.OPS
  let g = {
    ctm: vpT, stroke: '#000000', fill: '#000000', font: null, fontSize: 0, fontDir: 1,
    charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, mode: 0,
    tm: IDENT, x: 0, y: 0, lineX: 0, lineY: 0, fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
  }
  const stack = []
  // paint op -> [fill, stroke, close]
  const PAINT = {
    [OPS.stroke]: [false, true, false], [OPS.closeStroke]: [false, true, true],
    [OPS.fill]: [true, false, false], [OPS.eoFill]: [true, false, false],
    [OPS.fillStroke]: [true, true, false], [OPS.eoFillStroke]: [true, true, false],
    [OPS.closeFillStroke]: [true, true, true], [OPS.closeEOFillStroke]: [true, true, true],
  }

  const paint = (subs, doFill, doStroke) => {
    if (!subs.length) return
    if (doFill && g.fill) { const fp = buildFp(subs, g.fill); if (fp) objects.push(fp) }
    if (doStroke && g.stroke) { state.pid++; pushStrokes(objects, subs, g.stroke, state.pid) }
  }

  const moveText = (x, y) => { g.x = g.lineX += x; g.y = g.lineY += y }

  const showText = (glyphs) => {
    const font = g.font
    if (!font || g.fontSize === 0) return
    if (font.isType3Font) { state.type3 = (state.type3 || 0) + 1; return }
    const mode = g.mode & 3
    const fill = mode === 0 || mode === 2
    const stroke = mode === 1 || mode === 2
    const fs = g.fontSize, dir = g.fontDir
    const hs = g.hScale * dir
    const advScale = g.fontMatrix[0] * fs
    const outl = fontOutlines(font, fontCache)
    // glyph em -> page: scale(fs) . translate(x) . scale(hs, 1) . translate(tx, ty + rise) . Tm . CTM
    const base = mul([hs, 0, 0, 1, g.x, g.y + g.rise], mul(g.tm, g.ctm))
    let x = 0
    for (const gl of glyphs) {
      if (typeof gl === 'number') { x += -gl * fs / 1000; continue }
      const spacing = (gl.isSpace ? g.wordSpacing : 0) + g.charSpacing
      if ((fill || stroke) && (gl.isInFont || font.missingFile)) {
        const draw = (ch, ox, oy) => {
          const em = glyphEm(outl, ch, font)
          if (!em.length) { if (!outl.ot && (gl.unicode || '').trim()) state.noOutline = (state.noOutline || 0) + 1; return }
          const m = mul([fs, 0, 0, fs, ox, oy], base)
          paint(em.map((segs) => segs.map((s) => [s[0], ...s.slice(1).map((p) => tx(m, p[0], p[1]))])), fill, stroke)
        }
        draw(gl.fontChar, x, 0)
        if (gl.accent) draw(gl.accent.fontChar, x + fs * gl.accent.offset.x, fs * gl.accent.offset.y)
      }
      x += gl.width * advScale + spacing * dir
    }
    g.x += x * hs
  }

  const { fnArray, argsArray } = opList
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i]
    switch (fn) {
      case OPS.save: stack.push({ ...g }); break
      case OPS.restore: if (stack.length) g = stack.pop(); break
      case OPS.transform: g.ctm = mul(a, g.ctm); break
      case OPS.paintFormXObjectBegin:
        stack.push({ ...g })
        if (a?.[0] && a[0].length === 6) g.ctm = mul(Array.from(a[0]), g.ctm)
        break
      case OPS.paintFormXObjectEnd: if (stack.length) g = stack.pop(); break
      case OPS.setStrokeRGBColor: g.stroke = typeof a[0] === 'string' ? a[0] : null; break
      case OPS.setFillRGBColor: g.fill = typeof a[0] === 'string' ? a[0] : null; break
      case OPS.setStrokeColorN: case OPS.setStrokeTransparent: g.stroke = null; break
      case OPS.setFillColorN: case OPS.setFillTransparent: g.fill = null; break
      case OPS.constructPath: {
        const how = PAINT[a[0]]
        if (!how) break                                  // endPath (clipping) etc.
        const subs = []
        for (const d of a[1] || []) subs.push(...pathSubs(d, g.ctm))
        if (how[2]) {                                    // close*: close every sub-path
          for (const segs of subs) {
            const s0 = segs[0][1], last = segs[segs.length - 1], e = last[last.length - 1]
            if (e[0] !== s0[0] || e[1] !== s0[1]) segs.push(['l', e, s0])
          }
        }
        paint(subs, how[0], how[1])
        break
      }
      case OPS.beginText: g.tm = IDENT; g.x = g.y = g.lineX = g.lineY = 0; break
      case OPS.setFont: {
        const [name, size] = a
        g.font = page.commonObjs.has(name) ? page.commonObjs.get(name) : null
        g.fontMatrix = g.font?.fontMatrix || [0.001, 0, 0, 0.001, 0, 0]
        g.fontDir = size < 0 ? -1 : 1
        g.fontSize = Math.abs(size)
        break
      }
      case OPS.setTextMatrix: g.tm = Array.from(a[0]?.length === 6 ? a[0] : a); g.x = g.y = g.lineX = g.lineY = 0; break
      case OPS.moveText: moveText(a[0], a[1]); break
      case OPS.setLeading: g.leading = -a[0]; break
      case OPS.setLeadingMoveText: g.leading = a[1]; moveText(a[0], a[1]); break
      case OPS.nextLine: moveText(0, g.leading); break
      case OPS.setCharSpacing: g.charSpacing = a[0]; break
      case OPS.setWordSpacing: g.wordSpacing = a[0]; break
      case OPS.setHScale: g.hScale = a[0] / 100; break
      case OPS.setTextRise: g.rise = a[0]; break
      case OPS.setTextRenderingMode: g.mode = a[0]; break
      case OPS.showText: case OPS.showSpacedText: showText(a[0]); break
      case OPS.nextLineShowText: moveText(0, g.leading); showText(a[0]); break
      case OPS.nextLineSetSpacingShowText:
        g.wordSpacing = a[0]; g.charSpacing = a[1]; moveText(0, g.leading); showText(a[2]); break
      case OPS.paintImageXObject: onImage(a[0], g.ctm); break     // object id, resolved later
      case OPS.paintInlineImageXObject: onImage(a[0], g.ctm); break
    }
  }
}

function imageObj(page, id) {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000)      // never hang on a broken image
    store.get(id, (img) => { clearTimeout(timer); resolve(img) })
  })
}

function makeAssetFactory(loadAsset) {
  const DIRS = { standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm', cMapUrl: 'cmaps' }
  return class AssetFactory {
    async fetch({ kind, filename }) {
      if (!loadAsset) throw new Error('no asset loader')
      return loadAsset(DIRS[kind], filename)
    }
  }
}

// ── PDF ──────────────────────────────────────────────────────────────────────
async function extractPdf(pdfjs, data, { watermarks = [], loadAsset } = {}) {
  const task = pdfjs.getDocument({
    data, fontExtraProperties: true, disableFontFace: true, useSystemFonts: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, useWorkerFetch: false,
    BinaryDataFactory: makeAssetFactory(loadAsset),
    standardFontDataUrl: 'pdfjs/standard_fonts/', wasmUrl: 'pdfjs/wasm/', cMapUrl: 'pdfjs/cmaps/',
    verbosity: 0,
  })
  const doc = await task.promise
  const objects = []
  const state = { pid: 0 }
  try {
    const n = doc.numPages
    if (!n) return { success: false, lines: [], line_count: 0 }
    const fontCache = new Map()
    for (let pn = 1; pn <= n; pn++) {
      const page = await doc.getPage(pn)
      const vp = page.getViewport({ scale: 1 })
      if (pn === 1) objects.push({ type: 'mbox', w: mm(vp.width), h: mm(vp.height) })
      const vpT = Array.from(vp.transform)
      const lines = textLines(await page.getTextContent(), vpT)
      const wmBoxes = watermarkBoxes(lines, watermarks)
      const edu = lines.some((l) => l.text.includes(ARCHICAD_EDU_MARKER))
      const start = objects.length
      const opList = await page.getOperatorList()
      const images = []
      walkPage(pdfjs, page, opList, vpT, fontCache, state, objects, (img, ctm) => images.push([img, ctm]))
      // Images after the vectors, like the old extraction did. Decoded images
      // arrive asynchronously in page.objs (or commonObjs for shared ones).
      for (const [ref, ctm] of images) {
        try {
          const img = typeof ref === 'string' ? await imageObj(page, ref) : ref
          const res = pdfImageEntry(img, ctm)
          if (!res) continue
          if (edu && res.stamp) res.entry.wm = true
          objects.push(res.entry)
        } catch (e) {
          console.warn('[extract] image failed', e)
        }
      }
      if (wmBoxes.length) {
        for (let i = start; i < objects.length; i++) {
          const o = objects[i]
          if ((o.type === 'l' || o.type === 'c' || o.type === 'fp') && inWatermark(o, wmBoxes)) o.wm = true
        }
      }
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  const warnings = []
  if (state.type3 || state.noOutline) warnings.push('textNotConverted')
  return { success: true, line_count: objects.length, lines: objects, warnings }
}

// ── SVG ──────────────────────────────────────────────────────────────────────
// Text in an SVG is set into a small temporary PDF with the PDF standard fonts
// (Helvetica / Times / Courier, like most viewers substitute unknown fonts)
// and read back through the PDF path - the same outlines as PDF text.
function standardFontFor(sp) {
  const fam = sp.family
  const mono = /mono|courier|consolas/.test(fam)
  const serif = !mono && /times|georgia|garamond|(^|[\s,'"])serif/.test(fam) && !/sans/.test(fam)
  const bold = /bold|bolder|[6-9]00/.test(sp.weight)
  const it = sp.italic
  if (mono) return bold && it ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : it ? StandardFonts.CourierOblique : StandardFonts.Courier
  if (serif) return bold && it ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : it ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman
  return bold && it ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : it ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica
}

const rgbOps = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4)).join(' ')
const n4 = (v) => (Math.round(v * 10000) / 10000).toString()

async function svgTextToObjects(pdfjs, textOps, width, height, opts, state) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([width, height])
  const fonts = new Map()
  const fontRes = async (name) => {
    if (!fonts.has(name)) {
      const f = await pdf.embedFont(name)
      fonts.set(name, { f, key: page.node.newFontDictionary('F', f.ref) })
    }
    return fonts.get(name)
  }
  const out = []
  let failed = 0
  for (const op of textOps) {
    // layout: chunks start at every absolute x; text-anchor shifts each chunk
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
      if (!sp.str) continue
      const { f, key } = await fontRes(standardFontFor(sp))
      let enc, w
      try { enc = f.encodeText(sp.str); w = f.widthOfTextAtSize(sp.str, sp.size) } catch { failed++; continue }
      if (!sp.hidden && (sp.fill || sp.stroke)) chunk.items.push({ sp, at: pen.slice(), enc, key, w })
      pen[0] += w
    }
    for (const ch of chunks) {
      if (!ch.items.length) continue
      const last = ch.items[ch.items.length - 1]
      const width = last.at[0] + last.w - ch.start
      const shift = ch.anchor === 'middle' ? -width / 2 : ch.anchor === 'end' ? -width : 0
      for (const { sp, at, enc, key } of ch.items) {
        const mode = sp.fill && sp.stroke ? 2 : sp.stroke ? 1 : 0
        // page y up; op.ctm maps SVG user units to points with y down
        out.push(`q 1 0 0 -1 0 ${n4(height)} cm ${op.ctm.map(n4).join(' ')} cm`)
        if (sp.fill) out.push(`${rgbOps(sp.fill)} rg`)
        if (sp.stroke) out.push(`${rgbOps(sp.stroke)} RG`)
        out.push(`BT ${key.toString()} 1 Tf ${mode} Tr ${n4(sp.size)} 0 0 ${n4(-sp.size)} ${n4(at[0] + shift)} ${n4(at[1])} Tm ${enc.toString()} Tj ET Q`)
      }
    }
  }
  if (failed) state.textFailed = (state.textFailed || 0) + failed
  if (!out.length) return []
  page.node.addContentStream(pdf.context.register(pdf.context.stream(out.join('\n'))))
  const res = await extractPdf(pdfjs, await pdf.save(), opts)
  return res.lines.filter((o) => o.type !== 'mbox')
}

async function extractSvg(pdfjs, data, opts) {
  const text = normalizeSvgStyleConflicts(new TextDecoder('utf-8').decode(data))
  const svg = parseSvg(text, { images: true })
  const objects = [{ type: 'mbox', w: mm(svg.width), h: mm(svg.height) }]
  const state = { pid: 0 }
  // All text is set in one temporary PDF; its outlines take the place of the
  // first text element in drawing order.
  const textOps = svg.ops.filter((op) => op.kind === 'text')
  let textObjs = []
  if (textOps.length) {
    try {
      textObjs = await svgTextToObjects(pdfjs, textOps, svg.width, svg.height, opts, state)
    } catch (e) {
      console.warn('[extract] SVG text failed', e)
      state.textFailed = (state.textFailed || 0) + textOps.length
    }
  }
  let textDone = false
  for (const op of svg.ops) {
    if (op.kind === 'fill') {
      const fp = buildFp(op.subs, op.color)
      if (fp) objects.push(fp)
    } else if (op.kind === 'stroke') {
      state.pid++
      pushStrokes(objects, op.subs, op.color, state.pid)
    } else if (op.kind === 'image') {
      try {
        const e = svgImageEntry(op)
        if (e) objects.push(e)
      } catch (err) {
        console.warn('[extract] SVG image failed', err)
      }
    } else if (op.kind === 'text' && !textDone) {
      // stroke pids of the text must not collide with the drawing's
      for (const o of textObjs) objects.push(o.pid != null ? { ...o, pid: `t${o.pid}` } : o)
      textDone = true
    }
  }
  const warnings = []
  if (state.textFailed) warnings.push('svgText')
  return { success: true, line_count: objects.length, lines: objects, warnings }
}

// ── Main ─────────────────────────────────────────────────────────────────────
/**
 * @param pdfjs      the pdf.js namespace (legacy build, worker set up in-thread)
 * @param bytes      Uint8Array / ArrayBuffer of the file
 * @param filename   used for the type (.pdf / .svg)
 * @param opts       { watermarks: string[], loadAsset(dir, file) -> Promise<Uint8Array> }
 */
export async function extractDocument(pdfjs, bytes, filename, opts = {}) {
  const name = (filename || '').toLowerCase()
  // a plain Uint8Array (pdf.js refuses Node's Buffer subclass)
  const data = bytes?.constructor === Uint8Array ? bytes : new Uint8Array(bytes)
  if (name.endsWith('.svg')) return extractSvg(pdfjs, data, opts)
  if (!name.endsWith('.pdf')) throw new Error('Nur PDF- und SVG-Dateien werden unterstützt')
  return extractPdf(pdfjs, data, opts)
}
