#!/usr/bin/env node
/**
 * Build the scoring process (`arena-worker`, worker/src/index.ts) into one
 * immutable ESM artifact for the controlled local release channel
 * (worker/deploy-scoring-local.sh). The release then runs `node <artifact>`
 * from its own exact-commit directory instead of `npx tsx` against the
 * shared working tree (2026-11 audit P1-3).
 *
 * npm packages stay external (resolved from the release's own node_modules);
 * repository modules, including `@/` path aliases, are bundled.
 *
 * Usage: node worker/build-scoring-worker.mjs --outdir=<absolute dir>
 */

import { build } from 'esbuild'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outdirArg = process.argv.slice(2).find((arg) => arg.startsWith('--outdir='))
const outdir = outdirArg?.slice('--outdir='.length)
if (!outdir || !isAbsolute(outdir)) {
  console.error('✗ --outdir=<absolute directory> is required')
  process.exit(2)
}

// The worker, and the preflight the deploy runs before touching PM2.
const ARTIFACTS = [
  { entry: join(repoDir, 'worker', 'src', 'index.ts'), file: 'scoring-worker.mjs' },
  { entry: join(repoDir, 'worker', 'src', 'scoring-preflight.ts'), file: 'scoring-preflight.mjs' },
]

for (const { entry, file } of ARTIFACTS) {
  await build({
    absWorkingDir: repoDir,
    entryPoints: [entry],
    outfile: join(outdir, file),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    tsconfig: join(repoDir, 'tsconfig.json'),
    sourcemap: 'linked',
    logLevel: 'warning',
    // Bundled CommonJS helpers in ESM need a real require.
    banner: {
      js: "import { createRequire as __arenaCreateRequire } from 'node:module'; const require = __arenaCreateRequire(import.meta.url);",
    },
  })
  console.log(`[build-scoring-worker] wrote ${join(outdir, file)}`)
}
