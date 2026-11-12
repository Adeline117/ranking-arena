import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate } from './fix-requires-test.mjs'

const code = ['lib/data/a.ts']

test('blocks a fix to application code without a test', () => {
  assert.equal(evaluate({ title: 'fix(rankings): x', body: '', files: code }).ok, false)
  assert.equal(evaluate({ title: 'fix: x', body: null, files: code }).ok, false)
})

test('accepts a fix with a unit or E2E test', () => {
  for (const test_ of ['lib/data/__tests__/a.test.ts', 'e2e/hermetic/a.spec.ts']) {
    assert.equal(evaluate({ title: 'fix: x', body: '', files: [...code, test_] }).ok, true)
  }
})

test('accepts a stated exemption but not an empty one', () => {
  const stated = 'Context\nNo regression test: copy change only'
  assert.equal(evaluate({ title: 'fix: x', body: stated, files: code }).ok, true)
  assert.equal(evaluate({ title: 'fix: x', body: 'No regression test:', files: code }).ok, false)
})

test('ignores non-fix titles and fixes outside application code', () => {
  assert.equal(evaluate({ title: 'feat: x', body: '', files: code }).ok, true)
  assert.equal(evaluate({ title: 'fix: x', body: '', files: ['docs/a.md'] }).ok, true)
})
