// Fittet BEIDE Schichten des Zeitmodells (Anzeige des Job Managers und
// tatsaechlich gebrauchte Zeit) mit dem PRODUKTIVCODE als Geometrie-Quelle.
//
//   cd frontend && node --import ../docs/calib/register.mjs ../docs/calib/fit_all.mjs [write]
//
// Daten:
//   * fit_model.py DATA / MEASURED  - Messreihen 1-4 (01-61, alle Speeds)
//   * data/kompakt.json             - kompakter Satz 80-93 und die Zeilen
//                                     darunter (python extract_kompakt.py)
//   * data/*.pdf                    - echte Dateien aus diesen Zeilen. Nicht im
//                                     Repo (Arbeiten anderer Leute); fehlen sie,
//                                     werden diese Zeilen uebersprungen.
//
// Ablauf: Fuer jeden Lauf rechnet buildToolpath() EINMAL die Geometrie
// (Reihenfolge, Haltepunkte, Laenge jeder durchgehenden Fahrt, Leerwege,
// Scanzeilen). Die Zeit ist danach eine geschlossene Formel in den
// Konstanten - genau die, die toolpath.js rechnet (geprueft: Abweichung zur
// echten Funktion wird ausgegeben). So laesst sich ueber alle Laeufe und alle
// Konstanten gleichzeitig fitten (Levenberg-Marquardt).
//
// "write" schreibt die Konstanten in fitted_all.json.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as T from '../../frontend/src/toolpath.js'
import { CALIBRATION as CAL, REALITY, rasterSpeedForPct, rasterLineOverheadForPct } from '../../frontend/src/calibration.js'
import { svgToData } from './svg_to_data.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RSPD = [10, 20, 40, 60, 80, 100]

// ── Messdaten ────────────────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(HERE, 'fit_model.py'), 'utf8')
const meas = new Map()
for (const m of src.match(/MEASURED = \{([\s\S]*?)\n\}/)[1]
  .matchAll(/\("([^"]+)", (None|\d+), (\d+)\): \((None|\d+), (None|\d+)\)/g)) {
  meas.set(`${m[1]}|${m[2]}|${m[3]}`, [m[4], m[5]].map((v) => (v === 'None' ? null : Number(v))))
}
const num = (v) => (v === 'None' || v == null ? null : Number(v))
export const RUNS = []
for (const m of src.match(/DATA = \[([\s\S]*?)\n\]/)[1]
  .matchAll(/\("([^"]+)", (None|\d+), (\d+|"[\d/]+"), (None|\d+), (None|\d+)\)/g)) {
  const [, file, dpi, sp, est, opt] = m
  const speed = sp.replace(/"/g, '')
  const [vp, rp] = speed.includes('/') ? speed.split('/').map(Number) : [Number(speed), Number(speed)]
  const [me, mo] = meas.get(`${file}|${dpi}|${speed}`) || [null, null]
  RUNS.push({ set: 'alt', file, dpi: num(dpi), vpct: { cut: vp, engrave: vp, other: vp }, rpct: rp, speed,
              est: num(est), opt: num(opt), meas: me, opt_meas: mo })
}
const kompakt = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'kompakt.json'), 'utf8'))
for (const r of kompakt) {
  if (/\.pdf$/i.test(r.file)) {
    // "20 fuer cut und 100 fuer gravur"
    const name = r.file.split(/[\\/]/).pop()
    if (!fs.existsSync(path.join(HERE, 'data', name))) continue
    RUNS.push({ set: 'real', file: name, pdf: path.join(HERE, 'data', name), dpi: 600,
                vpct: { cut: 20, engrave: 100, other: 100 }, rpct: 100, speed: '20/100',
                est: r.est, opt: r.opt, meas: r.meas, opt_meas: r.opt_meas })
    continue
  }
  if (r.file === '92_k_raster_bild') continue          // Bild: Tinte braucht den Browser (imageInk)
  const [vp, rp] = r.speed.includes('/') ? r.speed.split('/').map(Number) : [Number(r.speed), Number(r.speed)]
  RUNS.push({ set: 'kompakt', file: r.file, dpi: r.dpi, vpct: { cut: vp, engrave: vp, other: vp }, rpct: rp,
              speed: r.speed, est: r.est, opt: r.opt, meas: r.meas, opt_meas: r.opt_meas })
}

