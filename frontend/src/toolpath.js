// Machine toolpath construction.
//
// Mirrors the ordering logic of the old PyQt program (Reference/old version of
// the program.py, AnalysisThread.run): classify paths by colour, run the
// engrave phase before the cut phase, optionally nearest-neighbour optimise the
// order within each phase, and insert travel ("Leerwege") moves between paths.
//
import { CALIBRATION, REALITY, rasterLineOverheadForPct, rasterPctForSpeed }
  from './calibration'

// Geometry is kept as PRIMITIVES - a path is a list of line ('L') and cubic
// bezier ('C') primitives. Beziers stay beziers all the way through; they are
// only tessellated (adaptively, by arc length) at render time. Coordinates are
// in viewer space (mm, origin top-left, y negative downward). The print head
// starts at the top-left (0,0).

// Default head speeds (mm/s). Used as a FALLBACK when no printer/material profile
// is selected; otherwise buildToolpath receives resolved speeds via opts.speeds.
export const SPEED_MM_S = {
  engrave: 80,   // red vector engrave
  raster:  200,  // raster (green/grayscale) engrave
  cut:     30,   // blue layer
  other:   60,   // anything uncategorised
  travel: 250,   // rapid moves between paths (no beam)
}

// Raster (boustrophedon engraving) parameters - green and grayscale content is
// engraved by scanning horizontally back and forth over its bounding box.
const RASTER_PITCH    = 0.6   // mm between scan lines (vertical step) - fallback only
// Overscan is NOT a fixed distance: it is the turnaround run-out, so it grows
// with the SQUARE of the raster speed (~0,9 mm per side at 20 %, ~22 mm at
// 100 %). rasterOverscanFor() derives it; see calibration.js.
const RASTER_MAX_ROWS = 20000 // safety cap. Was 1200, which silently capped every
                              // region taller than ~50 mm at 600 dpi (pitch grew,
                              // rows dropped) and made the estimate far too fast.
const RASTER_GREEN    = '#00a000'  // colour of green-region scan lines
// Marker colour for grayscale-image (bitmap) scan lines - NOT the actual
// rendered colour. A fixed hex can't be right in both themes (white vanishes
// on the light theme's white bed), so the viewer swaps this for a real
// per-theme colour (white on dark, dark gray on light) at render time. Kept
// exported so ThreeViewer.vue can recognise it; picked memorably far from any
// real ink colour so it's never confused with genuine content.
export const RASTER_BITMAP_MARK = '#fffffe'
const RASTER_GRAY = RASTER_BITMAP_MARK

// Hand-removal heuristic: every closed cut contour is a part that must be picked
// out by hand, so what drives the extra handling time is the COUNT, not the size.
// The size filter is kept (tunable) but set effectively "off" so all parts count.
const SMALL_PART_MM = 1e6

// Grid-fall heuristic: a part this small (≈ 1.5 × 0.8 cm or less) can drop through
// the cutter's honeycomb/slat grid; retrieving it costs time. These get the
// separate "may fall through" warning and the optional viewer highlight.
const TINY_PART_W = 15   // mm - larger side
const TINY_PART_H = 8    // mm, shorter side
// A closed contour only counts as a part if it encloses at least this much.
const MIN_PART_AREA = 0.01   // mm²

// Signed area enclosed by a polyline (shoelace), mm². Always closes the loop
// from the last point back to the first, so a nearly-closed contour still
// measures right and a lone short line comes out as 0.
function enclosedArea(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

// Time (s) to traverse a path of length L at target speed v (mm/s) with finite
// acceleration a (mm/s²), assuming the head starts and ends at rest. With a<=0
// this is just constant-speed L/v. On short paths the head never reaches v
// (triangular profile); otherwise it's a trapezoid.
export function rampedTime(L, v, a) {
  if (!v || v <= 0 || L <= 0) return 0
  if (!a || a <= 0) return L / v
  const dAcc = (v * v) / (2 * a)          // distance to ramp 0→v
  if (2 * dAcc <= L) return 2 * (v / a) + (L - 2 * dAcc) / v   // trapezoid
  return 2 * Math.sqrt(L / a)             // triangle (peak < v)
}

// Same, but JERK-limited (S-shaped speed curve): the acceleration itself
// ramps up and down at j mm/s³ instead of jumping to a. Rest to rest over S,
// target speed v. Closed form, no iteration; with j <= 0 it is rampedTime.
// NOT used by the app: docs/calib/fit_all.mjs tried it for the real machine
// (2026-11-20) and every finite jerk fitted worse than none.
export function sCurveTime(S, v, a, j) {
  if (!v || v <= 0 || S <= 0) return 0
  if (!a || a <= 0) return S / v
  if (!j || j <= 0) return rampedTime(S, v, a)
  // time to go from rest to speed u: without reaching a, or with a plateau at a
  const accT = (u) => (u * j < a * a ? 2 * Math.sqrt(u / j) : u / a + a / j)
  const tv = accT(v), dv = (v * tv) / 2       // the run-up covers v * t / 2 (symmetric curve)
  if (2 * dv <= S) return 2 * tv + (S - 2 * dv) / v
  // too short for v: peak speed u where up + down cover exactly S
  const uj = (a * a) / j
  const u = uj * accT(uj) >= S
    ? Math.cbrt((S * S * j) / 4)
    : (a / 2) * (-a / j + Math.sqrt((a / j) ** 2 + (4 * S) / a))
  return 2 * accT(u)
}

// Direction change (between consecutive segments) sharper than this forces the
// head to a full stop - the velocity profile restarts from rest. Catches raster
// turnarounds (180°) and the vertical step between scan rows (90°), which is
// exactly where a real machine decelerates, stops and reverses.
//
// MEASURED (see calibration.js cornerAngleDeg): the threshold is 30°. The
// angle series 45–49 varies ONLY the bend angle at constant length and corner
// count: 8°/14°/20°/26° all cost 139 s optimised, 32° jumps to 154 s; the
// 12-sided polygon (30° corners) at 100 % shows no stops. Above it, 45°, 90°
// and 150° cost exactly the same (84-86): a full stop, no partial braking.
// Read at call time (not frozen at import), so the fit scripts in docs/calib
// can try other constants on the production code.
const cornerCos = () => Math.cos((CALIBRATION.cornerAngleDeg * Math.PI) / 180)

// Acceleration of a vector or travel move at head speed v (mm/s). `accel` is
// the printer profile's value at standstill; the machine's estimate assumes
// MORE acceleration the faster the speed setting (see calibration.js
// accelPerSpeed), so a short stroke at 100 % is quicker than at 40 % although
// neither reaches full speed.
export const accelAt = (v, accel) => (accel > 0 ? accel + (CALIBRATION.accelPerSpeed || 0) * (v || 0) : 0)

// Raster and vector run on DIFFERENT acceleration regimes: the calibrated raster
// line overhead already contains the whole turnaround, so raster scan lines are
// modelled at constant speed (a = 0) to avoid charging the ramp twice.
// buildToolpath stores each move's speed (m.v) and the acceleration law of its
// mode (m.a0, m.a1: "Optimieren" on or off, calibration.js `optimized`).
export const accelFor = (m, accel) => {
  if (m.category === 'raster') return 0
  if (m.a0 != null) return m.a0 > 0 ? m.a0 + m.a1 * (m.v || 0) : 0
  return accelAt(m.v, accel)
}

// Same reasoning for the per-stop penalty: a scan row's turnaround is already
// paid for by the overscan run-out plus the per-line overhead, so charging
// CORNER_PENALTY again at each row end (2 per row) would double-count it -
// worth ~80 s on an 80 mm tall region at 600 dpi.
export const cornerPenaltyFor = (m) => (m.category === 'raster' ? 0 : (m.p0 ?? CALIBRATION.cornerPenalty))

// Extra time (s) charged on a move beyond the traversal of its own geometry:
//   travel - the fixed cost of starting the next vector;
//   raster - the SPEED-INDEPENDENT part of the per-scan-line overhead plus the
//            Y feed, once per scan row (m.rows). Both come straight from the
//            measured table (m.lineOverhead), no longer from a formula.
//   vector - an object that starts right where the previous one ended (no
//            travel in between) still costs a full stop (m.joined), see
//            calibration.js objectStopPenalty.
export const moveExtraTime = (m) => {
  if (m.kind === 'travel') return m.home ? 0 : (m.pv ?? CALIBRATION.vectorStartPenalty)   // home leg starts no vector
  if (m.category === 'raster' && m.rows) {
    return (CALIBRATION.rasterBandOverhead || 0) + m.rows * (m.lineOverhead + CALIBRATION.rasterYFeed * m.pitch)
  }
  if (m.prims) return m.joined ? CALIBRATION.objectStopPenalty : 0
  return 0
}

// NO overscan is drawn any more. It used to be derived from the per-line
// overhead on the assumption that the overhead IS a run-out, so charging it as
// distance kept geometry and timing consistent. The measured overhead is
// U-shaped over speed (see calibration.js), which no run-out can produce - so
// the assumption was wrong, the overhead is now a tabulated TIME, and drawing a
// made-up overhang would only add time the machine does not spend (scan rows
// run at a = 0, so every drawn mm costs time).

// Speed (mm/s) at distance s along a run of length S that starts and ends at
// rest, with target speed v and acceleration a (trapezoid, or triangle when the
// run is too short to reach v).
function speedAt(s, S, v, a) {
  const dAcc = (v * v) / (2 * a)
  if (2 * dAcc <= S) {
    if (s < dAcc)     return Math.sqrt(2 * a * s)
    if (s > S - dAcc) return Math.sqrt(Math.max(0, 2 * a * (S - s)))
    return v
  }
  const half = S / 2
  return s <= half ? Math.sqrt(2 * a * s) : Math.sqrt(Math.max(0, 2 * a * (S - s)))
}

// Time (s) + average speed (mm/s) to traverse the sub-interval [s0,s1] of a run
// of length S that starts/ends at rest. Split at the trapezoid/triangle phase
// boundaries; within an accel/decel phase Δt = |Δv| / a, within cruise Δt = L/v.
function profileSeg(s0, s1, S, v, a) {
  const len = s1 - s0
  if (len <= 0) return { dt: 0, vavg: v }
  if (!a || a <= 0 || !v || v <= 0) return { dt: v > 0 ? len / v : 0, vavg: v }
  const dAcc = (v * v) / (2 * a)
  const bounds = 2 * dAcc <= S ? [dAcc, S - dAcc] : [S / 2]
  const pts = [s0]
  for (const b of bounds) if (b > s0 && b < s1) pts.push(b)
  pts.push(s1)
  let dt = 0
  for (let k = 0; k < pts.length - 1; k++) {
    const x0 = pts[k], x1 = pts[k + 1], xm = (x0 + x1) / 2
    const cruise = 2 * dAcc <= S && xm >= dAcc && xm <= S - dAcc
    if (cruise) dt += (x1 - x0) / v
    else dt += Math.abs(speedAt(x1, S, v, a) - speedAt(x0, S, v, a)) / a
  }
  return { dt, vavg: dt > 0 ? len / dt : v }
}

// Flatten a machine move into its traversed polyline (array of points).
export function movePolyline(m) {
  if (m.kind === 'travel') return [m.a, m.b]
  const pts = []
  for (const prim of m.prims) {
    const pp = flattenPrim(prim)
    if (pts.length) pts.push(...pp.slice(1))   // dedupe the shared join point
    else pts.push(...pp)
  }
  return pts
}

// "Optimieren" OFF on the machine (path order 'file'): MEASURED, the head stops
// at EVERY original vertex of a straight-segment path, not only at corners
// sharper than cornerAngleDeg. Points that come from flattening a real bezier
// are exempt - the machine drives curves through. Evidence, est (off) vs opt
// (on) column of messprotokoll.xlsx: 51_poly_circles 94 s vs 74 s,
// 50_bezier_circles 74 s vs 74 s, 14_circle_d80 169 s vs 145 s. Same rule as
// moves_and_stops(every_vertex=True) in docs/calib/fit_model.py.
//
// This is why joining Archicad's exploded 0,2 mm pieces into one path changes
// nothing with "Optimieren" off: every join is still a straight-line vertex.
// Only turning them into curves (or switching "Optimieren" on) removes the stops.
//
// Returns one flag per point of movePolyline(m) (true = forced stop), or null
// when the move has none.
export function forcedStopsFor(m) {
  if (!m.vertexStops || !m.prims) return null
  const flags = []
  m.prims.forEach((prim, k) => {
    const n = prim.t === 'L' ? 2 : flattenPrim(prim).length
    for (let i = flags.length === 0 ? 0 : 1; i < n; i++) flags.push(false)   // join point deduped, like movePolyline
    if (k < m.prims.length - 1 && prim.t === 'L') flags[flags.length - 1] = true
  })
  return flags
}

/**
 * Acceleration-aware per-segment timing for a polyline. The head starts and ends
 * at rest AND comes to rest at every sharp corner, so each raster scan line
 * accelerates from / decelerates to its turnaround. (Without this, a whole
 * serpentine is one constant-speed move and the acceleration value barely changes
 * the estimate - which is why accel "had no effect".)
 *
 * @returns {{ durs:number[], speeds:number[], total:number }}
 *   durs[i] / speeds[i] = duration (s) and average speed (mm/s) of segment i.
 */
export function rampSegments(points, v, a, cornerPenalty = CALIBRATION.cornerPenalty, forced = null) {
  const n = points.length - 1
  if (n <= 0) return { durs: [], speeds: [], total: 0 }
  const segs = []
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[i + 1]
    const dx = q.x - p.x, dy = q.y - p.y
    const L = Math.hypot(dx, dy)
    segs.push({ L, ux: L > 1e-9 ? dx / L : 0, uy: L > 1e-9 ? dy / L : 0 })
  }
  // Mark vertices where the head must stop (run boundaries).
  const cosLim = cornerCos()
  const stop = new Array(n + 1).fill(false)
  stop[0] = true; stop[n] = true
  for (let i = 1; i < n; i++) {
    if (forced && forced[i]) { stop[i] = true; continue }   // see forcedStopsFor
    const a0 = segs[i - 1], a1 = segs[i]
    if (a0.L < 1e-9 || a1.L < 1e-9) { stop[i] = true; continue }
    if (a0.ux * a1.ux + a0.uy * a1.uy < cosLim) stop[i] = true
  }
  const durs = new Array(n).fill(0)
  const speeds = new Array(n).fill(v)
  const runLens = []                          // length of every run (docs/calib fit scripts)
  let total = 0, runs = 0
  for (let rs = 0; rs < n; ) {
    let re = rs + 1
    while (re < n && !stop[re]) re++          // run = segments [rs, re)
    let S = 0
    for (let k = rs; k < re; k++) S += segs[k].L
    runLens.push(S)
    let s0 = 0
    for (let k = rs; k < re; k++) {
      const s1 = s0 + segs[k].L
      const { dt, vavg } = profileSeg(s0, s1, S, v, a)
      // Charge the stop that STARTS this run (every run but the first).
      const pen = (k === rs && rs > 0) ? cornerPenalty : 0
      durs[k] = dt + pen; speeds[k] = vavg; total += dt + pen
      s0 = s1
    }
    rs = re
    runs++
  }
  // runs - 1 = full stops INSIDE the polyline; runLens for the fit scripts.
  return { durs, speeds, total, runs, runLens }
}

