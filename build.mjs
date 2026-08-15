/**
 * dsh-mobile build: esbuild emits the two artifacts the loader contract
 * expects, mirroring dsh-skin-daihaoyuan.
 *
 *  - lib/client.js — the browser bundle in the closure-factory format
 *    (window.__ModuleLoader__.load({ id, factory })), with react and the
 *    platform module table externalized to the frozen module table and the
 *    mobile stylesheet inlined via the text loader.
 *  - lib/index.js — the node half: the upload RPC channel over the generic
 *    connection transport. Its only runtime imports are node builtins (all
 *    dsh/@deepseek-ai references are type-only and erased), so the host
 *    half needs no node_modules of its own.
 *
 * `node build.mjs --watch` rewrites lib/client.js on change; the running
 * `dsh web` host stat-polls every roster row's bundle (500 ms) and hot-swaps
 * the fiber in the browser — no page reload, no server restart.
 */
import { context } from 'esbuild'

const ID = 'dsh-mobile'

/** The loader module table (repo: packages/client/web/src/platform.ts) plus the documented runtime-store exemption. */
const EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-connection/client',
  '@deepseek-ai/dsh-client-ui-layout/client',
]

const shared = {
  bundle: true,
  minify: false,
  sourcemap: true,
  target: 'es2020',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
}

const clientConfig = {
  ...shared,
  entryPoints: ['src/client.tsx'],
  outfile: 'lib/client.js',
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  external: EXTERNALS,
  loader: { '.css': 'text' },
  // esbuild has no `intro`: the module/exports locals the cjs output assigns
  // into ride the banner, directly inside the factory body.
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
}

const nodeConfig = {
  ...shared,
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  platform: 'node',
  format: 'esm',
}

if (process.argv.includes('--watch')) {
  const clients = await context(clientConfig)
  const nodes = await context(nodeConfig)
  await clients.watch()
  await nodes.watch()
  console.log(`[dsh-mobile] watching src/ — lib/client.js hot-swaps into the running dsh web (${ID})`)
  await new Promise(() => {})
} else {
  const clients = await context(clientConfig)
  const nodes = await context(nodeConfig)
  await clients.rebuild()
  await nodes.rebuild()
  await clients.dispose()
  await nodes.dispose()
  console.log(`[dsh-mobile] built lib/client.js and lib/index.js for ${ID}`)
}
