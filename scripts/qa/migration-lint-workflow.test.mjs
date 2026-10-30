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
  assert.equal(checkout.with['persist-credentials'], false)
  assert.ok(migrationLint)
  assert.equal(migrationLint.env, undefined)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
})

test('migration lint delegates to the fail-closed Node scanner', () => {
  assert.match(migrationLint.run, /set -euo pipefail/)
  assert.match(
    migrationLint.run,
    /node scripts\/qa\/migration-dangerous-ddl-check\.mjs[\s\\]+\n\s+--event "\$GITHUB_EVENT_PATH" HEAD/
  )
  assert.doesNotMatch(migrationLint.run, /HEAD\^/)
  assert.doesNotMatch(migrationLint.run, /\${{\s*secrets\./)
  assert.doesNotMatch(migrationLint.run, /\|\| true/)
})