// ── Geometrie einmal aus dem Produktivcode ──────────────────────────────────
let pdfLoader = null
async function loadData(run) {
  if (!run.pdf) return svgToData(run.file)
  if (!pdfLoader) {
    const root = path.join(HERE, '..', '..', 'frontend')
    const pdfjs = await import('../../frontend/node_modules/pdfjs-dist/legacy/build/pdf.mjs')
    globalThis.pdfjsWorker = await import('../../frontend/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
    const { extractDocument } = await import('../../frontend/src/pdf/extract.js')
    const { WATERMARKS } = await import('../../frontend/src/pdf/watermarks.js')
    const assets = path.join(root, 'node_modules', 'pdfjs-dist')
    const opts = { watermarks: WATERMARKS, loadAsset: async (d, f) => new Uint8Array(fs.readFileSync(path.join(assets, d, f))) }
    pdfLoader = async (f) => (await extractDocument(pdfjs, fs.readFileSync(f), path.basename(f), opts)).lines
  }
  return pdfLoader(run.pdf)
}

export function speedsFor(run, kv = CAL.vectorMaxSpeed / 100) {
  return { cut: kv * run.vpct.cut, engrave: kv * run.vpct.engrave, other: kv * run.vpct.other,
           raster: rasterSpeedForPct(run.rpct), travel: CAL.travelSpeed }
}

// Merkmale eines Laufs fuer eine Spalte ('file' = ohne Optimieren, 'nn' = mit).
export function features(data, run, algo) {
  const speeds = speedsFor(run)
  const { moves, stats } = T.buildToolpath(data, { optimize: algo, speeds,
    rasterPitch: run.dpi ? 25.4 / run.dpi : undefined, accel: CAL.vectorAccel })
  const F = { algo, vec: [], travel: [], raster: [], display: stats.displayTime, real: stats.totalTime, stats }
  for (const m of moves) {
    if (m.approach) continue                     // Anfahrt ins Raster: Zeit steckt im Band
    if (m.kind === 'travel') { F.travel.push({ L: T.dist(m.a, m.b), home: !!m.home }); continue }
    if (m.category === 'raster') {
      const pts = T.movePolyline(m)
      let L = 0
      for (let i = 1; i < pts.length; i++) L += T.dist(pts[i - 1], pts[i])
      F.raster.push({ L, rows: m.rows || 0, pitch: m.pitch || 0, pct: run.rpct })
      continue
    }
    const pts = T.movePolyline(m)
    const r = T.rampSegments(pts, m.v, 1, 0, T.forcedStopsFor(m))
    const segs = []
    for (let i = 1; i < pts.length; i++) { const L = T.dist(pts[i - 1], pts[i]); if (L < 20) segs.push(L) }
    // Summe (1 - cos Knick) ueber die Knicke, an denen NICHT gehalten wird
    let bend = 0
    const cosLim = Math.cos(CAL.cornerAngleDeg * Math.PI / 180), forced = T.forcedStopsFor(m)
    for (let i = 1; i < pts.length - 1; i++) {
      if (forced && forced[i]) continue
      const ax = pts[i].x - pts[i - 1].x, ay = pts[i].y - pts[i - 1].y, bx = pts[i + 1].x - pts[i].x, by = pts[i + 1].y - pts[i].y
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
      if (la < 1e-9 || lb < 1e-9) continue
      const c = (ax * bx + ay * by) / (la * lb)
      if (c >= cosLim) bend += 1 - c
    }
    F.vec.push({ pct: run.vpct[m.kind] ?? run.vpct.other, runs: r.runLens, joined: !!m.joined, file: !!m.vertexStops, segs, bend })
  }
  return F
}

// ── Die Zeitformel von toolpath.js, in den Konstanten P ─────────────────────
export const accel = (P, v) => P.a0 + P.a1 * v
export function displayTime(P0, F) {
  // Mit "Optimieren" eigene Vektor-Konstanten (CALIBRATION.optimized)
  const P = F.algo !== 'file' && P0.opt ? { ...P0, ...P0.opt } : P0
  let t = P.c0
  const rt = P.j > 0 ? (S, v, a) => T.sCurveTime(S, v, a, P.j) : T.rampedTime
  for (const m of F.vec) {
    const v = P.kv * m.pct + (P.kv0 || 0), a = accel(P, v)
    for (const S of m.runs) t += rt(S, v, a)
    t += (m.runs.length - 1) * (P.p0 + (P.p1 || 0) * v)
    if (m.joined) t += P.pj
    if (m.file) t += P.pf
    if (P.tm) for (const L of m.segs) if (L / v < P.tm) t += P.tm - L / v
    t += P.g * v * m.bend
  }
  const at = P.at > 0 ? P.at : accel(P, P.vt)
  for (const tr of F.travel) t += rt(tr.L, P.vt, at) + (tr.home ? 0 : P.pv)
  for (const r of F.raster) t += r.L * (1 + P.bd * (r.pitch ? 25.4 / r.pitch : 0)) / P.vr[r.pct] + r.rows * (P.ovh[r.pct] + P.yf * r.pitch) + (r.rows ? P.rb : 0)
  return t
}

// Schicht 2: dieselbe Formel mit den Konstanten der echten Maschine.
export function realTime(R, F) {
  let t = displayTime({ ...R, opt: null }, F)
  for (const r of F.raster) if (r.rows) t += R.rpl * r.rows + R.rph * r.rows * r.pitch
  return t
}
export function currentReal() {
  const P = currentParams()
  return { ...P, kv0: REALITY.speedOffset, a0: REALITY.vectorAccel, a1: REALITY.accelPerSpeed,
           p0: REALITY.stopPenalty, p1: REALITY.stopPenaltyPerSpeed, pv: REALITY.vectorStartPenalty, pf: REALITY.fileObjectPenalty || 0,
           vt: REALITY.travelSpeed, rpl: REALITY.rasterPerLine, rph: REALITY.rasterPerMmHeight }
}

export function currentParams() {
  return {
    kv: CAL.vectorMaxSpeed / 100, a0: CAL.vectorAccel, a1: CAL.accelPerSpeed || 0,
    p0: CAL.cornerPenalty, pv: CAL.vectorStartPenalty, pj: CAL.objectStopPenalty, pf: CAL.fileObjectPenalty || 0,
    p1: 0, kv0: 0, j: 0, tm: CAL.minSegmentTime || 0, at: CAL.travelAccel || 0, rb: CAL.rasterBandOverhead || 0, bd: CAL.rasterDpiSlowdown || 0, g: CAL.bendPenalty || 0,
    yf: CAL.rasterYFeed, c0: CAL.jobOverhead, vt: CAL.travelSpeed,
    opt: CAL.optimized ? { a0: CAL.optimized.vectorAccel, a1: CAL.optimized.accelPerSpeed,
                           p0: CAL.optimized.cornerPenalty, pv: CAL.optimized.vectorStartPenalty } : null,
    vr: Object.fromEntries(RSPD.map((p) => [p, rasterSpeedForPct(p)])),
    ovh: Object.fromEntries(RSPD.map((p) => [p, rasterLineOverheadForPct(p)])),
  }
}

// ── Parameter <-> Vektor ─────────────────────────────────────────────────────
export function makeSpec(free) {
  const spec = []
  for (const k of free) {
    if (k === 'vr' || k === 'ovh') for (const p of RSPD) spec.push([k, p])
    else if (k === 'opt') for (const p of ['a0', 'a1', 'p0', 'pv']) spec.push([k, p])
    else spec.push([k])
  }
  return spec
}
const getP = (P, [k, p]) => (p == null ? P[k] : P[k][p])
const setP = (P, [k, p], v) => { if (p == null) P[k] = v; else P[k][p] = v }
const clone = (P) => ({ ...P, vr: { ...P.vr }, ovh: { ...P.ovh }, opt: P.opt ? { ...P.opt } : P.opt })

// Levenberg-Marquardt mit numerischer Jacobi-Matrix.
export function lm(P0, spec, resid, { iters = 60, log = false } = {}) {
  let P = clone(P0)
  let r = resid(P), cost = r.reduce((s, x) => s + x * x, 0), lam = 1e-3
  for (let it = 0; it < iters; it++) {
    const n = spec.length, J = []
    for (let j = 0; j < n; j++) {
      const v0 = getP(P, spec[j]), h = Math.max(1e-7, Math.abs(v0) * 1e-5)
      const Pp = clone(P); setP(Pp, spec[j], v0 + h)
      const Pm = clone(P); setP(Pm, spec[j], v0 - h)
      const rp = resid(Pp), rm = resid(Pm)
      J.push(rp.map((x, i) => (x - rm[i]) / (2 * h)))
    }
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => J[i].reduce((s, x, k) => s + x * J[j][k], 0)))
    const g = J.map((col) => col.reduce((s, x, k) => s + x * r[k], 0))
    let improved = false
    for (let tries = 0; tries < 12; tries++) {
      const M = A.map((row, i) => row.map((x, j) => x + (i === j ? lam * (A[i][i] || 1e-12) : 0)))
      const d = solve(M, g.map((x) => -x))
      const Pn = clone(P)
      spec.forEach((s, j) => setP(Pn, s, getP(P, s) + d[j]))
      const rn = resid(Pn), cn = rn.reduce((s, x) => s + x * x, 0)
      if (Number.isFinite(cn) && cn < cost) { P = Pn; r = rn; improved = cost - cn > 1e-12 * cost; cost = cn; lam = Math.max(lam / 3, 1e-9); break }
      lam *= 4
    }
    if (log) console.log(`  it ${it} cost ${cost.toExponential(4)} lam ${lam.toExponential(1)}`)
    if (!improved) break
  }
  return { P, cost }
}
function solve(M, b) {
  const n = b.length, A = M.map((r, i) => [...r, b[i]])
  for (let i = 0; i < n; i++) {
    let p = i
    for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k
    ;[A[i], A[p]] = [A[p], A[i]]
    for (let k = i + 1; k < n; k++) {
      const f = A[k][i] / A[i][i]
      for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j]
    }
  }
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = A[i][n]
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]
    x[i] = s / A[i][i]
  }
  return x
}

