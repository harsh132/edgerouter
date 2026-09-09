import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // What shadcn's generated components import themselves.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5180,
    // The runtime holds the key; the page only ever asks it for things.
    proxy: { '/api': { target: 'http://127.0.0.1:8800', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
