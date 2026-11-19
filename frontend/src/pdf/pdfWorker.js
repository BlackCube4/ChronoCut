// Web worker: all PDF work runs here, off the UI thread, so a large Archicad
// PDF does not freeze the page while it is read. Nothing leaves the user's
// computer.
//
// pdf.js normally starts its own worker; we already ARE one, so its worker
// code is loaded into this thread instead (pdf.js picks it up from
// globalThis.pdfjsWorker). Legacy build: runs on somewhat older browsers too.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import { extractDocument } from './extract.js'
import { buildPdf } from './export.js'
import { WATERMARKS } from './watermarks.js'

globalThis.pdfjsWorker = pdfjsWorker

// pdf.js' standard fonts and wasm decoders are served next to the app under
// pdfjs/ (see vite.config.js); the page tells us where the app lives.
let assetBase = null
const loadAsset = async (dir, file) => {
  const res = await fetch(new URL(`pdfjs/${dir}/${file}`, assetBase))
  if (!res.ok) throw new Error(`${dir}/${file}: HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

self.onmessage = async (e) => {
  const { id, op } = e.data
  if (e.data.base) assetBase = e.data.base
  try {
    if (op === 'extract') {
      const result = await extractDocument(pdfjs, new Uint8Array(e.data.buffer), e.data.name,
                                           { watermarks: WATERMARKS, loadAsset })
      self.postMessage({ id, ok: true, result })
    } else if (op === 'pdf') {
      const bytes = await buildPdf(e.data.objects)
      self.postMessage({ id, ok: true, result: bytes }, [bytes.buffer])
    } else if (op === 'ping') {
      self.postMessage({ id, ok: true, result: true })
    } else {
      throw new Error(`unknown op ${op}`)
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) })
  }
}
