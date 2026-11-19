// Minimal SVG reader: turns an SVG document into paint operations (filled and
// stroked paths, images) in PDF points, origin top-left - the same space the
// MuPDF device callbacks deliver for a PDF page.
//
// Why our own: the WebAssembly build of MuPDF (mupdf.js) ships without the SVG
// document handler. It is used for two things:
//   1. reading back MuPDF's own SVG output (PDF page -> SVG with text as paths),
//      which is how text becomes outlines - same trick as the old backend;
//   2. reading SVG files the user loads directly.
//
// Supported: svg/g/use/symbol/defs, path (all commands incl. arcs), rect (also
// rounded), circle, ellipse, line, polyline, polygon, image; transforms;
// presentation attributes, style="", <style> rules for simple selectors
// (tag, .class, #id, tag.class, comma lists - enough for CorelDRAW/Inkscape/
// Illustrator exports); inheritance; display:none / visibility:hidden.
// <text>/<tspan> come out as 'text' ops (positions, font, colour); the caller
// sets them with MuPDF's built-in fonts and converts them to outlines.
// Not supported: gradients and patterns as paint (skipped), clipping, masks,
// opacity, text on a path.

// ── Small helpers ────────────────────────────────────────────────────────────
const IDENT = [1, 0, 0, 1, 0, 0]
const mul = (a, b) => [               // a then b  (point' = b(a(point)))
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
]
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

const NUM_RE = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g
const nums = (s) => (String(s || '').match(NUM_RE) || []).map(Number)

// User units per unit. MuPDF's SVG reader counts 1 px = 1 pt (72 per inch),
// unlike browsers (96). Kept like that on purpose: the old backend read SVGs
// with MuPDF, so files keep exactly the size they had before.
const UNIT_PX = { '': 1, px: 1, pt: 1, pc: 12, mm: 72 / 25.4, cm: 72 / 2.54, in: 72 }
function length(v, ref = 0) {
  if (v == null || v === '') return null
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(String(v))
  if (!m) return null
  const n = Number(m[1]), u = m[2].toLowerCase()
  if (u === '%') return (n / 100) * ref
  if (u === 'em' || u === 'ex') return n * 16
  return n * (UNIT_PX[u] ?? 1)
}

function parseTransform(s) {
  let m = IDENT
  if (!s) return m
  for (const [, fn, args] of String(s).matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = nums(args)
    let t = IDENT
    if (fn === 'matrix' && a.length >= 6) t = a.slice(0, 6)
    else if (fn === 'translate') t = [1, 0, 0, 1, a[0] || 0, a[1] || 0]
    else if (fn === 'scale') t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]
    else if (fn === 'rotate') {
      const r = ((a[0] || 0) * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r)
      t = [c, sn, -sn, c, 0, 0]
      if (a.length >= 3) t = mul(mul([1, 0, 0, 1, -a[1], -a[2]], t), [1, 0, 0, 1, a[1], a[2]])
    } else if (fn === 'skewX') t = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0]
    else if (fn === 'skewY') t = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]
    m = mul(t, m)     // later functions apply first: matrix = m * t
  }
  return m
}

// ── Colours ──────────────────────────────────────────────────────────────────
const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', lime: '#00ff00', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff',
  fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
  navy: '#000080', olive: '#808000', purple: '#800080', teal: '#008080', orange: '#ffa500',
  darkred: '#8b0000', darkblue: '#00008b', darkgreen: '#006400', lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', pink: '#ffc0cb',
  brown: '#a52a2a', gold: '#ffd700',
}
// -> '#rrggbb' | null (none / unsupported paint)
function parseColor(v, current) {
  if (v == null) return undefined
  let s = String(v).trim().toLowerCase()
  if (!s || s === 'none' || s === 'transparent') return null
  if (s.startsWith('url(')) {           // gradient/pattern: use the fallback colour if any
    const rest = s.replace(/^url\([^)]*\)\s*/, '')
    return rest ? parseColor(rest, current) : null
  }
  if (s === 'currentcolor') return current ?? '#000000'
  if (NAMED[s]) return NAMED[s]
  let m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) return '#' + m[1].split('').map((c) => c + c).join('')
  m = /^#([0-9a-f]{6})/.exec(s)
  if (m) return '#' + m[1]
  m = /^rgba?\(([^)]*)\)$/.exec(s)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3)
    const v3 = parts.map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)))
    return '#' + v3.map((x) => Math.max(0, Math.min(255, Math.round(x || 0))).toString(16).padStart(2, '0')).join('')
  }
  return '#000000'
}