/**
 * Annotate each segment of a polyline with its place in the velocity profile, so
 * the renderer can shade speed + reveal time PER FRAGMENT instead of subdividing
 * the geometry. The polyline keeps its natural tessellation (a straight line stays
 * one segment); the smooth ramp is reconstructed on the GPU from these numbers.
 *
 * @returns {Array<{ s0, s1, S, dur, runStartRel }>} one entry per segment:
 *   s0/s1       arc-length (mm) of the segment's endpoints within its run
 *   S           total length (mm) of the run (between two corner stops)
 *   dur         duration (s) of the segment under the acceleration profile
 *   runStartRel time (s) at the run's start, relative to the polyline start
 */
export function annotateRuns(points, v, a, cornerPenalty = CALIBRATION.cornerPenalty, forced = null) {
  const n = points.length - 1
  const out = []
  if (n <= 0) return out

  const segL = []
  for (let i = 0; i < n; i++) {
    segL.push(Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y))
  }
  // Corner stops (same rule as rampSegments): the head rests at run boundaries.
  const cosLim = cornerCos()
  const stop = new Array(points.length).fill(false)
  stop[0] = true; stop[n] = true
  for (let i = 1; i < n; i++) {
    if (forced && forced[i]) { stop[i] = true; continue }   // see forcedStopsFor
    const ax = points[i].x - points[i - 1].x, ay = points[i].y - points[i - 1].y
    const bx = points[i + 1].x - points[i].x, by = points[i + 1].y - points[i].y
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
    if (la < 1e-9 || lb < 1e-9) { stop[i] = true; continue }
    if ((ax * bx + ay * by) / (la * lb) < cosLim) stop[i] = true
  }

  let cumTime = 0   // relative to the polyline start
  for (let rs = 0; rs < n; ) {
    let re = rs + 1
    while (re < n && !stop[re]) re++          // run = segments [rs, re)
    let S = 0
    for (let k = rs; k < re; k++) S += segL[k]
    cumTime += (rs > 0 ? cornerPenalty : 0)   // stop that starts this run
    const runStartRel = cumTime
    let s0 = 0
    for (let k = rs; k < re; k++) {
      const s1 = s0 + segL[k]
      const { dt } = profileSeg(s0, s1, S, v, a)
      out[k] = { s0, s1, S, dur: dt, runStartRel }
      cumTime += dt
      s0 = s1
    }
    rs = re
  }
  return out
}

const GRAY_TOL = 0.12   // max channel spread for a colour to count as grayscale

export function categorize(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  // Green must stay low too: otherwise orange/yellow counted as red (vector
  // engrave) and cyan as blue (cut) - see "werkzeug tests/edge cases".
  if (b > 0.8 && r < 0.2 && g < 0.35) return 'blue'
  if (r > 0.8 && b < 0.2 && g < 0.35) return 'red'
  if (g > 0.5 && r < 0.4) return 'green'
  // grayscale (black / white / any gray) is raster-engraved, like a bitmap.
  if (Math.max(r, g, b) - Math.min(r, g, b) < GRAY_TOL) return 'gray'
  return 'other'
}

// Colours engraved as a raster (green fills + any grayscale content).
export const isGreen = (hex) => categorize(hex || '#000000') === 'green'
export const isGray  = (hex) => categorize(hex || '#000000') === 'gray'
export const isRasterColor = (hex) => { const c = categorize(hex || '#000000'); return c === 'green' || c === 'gray' }

// Map a colour category to a machine operation (drives speed + travel grouping).
export function kindOf(category) {
  if (category === 'blue')  return 'cut'
  if (category === 'other') return 'other'
  return 'engrave' // red, green, gray
}

// ── Edits (Fix Colors / Remove Doubles) ───────────────────────────────────────
// Both operate on the raw extraction object list and return new data so the
// caller can swap it in as the single source of truth (and export it).

// Canonical pure colours each near-colour snaps to.
const PURE_RED   = '#ff0000'
const PURE_BLUE  = '#0000ff'
const PURE_GREEN = '#00ff00'

// Grober Fangbereich fuer "Farben korrigieren", gedacht fuer Anfaenger, die
// "irgendein Rot" oder "irgendein Blau" gewaehlt haben (#c00000, #e03030,
// dunkelrot, #3366ff, marineblau ...). Bewusst GROB und ohne Regler: wer
// absichtlich Sonderfarben nutzt, hat Rot und Blau ohnehin exakt eingetragen.
// Massgeblich ist der Farbton, damit Orange (~30°), Gelb (60°), Cyan (180°)
// und Violett (~280°) NICHT gefangen werden. Fast-Grau und fast-Schwarz
// bleiben ebenfalls, wie sie sind (zu wenig Saettigung bzw. Helligkeit).
// categorize() bleibt streng - sie entscheidet ueber das Routing ohne Klick.
const SNAP_HUE = {           // [von, bis] in Grad, Bereich darf ueber 0° laufen
  red:   [340, 18],
  blue:  [205, 262],
  green: [85, 155],
}
const SNAP_MIN_SAT = 0.45    // HSV-Saettigung
const SNAP_MIN_VAL = 0.25    // HSV-Helligkeit (dunkelrot #800000 = 0,5 zaehlt)

function hsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  return { h: (h + 360) % 360, s: max > 0 ? d / max : 0, v: max }
}

// Ziel-Reinfarbe fuer Striche (rot/blau) bzw. Fuellungen (gruen), sonst null.
function snapTarget(hex, isFill) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return null
  const { h, s, v } = hsv(hex)
  if (s < SNAP_MIN_SAT || v < SNAP_MIN_VAL) return null
  const inHue = ([a, b]) => (a <= b ? h >= a && h <= b : h >= a || h <= b)
  if (isFill) return inHue(SNAP_HUE.green) ? PURE_GREEN : null
  if (inHue(SNAP_HUE.red)) return PURE_RED
  if (inHue(SNAP_HUE.blue)) return PURE_BLUE
  return null
}

/**
 * Snap roughly-red / roughly-blue strokes and roughly-green fills to their
 * canonical value (see SNAP_HUE). Everything else is left untouched.
 * Returns a new array (shallow-copied items).
 */
export function fixColors(data) {
  // Only clone (i.e. "change") an object when the colour ACTUALLY differs from the
  // pure target - so re-running is idempotent and the changed-count is truthful
  // (a file that is already pure red/blue/green reports 0 fixed).
  return data.map((obj) => {
    if (obj.type === 'l' || obj.type === 'c') {
      const t = snapTarget(obj.color, false)
      if (t && obj.color.toLowerCase() !== t) return { ...obj, color: t }
    } else if (obj.type === 'fp') {
      const t = snapTarget(obj.fill, true)
      if (t && obj.fill.toLowerCase() !== t) return { ...obj, fill: t }
    }
    return obj
  })
}

// ── Remove Doubles (overlap removal) ──────────────────────────────────────────
// Removes redundant coverage where strokes lie on top of one another:
//   • same colour, exactly or partially on top → keep ONE copy
//   • red on top of blue                       → the red part goes (the cut
//                                                 already removes that material)
// Works on the REAL geometry: straight segments stay segments and beziers stay
// beziers (trimmed with de Casteljau), so nothing is degraded to the polyline
// the viewer happens to draw.
//
// Two properties matter and are guaranteed by construction:
//   1. A primitive that survives untouched is emitted from its OWN coordinates,
//      never rebuilt from a group average - so unaffected geometry is bit-identical
//      and closed contours keep closing.
//   2. Grouping compares every member against a fixed group REPRESENTATIVE, not
//      against its neighbour. Neighbour-chaining used to let hundreds of lines at
//      wildly different angles collapse into one "collinear" group.
//
// Returns { data, removed } - removed carries the dropped pieces as line segments
// for the viewer's highlight.

const OVERLAP_EPS = 0.02    // mm - ignore sub-epsilon slivers
const ANGLE_TOL   = 0.012   // rad ≈ 0.7°, max tilt against the group representative
const C_TOL       = 0.08    // mm, max perpendicular distance from the representative
const CURVE_TOL   = 0.05    // mm, how close two beziers must run to count as one

// ── 1D interval helpers ───────────────────────────────────────────────────────
function mergeIv(list) {
  if (list.length === 0) return []
  const s = list.map(x => x.slice()).sort((a, b) => a[0] - b[0])
  const out = [s[0]]
  for (let i = 1; i < s.length; i++) {
    const last = out[out.length - 1]
    if (s[i][0] <= last[1] + 1e-7) last[1] = Math.max(last[1], s[i][1])
    else out.push(s[i])
  }
  return out
}
function subtractIv(A, B) {            // A minus B (both merged)
  let segs = A.map(x => x.slice())
  for (const [b0, b1] of B) {
    const next = []
    for (const [a0, a1] of segs) {
      if (b1 <= a0 || b0 >= a1) { next.push([a0, a1]); continue }
      if (b0 > a0) next.push([a0, b0])
      if (b1 < a1) next.push([b1, a1])
    }
    segs = next
  }
  return segs
}

// ── Grouping of collinear straight segments ───────────────────────────────────
// Membership is decided against the group's representative, which bounds a
// group's spread to the tolerance.
//
// Candidates come from a grid of GROUP_CELL mm cells: every member registers
// itself in the cells it passes through. A group is joined only if one of its
// members really OVERLAPS the new piece (on the group's axis) - only overlaps
// are doubles, and unlike "near enough to show up in a nearby cell" that does
// not depend on where the cell borders fall, i.e. on where the drawing sits. (The old hash on (angle, offset from the origin) did: one
// angle bucket further, the offset moved by up to ANGLE_TOL x distance from
// the origin, i.e. millimetres, and real doubles were missed or found
// depending on the position. Moving the drawing turned up new ones.)
const angDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, Math.PI - d) }
const GROUP_CELL = 2   // mm, >= 2 * C_TOL so a 3x3 neighbourhood always reaches

function groupCollinear(segs) {
  const groups = []
  const parent = []                             // merged groups point to the survivor
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i }
  const cells = new Map()                       // cell -> items registered there
  const cOf = (ang, x, y) => -Math.sin(ang) * x + Math.cos(ang) * y
  const cellsOf = (s) => {                      // cells along the segment, both ends included
    const n = Math.max(1, Math.ceil(Math.hypot(s.x2 - s.x1, s.y2 - s.y1) / GROUP_CELL))
    const out = new Set()
    for (let i = 0; i <= n; i++) {
      const f = i / n
      out.add(`${Math.floor((s.x1 + (s.x2 - s.x1) * f) / GROUP_CELL)}|${Math.floor((s.y1 + (s.y2 - s.y1) * f) / GROUP_CELL)}`)
    }
    return out
  }
  // 1e-9 slack: 3-decimal PDF coordinates hit the tolerance exactly, and float
  // noise must not decide those differently after the drawing moved.
  const fits = (g, a, x, y) => angDist(a, g.a) <= ANGLE_TOL + 1e-9 && Math.abs(cOf(g.a, x, y) - g.c) <= C_TOL + 1e-7
  const project = (g, it) => {
    const t1 = g.ux * it.s.x1 + g.uy * it.s.y1
    const t2 = g.ux * it.s.x2 + g.uy * it.s.y2
    it.lo = Math.min(t1, t2); it.hi = Math.max(t1, t2); it.flip = t2 < t1
    return it
  }

  segs.forEach((s, seq) => {
    let a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)
    if (a < 0) a += Math.PI
    if (a >= Math.PI) a -= Math.PI
    const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2
    const own = cellsOf(s)

    const seen = new Set(), ok = new Map()      // item / group (-> fits?) already looked at
    const hitSet = new Set()
    for (const key of own) {
      const [cx, cy] = key.split('|').map(Number)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = cells.get(`${cx + dx}|${cy + dy}`)
          if (!list) continue
          for (const it of list) {
            if (seen.has(it)) continue
            seen.add(it)
            const gi = find(it.g)
            if (hitSet.has(gi)) continue
            const g = groups[gi]
            if (!ok.has(gi)) ok.set(gi, fits(g, a, mx, my))
            if (!ok.get(gi)) continue
            const t1 = g.ux * s.x1 + g.uy * s.y1, t2 = g.ux * s.x2 + g.uy * s.y2
            if (Math.min(Math.max(t1, t2), it.hi) - Math.max(Math.min(t1, t2), it.lo) > OVERLAP_EPS) hitSet.add(gi)
          }
        }
      }
    }
    const hits = [...hitSet].sort((p, q) => p - q)

    let gi
    if (hits.length === 0) {
      gi = groups.length
      groups.push({ a, c: cOf(a, mx, my), px: mx, py: my, ux: Math.cos(a), uy: Math.sin(a), items: [] })
      parent.push(gi)
    } else {
      // Lowest (= oldest) group wins. A piece bridging two groups merges them,
      // but only when their representatives agree within the tolerance, so a
      // chain of merges cannot drift away from the survivor's line.
      gi = hits[0]
      const g = groups[gi]
      for (const other of hits.slice(1)) {
        const o = groups[other]
        if (!fits(g, o.a, o.px, o.py)) continue
        for (const it of o.items) g.items.push(project(g, it))
        o.items = null
        parent[other] = gi
      }
    }
    // Project onto the group's axis; keep the ORIGINAL endpoints for emitting.
    const item = project(groups[gi], { s, seq, g: gi })
    groups[gi].items.push(item)
    for (const key of own) {
      if (!cells.has(key)) cells.set(key, [])
      cells.get(key).push(item)
    }
  })
  // Inside a group, file order decides who keeps a shared stretch.
  return groups.filter((g) => g.items).map((g) => { g.items.sort((p, q) => p.seq - q.seq); return g })
}

