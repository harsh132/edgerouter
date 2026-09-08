/**
 * The three lines of Node's `crypto` that Circle's browser client actually uses.
 *
 * `@circle-fin/x402-batching/client` is documented as the browser half and still
 * does `import { randomBytes } from "crypto"` — a Node habit that survives into
 * a browser build and fails at bundle time. Vite externalises the module and
 * rollup then refuses, which is the good version of this problem: the bad one is
 * a shim that silently returns nothing at runtime.
 *
 * So this is deliberately not a polyfill of `crypto`. It is the one function,
 * backed by the platform's own CSPRNG, and anything else that module reaches for
 * will fail loudly rather than quietly return undefined.
 */
export const randomBytes = (size: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(size));

export default { randomBytes };
