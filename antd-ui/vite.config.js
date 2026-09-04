import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    proxy: {
      '/server': 'http://127.0.0.1:9501',
      '/text': 'http://127.0.0.1:9501',
      '/upload': 'http://127.0.0.1:9501',
      '/file': 'http://127.0.0.1:9501',
      '/content': 'http://127.0.0.1:9501',
      '/revoke': 'http://127.0.0.1:9501',
      '/push': {
        target: 'ws://127.0.0.1:9501',
        ws: true,
      },
    },
  },
})
