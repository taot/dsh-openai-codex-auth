/**
 * Standalone tsdown build for `dsh-openai-codex`.
 *
 * Emits two artifacts:
 *  - `lib/index.js`  — Node ESM Host half (the plugin the bundle patch loads).
 *  - `lib/client.js` — browser client bundle as the lazy-CJS loader artifact
 *    (`window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`),
 *    reproducing the output format the deepseek-harness `clientBundle` preset
 *    produces so the client-module system can serve and execute it.
 *
 * Browser externals are the shell's platform modules; everything else under
 * `@deepseek-ai/*` is either a platform module (stays external) or is a wire
 * layer best inlined — cross-plugin VALUE imports are rejected by the same
 * purity gate DSH applies (we collaborate through cordis services instead).
 */

import { defineConfig } from 'tsdown'

const ID = 'dsh-openai-codex'

/** Browser platform modules the shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'
const CLIENT_EXTERNALS = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/** Inline-safe wire/type layers with no shared runtime identity (mirrors DSH). */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

export default defineConfig(({ env }) => {
  const face = env?.DSH_BUILD_FACE
  if (face === 'host') return [libraryConfig()]
  if (face === 'client') return [clientConfig()]
  return [libraryConfig(), clientConfig()]
})

function libraryConfig() {
  return {
    name: ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
}

function clientConfig() {
  return {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      name: 'dsh-client-bundle-purity',
      resolveId(source) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        if (VENDORED_LIBRARY.test(source)) return null
        if (INLINE_SAFE.test(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a platform module or an inline-safe wire layer — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports never reach this gate)',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