// ── Bezier helpers ────────────────────────────────────────────────────────────
const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

function bezSplitRight(p, t) {                  // control points of [t,1]
  const a = lerpP(p[0], p[1], t), b = lerpP(p[1], p[2], t), c = lerpP(p[2], p[3], t)
  const d = lerpP(a, b, t), e = lerpP(b, c, t)
  return [lerpP(d, e, t), e, c, p[3]]
}
function bezSplitLeft(p, t) {                   // control points of [0,t]
  const a = lerpP(p[0], p[1], t), b = lerpP(p[1], p[2], t), c = lerpP(p[2], p[3], t)
  const d = lerpP(a, b, t), e = lerpP(b, c, t)
  return [p[0], a, d, lerpP(d, e, t)]
}
function bezSub(p, t0, t1) {                    // sub-curve on [t0,t1]
  if (t1 - t0 <= 1e-9) return null
  const q = t0 > 1e-9 ? bezSplitRight(p, t0) : p
  const tt = t0 > 1e-9 ? (t1 - t0) / (1 - t0) : t1
  return tt < 1 - 1e-9 ? bezSplitLeft(q, tt) : q
}
const bezAt = (p, t) => cubicAt({ p0: p[0], p1: p[1], p2: p[2], p3: p[3] }, t)

// Parameter on `p` closest to `pt`: coarse scan, then a short bisection refine.
function nearestT(p, pt) {
  let bt = 0, bd = Infinity
  for (let i = 0; i <= 48; i++) {
    const t = i / 48, q = bezAt(p, t)
    const d = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2
    if (d < bd) { bd = d; bt = t }
  }
  let step = 1 / 48
  for (let k = 0; k < 24; k++) {
    step /= 2
    for (const t of [bt - step, bt + step]) {
      if (t < 0 || t > 1) continue
      const q = bezAt(p, t)
      const d = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2
      if (d < bd) { bd = d; bt = t }
    }
  }
  return { t: bt, dist: Math.sqrt(bd) }
}

// Unit tangent of `p` at parameter `t` (finite difference - plenty accurate at
// the mm scale these curves live at).
function tangentAt(p, t, h = 1e-3) {
  const t0 = Math.max(0, t - h), t1 = Math.min(1, t + h)
  if (t1 - t0 < 1e-9) return { x: 0, y: 0 }
  const a = bezAt(p, t0), b = bezAt(p, t1)
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  return len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 0, y: 0 }
}
// Two curves running near-parallel within CROSS_ANGLE_TOL of each other (in
// either direction - a retraced sub-curve may be reversed) at their closest
// point. Below this, a match is a genuine crossing, not shared geometry.
const CROSS_ANGLE_COS = Math.cos((20 * Math.PI) / 180)   // 20°

// Which parameter ranges of `cp` run along `other`?
//
// Sampling beats trying to solve for an affine parameter mapping: it covers full
// containment AND partial overlap, in either direction, and needs no assumption
// about how the two curves were split. Position alone isn't enough, though: two
// DIFFERENT curves that cross (e.g. two circles offset by less than CURVE_TOL at
// their nearest point, like intentionally overlapping rings) can dip within
// tolerance over a real arc near the crossing, not just a single point - so a
// match also requires the TANGENT directions to be parallel (or antiparallel).
// A transversal crossing has clearly different tangents and is correctly
// rejected; a genuinely shared/retraced curve has matching tangents throughout.
function onOther(cp, other, t) {
  const p = bezAt(cp, t)
  const { t: u, dist } = nearestT(other, p)
  if (dist > CURVE_TOL) return false
  const ta = tangentAt(cp, t), tb = tangentAt(other, u)
  const dot = ta.x * tb.x + ta.y * tb.y
  return Math.abs(dot) >= CROSS_ANGLE_COS
}

function refineBoundary(cp, other, tOff, tOn) {   // bisect towards the "on" side
  for (let k = 0; k < 18; k++) {
    const m = (tOff + tOn) / 2
    if (onOther(cp, other, m)) tOn = m; else tOff = m
  }
  return tOn
}

// A genuine shared/duplicate arc is always ANCHORED at one of cp's own
// endpoints: real duplicates come from copying a whole curve, or splitting a
// path and duplicating a piece - either way, the shared range starts where cp
// starts or ends where cp ends (verified against both passing overlap tests
// below). A match that sits entirely in cp's INTERIOR, touching neither end,
// is a coincidence, not shared geometry - and coincidences do happen: two
// circles offset by a small fraction of their radius cross at a shallow angle
// (this pair crosses at ~3°), so position AND tangent direction both stay
// within tolerance for a real stretch near each crossing even though the
// circles are genuinely different. Discarding interior-only matches is what
// tells the two situations apart; tightening CURVE_TOL can't, since at the
// exact crossing point the gap is mathematically zero regardless of tolerance.
//
// "Anchored" is measured as physical distance (mm) from cp's own start/end
// POINT, not parameter distance - a parameter epsilon doesn't scale with the
// curve's real length (a tiny parameter slice of a large arc is still several
// hundredths of a mm, which is exactly the scale a false crossing sits at).
const ANCHOR_MM = OVERLAP_EPS   // same "negligible" scale used for line slivers

// Endpoint-anchoring alone still lets one thing through: two ADJACENT curve
// primitives of the very same shape (e.g. a circle built from 4 quarter-arc
// beziers) share an exact point by construction, and are typically drawn G1-
// continuous there (matching tangents), so the same shallow-angle situation
// happens again - briefly, right at that shared joint - even though nothing
// is actually redundant (the two arcs just meet, they don't overlap). A real
// duplicate/retraced arc runs alongside the other curve for a substantial
// stretch; a joint's false match dies out within a fraction of a mm. Requiring
// a minimum matched length throws out the joint artefact while comfortably
// clearing every genuine case above (tens of mm in this file's real content).
const MIN_MATCH_MM = 0.15

function arcLen(cp, t0, t1, steps = 8) {
  let len = 0, prev = bezAt(cp, t0)
  for (let i = 1; i <= steps; i++) {
    const p = bezAt(cp, t0 + (t1 - t0) * (i / steps))
    len += Math.hypot(p.x - prev.x, p.y - prev.y)
    prev = p
  }
  return len
}

function coveredRanges(cp, other) {
  const N = 64
  const flag = []
  for (let i = 0; i <= N; i++) flag.push(onOther(cp, other, i / N))
  const out = []
  let s = null
  for (let i = 0; i <= N; i++) {
    const on = flag[i]
    if (on && s === null) s = i
    if ((!on || i === N) && s !== null) {
      const e = on ? i : i - 1
      let lo = s / N, hi = e / N
      if (s > 0) lo = refineBoundary(cp, other, (s - 1) / N, s / N)
      if (e < N) hi = refineBoundary(cp, other, (e + 1) / N, e / N)
      const dLo = Math.hypot(bezAt(cp, lo).x - cp[0].x, bezAt(cp, lo).y - cp[0].y)
      const dHi = Math.hypot(bezAt(cp, hi).x - cp[3].x, bezAt(cp, hi).y - cp[3].y)
      const anchored = dLo <= ANCHOR_MM || dHi <= ANCHOR_MM
      if (hi - lo > 1e-6 && anchored && arcLen(cp, lo, hi) >= MIN_MATCH_MM) out.push([lo, hi])
      s = null
    }
  }
  return out
}

const bboxOf = (p) => ({
  x0: Math.min(p[0].x, p[1].x, p[2].x, p[3].x), x1: Math.max(p[0].x, p[1].x, p[2].x, p[3].x),
  y0: Math.min(p[0].y, p[1].y, p[2].y, p[3].y), y1: Math.max(p[0].y, p[1].y, p[2].y, p[3].y),
})
const bboxHit = (a, b, tol) =>
  a.x0 - tol <= b.x1 && b.x0 - tol <= a.x1 && a.y0 - tol <= b.y1 && b.y0 - tol <= a.y1

function curveToSegs(p, sink) {
  const pts = flattenPrim({ t: 'C', p0: p[0], p1: p[1], p2: p[2], p3: p[3] })
  for (let i = 0; i < pts.length - 1; i++)
    sink.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
}

/**
 * Remove doubled / overlapping coverage. See header above.
 *
 * Runs until nothing changes any more: cutting an overlap out of a line leaves
 * remainders, and those can themselves lie on top of a third line - one pass
 * used to leave them for a second click (e.g. 405, then 4 more on a production file).
 * @returns {{ data: Array, removed: Array<{x1,y1,x2,y2}> }}
 */
const DOUBLES_MAX_PASSES = 8
export function computeDoubleRemoval(data) {
  let cur = data
  const removed = []
  for (let pass = 0; pass < DOUBLES_MAX_PASSES; pass++) {
    const r = doubleRemovalPass(cur)
    if (!r.removed.length) break
    removed.push(...r.removed)
    cur = r.data
  }
  return { data: removed.length ? cur : data, removed }
}

function doubleRemovalPass(data) {
  // Survivors go back to the position of the object they came from, so the
  // file order stays as it was. (They used to come out sorted by collinear
  // group: after the Autopilot's second doubles pass the pieces of one joined
  // path were scattered, and the PDF export wrote every stretch as its own path.)
  const slots = new Map()   // original object -> its surviving pieces
  const put = (o, piece) => { if (!slots.has(o)) slots.set(o, []); slots.get(o).push(piece) }
  const dropped = new Set()
  const removed = []    // dropped pieces, as segments for the highlight
  // Cut points land on the extraction's 0.001 mm grid (pdf/extract.js), so a
  // trimmed piece is the same here as after saving and re-loading the PDF -
  // otherwise a gap of 0.01006 mm stays open now and closes after re-loading.
  const r3 = (v) => Math.round(v * 1000) / 1000

  // Blue is processed before red so red always loses against a cut; within one
  // colour the first occurrence in the file wins.
  const rank = (o) => (categorize(o.color || '#000000') === 'blue' ? 0 : 1)
  const lines = [], curves = []
  for (const o of data) {
    const cat = (o.type === 'l' || o.type === 'c') ? categorize(o.color || '#000000') : null
    if (o.type === 'l' && (cat === 'red' || cat === 'blue')) {
      if (Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 1e-9) { dropped.add(o); continue }   // zero length → drop
      lines.push(o)
    } else if (o.type === 'c' && (cat === 'red' || cat === 'blue')) {
      curves.push(o)
    }
  }
  lines.sort((a, b) => rank(a) - rank(b))
  curves.sort((a, b) => rank(a) - rank(b))

  // ── Straight segments ───────────────────────────────────────────────────────
  const segView = lines.map(o => ({ x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2, o }))
  for (const g of groupCollinear(segView)) {
    let covered = []                                   // what earlier members took
    for (const it of g.items) {
      const o = it.s.o
      const keep = subtractIv([[it.lo, it.hi]], covered)
      covered = mergeIv([...covered, [it.lo, it.hi]])
      const span = it.hi - it.lo
      // Emit surviving pieces from the ORIGINAL endpoints (never from group means).
      const A = { x: o.x1, y: o.y1 }, B = { x: o.x2, y: o.y2 }
      const at = (t) => {
        const f = it.flip ? (it.hi - t) / span : (t - it.lo) / span
        return lerpP(A, B, f)
      }
      const emit = (ivs, sink) => {
        for (const [t0, t1] of ivs) {
          if (t1 - t0 <= OVERLAP_EPS) continue
          const p = at(t0), q = at(t1)
          if (sink === 'out') put(o, { ...o, x1: r3(p.x), y1: r3(p.y), x2: r3(q.x), y2: r3(q.y) })
          else removed.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y })
        }
      }
      if (keep.length === 1 && keep[0][0] === it.lo && keep[0][1] === it.hi) {
        put(o, o)                                      // untouched → byte-identical
      } else {
        emit(keep, 'out')
        emit(subtractIv([[it.lo, it.hi]], keep), 'removed')
      }
    }
  }

  // ── Bezier curves ───────────────────────────────────────────────────────────
  const kept = []                                      // {cp, bbox} already placed
  for (const o of curves) {
    const cp = [{ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 },
                { x: o.x3, y: o.y3 }, { x: o.x4, y: o.y4 }]
    const bb = bboxOf(cp)
    let ranges = [[0, 1]]                              // still-alive part of THIS curve
    for (const k of kept) {
      if (!bboxHit(bb, k.bbox, CURVE_TOL)) continue
      for (const cov of coveredRanges(cp, k.cp)) ranges = subtractIv(ranges, [cov])
      if (ranges.length === 0) break
    }
    const full = ranges.length === 1 && ranges[0][0] <= 1e-9 && ranges[0][1] >= 1 - 1e-9
    if (full) {
      put(o, o)
      kept.push({ cp, bbox: bb })
      continue
    }
    for (const [t0, t1] of subtractIv([[0, 1]], ranges)) curveToSegs(bezSub(cp, t0, t1) || cp, removed)
    for (const [t0, t1] of ranges) {
      const sub = bezSub(cp, t0, t1)
      if (!sub) continue
      const len = Math.hypot(sub[3].x - sub[0].x, sub[3].y - sub[0].y)
      if (len <= OVERLAP_EPS) continue
      put(o, { ...o, x1: r3(sub[0].x), y1: r3(sub[0].y), x2: r3(sub[1].x), y2: r3(sub[1].y),
                     x3: r3(sub[2].x), y3: r3(sub[2].y), x4: r3(sub[3].x), y4: r3(sub[3].y) })
      kept.push({ cp: sub, bbox: bboxOf(sub) })
    }
  }

  const cand = new Set([...lines, ...curves])
  const out = []
  for (const o of data) {
    if (cand.has(o)) { const p = slots.get(o); if (p) out.push(...p) }
    else if (!dropped.has(o)) out.push(o)
  }
  return {
    data: out,
    removed: removed.filter(s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > OVERLAP_EPS),
  }
}

