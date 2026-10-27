import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../server-node/static',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '0.0.0.0',
    port: 1210,
    proxy: {
      '/server': 'http://127.0.0.1:9501',
      '/text': 'http://127.0.0.1:9501',
      '/upload': 'http://127.0.0.1:9501',
      '/revoke': 'http://127.0.0.1:9501',
      '/file': 'http://127.0.0.1:9501',
      '/content': 'http://127.0.0.1:9501',
      '/push': { target: 'ws://127.0.0.1:9501', ws: true },
    },
  },
});
