import { defineConfig } from 'tsdown';

/**
 * The browser half.
 *
 * Different from the Node build in every way that matters, so it is a separate
 * config rather than a second entry:
 *
 *   format cjs      the shell hands each bundle a `require` and reads
 *                   `module.exports`; ESM `import` has nothing to resolve
 *                   against in that environment
 *   platform browser no node builtins, and none are used — this half reads the
 *                   settings document, it does not touch a wallet file
 *   react external  the shell seeds a frozen module table (React, Cordis, the
 *                   static UI libraries) and every dynamic bundle resolves
 *                   against exactly that. A bundled React would be a second
 *                   copy with its own hook dispatcher, which fails at the first
 *                   `useState` rather than at build time.
 *
 * Everything `@deepseek-ai/*` is external for the same reason, and in practice
 * only the type imports touch those packages: the page reaches the harness
 * through `ctx` services, never through a cross-plugin value import.
 *
 * The output still needs wrapping in the loader's registration call — see
 * `build-client.mjs`, which owns that shape.
 */
export default defineConfig({
  entry: ['src/client.tsx'],
  outDir: 'client',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [/^@deepseek-ai\//, 'react', 'react-dom', 'react/jsx-runtime'],
});