// ── Remove white (watermark cleanup) ──────────────────────────────────────────
// Drop near-white strokes (l/c) and fills (fp). White = nothing on a laser, so
// these are almost always watermarks/artefacts.
const WHITE_LUM = 0.95   // luminance above which a colour counts as "(near-)white"

function hexLum(hex) {
  const c = hex || '#000000'
  return 0.299 * parseInt(c.slice(1, 3), 16) / 255
       + 0.587 * parseInt(c.slice(3, 5), 16) / 255
       + 0.114 * parseInt(c.slice(5, 7), 16) / 255
}

export function removeWhite(data, lumThreshold = WHITE_LUM) {
  return data.filter((o) => {
    if (o.type === 'l' || o.type === 'c') return hexLum(o.color) <= lumThreshold
    if (o.type === 'fp') return hexLum(o.fill) <= lumThreshold
    return true
  })
}

// ── Detect helpers (preview highlight for Fix Colors / Remove White) ──────────
// Return { count, segs } where segs are line segments [{x1,y1,x2,y2}] of the
// elements that WOULD change - mirroring computeDoubleRemoval's `removed`, so the
// viewer can highlight them before the edit is applied.
function strokeSegs(o) {
  if (o.type === 'l') return [{ x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 }]
  const pts = flattenPrim({ t: 'C', p0: { x: o.x1, y: o.y1 }, p1: { x: o.x2, y: o.y2 },
                            p2: { x: o.x3, y: o.y3 }, p3: { x: o.x4, y: o.y4 } })
  const segs = []
  for (let i = 0; i < pts.length - 1; i++) segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
  return segs
}

function fpSegs(path) {
  const segs = []
  let cx = 0, cy = 0, sx = 0, sy = 0
  for (const c of path) {
    if (c.cmd === 'M') { cx = c.x; cy = c.y; sx = cx; sy = cy }
    else if (c.cmd === 'L') { segs.push({ x1: cx, y1: cy, x2: c.x, y2: c.y }); cx = c.x; cy = c.y }
    else if (c.cmd === 'C') {
      const pts = flattenPrim({ t: 'C', p0: { x: cx, y: cy }, p1: { x: c.x1, y: c.y1 },
                                p2: { x: c.x2, y: c.y2 }, p3: { x: c.x, y: c.y } })
      for (let i = 0; i < pts.length - 1; i++) segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y })
      cx = c.x; cy = c.y
    } else if (c.cmd === 'Z') { segs.push({ x1: cx, y1: cy, x2: sx, y2: sy }); cx = sx; cy = sy }
  }
  return segs
}

export function detectFixColors(data) {
  let count = 0
  const segs = []
  for (const o of data) {
    if (o.type === 'l' || o.type === 'c') {
      const t = snapTarget(o.color, false)
      if (t && o.color.toLowerCase() !== t) { count++; segs.push(...strokeSegs(o)) }
    } else if (o.type === 'fp') {
      const t = snapTarget(o.fill, true)
      if (t && o.fill.toLowerCase() !== t) { count++; segs.push(...fpSegs(o.path)) }
    }
  }
  return { count, segs }
}

export function detectRemoveWhite(data, lumThreshold = WHITE_LUM) {
  let count = 0
  const segs = []
  for (const o of data) {
    if ((o.type === 'l' || o.type === 'c') && hexLum(o.color) > lumThreshold) { count++; segs.push(...strokeSegs(o)) }
    else if (o.type === 'fp' && hexLum(o.fill) > lumThreshold) { count++; segs.push(...fpSegs(o.path)) }
  }
  return { count, segs }
}

// ── Remove Tiny Segments ──────────────────────────────────────────────────────
// Sub-0.005mm lines/curves are pure extraction noise (stray near-zero-length
// pieces some SVG/PDF sources leave behind) - real detail never gets that
// small, but a job full of them can trip up the printer's own path optimiser.
// Filled (raster) content is left alone: a "tiny segment" there is just a
// normal fine detail of the bitmap, not an artefact.
const TINY_SEGMENT_LEN = 0.005   // mm

function strokeLen(o) {
  const segs = strokeSegs(o)
  let L = 0
  for (const s of segs) L += Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
  return L
}

export function detectTinySegments(data, minLen = TINY_SEGMENT_LEN) {
  let count = 0
  const segs = []
  for (const o of data) {
    if ((o.type === 'l' || o.type === 'c') && strokeLen(o) < minLen) { count++; segs.push(...strokeSegs(o)) }
  }
  return { count, segs }
}

export function removeTinySegments(data, minLen = TINY_SEGMENT_LEN) {
  return data.filter((o) => !((o.type === 'l' || o.type === 'c') && strokeLen(o) < minLen))
}

// ── Wasserzeichen entfernen ───────────────────────────────────────────────────
// The extraction only TAGS watermark objects (o.wm, see pdf/extract.js and
// pdf/watermarks.js) - they stay visible, because the laser would get them
// too. Removing them is the user's call. Afterwards the drawing is moved so its
// top-left corner sits WATERMARK_MARGIN mm from the bed corner again: a removed
// stamp often was the outermost thing on the page.
const WATERMARK_MARGIN = 5   // mm

function objSegs(o) {
  if (o.type === 'l' || o.type === 'c') return strokeSegs(o)
  if (o.type === 'fp') return fpSegs(o.path)
  if (o.type === 'img') {
    const x0 = o.x, x1 = o.x + o.w, y0 = o.y, y1 = o.y - o.h
    return [{ x1: x0, y1: y0, x2: x1, y2: y0 }, { x1, y1: y0, x2: x1, y2: y1 },
            { x1, y1, x2: x0, y2: y1 }, { x1: x0, y1, x2: x0, y2: y0 }]
  }
  return []
}

export function detectWatermarks(data) {
  let count = 0
  const segs = []
  for (const o of data) if (o.wm) { count++; segs.push(...objSegs(o)) }
  return { count, segs }
}

// Exact extent of the drawing (curves flattened finely, not their control
// points). Coordinates: x right, y negative downward, so top-left = (minX, maxY).
function drawingBBox(data) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const grow = (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  for (const o of data) {
    if (o.type === 'l') { grow(o.x1, o.y1); grow(o.x2, o.y2) }
    else if (o.type === 'c') { for (const p of flattenPrim(objToPrim(o), 0.005)) grow(p.x, p.y) }
    else if (o.type === 'fp') { for (const s of fpSegs(o.path)) { grow(s.x1, s.y1); grow(s.x2, s.y2) } }
    else if (o.type === 'img') { grow(o.x, o.y); grow(o.x + o.w, o.y - o.h) }
  }
  return isFinite(minX) ? { minX, maxX, minY, maxY } : null
}

// Moves everything so the drawing's top-left corner is `margin` mm in from the
// bed's top-left corner. Returns the shifted data (or the input if nothing moves).
export function alignTopLeft(data, margin = WATERMARK_MARGIN) {
  const box = drawingBBox(data)
  if (!box) return data
  const dx = margin - box.minX, dy = -margin - box.maxY
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return data
  return data.map((o) => (o.type === 'mbox' ? o : translateObj(o, dx, dy)))
}

export function removeWatermarks(data, margin = WATERMARK_MARGIN) {
  const kept = data.filter((o) => !o.wm)
  const count = data.length - kept.length
  return { data: count > 0 ? alignTopLeft(kept, margin) : data, count }
}

// ── Kurven verbinden (join + smooth) ──────────────────────────────────────────
// CAD exports (Archicad above all) often store every contour as thousands of
// separate ~0,2 mm straight pieces. Two separate things happen here:
//   1. JOIN: same-colour pieces whose endpoints touch become one path (one
//      shared `pid`), and the PDF export writes each pid as ONE path object
//      (pdf/export.js) instead of one object per piece.
//   2. SMOOTH: runs of short, gently bending straight pieces are replaced by
//      fitted bezier curves that stay within JOIN_FIT_TOL of the original points.
// Only (2) changes how the machine drives with "Optimieren" off: it stops at
// every straight-line vertex but drives curves through (forcedStopsFor). With
// "Optimieren" on it already drives through gentle bends, joined or not - so
// there the estimate barely moves, which is the honest answer.
const JOIN_FIT_TOL = 0.02     // mm, max distance of the fitted curve from the original points
const JOIN_SHORT_SEG = 2      // mm, longer straight pieces are real edges and stay lines
const JOIN_SMOOTH_DEG = 20    // a bend sharper than this between two pieces is a real corner
const JOIN_MIN_RUN = 3        // fewer pieces than this are not worth a curve
const JOIN_SMOOTH_COS = Math.cos((JOIN_SMOOTH_DEG * Math.PI) / 180)

let joinPidCounter = 0
const nextJoinPid = () => `j${++joinPidCounter}`   // the extraction uses numeric pids, no collision
const isJoinPid = (pid) => typeof pid === 'string' && pid[0] === 'j'

// Index ranges [start, end) of prims that should become one fitted curve run.
function smoothRuns(prims) {
  const runs = []
  const short = (p) => {
    if (p.t !== 'L') return false
    const L = dist(p.a, p.b)
    return L > 1e-9 && L < JOIN_SHORT_SEG
  }
  const gentle = (p, q) => {
    const ax = p.b.x - p.a.x, ay = p.b.y - p.a.y, bx = q.b.x - q.a.x, by = q.b.y - q.a.y
    return (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) >= JOIN_SMOOTH_COS
  }
  let rs = -1
  const close = (end) => { if (rs >= 0 && end - rs >= JOIN_MIN_RUN) runs.push([rs, end]) }
  for (let i = 0; i < prims.length; i++) {
    if (!short(prims[i])) { close(i); rs = -1; continue }
    if (rs >= 0 && !gentle(prims[i - 1], prims[i])) { close(i); rs = i; continue }
    if (rs < 0) rs = i
  }
  close(prims.length)
  return runs
}

// Which chains would change: more than one source object (or no pid info) to
// join, or something to smooth. Already-joined, already-smooth paths are skipped,
// so a second run reports nothing.
function joinPlan(data) {
  const items = []
  data.forEach((obj, idx) => {
    const prim = objToPrim(obj)
    if (prim) items.push({ key: (obj.color || '#000000').toLowerCase(), prim, ref: idx, group: obj.pid })
  })
  // Pieces per path this tool made earlier (pid 'j...').
  const joinedSize = new Map()
  for (const { ref } of items) {
    const pid = data[ref].pid
    if (isJoinPid(pid)) joinedSize.set(pid, (joinedSize.get(pid) || 0) + 1)
  }
  const plans = []
  for (const chain of chainPrims(items, { byGroup: true })) {
    if (chain.prims.length < 2) continue
    const pids = new Set(chain.refs.map((i) => data[i].pid))
    // Where three pieces meet, the chaining can run through a joined path
    // instead of along it and take only part of it. Rebuilding that just moves
    // the split elsewhere (and which way it goes depends on float noise, e.g.
    // after the drawing moved), so such a chain is not worth anything.
    const taken = new Map()
    for (const i of chain.refs) if (isJoinPid(data[i].pid)) taken.set(data[i].pid, (taken.get(data[i].pid) || 0) + 1)
    let partial = false
    for (const [pid, n] of taken) if (n < joinedSize.get(pid)) partial = true
    if (partial) continue
    const runs = smoothRuns(chain.prims)
    const separate = pids.size > 1 || pids.has(undefined)
    if (!separate && runs.length === 0) continue
    plans.push({ chain, runs })
  }
  return plans
}

export function detectJoinCurves(data) {
  const { consumed } = joinCurvesIter(data)
  const segs = []
  for (const o of consumed) segs.push(...strokeSegs(o))
  return { count: consumed.size ? freshCount(consumed) : 0, segs }
}

const r4 = (v) => Math.round(v * 1e4) / 1e4
function primObj(prim, color, pid) {
  if (prim.t === 'L') {
    return { type: 'l', x1: prim.a.x, y1: prim.a.y, x2: prim.b.x, y2: prim.b.y, color, pid }
  }
  return { type: 'c', x1: prim.p0.x, y1: prim.p0.y, x2: r4(prim.p1.x), y2: r4(prim.p1.y),
           x3: r4(prim.p2.x), y3: r4(prim.p2.y), x4: prim.p3.x, y4: prim.p3.y, color, pid }
}

// Returns { data, count, paths }: the new object list (each joined chain sits at
// the position of its first source object, so drawing order is kept), how many
// source objects were merged, and into how many paths.
//
// Chaining is greedy: where three pieces meet, one of them is left over and
// only a second pass hangs it onto the now joined path. So this repeats until
// nothing is left to join; one click (or one autopilot step) does everything.
const JOIN_MAX_PASSES = 8
export function joinCurves(data) {
  const r = joinCurvesIter(data)
  if (!r.consumed.size) return { data, count: 0, paths: 0 }
  return { data: r.data, count: freshCount(r.consumed), paths: r.paths }
}

