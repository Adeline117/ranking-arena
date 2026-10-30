import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = process.cwd()
const scriptsDirectory = join(root, 'scripts')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const allowlist = JSON.parse(
  readFileSync(join(scriptsDirectory, 'PRODUCTION_ALLOWLIST.json'), 'utf8')
)
const { validateAllowlist } = await import('../check-production-boundary.mjs')

test('runtime allowlist contains only extant read-only diagnostics', () => {
  assert.equal(
    packageJson.scripts['check:scripts-boundary'],
    'node scripts/check-production-boundary.mjs'
  )
  assert.deepEqual(allowlist.allowed, [
    'check_enrichment.mjs',
    'check_seasons.mjs',
    'check_status.mjs',
    'diagnose.mjs',
  ])
  assert.deepEqual(validateAllowlist(allowlist.allowed, scriptsDirectory), [])
  assert.match(
    readFileSync(join(scriptsDirectory, 'check-production-boundary.mjs'), 'utf8'),
    /isSymbolicLink\(\)/
  )
})

test('runtime allowlist fails closed for empty, duplicate, traversal, and missing entries', () => {
  assert.deepEqual(validateAllowlist([], scriptsDirectory), ['allowed must not be empty'])
  assert.match(
    validateAllowlist(['check_status.mjs', 'check_status.mjs'], scriptsDirectory).join('\n'),
    /duplicate allowlist entries/
  )
  assert.match(
    validateAllowlist(['../check_status.mjs'], scriptsDirectory).join('\n'),
    /invalid allowlist entry/
  )
  assert.match(
    validateAllowlist(['check_status.ts'], scriptsDirectory).join('\n'),
    /invalid allowlist entry/
  )
  assert.match(
    validateAllowlist(['missing.mjs'], scriptsDirectory).join('\n'),
    /missing allowlist file/
  )
})

test('runtime allowlist rejects a symlink even when its target is a regular script', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'arena-production-boundary-'))
  try {
    writeFileSync(join(fixtureDirectory, 'target.mjs'), '#!/usr/bin/env node\n')
    symlinkSync('target.mjs', join(fixtureDirectory, 'linked.mjs'))
    assert.match(
      validateAllowlist(['linked.mjs'], fixtureDirectory).join('\n'),
      /must be a regular file/
    )
  } finally {
    rmSync(fixtureDirectory, { force: true, recursive: true })
  }
})

test('boundary command is a CI-runnable verifier rather than an executor', () => {
  const result = spawnSync(process.execPath, ['scripts/check-production-boundary.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {},
  })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /documented read-only diagnostics: 4/)
})
