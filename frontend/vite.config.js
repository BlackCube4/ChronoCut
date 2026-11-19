import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// ChronoCut is a purely static web app: PDF reading and writing run in the
// browser (MuPDF as WebAssembly, src/pdf/), so there is no backend to proxy.
export default defineConfig({
  plugins: [vue()],
  // Relative asset paths: the built dist/ works from any sub folder of a web
  // server (e.g. https://server/chronocut/) without rebuilding.
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    // printers/*.xml live in the repo root, one level above this project
    fs: { allow: ['..'] },
  },
  // mupdf.js loads its .wasm via import.meta.url - pre-bundling would break that
  optimizeDeps: { exclude: ['mupdf'] },
  // mupdf.js uses top-level await (also inside the worker)
  build: { target: 'es2022' },
  worker: { format: 'es' },
})
