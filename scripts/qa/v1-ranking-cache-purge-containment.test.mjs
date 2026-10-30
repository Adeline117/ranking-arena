import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = resolve(ROOT, 'scripts/maintenance/purge-ranking-authority-caches.sh')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const forbiddenCapabilitySyntax =
  /\b(?:vercel|git|curl|wget|ssh|scp|ping|nc|netcat|host|hostname|env|export|source|dotenv)\b|https?:\/\/|\b(?:cache\s+purge|purge\s+cache)\b|\$(?:\{[^}]+\}|\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)/i

function runTombstone(args) {
  return spawnSync(SCRIPT, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5_000,
  })
}

function boundarySection(document) {
  const heading = 'V1 ranking authority cache-purge source'
  const start = document.indexOf(heading)

  assert.notEqual(start, -1, 'documentation must include the ranking cache-purge boundary')
  const nextHeading = document.indexOf('\n#', start + heading.length)
  return document.slice(start, nextHeading === -1 ? undefined : nextHeading)
}

test('ranking cache maintenance source retains no former actuator capability', () => {
  const source = readFileSync(SCRIPT, 'utf8')

  assert.match(source, /\[RETIRED\]/)
  assert.match(source, /exit 2/)
  assert.doesNotMatch(source, forbiddenCapabilitySyntax)
})

test('ranking cache maintenance tombstone fails closed under an empty environment', () => {
  for (const args of [[], ['plan'], ['apply'], ['--unexpected-legacy-flag=value']]) {
    const result = runTombstone(args)

    assert.equal(
      result.error,
      undefined,
      `tombstone must launch for ${args.join(' ') || 'no args'}`
    )
    assert.equal(result.status, 2, `tombstone must exit 2 for ${args.join(' ') || 'no args'}`)
    assert.equal(result.stdout, '', 'tombstone must not write to stdout')
    assert.match(result.stderr, /\[RETIRED\]/, 'tombstone must report retirement on stderr')
  }
})

test('ranking cache maintenance boundary remains source-only and narrowly documented', () => {
  for (const document of [progress, runbook]) {
    const boundary = boundarySection(document)

    assert.match(boundary, /V1 ranking authority cache-purge source (?:containment|boundary)/)
    assert.match(boundary, /`scripts\/maintenance\/purge-ranking-authority-caches\.sh`/)
    assert.match(boundary, /source-only/)
    assert.match(boundary, /route|routes/i)
    assert.match(boundary, /cache policy/i)
    assert.doesNotMatch(boundary, /cache (?:was |has been |is )?cleared/i)
  }
})