// ── Merkmale aller Laeufe ────────────────────────────────────────────────────
export async function loadAll({ verbose = false } = {}) {
  const cache = new Map()
  for (const run of RUNS) {
    const key = run.pdf || run.file
    if (!cache.has(key)) cache.set(key, await loadData(run))
    const data = cache.get(key)
    run.F = { file: features(data, run, 'file'), nn: features(data, run, 'nn') }
    if (verbose) process.stdout.write('.')
  }
  if (verbose) process.stdout.write('\n')
  return RUNS
}

// Spalten einer Messung: [Spalte, Algo, angezeigt, gemessen]
export const cols = (run) => [['est', 'file', run.est, run.meas], ['opt', 'nn', run.opt, run.opt_meas]]

// ── Hauptprogramm ────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  for (const kv of (process.env.CAL || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); CAL[k] = v === 'true' ? true : v === 'false' ? false : Number(v) }
  await loadAll({ verbose: true })
  const P0 = currentParams()
  // Selbsttest: die Formel muss die Anzeige von toolpath.js exakt treffen.
  let worst = 0
  for (const run of RUNS) for (const [, algo] of cols(run)) worst = Math.max(worst, Math.abs(displayTime(P0, run.F[algo]) - run.F[algo].display))
  console.log(`Formel vs. toolpath.js: groesste Abweichung ${worst.toExponential(2)} s`)
  if (REALITY.vectorAccel) {
    const Rc = currentReal()
    let w2 = 0
    for (const run of RUNS) for (const [, algo] of cols(run)) w2 = Math.max(w2, Math.abs(realTime(Rc, run.F[algo]) - run.F[algo].real))
    console.log(`Realzeit-Formel vs. toolpath.js: groesste Abweichung ${w2.toExponential(2)} s`)
  }

  const rows = []
  for (const run of RUNS) for (const [col, algo, shown] of cols(run)) {
    if (shown == null) continue
    if (run.set === 'alt' && ['01_overhead_dot', '02_overhead_shortline'].includes(run.file)) continue
    // Vom alten Export (Doppelte-Entfernen hatte die Pfadstuecke verstreut):
    // ohne "Optimieren" 167 s daneben, durch keine Regel erklaerbar, die nicht
    // alles andere verschlechtert. Nur angezeigt, nicht gefittet.
    if (col === 'est' && /produktionsdatei_B/i.test(run.file) && !process.env.ALLREAL) run.excluded = true
    rows.push({ run, col, algo, shown })
  }
  // Gewicht: Anzeige auf ganze Sekunden (+-0,5 s) plus 1 % Modellunschaerfe -
  // so zaehlen kurze Laeufe nicht ueberproportional und lange echte Jobs nicht
  // unter (ein 1273-s-Job ist auf 0,5 s genau abgelesen).
  const sigma = (y) => Math.hypot(0.5, (Number(process.env.REL || 1) / 100) * y)
  const resid = (P) => rows.map((x) => (x.run.excluded && x.col === 'est' ? 0 : (displayTime(P, x.run.F[x.algo]) - x.shown) / sigma(x.shown)))
  const report = (P, label) => {
    const byset = {}
    for (const x of rows) {
      const pred = displayTime(P, x.run.F[x.algo]), e = pred - x.shown
      ;(byset[x.run.set] ||= []).push({ x, pred, e, pc: 100 * e / x.shown })
    }
    console.log(`\n${label}`)
    for (const [k, list] of Object.entries(byset)) {
      const a = list.map((l) => Math.abs(l.pc)), s = list.map((l) => Math.abs(l.e))
      console.log(`  ${k.padEnd(8)} n=${String(list.length).padStart(3)}  Ø ${(a.reduce((p, q) => p + q, 0) / a.length).toFixed(2)} %  max ${Math.max(...a).toFixed(1)} %  |  Ø ${(s.reduce((p, q) => p + q, 0) / s.length).toFixed(2)} s  max ${Math.max(...s).toFixed(1)} s  ueber 0,5 s: ${s.filter((v) => v > 0.5).length}`)
    }
    return byset
  }
  report(P0, 'AKTUELL (calibration.js)')
  const free = (process.env.FREE || 'kv,a0,a1,p0,pv,pj,pf,rb,bd,yf,c0,vr,ovh').split(',')
  let { P } = lm(P0, makeSpec(free), resid, { iters: 80 })
  // Zweite Stufe: mit "Optimieren" eigene Vektor-Konstanten (OPT=1)
  if (process.env.OPT) {
    if (!P.opt) P.opt = { a0: P.a0, a1: P.a1, p0: P.p0, pv: P.pv }
    P = lm(P, makeSpec([...free, 'opt']), resid, { iters: 80 }).P
  }
  const byset = report(P, 'GEFITTET')
  console.log('\nKonstanten:')
  if (P.opt) console.log(`  opt: a0 ${P.opt.a0.toFixed(0)} a1 ${P.opt.a1.toFixed(3)} p0 ${P.opt.p0.toFixed(4)} pv ${P.opt.pv.toFixed(4)}`)
  for (const k of ['kv', 'a0', 'a1', 'p0', 'pv', 'pj', 'pf', 'g', 'tm', 'at', 'vt', 'rb', 'bd', 'yf', 'c0']) console.log(`  ${k.padEnd(3)} ${P0[k].toPrecision(5).padStart(10)} -> ${P[k].toPrecision(5)}`)
  for (const p of RSPD) console.log(`  ${String(p).padStart(3)} %  v ${P0.vr[p].toFixed(1)} -> ${P.vr[p].toFixed(1)}   ovh ${(P0.ovh[p] * 1000).toFixed(2)} -> ${(P.ovh[p] * 1000).toFixed(2)} ms`)
  console.log('\nGroesste Abweichungen:')
  const all = Object.values(byset).flat().sort((a, b) => Math.abs(b.e) - Math.abs(a.e))
  for (const l of all.slice(0, 25)) console.log(`  ${l.x.run.set.padEnd(7)} ${l.x.run.file.slice(0, 34).padEnd(34)} ${String(l.x.run.speed).padStart(6)} ${String(l.x.run.dpi ?? '').padStart(4)} ${l.x.col}  angezeigt ${String(l.x.shown).padStart(5)}  Modell ${l.pred.toFixed(1).padStart(7)}  ${l.e >= 0 ? '+' : ''}${l.e.toFixed(1)} s`)
  if (process.argv.includes('write')) fs.writeFileSync(path.join(HERE, 'fitted_all.json'), JSON.stringify(P, null, 1))

  // ── Schicht 2: Anzeige -> gemessene Zeit ──────────────────────────────────
  // Linear in Merkmalen der Geometrie, gefittet gegen (gemessen - ABGELESENE
  // Anzeige). Bewertet wird am Ende Modell-Anzeige + Korrektur gegen gemessen.
  const RF = (process.env.RFEAT || 'rows,height,contours,travel,stops,stopsV').split(',')
  const feat = (F, run) => {
    let rows = 0, height = 0, contours = 0, stops = 0, stopsV = 0, joined = 0, runsV = 0
    for (const r of F.raster) { if (r.rows) { rows += r.rows; height += r.rows * r.pitch } }
    for (const m of F.vec) {
      const v = P.kv * m.pct
      contours++
      stops += m.runs.length - 1; stopsV += (m.runs.length - 1) * v
      runsV += m.runs.length * v
      if (m.joined) joined++
    }
    let travel = 0
    for (const tr of F.travel) travel += tr.L
    const all = { rows, height, contours, travel, stops, stopsV, joined, runsV }
    return RF.map((k) => all[k])
  }
  const mrows = []
  for (const run of RUNS) for (const [col, algo, shown, me] of cols(run)) {
    if (me == null || shown == null) continue
    if (['01_overhead_dot', '02_overhead_shortline'].includes(run.file)) continue
    mrows.push({ run, col, algo, shown, me, x: feat(run.F[algo], run), disp: displayTime(P, run.F[algo]) })
  }
  const n = RF.length
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0)
  for (const r of mrows) {
    const w = 1 / sigma(r.me) ** 2, y = r.me - r.shown
    for (let i = 0; i < n; i++) { b[i] += w * r.x[i] * y; for (let j = 0; j < n; j++) A[i][j] += w * r.x[i] * r.x[j] }
  }
  const coef = solve(A, b)
  const oldMap = { rows: REALITY.rasterPerLine, height: REALITY.rasterPerMmHeight, contours: REALITY.vectorPerContour,
                   travel: REALITY.vectorPerMmTravel, stops: REALITY.vectorPerStop, stopsV: REALITY.vectorPerStopPerSpeed || 0 }
  const evalR = (c) => {
    const e = mrows.map((r) => ({ r, pred: r.disp + c.reduce((s, ci, i) => s + ci * r.x[i], 0) }))
    e.forEach((x) => { x.e = x.pred - x.r.me })
    return e
  }
  const summ = (e, label) => {
    const bys = {}
    for (const x of e) (bys[x.r.run.set] ||= []).push(Math.abs(x.e))
    console.log(label, Object.entries(bys).map(([k, v]) => `${k} n=${v.length} Ø ${(v.reduce((p, q) => p + q, 0) / v.length).toFixed(2)} s max ${Math.max(...v).toFixed(1)} s, >1 s: ${v.filter((q) => q > 1).length}`).join('  |  '))
  }
  console.log('\nREALITAET (gemessen) - Modell-Anzeige + Korrektur:')
  summ(evalR(RF.map(() => 0)), '  ohne Korrektur:  ')
  summ(evalR(RF.map((k) => oldMap[k] ?? 0)), '  alte REALITY:    ')
  const eN = evalR(coef)
  summ(eN, '  neu gefittet:    ')
  console.log('  Koeffizienten:', RF.map((k, i) => `${k}=${coef[i].toPrecision(4)}`).join('  '))
  for (const x of [...eN].sort((p, q) => Math.abs(q.e) - Math.abs(p.e)).slice(0, 14)) {
    console.log(`    ${x.r.run.set.padEnd(7)} ${x.r.run.file.slice(0, 22).padEnd(22)} ${String(x.r.run.speed).padStart(6)} ${x.r.col}  angezeigt ${x.r.shown} gemessen ${x.r.me}  Modell ${x.pred.toFixed(1)}  ${x.e >= 0 ? '+' : ''}${x.e.toFixed(1)}`)
  }
  if (process.argv.includes('write')) fs.writeFileSync(path.join(HERE, 'fitted_reality.json'), JSON.stringify(Object.fromEntries(RF.map((k, i) => [k, coef[i]])), null, 1))

  // Variante B: eigene Kinematik der echten Maschine (gleiche Formel, eigene
  // Konstanten) + Raster je Zeile / je mm Hoehe.
  const R0 = { ...clone(P), rpl: REALITY.rasterPerLine, rph: REALITY.rasterPerMmHeight, j: Number(process.env.RJ || 0) }
  const RFREE = (process.env.RFREE || 'a0,a1,p0,pv,pj,vt,rpl,rph').split(',')
  const rres = (R) => mrows.map((r) => (realTime(R, r.run.F[r.algo]) - r.me) / sigma(r.me))
  const { P: R } = lm(R0, makeSpec(RFREE), rres, { iters: 80 })
  const eB = mrows.map((r) => { const pred = realTime(R, r.run.F[r.algo]); return { r, pred, e: pred - r.me } })
  summ(eB, '  eigene Kinematik: ')
  console.log('  Konstanten:', RFREE.map((k) => `${k}=${(+R[k]).toPrecision(4)}`).join('  '))
  for (const x of [...eB].sort((p, q) => Math.abs(q.e) - Math.abs(p.e)).slice(0, 14)) {
    console.log(`    ${x.r.run.set.padEnd(7)} ${x.r.run.file.slice(0, 22).padEnd(22)} ${String(x.r.run.speed).padStart(6)} ${x.r.col}  angezeigt ${x.r.shown} gemessen ${x.r.me}  Modell ${x.pred.toFixed(1)}  ${x.e >= 0 ? '+' : ''}${x.e.toFixed(1)}`)
  }
  if (process.argv.includes('write')) fs.writeFileSync(path.join(HERE, 'fitted_real_kin.json'), JSON.stringify(R, null, 1))

  // ── Test: vier getrennte Fits (je Spalte eigene Konstanten) ──────────────
  if (process.env.SPLIT) {
    const st = (list) => { const a = list.map(Math.abs); return `n=${a.length} Ø ${(a.reduce((p, q) => p + q, 0) / a.length).toFixed(2)} s max ${Math.max(...a).toFixed(1)} s` }
    for (const col of ['est', 'opt']) {
      const sub = rows.filter((x) => x.col === col)
      const r1 = (Q) => sub.map((x) => (x.run.excluded && x.col === 'est' ? 0 : (displayTime(Q, x.run.F[x.algo]) - x.shown) / sigma(x.shown)))
      const { P: Q } = lm(P, makeSpec(free), r1, { iters: 80 })
      const errJ = sub.filter((x) => !(x.run.excluded && x.col === 'est')).map((x) => displayTime(P, x.run.F[x.algo]) - x.shown)
      const errS = sub.filter((x) => !(x.run.excluded && x.col === 'est')).map((x) => displayTime(Q, x.run.F[x.algo]) - x.shown)
      console.log(`  Anzeige ${col}: gemeinsam ${st(errJ)}  |  eigener Fit ${st(errS)}`)
      console.log('     ', ['kv', 'a0', 'a1', 'p0', 'pv', 'pj', 'pf', 'rb', 'yf', 'c0'].map((k) => `${k} ${(+P[k]).toPrecision(3)}->${(+Q[k]).toPrecision(3)}`).join('  '))
      for (const x of sub.filter((x) => x.run.set === 'real')) console.log(`      ${x.run.file.slice(22, 50)} ${x.col} ${x.shown}: gemeinsam ${(displayTime(P, x.run.F[x.algo]) - x.shown).toFixed(1)}  eigener ${(displayTime(Q, x.run.F[x.algo]) - x.shown).toFixed(1)}`)
      const msub = mrows.filter((x) => x.col === col)
      const r2 = (Q2) => msub.map((x) => (realTime(Q2, x.run.F[x.algo]) - x.me) / sigma(x.me))
      const { P: Q2 } = lm(R, makeSpec(RFREE), r2, { iters: 80 })
      console.log(`  gemessen ${col}: gemeinsam ${st(msub.map((x) => realTime(R, x.run.F[x.algo]) - x.me))}  |  eigener Fit ${st(msub.map((x) => realTime(Q2, x.run.F[x.algo]) - x.me))}`)
    }
  }
}

// Tabelle aller Zeilen eines Satzes (FIT_TABLE=kompakt)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.env.FIT_TABLE) {
  const P = JSON.parse(fs.readFileSync(path.join(HERE, 'fitted_all.json'), 'utf8'))
  for (const run of RUNS.filter((r) => r.set === process.env.FIT_TABLE)) {
    const c = cols(run).map(([col, algo, shown]) => shown == null ? `${col} -` : `${col} ${shown} ${(displayTime(P, run.F[algo]) - shown >= 0 ? '+' : '')}${(displayTime(P, run.F[algo]) - shown).toFixed(1)}`)
    console.log(`  ${run.file.slice(0, 22).padEnd(22)} ${String(run.speed).padStart(6)} ${String(run.dpi ?? '').padStart(4)}   ${c.join('   ')}`)
  }
}
