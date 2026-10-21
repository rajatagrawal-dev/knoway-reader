import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The desktop app serves the built frontend through Tauri, which decides a
// file's type by sniffing its content before looking at its extension — and
// it takes "%PDF" anywhere in a file's first kilobyte to mean a PDF. A
// script chunk served as application/pdf won't load ("'application/pdf' is
// not a valid JavaScript MIME type"), so the build refuses to produce one.
// (The dev server goes by extension, so this only shows in a packaged app.)
function noScriptsSniffedAsPdf(): Plugin {
  return {
    name: 'no-scripts-sniffed-as-pdf',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (!/\.(m?js|css)$/.test(file.fileName)) continue
        const text = file.type === 'chunk' ? file.code : String(file.source)
        if (text.slice(0, 1024).includes('%PDF')) {
          this.error(
            `${file.fileName} has "%PDF" in its first 1024 bytes, so the desktop app would serve it as a PDF. ` +
              'Write that text another way in the source (by its bytes, say).',
          )
        }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), noScriptsSniffedAsPdf()],
  server: {
    proxy: {
      '/api': 'http://localhost:4300',
    },
  },
  // pdf.js's worker setup does its own dynamic `import()` of the worker
  // script as a fallback path; esbuild pre-bundling that module (Vite's
  // default for deps) can desync it from the raw worker file served
  // separately, breaking that fallback ("Setting up fake worker failed").
  // Serving it as native ESM avoids the mismatch.
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
})
