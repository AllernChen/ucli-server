import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [vue()],
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/healthz': 'http://127.0.0.1:3000', '/metrics': 'http://127.0.0.1:3000' } },
  build: { outDir: 'dist' }
})
