// UI side of the PDF worker (pdfWorker.js): reading PDF/SVG files and writing
// PDFs, all locally in the browser.
let worker = null
let seq = 0
const pending = new Map()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./pdfWorker.js', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    ok ? p.resolve(result) : p.reject(new Error(error))
  }
  worker.onerror = (e) => {
    // e.g. the WebAssembly file could not be loaded: fail every open request
    const err = new Error(e.message || 'PDF-Modul konnte nicht geladen werden')
    for (const p of pending.values()) p.reject(err)
    pending.clear()
    worker.terminate()
    worker = null
  }
  return worker
}

function call(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    // base: where the app lives, so the worker finds pdfjs/ (fonts, decoders)
    getWorker().postMessage({ ...msg, id, base: new URL('./', document.baseURI).href }, transfer)
  })
}

// Start the PDF worker early, so the first file opens without waiting for it.
export function warmUp() {
  call({ op: 'ping' }).catch(() => { /* the first real call reports it */ })
}

/** File (PDF/SVG) -> { success, lines, line_count, warnings } */
export async function extractFile(file) {
  const buffer = await file.arrayBuffer()
  return call({ op: 'extract', name: file.name, buffer }, [buffer])
}

/** Drawing objects -> PDF Blob */
export async function buildPdfBlob(objects) {
  const bytes = await call({ op: 'pdf', objects })
  return new Blob([bytes], { type: 'application/pdf' })
}

/** Build the PDF and hand it to the browser as a download. */
export async function downloadPdf(objects, filename = 'laser_drawing.pdf') {
  const blob = await buildPdfBlob(objects)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