// Pieces that were not part of a joined path yet - so the Autopilot, which
// joins again after removing doubles, does not count the same piece twice.
// Only merging paths that were joined already still reports what it took.
function freshCount(consumed) {
  let n = 0
  for (const o of consumed) if (!isJoinPid(o.pid)) n++
  return n || consumed.size
}

// `consumed`: the ORIGINAL objects of `data` that went into a joined path.
// Pieces made by an earlier pass have new objects, so they are never counted twice.
function joinCurvesIter(data) {
  let cur = splitJoinedPaths(data)
  const original = new Set(cur)
  const consumed = new Set()
  const pids = new Set()
  for (let pass = 0; pass < JOIN_MAX_PASSES; pass++) {
    const plans = joinPlan(cur)
    if (!plans.length) break
    for (const { chain } of plans) for (const i of chain.refs) if (original.has(cur[i])) consumed.add(cur[i])
    cur = joinPass(cur, plans, pids)
  }
  const paths = new Set()
  for (const o of cur) if (pids.has(o.pid)) paths.add(o.pid)
  return { data: cur, consumed, paths: paths.size }
}

// Remove Doubles can cut a joined path into pieces that no longer touch. They
// still share one pid, so joinPlan would treat every chain through one piece as
// taking only PART of that path and skip it - after re-loading the export,
// where the pid is gone, the same chain would be joined. Give each such
// stretch its own pid first so both cases agree. The input objects are not
// changed; a renamed piece is a copy.
function splitJoinedPaths(data) {
  const last = new Map()      // pid -> { end, pid } of its previous piece
  let out = null
  data.forEach((o, i) => {
    if (!isJoinPid(o.pid) || (o.type !== 'l' && o.type !== 'c')) return
    const prev = last.get(o.pid)
    let pid = o.pid
    if (prev) {
      const gap = Math.abs(prev.end.x - o.x1) > LINK_MATCH || Math.abs(prev.end.y - o.y1) > LINK_MATCH
      pid = gap ? nextJoinPid() : prev.pid
    }
    last.set(o.pid, { end: o.type === 'l' ? { x: o.x2, y: o.y2 } : { x: o.x4, y: o.y4 }, pid })
    if (pid !== o.pid) {
      if (!out) out = data.slice()
      out[i] = { ...o, pid }
    }
  })
  return out || data
}

function joinPass(data, plans, pids) {
  const replace = new Map()
  const consumed = new Set()
  for (const { chain, runs } of plans) {
    const color = data[chain.seedRef].color
    const pid = nextJoinPid()
    pids.add(pid)
    const objs = []
    let k = 0
    for (const [rs, re] of runs) {
      for (; k < rs; k++) objs.push(primObj(chain.prims[k], color, pid))
      const pts = [chain.prims[rs].a]
      for (let j = rs; j < re; j++) pts.push(chain.prims[j].b)
      for (const b of fitCubics(pts, JOIN_FIT_TOL)) {
        objs.push(primObj({ t: 'C', p0: b[0], p1: b[1], p2: b[2], p3: b[3] }, color, pid))
      }
      k = re
    }
    for (; k < chain.prims.length; k++) objs.push(primObj(chain.prims[k], color, pid))
    // Pieces only had to MEET within LINK_TOL to be chained. Make every start
    // land exactly on the previous end, otherwise the export starts a new
    // subpath (a fresh moveto) at each tiny gap.
    const snap = () => {
      for (let i = 1; i < objs.length; i++) {
        const prev = objs[i - 1]
        objs[i].x1 = prev.type === 'l' ? prev.x2 : prev.x4
        objs[i].y1 = prev.type === 'l' ? prev.y2 : prev.y4
      }
    }
    // The fit, and the snapping itself, can leave crumbs shorter than Remove
    // Tiny Segments allows; drop them so that step has nothing new to find.
    // A dropped last piece hands its end to the one before, so a closed
    // contour still ends where it began.
    const dropCrumbs = () => {
      let dropped = false
      for (let i = objs.length - 1; i >= 0 && objs.length > 1; i--) {
        if (strokeLen(objs[i]) >= TINY_SEGMENT_LEN) continue
        const [gone] = objs.splice(i, 1)
        dropped = true
        if (i === objs.length && i > 0) {
          const prev = objs[i - 1], ex = gone.type === 'l' ? gone.x2 : gone.x4, ey = gone.type === 'l' ? gone.y2 : gone.y4
          if (prev.type === 'l') { prev.x2 = ex; prev.y2 = ey } else { prev.x4 = ex; prev.y4 = ey }
        }
      }
      return dropped
    }
    snap()
    while (dropCrumbs()) snap()
    let first = Infinity
    for (const i of chain.refs) { consumed.add(i); if (i < first) first = i }
    replace.set(first, objs)
  }
  const out = []
  data.forEach((o, i) => {
    if (replace.has(i)) out.push(...replace.get(i))
    else if (!consumed.has(i)) out.push(o)
  })
  return out
}

// ── Bezier fitting (Schneider, "An Algorithm for Automatically Fitting
// Digitized Curves", Graphics Gems 1990) ──────────────────────────────────────
// Fits a chain of cubic beziers through `pts` so that every input point lies
// within `tol` of the curve. Returns [[p0, p1, p2, p3], ...].
const vSub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
const vAdd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y })
const vScale = (a, s) => ({ x: a.x * s, y: a.y * s })
const vDot = (a, b) => a.x * b.x + a.y * b.y
const vUnit = (a) => { const L = Math.hypot(a.x, a.y); return L > 1e-12 ? { x: a.x / L, y: a.y / L } : { x: 0, y: 0 } }

function bezPoint(b, t) {
  const mt = 1 - t
  const k0 = mt * mt * mt, k1 = 3 * t * mt * mt, k2 = 3 * t * t * mt, k3 = t * t * t
  return { x: k0 * b[0].x + k1 * b[1].x + k2 * b[2].x + k3 * b[3].x,
           y: k0 * b[0].y + k1 * b[1].y + k2 * b[2].y + k3 * b[3].y }
}

export function fitCubics(pts, tol) {
  const n = pts.length
  if (n < 2) return []
  const out = []
  const t1 = vUnit(vSub(pts[1], pts[0]))
  const t2 = vUnit(vSub(pts[n - 2], pts[n - 1]))
  fitRange(pts, 0, n - 1, t1, t2, tol * tol, out, 0)
  return out
}

function fitRange(pts, first, last, tHat1, tHat2, errSq, out, depth) {
  const p0 = pts[first], p3 = pts[last]
  if (last - first === 1 || depth > 64) {
    if (last - first === 1) {
      const d = dist(p0, p3) / 3
      out.push([p0, vAdd(p0, vScale(tHat1, d)), vAdd(p3, vScale(tHat2, d)), p3])
    } else {
      // Pathological input - keep the original points as straight curve pieces.
      for (let i = first; i < last; i++) {
        const a = pts[i], b = pts[i + 1], d = vScale(vSub(b, a), 1 / 3)
        out.push([a, vAdd(a, d), vSub(b, d), b])
      }
    }
    return
  }
  let u = chordParams(pts, first, last)
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2)
  let { max, split } = maxFitError(pts, first, last, bez, u)
  if (max < errSq) { out.push(bez); return }
  if (max < errSq * 4) {
    for (let it = 0; it < 4; it++) {
      u = u.map((t, k) => newtonRoot(bez, pts[first + k], t))
      bez = generateBezier(pts, first, last, u, tHat1, tHat2)
      ;({ max, split } = maxFitError(pts, first, last, bez, u))
      if (max < errSq) { out.push(bez); return }
    }
  }
  let tc = vUnit(vSub(pts[split - 1], pts[split + 1]))
  if (tc.x === 0 && tc.y === 0) tc = vUnit(vSub(pts[split - 1], pts[split]))
  fitRange(pts, first, split, tHat1, tc, errSq, out, depth + 1)
  fitRange(pts, split, last, vScale(tc, -1), tHat2, errSq, out, depth + 1)
}

function chordParams(pts, first, last) {
  const u = [0]
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(pts[i], pts[i - 1]))
  const total = u[u.length - 1] || 1
  return u.map((v) => v / total)
}

// Least-squares control points along the fixed end tangents.
function generateBezier(pts, first, last, u, tHat1, tHat2) {
  const p0 = pts[first], p3 = pts[last]
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t
    const b0 = mt * mt * mt, b1 = 3 * t * mt * mt, b2 = 3 * t * t * mt, b3 = t * t * t
    const a1 = vScale(tHat1, b1), a2 = vScale(tHat2, b2)
    c00 += vDot(a1, a1); c01 += vDot(a1, a2); c11 += vDot(a2, a2)
    const tmp = vSub(pts[first + i], vAdd(vScale(p0, b0 + b1), vScale(p3, b2 + b3)))
    x0 += vDot(a1, tmp); x1 += vDot(a2, tmp)
  }
  const det = c00 * c11 - c01 * c01
  let al = Math.abs(det) > 1e-18 ? (x0 * c11 - x1 * c01) / det : 0
  let ar = Math.abs(det) > 1e-18 ? (c00 * x1 - c01 * x0) / det : 0
  const segLen = dist(p0, p3)
  if (al < 1e-6 * segLen || ar < 1e-6 * segLen) al = ar = segLen / 3   // Wu/Barsky fallback
  return [p0, vAdd(p0, vScale(tHat1, al)), vAdd(p3, vScale(tHat2, ar)), p3]
}

function maxFitError(pts, first, last, bez, u) {
  let max = 0, split = Math.floor((first + last) / 2)
  for (let i = first + 1; i < last; i++) {
    const p = bezPoint(bez, u[i - first])
    const d = (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2
    if (d >= max) { max = d; split = i }
  }
  return { max, split }
}

// One Newton-Raphson step towards the parameter of the curve point closest to P.
function newtonRoot(b, P, t) {
  const mt = 1 - t
  const q = bezPoint(b, t)
  const q1 = {
    x: 3 * (mt * mt * (b[1].x - b[0].x) + 2 * t * mt * (b[2].x - b[1].x) + t * t * (b[3].x - b[2].x)),
    y: 3 * (mt * mt * (b[1].y - b[0].y) + 2 * t * mt * (b[2].y - b[1].y) + t * t * (b[3].y - b[2].y)),
  }
  const q2 = {
    x: 6 * (mt * (b[2].x - 2 * b[1].x + b[0].x) + t * (b[3].x - 2 * b[2].x + b[1].x)),
    y: 6 * (mt * (b[2].y - 2 * b[1].y + b[0].y) + t * (b[3].y - 2 * b[2].y + b[1].y)),
  }
  const dx = q.x - P.x, dy = q.y - P.y
  const den = q1.x * q1.x + q1.y * q1.y + dx * q2.x + dy * q2.y
  if (Math.abs(den) < 1e-12) return t
  return Math.min(1, Math.max(0, t - (dx * q1.x + dy * q1.y) / den))
}

// ── Rotate the whole design 90° ───────────────────────────────────────────────
// dir: 'ccw' (rotate left) | 'cw' (rotate right). After rotating, the content is
// re-anchored so its top-left corner sits back at (0,0) (x ≥ 0, y ≤ 0).
function translateObj(o, dx, dy) {
  if (o.type === 'l') return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy }
  if (o.type === 'c') return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy,
                                     x3: o.x3 + dx, y3: o.y3 + dy, x4: o.x4 + dx, y4: o.y4 + dy }
  if (o.type === 'fp') return { ...o, path: o.path.map((cmd) => {
    const n = { ...cmd }
    if ('x'  in cmd) { n.x  = cmd.x  + dx; n.y  = cmd.y  + dy }
    if ('x1' in cmd) { n.x1 = cmd.x1 + dx; n.y1 = cmd.y1 + dy }
    if ('x2' in cmd) { n.x2 = cmd.x2 + dx; n.y2 = cmd.y2 + dy }
    return n
  }) }
  if (o.type === 'img') return { ...o, x: o.x + dx, y: o.y + dy }
  return { ...o }
}

export function rotateData(data, dir = 'cw') {
  const R = dir === 'ccw' ? (x, y) => [-y, x]   // 90° counter-clockwise (left)
                          : (x, y) => [y, -x]   // 90° clockwise (right)
  let minX = Infinity, maxY = -Infinity
  const grow = (x, y) => { if (x < minX) minX = x; if (y > maxY) maxY = y }

  const tmp = data.map((o) => {
    if (o.type === 'l') {
      const a = R(o.x1, o.y1), b = R(o.x2, o.y2)
      grow(a[0], a[1]); grow(b[0], b[1])
      return { ...o, x1: a[0], y1: a[1], x2: b[0], y2: b[1] }
    }
    if (o.type === 'c') {
      const a = R(o.x1, o.y1), b = R(o.x2, o.y2), c = R(o.x3, o.y3), d = R(o.x4, o.y4)
      grow(a[0], a[1]); grow(b[0], b[1]); grow(c[0], c[1]); grow(d[0], d[1])
      return { ...o, x1: a[0], y1: a[1], x2: b[0], y2: b[1], x3: c[0], y3: c[1], x4: d[0], y4: d[1] }
    }
    if (o.type === 'fp') {
      const path = o.path.map((cmd) => {
        const n = { ...cmd }
        if ('x'  in cmd) { const p = R(cmd.x,  cmd.y);  n.x  = p[0]; n.y  = p[1]; grow(p[0], p[1]) }
        if ('x1' in cmd) { const p = R(cmd.x1, cmd.y1); n.x1 = p[0]; n.y1 = p[1]; grow(p[0], p[1]) }
        if ('x2' in cmd) { const p = R(cmd.x2, cmd.y2); n.x2 = p[0]; n.y2 = p[1]; grow(p[0], p[1]) }
        return n
      })
      return { ...o, path }
    }
    if (o.type === 'img') {
      const corners = [R(o.x, o.y), R(o.x + o.w, o.y), R(o.x, o.y - o.h), R(o.x + o.w, o.y - o.h)]
      let cx0 = Infinity, cx1 = -Infinity, cy0 = Infinity, cy1 = -Infinity
      for (const [x, y] of corners) { if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y }
      grow(cx0, cy0); grow(cx1, cy1)
      const step = dir === 'ccw' ? 90 : -90
      const rot = (((o.rot || 0) + step) % 360 + 360) % 360
      return { ...o, x: cx0, y: cy1, w: cx1 - cx0, h: cy1 - cy0, rot }   // top-left = (minX, maxY)
    }
    if (o.type === 'mbox') return { ...o, w: o.h, h: o.w }
    return { ...o }
  })

  const dx = isFinite(minX) ? -minX : 0
  const dy = isFinite(maxY) ? -maxY : 0
  return (dx === 0 && dy === 0) ? tmp : tmp.map((o) => translateObj(o, dx, dy))
}

