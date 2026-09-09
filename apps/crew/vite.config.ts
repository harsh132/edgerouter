import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    // The runtime holds the key; the page only ever asks it for things.
    proxy: { '/api': { target: 'http://127.0.0.1:8800', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
