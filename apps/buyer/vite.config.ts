import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The buyer is a static page. It talks to the gate over HTTP and to Circle's
 * Gateway API directly, so there is nothing to serve but files.
 *
 * `global` is aliased because some of the chain libraries still reach for it —
 * a Node habit that survives into browser builds and fails at runtime rather
 * than at build time, which is the worst place to find it.
 */
export default defineConfig({
  plugins: [react()],
  define: { global: 'globalThis' },
  resolve: {
    alias: {
      // Circle's browser client imports `randomBytes` from Node's crypto. See
      // src/shims/crypto.ts for why this is one function rather than a polyfill.
      crypto: new URL('./src/shims/crypto.ts', import.meta.url).pathname,
    },
  },
  server: { port: 5173 },
});