// ── Primitive helpers ─────────────────────────────────────────────────────────
const primStart = (p) => (p.t === 'L' ? p.a : p.p0)
const primEnd   = (p) => (p.t === 'L' ? p.b : p.p3)

function reversePrim(p) {
  if (p.t === 'L') return { t: 'L', a: p.b, b: p.a }
  return { t: 'C', p0: p.p3, p1: p.p2, p2: p.p1, p3: p.p0 } // reverse control points
}

function reversePath(path) {
  path.prims = path.prims.reverse().map(reversePrim)
  const s = path.start; path.start = path.end; path.end = s
  return path
}

// Cubic point at parameter t.
function cubicAt(p, t) {
  const mt = 1 - t
  const a = mt*mt*mt, b = 3*mt*mt*t, c = 3*mt*t*t, d = t*t*t
  return {
    x: a*p.p0.x + b*p.p1.x + c*p.p2.x + d*p.p3.x,
    y: a*p.p0.y + b*p.p1.y + c*p.p2.y + d*p.p3.y,
  }
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

// Perpendicular distance from point p to the infinite line through a–b.
function distToLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.sqrt(len2)
}

function subdivideCubic(p0, p1, p2, p3, tol, depth, out) {
  // Flat enough when both control points sit within `tol` of the chord p0–p3.
  const d = Math.max(distToLine(p1, p0, p3), distToLine(p2, p0, p3))
  if (depth <= 0 || d <= tol) {
    out.push(p3)
    return
  }
  // de Casteljau split at t = 0.5
  const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3)
  const p012 = mid(p01, p12), p123 = mid(p12, p23)
  const m = mid(p012, p123)
  subdivideCubic(p0, p01, p012, m, tol, depth - 1, out)
  subdivideCubic(m, p123, p23, p3, tol, depth - 1, out)
}

// Adaptive bezier flatness tolerance (mm) - how far a chord may bend away from
// the true curve before it gets subdivided again. Lower = more segments = a
// closer-fitting (and heavier) polyline. Exposed via setTessellationTolerance()
// so the UI can trade fidelity for performance on simple files; every call to
// flattenPrim() that doesn't pass its own `tol` picks up the current value.
let TESSELLATION_TOL = 0.2
export function getTessellationTolerance() { return TESSELLATION_TOL }
export function setTessellationTolerance(mm) {
  TESSELLATION_TOL = Math.max(0.005, Math.min(1, Number(mm) || 0.2))
}

/**
 * Tessellate a primitive into a polyline using ADAPTIVE (flatness-based)
 * subdivision: a cubic is split only where it bends away from a straight chord
 * by more than `tol` mm. Gentle curves get a handful of segments, tight ones
 * more - far fewer points than the old fixed/length-based count.
 *
 * @returns {Array<{x,y}>} points including both endpoints (line → 2 points)
 */
export function flattenPrim(p, tol = TESSELLATION_TOL, maxDepth = 8) {
  if (p.t === 'L') return [p.a, p.b]
  const out = [p.p0]
  subdivideCubic(p.p0, p.p1, p.p2, p.p3, tol, maxDepth, out)
  return out
}

function primLength(p) {
  if (p.t === 'L') return dist(p.a, p.b)
  const pts = flattenPrim(p)
  let L = 0
  for (let i = 0; i < pts.length - 1; i++) L += dist(pts[i], pts[i + 1])
  return L
}

// Reconstruct connected paths from the flat l/c stream, keeping each item as a
// primitive. Primitives link by matching ENDPOINTS (a spatial lookup), not by
// sitting next to each other in the array - so reconstruction is independent of
// item order. This matters because edits like Remove Doubles rebuild the line
// list grouped by shared direction/offset (not by connectivity), which used to
// shatter closed polygons into unclosed fragments and silently zero out the
// small-/tiny-part warnings. Order-independent linking fixes that for any
// edit or extraction order.
const LINK_TOL = 0.01   // mm - matches the old adjacency tolerance
// PDF coordinates sit on a 0.001 mm grid, so gaps of EXACTLY LINK_TOL are
// common. Without a little slack, float noise decides them, differently once
// the drawing has been moved, and a second click found more to join.
const LINK_MATCH = LINK_TOL + 1e-7
// Cells around a bucket, nearest first. Two points LINK_MATCH apart can be two
// buckets apart when both round at .5; the outer ring catches only that case.
const LINK_RING = (() => {
  const inner = [], outer = []
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) (Math.abs(dx) < 2 && Math.abs(dy) < 2 ? inner : outer).push([dx, dy])
  return [...inner, ...outer]
})()

// l / c extraction object -> primitive ('L' / 'C'), or null for anything else.
function objToPrim(obj) {
  if (obj.type === 'l') return { t: 'L', a: { x: obj.x1, y: obj.y1 }, b: { x: obj.x2, y: obj.y2 } }
  if (obj.type === 'c') {
    return {
      t: 'C',
      p0: { x: obj.x1, y: obj.y1 }, p1: { x: obj.x2, y: obj.y2 },
      p2: { x: obj.x3, y: obj.y3 }, p3: { x: obj.x4, y: obj.y4 },
    }
  }
  return null
}

// The machine drives the file's path OBJECTS (pid), each split only where the
// path has a gap. Objects without a pid count one primitive each.
//
//   "Optimieren" off: in file order. An object that starts where the last one
//     ended needs no travel but costs a stop of its own (objectStopPenalty).
//     MEASURED, 89_k_explodiert (the 800 lines of 85 as separate objects):
//     16 s more than 85 at every speed.
//   "Optimieren" on: nearest START next - objects are never reversed - and
//     where it starts exactly at the previous end the head drives through as
//     if it were one path. 89 then costs exactly what 85 costs, and the two
//     production files A and B (8482 single lines from CorelDraw, and the same
//     joined into paths) land on 516 / 447 s like the Job Manager. Merging
//     every touching piece regardless of direction (what this code did
//     before) gave 398 s for both; a stop at every object 591 s.
function reconstructObjects(data) {
  const out = []
  let cur = null
  for (const obj of data) {
    const prim = objToPrim(obj)
    if (!prim) continue
    const color = obj.color || '#000000'
    const s = primStart(prim)
    if (cur && obj.pid != null && obj.pid === cur.pid && color === cur.color &&
        Math.abs(s.x - cur.end.x) <= LINK_MATCH && Math.abs(s.y - cur.end.y) <= LINK_MATCH) {
      cur.prims.push(prim)
      cur.end = primEnd(prim)
    } else {
      cur = { category: categorize(color), color, pid: obj.pid, prims: [prim], start: s, end: primEnd(prim) }
      out.push(cur)
    }
  }
  return out
}

function reconstructPaths(data) {
  const items = []
  for (const obj of data) {
    const prim = objToPrim(obj)
    if (!prim) continue   // fp / img / mbox are not vector toolpaths
    const color = obj.color || '#000000'
    items.push({ key: categorize(color), prim, ref: color })
  }
  return chainPrims(items).map((c) => ({
    category: c.key, color: c.seedRef, prims: c.prims, start: c.start, end: c.end,
  }))
}

// Links primitives into chains by matching ENDPOINTS within LINK_TOL, only
// between items with the same `key`. items: [{ key, prim, ref }]. Returns
// [{ key, prims, refs, seedRef, start, end }]: prims oriented head to tail,
// refs = the items' refs in the same order, seedRef = the ref the chain grew from.
//
// With `byGroup` (Kurven verbinden), items carry a `group` (their path id) and
// where several pieces meet, the chain goes on along its own path first, then
// to the nearest end. Without it the first end found wins, which depends on
// the bucket order and so on where the drawing sits: two contours touching at
// one point were merged or not depending on the position, and the autopilot
// found more to join after it had aligned the drawing.
function chainPrims(items, { byGroup = false } = {}) {
  const prims = items.map((it) => ({
    cat: it.key, ref: it.ref, group: it.group, prim: it.prim, start: primStart(it.prim), end: primEnd(it.prim),
  }))

  const n = prims.length
  const used = new Array(n).fill(false)

  // Spatial index: bucket key (category + quantised point) -> endpoints there.
  // Query checks the 3×3 neighbourhood so points straddling a bucket edge
  // within LINK_TOL still match.
  const bucketKey = (cat, x, y) => `${cat}|${Math.round(x / LINK_TOL)}|${Math.round(y / LINK_TOL)}`
  const index = new Map()
  const addEntry = (idx, which) => {
    const pt = which === 'start' ? prims[idx].start : prims[idx].end
    const k = bucketKey(prims[idx].cat, pt.x, pt.y)
    if (!index.has(k)) index.set(k, [])
    index.get(k).push({ idx, which })
  }
  for (let i = 0; i < n; i++) { addEntry(i, 'start'); addEntry(i, 'end') }

  const findMatch = (cat, x, y, group) => {
    const bx = Math.round(x / LINK_TOL), by = Math.round(y / LINK_TOL)
    let best = null, bestScore = null
    for (const [dx, dy] of LINK_RING) {
      const list = index.get(`${cat}|${bx + dx}|${by + dy}`)
      if (!list) continue
      for (const e of list) {
        if (used[e.idx]) continue
        const pt = e.which === 'start' ? prims[e.idx].start : prims[e.idx].end
        if (Math.abs(pt.x - x) > LINK_MATCH || Math.abs(pt.y - y) > LINK_MATCH) continue
        if (!byGroup) return e
        const score = [prims[e.idx].group === group ? 0 : 1, Math.hypot(pt.x - x, pt.y - y), e.idx, e.which === 'start' ? 0 : 1]
        let better = !bestScore
        for (let k = 0; !better && k < score.length && score[k] <= bestScore[k]; k++) better = score[k] < bestScore[k]
        if (better) { best = e; bestScore = score }
      }
    }
    return best
  }
  const closes = (a, b) => Math.abs(a.x - b.x) <= LINK_MATCH && Math.abs(a.y - b.y) <= LINK_MATCH

  const paths = []
  for (let i = 0; i < n; i++) {
    if (used[i]) continue
    used[i] = true
    const seed = prims[i]
    const chain = [seed.prim]
    const refs = [seed.ref]
    const chainIdx = [i]
    const cat = seed.cat
    let head = seed.start, tail = seed.end

    // Extend forward from the tail (next primitive's start must meet our tail).
    for (;;) {
      const m = findMatch(cat, tail.x, tail.y, prims[chainIdx[chainIdx.length - 1]].group)
      if (!m) break
      used[m.idx] = true
      let next = prims[m.idx].prim
      if (m.which === 'end') next = reversePrim(next)   // orient so its start == tail
      chain.push(next)
      refs.push(prims[m.idx].ref)
      chainIdx.push(m.idx)
      tail = primEnd(next)
      if (closes(tail, head)) break                     // loop closed
    }
    // Extend backward from the head (only if not already closed into a loop).
    if (!closes(tail, head)) {
      for (;;) {
        const m = findMatch(cat, head.x, head.y, prims[chainIdx[0]].group)
        if (!m) break
        used[m.idx] = true
        let prev = prims[m.idx].prim
        if (m.which === 'start') prev = reversePrim(prev)   // orient so its end == head
        chain.unshift(prev)
        refs.unshift(prims[m.idx].ref)
        chainIdx.unshift(m.idx)
        head = primStart(prev)
        if (closes(tail, head)) break
      }
    }
    paths.push({ key: cat, prims: chain, refs, seedRef: seed.ref, start: head, end: tail })
  }
  return paths
}