// ── XML ──────────────────────────────────────────────────────────────────────
// Tiny tolerant XML parser: elements, attributes, text (for <style>), CDATA.
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, e) => {
    const l = e.toLowerCase()
    if (l === 'amp') return '&'
    if (l === 'lt') return '<'
    if (l === 'gt') return '>'
    if (l === 'quot') return '"'
    if (l === 'apos') return "'"
    if (l.startsWith('#x')) return String.fromCodePoint(parseInt(l.slice(2), 16))
    return String.fromCodePoint(parseInt(l.slice(1), 10))
  })
}

function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gi
  let m
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1]
    if (m[1] != null) { top.text += m[1]; top.children.push({ tag: '#text', attrs: {}, children: [], text: m[1] }) }
    else if (m[2]) {
      // close: pop to the matching element (tolerant)
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === m[2]) { stack.length = i; break }
    } else if (m[3]) {
      const attrs = {}
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decodeEntities(a[2] ?? a[3])
      const el = { tag: m[3].replace(/^svg:/, ''), attrs, children: [], text: '', parent: top }
      top.children.push(el)
      if (!m[5]) stack.push(el)
    } else if (m[6] != null) {
      const t = decodeEntities(m[6])
      top.text += t
      top.children.push({ tag: '#text', attrs: {}, children: [], text: t })
    }
  }
  return root
}

// ── CSS (<style>) ────────────────────────────────────────────────────────────
function parseDecls(s) {
  const out = {}
  for (const d of String(s || '').split(';')) {
    const i = d.indexOf(':')
    if (i > 0) out[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim().replace(/\s*!important$/i, '')
  }
  return out
}

function parseCss(text) {
  const rules = []
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [, sel, body] of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = parseDecls(body)
    for (const raw of sel.split(',')) {
      const s = raw.trim()
      const m = /^([\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(s)
      if (!m || s.startsWith('@')) continue        // complex selectors: ignored
      const tag = m[1] && m[1] !== '*' ? m[1] : null
      const classes = [...m[2].matchAll(/\.([\w-]+)/g)].map((x) => x[1])
      const ids = [...m[2].matchAll(/#([\w-]+)/g)].map((x) => x[1])
      const spec = ids.length * 100 + classes.length * 10 + (tag ? 1 : 0)
      rules.push({ tag, classes, ids, spec, decls, order: rules.length })
    }
  }
  return rules.sort((a, b) => a.spec - b.spec || a.order - b.order)
}

const STYLE_PROPS = ['fill', 'stroke', 'fill-rule', 'display', 'visibility', 'color',
  'font-size', 'font-family', 'font-weight', 'font-style', 'text-anchor']

function ownStyle(el, rules) {
  const st = {}
  for (const p of STYLE_PROPS) if (el.attrs[p] != null) st[p] = el.attrs[p]
  if (rules.length) {
    const cls = (el.attrs.class || '').split(/\s+/).filter(Boolean)
    for (const r of rules) {
      if (r.tag && r.tag !== el.tag) continue
      if (r.ids.length && !r.ids.includes(el.attrs.id)) continue
      if (r.classes.some((c) => !cls.includes(c))) continue
      for (const p of STYLE_PROPS) if (r.decls[p] != null) st[p] = r.decls[p]
    }
  }
  const inline = parseDecls(el.attrs.style)
  for (const p of STYLE_PROPS) if (inline[p] != null) st[p] = inline[p]
  return st
}

// ── Path data ────────────────────────────────────────────────────────────────
// Result: sub-paths of segments ['l', p0, p1] | ['c', p0, p1, p2, p3] in local
// user units (transform applied later).
function arcToCubics(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
  if (rx === 0 || ry === 0) return [['l', [x1, y1], [x2, y2]]]
  const s = Math.sin(phi), c = Math.cos(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = c * dx + s * dy, y1p = -s * dx + c * dy
  rx = Math.abs(rx); ry = Math.abs(ry)
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam) }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let co = Math.sqrt(Math.max(0, num / den))
  if (fa === fs) co = -co
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx
  const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!fs && dt > 0) dt -= 2 * Math.PI
  if (fs && dt < 0) dt += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9))
  const d = dt / n, k = (4 / 3) * Math.tan(d / 4)
  const pt = (t) => [cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c]
  const dv = (t) => [-rx * Math.sin(t) * c - ry * Math.cos(t) * s, -rx * Math.sin(t) * s + ry * Math.cos(t) * c]
  const out = []
  let p0 = [x1, y1]
  for (let i = 0; i < n; i++) {
    const a = t1 + i * d, b = a + d
    const da = dv(a), db = dv(b)
    const p3 = i === n - 1 ? [x2, y2] : pt(b)
    out.push(['c', p0, [p0[0] + k * da[0], p0[1] + k * da[1]], [p3[0] - k * db[0], p3[1] - k * db[1]], p3])
    p0 = p3
  }
  return out
}

