import assert from 'node:assert/strict'
import test from 'node:test'
import { findViolations } from './core-coverage-floor.mjs'

const summary = {
  total: {},
  '/repo/lib/a.ts': { lines: { pct: 80 }, branches: { pct: 60 } },
}

test('passes at or above the floor', () => {
  assert.deepEqual(
    findViolations(summary, { 'lib/a.ts': { lines: 80, branches: 50 } }, '/repo'),
    []
  )
})

test('reports a metric below the floor', () => {
  const [violation] = findViolations(summary, { 'lib/a.ts': { lines: 81 } }, '/repo')
  assert.match(violation, /lib\/a\.ts: lines 80% is below 81%/)
})

test('a floored file missing from the report fails instead of passing silently', () => {
  const [violation] = findViolations(summary, { 'lib/gone.ts': { lines: 1 } }, '/repo')
  assert.match(violation, /missing from the coverage report/)
})
