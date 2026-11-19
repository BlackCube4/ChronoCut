import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PDFJS = path.join(HERE, 'node_modules', 'pdfjs-dist')
// pdf.js loads these at run time: substitute fonts for PDFs that do not embed
// their fonts (Helvetica, Times, ...), and decoders for rare image formats
// (JPEG 2000, JBIG2). Served under pdfjs/ next to the app, licences included.
const PDFJS_DIRS = ['standard_fonts', 'wasm']

function pdfjsAssets() {
  return {
    name: 'chronocut-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const [dir, file] = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\//, '').split('/')
        const src = PDFJS_DIRS.includes(dir) && file && !file.includes('..') ? path.join(PDFJS, dir, file) : null
        if (!src || !fs.existsSync(src)) return next()
        if (file.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
        fs.createReadStream(src).pipe(res)
      })
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const file of fs.readdirSync(path.join(PDFJS, dir))) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${file}`, source: fs.readFileSync(path.join(PDFJS, dir, file)) })
        }
      }
    },
  }
}

// ChronoCut is a purely static web app: PDF reading and writing run in the
// browser (pdf.js + pdf-lib, src/pdf/), so there is no backend to proxy.
export default defineConfig({
  plugins: [vue(), pdfjsAssets()],
  // Relative asset paths: the built dist/ works from any sub folder of a web
  // server (e.g. https://server/chronocut/) without rebuilding.
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    // printers/*.xml live in the repo root, one level above this project
    fs: { allow: ['..'] },
  },
  build: { target: 'es2022' },
  worker: { format: 'es' },
})