export function parsePathData(d) {
  const subs = []
  let segs = null, cur = [0, 0], start = [0, 0], lastC = null, lastQ = null
  const toks = String(d || '').match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []
  let i = 0, cmd = null
  const isCmd = (t) => /^[A-Za-z]$/.test(t)
  const num = () => Number(toks[i++])
  const flag = () => {          // arc flags may be written without separators ("011")
    const t = toks[i]
    if (t.length > 1 && /^[01]/.test(t)) { toks[i] = t.slice(1); return Number(t[0]) }
    i++; return Number(t)
  }
  const ensure = () => { if (!segs) { segs = []; subs.push(segs); start = cur } }
  // zero-length lines stay: a lone "M p L p" is a dot the laser fires
  const line = (p) => { segs.push(['l', cur, p]); cur = p; lastC = lastQ = null }
  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++]
    else if (!cmd) { i++; continue }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase()
    const P = (x, y) => (rel ? [cur[0] + x, cur[1] + y] : [x, y])
    if (C === 'Z') {
      if (segs && (cur[0] !== start[0] || cur[1] !== start[1])) segs.push(['l', cur, start])
      cur = start; segs = null; lastC = lastQ = null
      continue
    }
    if (i >= toks.length || isCmd(toks[i])) continue
    if (C === 'M') {
      cur = P(num(), num()); start = cur
      segs = []; subs.push(segs)
      cmd = rel ? 'l' : 'L'; lastC = lastQ = null
    } else if (C === 'L') {
      ensure(); const p = P(num(), num()); line(p)
    } else if (C === 'H') {
      ensure(); const x = num(); line([rel ? cur[0] + x : x, cur[1]])
    } else if (C === 'V') {
      ensure(); const y = num(); line([cur[0], rel ? cur[1] + y : y])
    } else if (C === 'C') {
      ensure(); const p1 = P(num(), num()), p2 = P(num(), num()), p = P(num(), num())
      segs.push(['c', cur, p1, p2, p]); cur = p; lastC = p2; lastQ = null
    } else if (C === 'S') {
      ensure(); const p1 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur
      const p2 = P(num(), num()), p = P(num(), num())
      segs.push(['c', cur, p1, p2, p]); cur = p; lastC = p2; lastQ = null
    } else if (C === 'Q' || C === 'T') {
      ensure()
      const q = C === 'Q' ? P(num(), num()) : (lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur)
      const p = P(num(), num())
      segs.push(['c', cur, [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])],
                 [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p])
      cur = p; lastQ = q; lastC = null
    } else if (C === 'A') {
      ensure()
      const rx = num(), ry = num(), rot = num(), fa = flag(), fs = flag(), p = P(num(), num())
      segs.push(...arcToCubics(cur[0], cur[1], rx, ry, (rot * Math.PI) / 180, fa, fs, p[0], p[1]))
      cur = p; lastC = lastQ = null
    } else i++
  }
  return subs.filter((s) => s.length)
}

