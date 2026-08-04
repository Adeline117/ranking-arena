import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runBoundaryCheck, validateProductionAllowlist } from '../check-production-boundary.mjs'

const root = process.cwd()
const allowlist = JSON.parse(
  readFileSync(new URL('../PRODUCTION_ALLOWLIST.json', import.meta.url), 'utf8')
)
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const diagnoseSource = readFileSync(new URL('../diagnose.mjs', import.meta.url), 'utf8')

test('keeps the production script surface minimal and diagnostics canonical', () => {
  assert.deepEqual(allowlist.allowed, [
    'check_status.mjs',
    'diagnose.mjs',
    'pipeline-health-check.mjs',
  ])

  for (const command of [
    'check:seasons',
    'check:tables',
    'check:enrichment',
    'backfill:24h',
    'backfill:risk:7d30d',
  ]) {
    assert.equal(Object.hasOwn(packageJson.scripts, command), false)
  }

  assert.match(diagnoseSource, /check_status\.mjs/)
  assert.doesNotMatch(diagnoseSource, /check_(?:seasons|tables|enrichment)\.mjs|trader_snapshots/)
})

test('repository production allowlist is internally valid', () => {
  assert.equal(runBoundaryCheck(), 0)
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, ['scripts/check-production-boundary.mjs'], {
      cwd: root,
      stdio: 'pipe',
    })
  )
})

test('validator fails closed on malformed, duplicate, nested, and missing entries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-production-boundary-'))
  try {
    writeFileSync(join(directory, 'safe.mjs'), '')

    assert.deepEqual(validateProductionAllowlist({ allowed: ['safe.mjs'] }, directory), [])
    assert.match(validateProductionAllowlist({}, directory).join('\n'), /must be an array/)

    const errors = validateProductionAllowlist(
      {
        allowed: ['safe.mjs', 'safe.mjs', '../outside.mjs', 'unsupported.ts', 'missing.sh', 42],
      },
      directory
    ).join('\n')

    assert.match(errors, /duplicates safe\.mjs/)
    assert.match(errors, /root-level script/)
    assert.match(errors, /production script extension/)
    assert.match(errors, /does not exist/)
    assert.match(errors, /non-empty trimmed string/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('validator rejects an allowlisted symbolic link', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-production-boundary-'))
  try {
    writeFileSync(join(directory, 'target.mjs'), '')
    symlinkSync('target.mjs', join(directory, 'linked.mjs'))

    assert.match(
      validateProductionAllowlist({ allowed: ['linked.mjs'] }, directory).join('\n'),
      /must not be a symbolic link/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
