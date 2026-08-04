import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
const lintTypecheck = workflow.jobs['lint-typecheck']
const checkout = lintTypecheck.steps.find((step) =>
  String(step.uses ?? '').startsWith('actions/checkout@')
)
const migrationLint = lintTypecheck.steps.find(
  (step) => step.name === 'Migration lint — block dangerous DDL'
)

test('migration lint has enough Git history to compare the actual event range', () => {
  assert.ok(checkout)
  assert.equal(checkout.with['fetch-depth'], 0)
  assert.ok(migrationLint)
  assert.equal(migrationLint.env, undefined)
  assert.match(migrationLint.run, /process\.env\.GITHUB_EVENT_PATH/)
  assert.match(migrationLint.run, /event\.pull_request\?\.base\?\.sha \?\? event\.before/)
  assert.match(migrationLint.run, /\^\[0-9a-f\]\{40\}\$/)
  assert.match(migrationLint.run, /git rev-parse HEAD\^/)
})

test('migration lint delegates to the fail-closed Node scanner', () => {
  assert.match(migrationLint.run, /set -euo pipefail/)
  assert.match(
    migrationLint.run,
    /node scripts\/qa\/migration-dangerous-ddl-check\.mjs "\$BASE_SHA" HEAD/
  )
  assert.doesNotMatch(migrationLint.run, /NOT NULL\(\?!\.\*DEFAULT\)/)
  assert.doesNotMatch(migrationLint.run, /\|\| true/)
})