const K = 0.5522847498
function ellipseSubs(cx, cy, rx, ry) {
  const kx = K * rx, ky = K * ry
  const p = (x, y) => [cx + x, cy + y]
  return [[
    ['c', p(rx, 0), p(rx, ky), p(kx, ry), p(0, ry)],
    ['c', p(0, ry), p(-kx, ry), p(-rx, ky), p(-rx, 0)],
    ['c', p(-rx, 0), p(-rx, -ky), p(-kx, -ry), p(0, -ry)],
    ['c', p(0, -ry), p(kx, -ry), p(rx, -ky), p(rx, 0)],
  ]]
}

function shapeSubs(el, vw, vh) {
  const A = el.attrs
  const L = (k, ref) => length(A[k], ref) ?? 0
  switch (el.tag) {
    case 'path': return parsePathData(A.d)
    case 'line': return [[['l', [L('x1', vw), L('y1', vh)], [L('x2', vw), L('y2', vh)]]]]
    case 'polyline':
    case 'polygon': {
      const n = nums(A.points)
      const pts = []
      for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]])
      if (pts.length < 2) return []
      if (el.tag === 'polygon') pts.push(pts[0])
      return [pts.slice(1).map((p, i) => ['l', pts[i], p])]
    }
    case 'rect': {
      const x = L('x', vw), y = L('y', vh), w = L('width', vw), h = L('height', vh)
      if (!(w > 0 && h > 0)) return []
      let rx = length(A.rx, vw), ry = length(A.ry, vh)
      if (rx == null) rx = ry ?? 0
      if (ry == null) ry = rx
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2)
      if (!(rx > 0 && ry > 0)) {
        return [[['l', [x, y], [x + w, y]], ['l', [x + w, y], [x + w, y + h]],
                 ['l', [x + w, y + h], [x, y + h]], ['l', [x, y + h], [x, y]]]]
      }
      const kx = K * rx, ky = K * ry
      return [[
        ['l', [x + rx, y], [x + w - rx, y]],
        ['c', [x + w - rx, y], [x + w - rx + kx, y], [x + w, y + ry - ky], [x + w, y + ry]],
        ['l', [x + w, y + ry], [x + w, y + h - ry]],
        ['c', [x + w, y + h - ry], [x + w, y + h - ry + ky], [x + w - rx + kx, y + h], [x + w - rx, y + h]],
        ['l', [x + w - rx, y + h], [x + rx, y + h]],
        ['c', [x + rx, y + h], [x + rx - kx, y + h], [x, y + h - ry + ky], [x, y + h - ry]],
        ['l', [x, y + h - ry], [x, y + ry]],
        ['c', [x, y + ry], [x, y + ry - ky], [x + rx - kx, y], [x + rx, y]],
      ]]
    }
    case 'circle': {
      const r = L('r', Math.hypot(vw, vh) / Math.SQRT2)
      return r > 0 ? ellipseSubs(L('cx', vw), L('cy', vh), r, r) : []
    }
    case 'ellipse': {
      const rx = L('rx', vw), ry = L('ry', vh)
      return rx > 0 && ry > 0 ? ellipseSubs(L('cx', vw), L('cy', vh), rx, ry) : []
    }
  }
  return []
}

// viewBox + preserveAspectRatio -> matrix from viewBox units to viewport
function viewBoxMatrix(vb, w, h, par) {
  if (!vb || !(vb[2] > 0 && vb[3] > 0)) return IDENT
  let sx = w / vb[2], sy = h / vb[3]
  const p = String(par || 'xMidYMid meet').trim()
  let tx = -vb[0] * sx, ty = -vb[1] * sy
  if (!p.startsWith('none')) {
    const slice = /slice/.test(p)
    const s = slice ? Math.max(sx, sy) : Math.min(sx, sy)
    const al = /x(Min|Mid|Max)Y(Min|Mid|Max)/.exec(p) || [null, 'Mid', 'Mid']
    const fx = { Min: 0, Mid: 0.5, Max: 1 }[al[1]], fy = { Min: 0, Mid: 0.5, Max: 1 }[al[2]]
    tx = -vb[0] * s + (w - vb[2] * s) * fx
    ty = -vb[1] * s + (h - vb[3] * s) * fy
    sx = sy = s
  }
  return [sx, 0, 0, sy, tx, ty]
}

