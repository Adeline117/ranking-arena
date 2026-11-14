import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const retiredEntries = [
  { command: process.execPath, file: 'scripts/import/import_all_platforms.mjs' },
  { command: '/bin/sh', file: 'scripts/import/refresh.sh' },
  { command: '/bin/sh', file: 'scripts/import/import-all-blocked.sh' },
  { command: '/bin/sh', file: 'scripts/import/run_hl_enrichment.sh' },
  { command: process.execPath, file: 'scripts/vps-deploy/scraper-v16-parallel.js' },
  { command: process.execPath, file: 'scripts/vps-deploy/arena-proxy.mjs' },
  {
    command: process.execPath,
    file: 'scripts/archive/test-vps-scrapers.ts',
    runtimeArguments: ['--no-warnings', '--experimental-strip-types'],
  },
  { command: process.execPath, file: 'scripts/archive/verify-data-accuracy.mjs' },
]

const forbiddenRuntime =
  /process\.env|child_process|node:child_process|\bfetch\s*\(|\bcreateClient\s*\(|\bspawn(?:Sync)?\s*\(|\bexec(?:File)?\s*\(|\bcurl\b|\bwget\b/

test('V1 legacy proxy and import entrypoints are local tombstones', () => {
  for (const entry of retiredEntries) {
    for (const argumentsToIgnore of [[], ['--any-legacy-argument', 'ignored']]) {
      const result = spawnSync(
        entry.command,
        [...(entry.runtimeArguments ?? []), entry.file, ...argumentsToIgnore],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: {},
        }
      )

      assert.equal(result.error, undefined, entry.file)
      assert.equal(result.status, 2, entry.file)
      assert.equal(result.stdout, '', entry.file)
      assert.match(result.stderr, /^\[RETIRED\] .+\n$/, entry.file)
    }

    const source = readFileSync(path.join(repositoryRoot, entry.file), 'utf8')
    assert.doesNotMatch(source, forbiddenRuntime, entry.file)
    assert.doesNotMatch(source, /^\s*import\s|\brequire\s*\(/m, entry.file)
  }
})

test('legacy proxy HTTP guard verifies the tombstone contract without a server', () => {
  const result = spawnSync(
    process.execPath,
    ['--test', 'scripts/vps-deploy/proxy-http-guard.test.cjs'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {},
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.status, 0)
})

test('Cloudflare legacy proxy worker is a fixed no-store 410 with no upstream call', () => {
  const source = readFileSync(path.join(repositoryRoot, 'cloudflare-worker/src/index.ts'), 'utf8')

  assert.match(source, /LEGACY_PROXY_IMPORT_NOT_PUBLISHED/)
  assert.match(source, /status:\s*410/)
  assert.match(source, /'Cache-Control':\s*'private, no-store, max-age=0, must-revalidate'/)
  assert.match(source, /'CDN-Cache-Control':\s*'no-store'/)
  assert.match(source, /'Vercel-CDN-Cache-Control':\s*'no-store'/)
  assert.doesNotMatch(source, /\b(?:await\s+)?fetch\s*\(\s*[^)]/)
})
