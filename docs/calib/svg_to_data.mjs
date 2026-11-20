// SVG der Kalibrierdateien -> Extraktionsobjekte (l / c / fp), so wie sie aus
// der PDF-Extraktion des Backends kommen. Gemeinsam genutzt von verify_js.mjs
// und predict_all.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
                                '../../laser time calibration/files')

// ── SVG -> Extraktionsobjekte ───────────────────────────────────────────────
const NUM = /[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g
const BLUE = '#0000FF', RED = '#FF0000', GREEN = '#00FF00'

export function parsePathD(d, sc) {
  const toks = d.split(/([MmLlHhVvCcSsZz])/).filter(t => t.trim())
  const out = []
  let cur = [0, 0], start = [0, 0]
  for (let i = 0; i < toks.length; i++) {
    const cmd = toks[i]
    if (!/^[MmLlHhVvCcSsZz]$/.test(cmd)) continue
    const args = []
    while (i + 1 < toks.length && !/^[MmLlHhVvCcSsZz]$/.test(toks[i + 1])) {
      args.push(...(toks[++i].match(NUM) || []).map(Number))
    }
    const rel = cmd === cmd.toLowerCase() && cmd !== 'Z'
    const C = cmd.toUpperCase()
    const abs = (x, y) => rel ? [cur[0] + x, cur[1] + y] : [x, y]
    if (C === 'M') {
      for (let k = 0; k < args.length; k += 2) {
        cur = abs(args[k], args[k + 1])
        if (k === 0) { start = cur; out.push({ cmd: 'M', x: cur[0] * sc, y: cur[1] * sc }) }
        else out.push({ cmd: 'L', x: cur[0] * sc, y: cur[1] * sc })
      }
    } else if (C === 'L') {
      for (let k = 0; k < args.length; k += 2) {
        cur = abs(args[k], args[k + 1])
        out.push({ cmd: 'L', x: cur[0] * sc, y: cur[1] * sc })
      }
    } else if (C === 'C') {
      for (let k = 0; k < args.length; k += 6) {
        const p1 = abs(args[k], args[k + 1]), p2 = abs(args[k + 2], args[k + 3])
        const p3 = abs(args[k + 4], args[k + 5])
        out.push({ cmd: 'C', x1: p1[0] * sc, y1: p1[1] * sc, x2: p2[0] * sc, y2: p2[1] * sc,
                   x: p3[0] * sc, y: p3[1] * sc })
        cur = p3
      }
    } else if (C === 'Z') {
      out.push({ cmd: 'Z' }); cur = start
    }
  }
  return out
}

export function svgToData(name) {
  const src = fs.readFileSync(path.join(DIR, name + '.svg'), 'utf8')
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(src)
  const wm = /width="([\d.]+)mm"/.exec(src)
  const sc = vb && wm ? Number(wm[1]) / Number(vb[1]) : 1
  const data = []
  let pidCounter = 0
  const attr = (tag, n) => {
    const m = new RegExp(n + '="([^"]*)"').exec(tag)
    return m ? m[1] : null
  }
  for (const m of src.matchAll(/<(path|rect|line|circle)\b([^>]*)>/g)) {
    const [, tag, rest] = m
    const fill = (attr(rest, 'fill') || '').toLowerCase()
    const stroke = (attr(rest, 'stroke') || '').toLowerCase()
    const cls = attr(rest, 'class') || ''
    const isRaster = fill === '#00ff00' || fill === 'lime' || cls === 'fil0'
    // Rot = Vektorgravur (Messsatz 80-94), behaelt die Farbe, damit der
    // Produktivcode Gravur und Schnitt getrennt einsortiert.
    const isVector = stroke === '#0000ff' || stroke === '#ff0000'
    const color = stroke === '#ff0000' ? RED : BLUE
    if (!isRaster && !isVector) continue
    let cmds = null
    if (tag === 'path') {
      cmds = parsePathD(attr(rest, 'd'), sc)
    } else if (tag === 'rect') {
      const x = Number(attr(rest, 'x') || 0) * sc, y = Number(attr(rest, 'y') || 0) * sc
      const w = Number(attr(rest, 'width')) * sc, h = Number(attr(rest, 'height')) * sc
      cmds = [{ cmd: 'M', x, y }, { cmd: 'L', x: x + w, y }, { cmd: 'L', x: x + w, y: y + h },
              { cmd: 'L', x, y: y + h }, { cmd: 'Z' }]
    } else if (tag === 'line') {
      const x1 = Number(attr(rest, 'x1')) * sc, y1 = Number(attr(rest, 'y1')) * sc
      const x2 = Number(attr(rest, 'x2')) * sc, y2 = Number(attr(rest, 'y2')) * sc
      cmds = [{ cmd: 'M', x: x1, y: y1 }, { cmd: 'L', x: x2, y: y2 }]
    } else if (tag === 'circle') {
      const cx = Number(attr(rest, 'cx')) * sc, cy = Number(attr(rest, 'cy')) * sc
      const r = Number(attr(rest, 'r')) * sc, k = 0.5522847498 * r
      cmds = [{ cmd: 'M', x: cx + r, y: cy },
              { cmd: 'C', x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r },
              { cmd: 'C', x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy },
              { cmd: 'C', x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r },
              { cmd: 'C', x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
              { cmd: 'Z' }]
    }
    if (!cmds) continue
    if (isRaster) { data.push({ type: 'fp', fill: GREEN, path: cmds }); continue }
    // Vektor: als Folge von l/c-Objekten, wie sie aus der PDF-Extraktion kommen,
    // mit einer pid je SVG-Element (= ein Objekt fuer die Maschine)
    const pid = ++pidCounter
    let cur = null, st = null
    for (const c of cmds) {
      if (c.cmd === 'M') { cur = [c.x, c.y]; st = cur }
      else if (c.cmd === 'L') {
        data.push({ type: 'l', color, pid, x1: cur[0], y1: cur[1], x2: c.x, y2: c.y })
        cur = [c.x, c.y]
      } else if (c.cmd === 'C') {
        data.push({ type: 'c', color, pid, x1: cur[0], y1: cur[1], x2: c.x1, y2: c.y1,
                    x3: c.x2, y3: c.y2, x4: c.x, y4: c.y })
        cur = [c.x, c.y]
      } else if (c.cmd === 'Z' && st && (cur[0] !== st[0] || cur[1] !== st[1])) {
        data.push({ type: 'l', color, pid, x1: cur[0], y1: cur[1], x2: st[0], y2: st[1] })
        cur = st
      }
    }
  }
  return data
}