// Accumulate points into a bounding box. Pass a box (or null) and points.
function growBox(box, pts) {
  let { minX, minY, maxX, maxY } = box || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

// Bounding box {minX,maxX,minY,maxY} of a set of paths (uses control points,
// which bound the bezier curves). Returns null if empty.
function bboxOfPaths(paths) {
  let box = null
  for (const path of paths) {
    for (const prim of path.prims) {
      box = growBox(box, prim.t === 'L' ? [prim.a, prim.b] : [prim.p0, prim.p1, prim.p2, prim.p3])
    }
  }
  return box && isFinite(box.minX) ? box : null
}

// Bounding box of a raster image entry (top-left corner at x,y; extends right
// and downward, where down is negative y).
function bboxOfImage(img) {
  return { minX: img.x, maxX: img.x + img.w, maxY: img.y, minY: img.y - img.h }
}

// Split a filled-path command list into closed point loops (beziers flattened).
function fpLoops(path) {
  const loops = []
  let cur = [], sx = 0, sy = 0, cx = 0, cy = 0
  for (const c of path) {
    if (c.cmd === 'M') {
      if (cur.length > 1) loops.push(cur)
      cur = [{ x: c.x, y: c.y }]; sx = cx = c.x; sy = cy = c.y
    } else if (c.cmd === 'L') {
      cur.push({ x: c.x, y: c.y }); cx = c.x; cy = c.y
    } else if (c.cmd === 'C') {
      const pp = flattenPrim({ t: 'C', p0: { x: cx, y: cy }, p1: { x: c.x1, y: c.y1 },
                               p2: { x: c.x2, y: c.y2 }, p3: { x: c.x, y: c.y } })
      cur.push(...pp.slice(1)); cx = c.x; cy = c.y
    } else if (c.cmd === 'Z') {
      cur.push({ x: sx, y: sy }); loops.push(cur); cur = []; cx = sx; cy = sy
    }
  }
  if (cur.length > 1) loops.push(cur)
  return loops
}

/**
 * Per-scan-row spans of the raster content.
 *
 * MEASURED behaviour (calibration files 30–32): the head sweeps, for each scan
 * row, from the LEFTMOST to the RIGHTMOST ink IN THAT ROW.
 *   • frame with a hollow centre → full width every row (the empty middle is
 *     crossed, because there is ink on both sides)
 *   • two columns 80 mm apart    → full width (the gap is crossed)
 *   • right triangle             → row width grows with y (mean = half)
 * Taking the bounding-box width for every row makes a triangle ~60 % too slow;
 * splitting the two columns into separate regions makes them ~34 % too fast.
 *
 * @returns {Array<{ i:number, y:number, x0:number, x1:number }>} non-empty rows,
 *   top → bottom, `i` = row index (gaps in `i` mark empty bands).
 */
// Footprint row at fraction v (0 = top, 1 = bottom) of an image with analysed
// ink (imageInk.js) -> [u0, u1] as fractions of the footprint width, or null.
// A 90°/270° rotated image (rotateData) turns image COLUMNS into footprint rows.
function imageSpanAt(img, v) {
  const { ink } = img
  const rot = (((img.rot || 0) % 360) + 360) % 360
  if (rot === 0 || rot === 180) {
    const r = Math.min(ink.h - 1, Math.floor((rot === 0 ? v : 1 - v) * ink.h))
    const a = ink.rowX0[r]
    if (a < 0) return null
    const b = ink.rowX1[r] + 1
    return rot === 0 ? [a / ink.w, b / ink.w] : [1 - b / ink.w, 1 - a / ink.w]
  }
  const c = Math.min(ink.w - 1, Math.floor((rot === 90 ? 1 - v : v) * ink.w))
  const a = ink.colY0[c]
  if (a < 0) return null
  const b = ink.colY1[c] + 1
  return rot === 90 ? [a / ink.h, b / ink.h] : [1 - b / ink.h, 1 - a / ink.h]
}

function rasterScanRows(loops, pitch, images = []) {
  const edges = []
  let maxY = -Infinity, minY = Infinity
  for (const { pts, color } of loops) {
    for (const p of pts) { if (p.y > maxY) maxY = p.y; if (p.y < minY) minY = p.y }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1]
      if (a.y === b.y) continue                       // horizontal edge: no crossing
      edges.push({ lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y),
                   xa: a.x, ya: a.y, dxdy: (b.x - a.x) / (b.y - a.y), color })
    }
  }
  for (const img of images) {
    if (img.y > maxY) maxY = img.y
    if (img.y - img.h < minY) minY = img.y - img.h
  }
  if ((!edges.length && !images.length) || !isFinite(maxY)) return []
  edges.sort((e, f) => f.hi - e.hi)                   // sweep top → bottom

  const height = Math.max(0, maxY - minY)
  let nRows = Math.floor(height / pitch) + 1
  if (nRows > RASTER_MAX_ROWS) { nRows = RASTER_MAX_ROWS; pitch = height / Math.max(1, nRows - 1) }

  const rows = []
  let next = 0
  let active = []
  for (let i = 0; i < nRows; i++) {
    const y = maxY - i * pitch
    while (next < edges.length && edges[next].hi >= y) active.push(edges[next++])
    if (active.length > 8 && (i & 31) === 0) active = active.filter(e => e.lo <= y)
    let lo = Infinity, hi = -Infinity, green = false
    for (const e of active) {
      if (y > e.hi || y < e.lo) continue
      const x = e.xa + (y - e.ya) * e.dxdy
      if (x < lo) lo = x
      if (x > hi) hi = x
      if (e.color === 'green') green = true
    }
    for (const img of images) {
      const v = (img.y - y) / img.h
      if (v < 0 || v >= 1) continue
      const span = imageSpanAt(img, v)
      if (!span) continue
      const x0 = img.x + span[0] * img.w, x1 = img.x + span[1] * img.w
      if (x0 < lo) lo = x0
      if (x1 > hi) hi = x1
    }
    if (lo <= hi) rows.push({ i, y, x0: lo, x1: hi, green })
  }
  return rows
}

/**
 * Serpentine over a band of contiguous scan rows, each row spanning only its own
 * content (plus the calibrated overscan). Emitted as one continuous engrave move
 * preceded by a travel to its start.
 */
function rasterRegion(rows, lastPos, pitch, lineOverhead = 0) {
  // Colour is decided PER BAND (this contiguous run of rows), not for the whole
  // file: a photo bitmap and an unrelated green icon elsewhere in the design
  // both end up in the raster pass, but only rows a green loop actually crosses
  // should render green - otherwise a single green shape anywhere in the file
  // tinted every bitmap green too.
  const color = rows.some(r => r.green) ? RASTER_GREEN : RASTER_GRAY
  const over = 0
  const topY = rows[0].y
  const botY = rows[rows.length - 1].y
  let bMinX = Infinity, bMaxX = -Infinity

  const prims = []
  let ltr = true
  let prevEnd = null
  for (const r of rows) {
    const a = r.x0 - over, b = r.x1 + over
    if (a < bMinX) bMinX = a
    if (b > bMaxX) bMaxX = b
    const sx = ltr ? a : b
    const ex = ltr ? b : a
    if (prevEnd) prims.push({ t: 'L', a: prevEnd, b: { x: sx, y: r.y } })  // step to next row
    prims.push({ t: 'L', a: { x: sx, y: r.y }, b: { x: ex, y: r.y } })
    prevEnd = { x: ex, y: r.y }
    ltr = !ltr
  }

  const moves = []
  const start = prims.length ? primStart(prims[0]) : { x: bMinX, y: topY }
  if (dist(lastPos, start) > 0.1) {
    moves.push({ kind: 'travel', color: '#888888', a: { ...lastPos }, b: { ...start } })
  }
  // The swept rectangle (content + overscan) is carried so the viewer can draw
  // the region as one block matching the extent of the scan lines.
  moves.push({
    kind: 'engrave', color, category: 'raster', prims,
    // rows/pitch drive the per-scan-line overhead in moveExtraTime().
    rows: rows.length, pitch: pitch || RASTER_PITCH, lineOverhead,
    bbox: { minX: bMinX, maxX: bMaxX, minY: botY, maxY: topY },
  })
  const end = prims.length ? primEnd(prims[prims.length - 1]) : start
  return { moves, end }
}

// Path-order optimisation ("Pfadreihenfolge optimieren").
//
// MEASURED: the machine clearly minimises travel - 36_order_natural and
// 37_order_shuffled are the SAME geometry in a favourable and a maximally
// unfavourable file order (97 s vs 131 s unoptimised) and land on exactly the
// same 84 s once "Optimieren" is on. Plain file order is therefore out.
//
// How GOOD its tour is: greedy nearest-neighbour, not 2-opt. On the four real
// production files with a known preset, 'nn' lands at -3,1/-0,3/-0,2/-6,9 %
// against the Job Manager (Ø 2,6 %), '2opt' at -4,2/-2,0/-1,4/-7,7 %
// (Ø 3,8 %) - i.e. 2-opt finds a better tour than the machine does and
// therefore estimates too fast. 38_order_nntrap, built so that greedy drives
// 1428 mm further than 2-opt, is a tie (+1,4 % against -1,3 %) and does not
// decide it on its own.
//
// This reverses the earlier call for '2opt'. That one rested on how much travel
// time the machine's estimate leaves over once the cut time is subtracted - and
// that leftover budget is computed with the per-vector start penalty and the
// return-to-home leg, both of which changed in the 2025-09 recalibration. With
// the corrected constants the budget argument points the other way. 'nn' is
// also the conservative direction: it estimates slightly high, not low.
const TSP_MAX_PATHS = 4000   // above this, greedy only (2-opt is O(n²) per pass)
const TSP_MAX_PASSES = 20

// Selectable path-order algorithms, exposed in the UI for debugging/comparison
// against what the printer's own optimiser does:
//   'file' - no reordering, cut in file order (the pre-optimisation baseline)
//   'nn'   - greedy nearest-neighbour, the closest match to the printer's own
//            optimiser (see the MEASURED note above) - the default
//   '2opt' - nearest-neighbour seed + 2-opt improvement; a BETTER tour than the
//            printer finds, so it estimates slightly too fast
export const PATH_ORDER_ALGORITHMS = ['file', 'nn', '2opt']
export const DEFAULT_PATH_ORDER = 'nn'

// Greedy nearest neighbour by START point: the machine never reverses an
// object (see reconstructObjects), it picks the object whose start is
// nearest. Ties go to the object that comes first in the file. A grid over
// the start points keeps this fast for files with thousands of objects.
// `allowReverse` (an object may also be entered at its end) is only for the
// '2opt' what-if order.
export function nearestNeighbourOrder(paths, startPos, { allowReverse = false } = {}) {
  if (allowReverse) {
    const pool = [...paths]
    const seq = []
    let pos = { ...startPos }
    while (pool.length) {
      let best = 0, minD = Infinity, reverse = false
      for (let i = 0; i < pool.length; i++) {
        const ds = dist(pos, pool[i].start)
        const de = dist(pos, pool[i].end)
        if (ds < minD) { minD = ds; best = i; reverse = false }
        if (de < minD) { minD = de; best = i; reverse = true }
      }
      let cur = pool.splice(best, 1)[0]
      if (reverse) cur = reversePath(cur)
      seq.push(cur)
      pos = cur.end
    }
    return seq
  }
  const n = paths.length
  if (n === 0) return []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of paths) {
    minX = Math.min(minX, p.start.x); maxX = Math.max(maxX, p.start.x)
    minY = Math.min(minY, p.start.y); maxY = Math.max(maxY, p.start.y)
  }
  const cs = Math.max(1, Math.sqrt(((maxX - minX) * (maxY - minY)) / n) * 2)
  const W = Math.floor((maxX - minX) / cs) + 1, H = Math.floor((maxY - minY) / cs) + 1
  const cells = new Map()
  paths.forEach((p, i) => {
    const k = Math.floor((p.start.x - minX) / cs) + W * Math.floor((p.start.y - minY) / cs)
    if (!cells.has(k)) cells.set(k, [])
    cells.get(k).push(i)
  })
  const seq = []
  let pos = startPos
  for (let k = 0; k < n; k++) {
    const cx = Math.floor((pos.x - minX) / cs), cy = Math.floor((pos.y - minY) / cs)
    const rMax = Math.max(Math.abs(cx), Math.abs(cx - W), Math.abs(cy), Math.abs(cy - H)) + 1
    let best = -1, bd = Infinity
    const visit = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return
      const list = cells.get(x + W * y)
      if (!list) return
      for (const i of list) {
        const d = dist(pos, paths[i].start)
        if (d < bd || (d === bd && i < best)) { bd = d; best = i }
      }
    }
    for (let r = 0; r <= rMax; r++) {
      if (r === 0) visit(cx, cy)
      else {
        for (let x = cx - r; x <= cx + r; x++) { visit(x, cy - r); visit(x, cy + r) }
        for (let y = cy - r + 1; y <= cy + r - 1; y++) { visit(cx - r, y); visit(cx + r, y) }
      }
      // Everything in ring r+1 is at least r cells away from pos.
      if (best >= 0 && bd <= r * cs) break
    }
    const p = paths[best]
    const key = Math.floor((p.start.x - minX) / cs) + W * Math.floor((p.start.y - minY) / cs)
    const list = cells.get(key)
    list.splice(list.indexOf(best), 1)
    if (!list.length) cells.delete(key)
    seq.push(p)
    pos = p.end
  }
  return seq
}

// 2-opt improvement pass: reversing seq[i..k] flips the direction of every path
// inside it, which is free here because a contour may be cut either way round.
function twoOptImprove(seq, startPos) {
  const n = seq.length
  for (let pass = 0; pass < TSP_MAX_PASSES; pass++) {
    let improved = false
    for (let i = 0; i < n - 1; i++) {
      const prev = i === 0 ? startPos : seq[i - 1].end
      for (let k = i + 1; k < n; k++) {
        const next = k + 1 < n ? seq[k + 1].start : null
        const before = dist(prev, seq[i].start) + (next ? dist(seq[k].end, next) : 0)
        const after  = dist(prev, seq[k].end)   + (next ? dist(seq[i].start, next) : 0)
        if (after < before - 1e-9) {
          const slice = seq.slice(i, k + 1).reverse()
          for (const p of slice) reversePath(p)
          seq.splice(i, slice.length, ...slice)
          improved = true
        }
      }
    }
    if (!improved) break
  }
  return seq
}

// MEASURED (see PATH_ORDER_ALGORITHMS docs above / CALIBRATION.md): the printer
// minimises travel, but only about as well as greedy nearest-neighbour - '2opt'
// finds a shorter tour than it does and estimates ~1,2 points too fast on the
// real production files. 'nn' is the default.
function optimizeOrder(paths, startPos, algo = DEFAULT_PATH_ORDER) {
  if (algo === 'file' || paths.length < 2) return paths
  if (algo === 'nn') return nearestNeighbourOrder(paths, startPos)
  const seq = nearestNeighbourOrder(paths, startPos, { allowReverse: true })
  if (seq.length < 4 || seq.length > TSP_MAX_PATHS) return seq
  return twoOptImprove(seq, startPos)
}

// Time of one move with the machine's REAL kinematics (calibration.js REALITY):
// same path, same stops, other speed / acceleration / stop cost. `T` is the
// move's displayed time; raster keeps it and gets the per-line / per-height
// correction.
function realMoveTime(m, poly, forced, T, accel) {
  if (m.category === 'raster') {
    return T + (m.rows ? m.rows * (REALITY.rasterPerLine + REALITY.rasterPerMmHeight * m.pitch) : 0)
  }
  const travel = m.kind === 'travel'
  const v = travel ? REALITY.travelSpeed : m.v + REALITY.speedOffset
  const a = accel > 0 ? REALITY.vectorAccel + REALITY.accelPerSpeed * v : 0
  const stop = travel ? 0 : Math.max(0, REALITY.stopPenalty + REALITY.stopPenaltyPerSpeed * v)
  const extra = travel ? (m.home ? 0 : REALITY.vectorStartPenalty)
    : (m.joined ? CALIBRATION.objectStopPenalty : 0) + (m.vertexStops ? REALITY.fileObjectPenalty : 0)
  return rampSegments(poly, v, a, stop, forced).total + extra
}

