// Prueft den PRODUKTIVCODE (buildToolpath mit calibration.js) gegen alle
// Messungen: Anzeige gegen stats.displayTime, gemessene Zeit gegen
// stats.totalTime.
//
//   cd frontend && node --import ../docs/calib/register.mjs ../docs/calib/verify_all.mjs [kompakt|alt|real]
import { RUNS, loadAll, cols } from './fit_all.mjs'

await loadAll()
const only = process.argv[2]
const stat = {}
const add = (k, e) => (stat[k] ||= []).push(e)
const lines = []
for (const run of RUNS) {
  if (only && run.set !== only) continue
  const cells = []
  for (const [col, algo, shown, me] of cols(run)) {
    const F = run.F[algo]
    if (shown != null && !['01_overhead_dot', '02_overhead_shortline'].includes(run.file)) add(`${run.set} Anzeige`, F.display - shown)
    if (me != null && !['01_overhead_dot', '02_overhead_shortline'].includes(run.file)) add(`${run.set} gemessen`, F.real - me)
    const d = shown == null ? '' : `${shown} -> ${F.display.toFixed(1)}`
    const r = me == null ? '' : `${me} -> ${F.real.toFixed(1)}`
    cells.push(`${col}: ${d.padEnd(16)} ${r ? 'real ' + r : ''}`.padEnd(48))
  }
  lines.push(`${run.file.slice(0, 30).padEnd(30)} ${String(run.speed).padStart(6)} ${String(run.dpi ?? '').padStart(4)}  ${cells.join(' ')}`)
}
if (only) for (const l of lines) console.log(l)
console.log('\nAbweichung Modell - Cutter (s):')
for (const [k, es] of Object.entries(stat)) {
  const a = es.map(Math.abs)
  console.log(`  ${k.padEnd(18)} n=${String(es.length).padStart(3)}  Ø ${(a.reduce((p, q) => p + q, 0) / a.length).toFixed(2)}  max ${Math.max(...a).toFixed(1)}  <=1 s: ${a.filter((x) => x <= 1).length}`)
}
