import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