const NON_RENDERED = new Set(['defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'style',
  'linearGradient', 'radialGradient', 'filter', 'title', 'desc', 'metadata', 'script', 'font',
  'font-face', 'foreignObject', 'sodipodi:namedview', 'namedview'])

/**
 * @returns {{ width, height, ops: Array, textElements: number }}
 *   width/height: page size in PDF points.
 *   ops: { kind: 'fill'|'stroke', subs, color, evenOdd } with subs in points
 *        (top-left origin), or { kind: 'image', href, ctm, width, height, par }
 *        where ctm maps the image's own (x,y,w,h) box in user units to points.
 */
export function parseSvg(text, { images = true } = {}) {
  const doc = parseXml(text)
  const svg = doc.children.find((c) => c.tag === 'svg')
  if (!svg) throw new Error('Keine SVG-Datei (kein <svg>-Element)')

  // CSS rules from every <style> block
  const styles = []
  const ids = new Map()
  const walkAll = (el) => {
    if (el.tag === 'style') styles.push(el.text)
    if (el.attrs?.id) ids.set(el.attrs.id, el)
    for (const c of el.children) walkAll(c)
  }
  walkAll(svg)
  const rules = parseCss(styles.join('\n'))

  // Root viewport: width/height (px, with units) else the viewBox size.
  const vb = nums(svg.attrs.viewBox)
  const vbOk = vb.length === 4 && vb[2] > 0 && vb[3] > 0
  const wPx = length(svg.attrs.width, vbOk ? vb[2] : 0) ?? (vbOk ? vb[2] : 300)
  const hPx = length(svg.attrs.height, vbOk ? vb[3] : 0) ?? (vbOk ? vb[3] : 150)
  const PT = 1
  const rootM = mul(vbOk ? viewBoxMatrix(vb, wPx, hPx, svg.attrs.preserveAspectRatio) : IDENT,
                    [PT, 0, 0, PT, 0, 0])
  const refW = vbOk ? vb[2] : wPx, refH = vbOk ? vb[3] : hPx

  const ops = []
  let textElements = 0
  const xf = (subs, m) => subs.map((segs) => segs.map((s) => [s[0], ...s.slice(1).map((p) => apply(m, p[0], p[1]))]))

  function render(el, m, inh, depth) {
    if (depth > 64) return
    const own = ownStyle(el, rules)
    const st = { ...inh, ...own }
    if (own.display === 'none') return
    const local = el.attrs.transform ? mul(parseTransform(el.attrs.transform), m) : m

    if (el.tag === 'svg' && depth > 0) {       // nested viewport
      const x = length(el.attrs.x, refW) ?? 0, y = length(el.attrs.y, refH) ?? 0
      const w = length(el.attrs.width, refW) ?? refW, h = length(el.attrs.height, refH) ?? refH
      const nvb = nums(el.attrs.viewBox)
      const vm = nvb.length === 4 ? viewBoxMatrix(nvb, w, h, el.attrs.preserveAspectRatio) : IDENT
      const mm = mul(mul(vm, [1, 0, 0, 1, x, y]), local)
      for (const c of el.children) render(c, mm, st, depth + 1)
      return
    }
    if (el.tag === 'g' || el.tag === 'svg' || el.tag === 'a' || el.tag === 'switch') {
      for (const c of el.children) render(c, local, st, depth + 1)
      return
    }
    if (el.tag === 'use') {
      const href = (el.attrs['xlink:href'] || el.attrs.href || '').replace(/^#/, '')
      const ref = ids.get(href)
      if (!ref) return
      const x = length(el.attrs.x, refW) ?? 0, y = length(el.attrs.y, refH) ?? 0
      const um = mul([1, 0, 0, 1, x, y], local)
      if (ref.tag === 'symbol') {
        const w = length(el.attrs.width, refW) ?? length(ref.attrs.width, refW)
        const h = length(el.attrs.height, refH) ?? length(ref.attrs.height, refH)
        const svb = nums(ref.attrs.viewBox)
        const vm = svb.length === 4 && w && h ? viewBoxMatrix(svb, w, h, ref.attrs.preserveAspectRatio) : IDENT
        for (const c of ref.children) render(c, mul(vm, um), st, depth + 1)
      } else {
        render(ref, um, st, depth + 1)
      }
      return
    }
    if (NON_RENDERED.has(el.tag)) return
    if (el.tag === 'text') {
      textElements++
      const op = textOp(el, st, mul(local, rootM))
      if (op) ops.push(op)
      return
    }
    if (el.tag === 'image') {
      if (!images || st.visibility === 'hidden') return
      const href = el.attrs['xlink:href'] || el.attrs.href || ''
      const x = length(el.attrs.x, refW) ?? 0, y = length(el.attrs.y, refH) ?? 0
      const w = length(el.attrs.width, refW) ?? 0, h = length(el.attrs.height, refH) ?? 0
      if (href && w > 0 && h > 0) {
        ops.push({ kind: 'image', href, box: [x, y, w, h], ctm: mul(local, rootM), par: el.attrs.preserveAspectRatio })
      }
      return
    }
    const subs0 = shapeSubs(el, refW, refH)
    if (!subs0.length || st.visibility === 'hidden') return
    const subs = xf(subs0, mul(local, rootM))
    const color = st.color ? parseColor(st.color) : undefined
    // SVG defaults: fill black, stroke none; lines/polylines are never filled
    const fill = st.fill === undefined ? '#000000' : parseColor(st.fill, color)
    const stroke = st.stroke === undefined ? null : parseColor(st.stroke, color)
    if (fill && el.tag !== 'line') {
      ops.push({ kind: 'fill', subs, color: fill, evenOdd: (st['fill-rule'] || '').trim() === 'evenodd' })
    }
    if (stroke) ops.push({ kind: 'stroke', subs, color: stroke })
  }

  // <text>: spans with optional absolute x/y, relative dx/dy, and their style.
  // Layout (advance widths, text-anchor) needs the font, so it happens in the
  // caller. Whitespace collapses like in SVG's default xml:space.
  function textOp(el, st0, ctm) {
    const spans = []
    const first = (v) => { const n = String(v ?? '').trim().split(/[\s,]+/)[0]; return n ? length(n, refW) : null }
    const walk = (node, inh) => {
      for (const c of node.children) {
        if (c.tag === '#text') {
          const str = c.text.replace(/\s+/g, ' ')
          if (str) spans.push({ str, ...pick(inh) })
          continue
        }
        if (c.tag !== 'tspan' && c.tag !== 'a') continue
        const own = ownStyle(c, rules)
        if (own.display === 'none') continue
        const s = { ...inh, ...own }
        spans.push({ str: '', x: first(c.attrs.x), y: first(c.attrs.y), dx: first(c.attrs.dx) || 0, dy: first(c.attrs.dy) || 0, ...pick(s) })
        walk(c, s)
      }
    }
    const pick = (s) => {
      const color = s.color ? parseColor(s.color) : undefined
      return {
        size: length(s['font-size'], 16) ?? 12,
        family: String(s['font-family'] || '').toLowerCase(),
        weight: String(s['font-weight'] || 'normal').toLowerCase(),
        italic: /italic|oblique/i.test(s['font-style'] || ''),
        anchor: String(s['text-anchor'] || 'start').trim(),
        fill: s.fill === undefined ? '#000000' : parseColor(s.fill, color),
        stroke: s.stroke === undefined ? null : parseColor(s.stroke, color),
        hidden: s.visibility === 'hidden',
      }
    }
    spans.push({ str: '', x: first(el.attrs.x) ?? 0, y: first(el.attrs.y) ?? 0,
                 dx: first(el.attrs.dx) || 0, dy: first(el.attrs.dy) || 0, ...pick(st0) })
    walk(el, st0)
    // trim the whole element's leading/trailing blanks
    const texts = spans.filter((sp) => sp.str)
    if (!texts.length) return null
    texts[0].str = texts[0].str.replace(/^ /, '')
    texts[texts.length - 1].str = texts[texts.length - 1].str.replace(/ $/, '')
    return { kind: 'text', ctm, spans }
  }

  render(svg, IDENT, {}, 0)
  return { width: wPx * PT, height: hPx * PT, ops, textElements }
}
