import { defineConfig } from 'vite'
export default defineConfig({
  build: { target: 'esnext' },
  worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'workers/[name]-[hash].js' } } },
})
