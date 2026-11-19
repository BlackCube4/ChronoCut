// Web worker: all PDF work (MuPDF as WebAssembly) runs here, off the UI thread,
// so a large Archicad PDF does not freeze the page while it is read. Nothing
// leaves the user's computer.
//
// mupdf.js initialises its WebAssembly with a top-level await. Imported
// statically, the message handler below would only be installed after that -
// and a message arriving in the meantime (the very first file the user opens)
// would be lost. So: handler first, MuPDF loaded dynamically and awaited.
import { extractDocument } from './extract.js'
import { buildPdf } from './export.js'
import { WATERMARKS } from './watermarks.js'

const mupdfReady = import('mupdf')

self.onmessage = async (e) => {
  const { id, op } = e.data
  try {
    const mupdf = await mupdfReady
    if (op === 'extract') {
      const result = extractDocument(mupdf, new Uint8Array(e.data.buffer), e.data.name, WATERMARKS)
      self.postMessage({ id, ok: true, result })
    } else if (op === 'pdf') {
      const bytes = buildPdf(mupdf, e.data.objects)
      self.postMessage({ id, ok: true, result: bytes }, [bytes.buffer])
    } else if (op !== 'ping') {
      throw new Error(`unknown op ${op}`)
    } else {
      self.postMessage({ id, ok: true, result: true })
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) })
  }
}