/**
 * Build the ordered machine toolpath.
 *
 * Phases run in machine order: raster engrave (green vectors + grayscale images,
 * each its own bounding-box region) → red vector engrave → blue cut → other.
 * The print head starts at the top-left corner.
 *
 * @param {Array} data       extraction objects (l / c / fp / img / mbox)
 * @param {Object} opts
 * @param {string} [opts.optimize='file']  path-order algorithm within each vector
 *   phase - one of PATH_ORDER_ALGORITHMS ('file' | 'nn' | '2opt'); a falsy value
 *   is treated as 'file' for backwards compatibility with the old boolean flag.
 * @param {Function} [opts.imageInk]  (imgObj) => analysed ink or null, see
 *   imageInk.js getImageInk; without it every image counts as its full rectangle.
 * @returns {{ moves: Array, stats: Object }}
 *   moves: ordered list of either
 *     { kind:'cut'|'engrave'|'other', color, category, prims }   (beam-on path)
 *     { kind:'travel', color, a, b }                             (rapid move)
 *   stats: { cutLen, engraveLen, otherLen, travelLen, totalTime } (mm / seconds)
 */
export function buildToolpath(data, { optimize = 'file', speeds = SPEED_MM_S, rasterPitch = RASTER_PITCH, accel = 0, imageInk = null } = {}) {
  // Accept the old boolean flag too: true -> default algorithm, false -> 'file'.
  const pathOrderAlgo = optimize === true ? DEFAULT_PATH_ORDER : (optimize || 'file')
  // Resolve the head speed (mm/s) for a move, with raster getting its own speed.
  const speedFor = (m) => {
    const s = m.category === 'raster' ? (speeds.raster ?? speeds.engrave) : speeds[m.kind]
    return s || speeds.other || SPEED_MM_S.other
  }
  // The per-line overhead is tabulated against the SPEED SETTING, not against
  // mm/s, so recover the percentage from the resolved raster speed via the same
  // table. (Raster and vector run on different speed scales - dividing by the
  // vector maxSpeed here would be badly wrong.)
  const rasterLineOverhead = rasterLineOverheadForPct(
    rasterPctForSpeed(speeds.raster ?? speeds.engrave ?? SPEED_MM_S.raster))

  const allPaths = reconstructPaths(data)
  const rasterPaths = allPaths.filter(p => p.category === 'green' || p.category === 'gray')
  // Connected contours (touching pieces linked): only for counting cut-out parts.
  const vectorPaths = allPaths.filter(p => p.category !== 'green' && p.category !== 'gray')
  // What the machine drives: the file's objects (reconstructObjects).
  const vectorObjects = reconstructObjects(data).filter(p => p.category !== 'green' && p.category !== 'gray')

  // Raster content: ALL of it - green + grayscale vectors/fills AND grayscale
  // bitmaps, goes into ONE scanline pass. The machine sweeps each row from its
  // leftmost to its rightmost ink, so horizontally separated content in the same
  // rows shares a sweep (no proximity clustering) while a genuinely empty
  // vertical band produces no rows at all and thus splits the job by itself.
  // Each loop keeps its OWN colour tag so a shared band can still tell which
  // rows are actually green vs. grayscale (see rasterScanRows/rasterRegion).
  const rasterLoops = []
  const rasterImages = []   // images with analysed ink (opts.imageInk -> imageInk.js)
  let colorImages = 0
  for (const p of rasterPaths) {
    const pts = []
    for (const prim of p.prims) {
      const pp = flattenPrim(prim)
      if (pts.length) pts.push(...pp.slice(1)); else pts.push(...pp)
    }
    if (pts.length > 1) rasterLoops.push({ pts, color: p.category === 'green' ? 'green' : 'gray' })
  }
  for (const obj of data) {
    if (obj.type === 'fp' && isRasterColor(obj.fill)) {
      const color = isGreen(obj.fill) ? 'green' : 'gray'
      for (const loop of fpLoops(obj.path)) if (loop.length > 1) rasterLoops.push({ pts: loop, color })
    } else if (obj.type === 'img') {
      // EVERY image is engraved as a raster - colour ones too, the driver turns
      // them into grayscale. With its pixels analysed (imageInk.js) only the
      // rows/spans that actually carry ink count; until then (or if decoding
      // failed) the whole rectangle does, the conservative side.
      const ink = imageInk ? imageInk(obj) : null
      if (ink) {
        if (!ink.empty) rasterImages.push({ ...obj, ink })
        if (ink.colored) colorImages++
        continue
      }
      const b = bboxOfImage(obj)
      rasterLoops.push({
        pts: [{ x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY },
              { x: b.maxX, y: b.minY }, { x: b.minX, y: b.minY }, { x: b.minX, y: b.maxY }],
        color: 'gray',
      })
    }
  }
  const scanRows = rasterScanRows(rasterLoops, rasterPitch || RASTER_PITCH, rasterImages)
  // Split into bands of CONTIGUOUS rows: an empty vertical gap ends a band.
  const bands = []
  for (const r of scanRows) {
    const last = bands[bands.length - 1]
    if (last && r.i === last[last.length - 1].i + 1) last.push(r)
    else bands.push([r])
  }

  const moves = []
  let lastPos = { x: 0, y: 0 } // print head starts at the top-left corner

  // ── Engrave phase 1: raster bands (green + grayscale) ──────────────────────
  //
  // NO travel into (or between) raster bands. There is no separate rapid to
  // charge: the head reaches the start of a scan row during the sweep, and the
  // step to the next band is the Y feed, which rasterYFeed already prices in.
  //
  // MEASURED, 54_rast_overscan: a 1 mm wide bar engraved at x = 500 mm
  // (200 dpi, 100 %). Charging the approach at 250 mm/s overshoots its 29 s
  // display by 5,9 %, charging approach and way back by 13,1 %; charging
  // neither lands at -0,7 %. And 52/53 (same two blocks, 5 mm vs 60 mm apart)
  // are both 379 s - crossing the gap costs nothing.
  for (const band of bands) {
    const r = rasterRegion(band, lastPos, rasterPitch || RASTER_PITCH, rasterLineOverhead)
    for (const m of r.moves) if (m.kind !== 'travel') moves.push(m)
    lastPos = r.end
  }

  // ── Vector phases: red engrave, blue cut, other ───────────────────────────
  let didVector = false
  for (const cat of ['red', 'blue', 'other']) {
    let group = vectorObjects.filter(p => p.category === cat).map((p) => ({ ...p, prims: [...p.prims] }))
    if (group.length === 0) continue

    if (pathOrderAlgo !== 'file') {
      group = optimizeOrder(group, lastPos, pathOrderAlgo)
      // Drives through where the next object starts exactly at this one's end.
      const merged = []
      for (const p of group) {
        const last = merged[merged.length - 1]
        if (last && Math.abs(last.end.x - p.start.x) <= LINK_MATCH && Math.abs(last.end.y - p.start.y) <= LINK_MATCH) {
          last.prims.push(...p.prims); last.end = p.end
        } else merged.push(p)
      }
      group = merged
    }
    // (unoptimised: keep file order)

    for (const p of group) {
      // No travel when the object starts where the last one ended - but the
      // head still stops there (m.joined, moveExtraTime).
      const travel = !didVector || dist(lastPos, p.start) > 0.1
      if (travel && dist(lastPos, p.start) > 0.1) {
        moves.push({ kind: 'travel', color: '#888888', a: { ...lastPos }, b: { ...p.start } })
      }
      // 'file' = the machine's "Optimieren" OFF: file order AND a stop at every
      // straight-line vertex (forcedStopsFor). On: stops only at sharp corners.
      moves.push({ kind: kindOf(cat), color: p.color, category: cat, prims: p.prims,
                   vertexStops: pathOrderAlgo === 'file', joined: !travel })
      lastPos = p.end
      didVector = true
    }
  }

  // Return to home. The machine's estimate DOES include it: 42_home_near and
  // 43_home_far are the same 20 mm square, once in the start corner (5 s) and
  // once in the opposite corner (13 s). The 8 s difference is TWICE the ~1080 mm
  // approach at 250 mm/s (8,6 s), not once (4,3 s). Across all 134 runs the
  // return leg improves the fit from Ø 1,18 % to Ø 0,51 %.
  //
  // This reverses the earlier reading of the dashes files (17–19): under the old
  // parameter set the return leg overshot them, but that was the 69 ms per-vector
  // start penalty compensating for a missing term. With the penalty refitted to
  // 35 ms the dashes land within 1,8 % WITH the return leg.
  //
  // Only after a VECTOR phase - a raster-only job pays no travel at all, see the
  // raster loop above.
  if (CALIBRATION.returnToHome && didVector && (lastPos.x !== 0 || lastPos.y !== 0)) {
    // `home` marks it as NOT starting a vector, so it carries no start penalty.
    moves.push({ kind: 'travel', home: true, color: '#888888', a: { ...lastPos }, b: { x: 0, y: 0 } })
    lastPos = { x: 0, y: 0 }
  }

  // Stats + time estimate. Length AND time are tracked per operation type, with
  // raster engrave (green/grayscale serpentine) split out from vector engrave
  // (red) so the UI can break the total down by operation.
  const stats = {
    cutLen: 0, cutTime: 0, engraveLen: 0, engraveTime: 0, rasterLen: 0, rasterTime: 0,
    otherLen: 0, otherTime: 0, travelLen: 0, travelTime: 0, totalTime: 0,
    smallParts: 0, tinyParts: 0,
    colorImages,   // colour images: engraved in grayscale, never cut - the UI notes it
  }

  // Cut-out parts (closed blue contours). Easy to forget when judging a job: each
  // must be removed by hand (→ smallParts, drives handling time), and very small
  // ones can drop through the bed grid and need retrieving (→ tinyParts, with
  // their boxes returned so the viewer can highlight them on demand).
  const tinyBoxes = []
  for (const p of vectorPaths) {
    if (p.category !== 'blue') continue
    if (Math.hypot(p.start.x - p.end.x, p.start.y - p.end.y) > 0.5) continue   // open → not a part
    // Closed is not enough: a stray 0,1 mm line, or a line drawn there and back
    // in one path, also ends where it starts but encloses nothing. Without this
    // they showed up as "tiny parts that fall through the grid" (edge_winzig,
    // edge_dopplungen in "werkzeug tests/edge cases").
    if (Math.abs(enclosedArea(movePolyline(p))) < MIN_PART_AREA) continue
    const box = bboxOfPaths([p])
    if (!box) continue
    const w = box.maxX - box.minX, h = box.maxY - box.minY
    if (Math.max(w, h) <= SMALL_PART_MM) stats.smallParts++
    if (Math.max(w, h) <= TINY_PART_W && Math.min(w, h) <= TINY_PART_H) {
      stats.tinyParts++
      tinyBoxes.push(box)
    }
  }
  // Speed of every move, and the display constants of the chosen mode: with
  // "Optimieren" the Job Manager uses its own vector values (calibration.js
  // `optimized`). `accel` (printer profile) scales with them.
  const K = pathOrderAlgo !== 'file' && CALIBRATION.optimized ? { ...CALIBRATION, ...CALIBRATION.optimized } : CALIBRATION
  const a0 = accel > 0 ? accel * (K.vectorAccel / CALIBRATION.vectorAccel) : 0
  for (const m of moves) {
    m.v = m.kind === 'travel' ? (speeds.travel || SPEED_MM_S.travel) : speedFor(m)
    if (m.category === 'raster') continue
    m.a0 = a0; m.a1 = K.accelPerSpeed
    if (m.kind === 'travel') m.pv = K.vectorStartPenalty
    else m.p0 = K.cornerPenalty
  }
  let realTime = 0      // the same moves with the machine's REAL kinematics
  for (const m of moves) {
    let L = 0
    if (m.kind === 'travel') L = dist(m.a, m.b)
    else for (const prim of m.prims) L += primLength(prim)
    // Acceleration-aware: ramps at every corner (each scan-line turnaround), so
    // the printer's accel value actually drives the estimate.
    const poly = movePolyline(m), forced = forcedStopsFor(m)
    const ramp = rampSegments(poly, speedFor(m), accelFor(m, accel), cornerPenaltyFor(m), forced)
    const T = ramp.total + moveExtraTime(m)
    realTime += realMoveTime(m, poly, forced, T, accel)

    if      (m.kind === 'travel')     { stats.travelLen  += L; stats.travelTime  += T }
    else if (m.kind === 'cut')        { stats.cutLen     += L; stats.cutTime     += T }
    else if (m.category === 'raster') { stats.rasterLen  += L; stats.rasterTime  += T }
    else if (m.kind === 'engrave')    { stats.engraveLen += L; stats.engraveTime += T }
    else                              { stats.otherLen   += L; stats.otherTime   += T }
    stats.totalTime += T
  }
  stats.totalTime += CALIBRATION.jobOverhead

  // ── Anzeige → Realität ──────────────────────────────────────────────────
  // Everything above reproduces what the Job Manager DISPLAYS (the per-
  // operation times too). The machine's actual run time differs from it
  // systematically - see calibration.js REALITY: it accelerates less at high
  // speed, stops take longer, travel is a bit faster, raster finishes early.
  // stats.displayTime keeps the machine's own number, stats.totalTime becomes
  // the one that matters - how long the job really takes.
  stats.displayTime = stats.totalTime
  stats.totalTime = Math.max(0, realTime + CALIBRATION.jobOverhead)
  stats.realDelta = stats.totalTime - stats.displayTime

  return { moves, stats, tinyBoxes }
}
