import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packageJson = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const progress = readFileSync(resolve(ROOT, 'docs/PROGRESS.md'), 'utf8')
const runbook = readFileSync(resolve(ROOT, 'docs/RUNBOOK.md'), 'utf8')
const collectors = [
  'scripts/library/collect_arxiv.mjs',
  'scripts/library/collect_books.mjs',
  'scripts/library/collect_research.mjs',
  'scripts/library/collect_whitepapers.mjs',
  'scripts/library/seed_bulk.mjs',
]

const forbiddenRuntimeSyntax =
  /\bimport\b|\brequire\s*\(|process\.env|process\.argv|\bfetch\s*\(|\bpg\b|postgres|supabase|database_url|getclient|upsertitems|\.connect\s*\(|\.query\s*\(/i

function runCollector(collector, args) {
  return spawnSync(process.execPath, [collector, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {},
    timeout: 5000,
  })
}

test('V1 legacy Library collectors are inert compatibility tombstones', () => {
  const invocationSets = [[], ['--force', '--dry-run'], ['--unexpected-legacy-flag=value']]

  for (const collector of collectors) {
    const source = readFileSync(resolve(ROOT, collector), 'utf8')
    const filename = collector.split('/').at(-1)

    assert.match(source, new RegExp(`\\[RETIRED\\].*${filename}`, 'u'))
    assert.match(source, /process\.exitCode\s*=\s*2\b/)
    assert.doesNotMatch(source, forbiddenRuntimeSyntax)

    for (const args of invocationSets) {
      const result = runCollector(collector, args)

      assert.equal(result.error, undefined, `${collector} process must launch`)
      assert.equal(result.status, 2, `${collector} must return exit 2 for every invocation`)
      assert.equal(result.stdout, '', `${collector} must not write to stdout`)
      assert.match(result.stderr, /\[RETIRED\]/, `${collector} must report retirement on stderr`)
    }
  }
})

test('Library collector source boundary is documented and included by the unit sweep', () => {
  assert.match(packageJson, /"qa:sweep-unit":\s*"node --test scripts\/qa\/\*\.test\.mjs"/)

  for (const document of [progress, runbook]) {
    assert.match(document, /V1 legacy Library collector source (?:containment|boundary)/)
    assert.match(document, /`scripts\/library\/collect_arxiv\.mjs`/)
    assert.match(document, /`scripts\/library\/collect_books\.mjs`/)
    assert.match(document, /`scripts\/library\/collect_research\.mjs`/)
    assert.match(document, /`scripts\/library\/collect_whitepapers\.mjs`/)
    assert.match(document, /`scripts\/library\/seed_bulk\.mjs`/)
    assert.match(document, /source-only/)
  }
})
