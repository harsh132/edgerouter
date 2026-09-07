import { defineConfig } from 'tsdown';

/**
 * One bundle, installable into a harness profile.
 *
 * `@edgerouter/sdk` and `@edgerouter/core` are imported by relative path and
 * therefore get inlined here. That is deliberate: they are private packages of
 * this repository, and a plugin that depended on two unpublished names could
 * not be installed by anybody.
 *
 * The harness packages are the opposite case and must stay external. A plugin
 * carrying its own copy of `@deepseek-ai/dsh-llm` would extend a *different*
 * `LlmAdapter` class than the one the running harness checks against, and the
 * registration would fail for reasons that look nothing like the cause. They
 * are peer dependencies for the same reason.
 */
export default defineConfig({
  /*
    Two entries: the plugin the harness loads, and a wallet CLI the person who
    installed it can run. The CLI is not a convenience script in this repo — a
    user who installed a tarball into a profile has no repository and no bun,
    and "no setup required" cannot end with "clone this to find your address".
  */
  entry: ['src/index.ts', 'src/cli.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  // Bundled rather than emitted per file: the SDK is imported across package
  // boundaries, which tsc refuses to place under one rootDir.
  dts: true,
  clean: true,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/schemastery',
    '@x402/hedera',
    '@x402/evm',
    'viem',
  ],
});
