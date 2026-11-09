import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared'), '@': resolve(import.meta.dirname, 'src/renderer/src') } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: 'localhost', fs: { allow: [resolve(import.meta.dirname)] } },
  build: { outDir: '../../dist/web', emptyOutDir: true, target: 'es2022' }
})
