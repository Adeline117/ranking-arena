import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareWithAllowlist, scanRepository, scanSource } from './data-time-honesty-check.mjs'

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ALLOWLIST = JSON.parse(
  fs.readFileSync(path.join(REPO, 'scripts/qa/data-time-honesty-allowlist.json'), 'utf8')
)

test('flags a display-time key assigned from computed_at', () => {
  const hits = scanSource('lib/x.ts', 'const t = { lastUpdated: row.computed_at ?? null }\n')
  assert.deepEqual(
    hits.map((hit) => hit.rule),
    ['display-key-from-computed-at']
  )
  assert.equal(scanSource('app/y.ts', 'lastmod: trader.computedAt,').length, 1)
  assert.equal(scanSource('app/y.ts', 'updated_at: computedAt,').length, 1)
})

test('does not flag computed_at used for eligibility or written from another field', () => {
  assert.equal(scanSource('lib/x.ts', "computed_at: t.lastUpdated ?? '',").length, 0)
  assert.equal(scanSource('lib/x.ts', "query.gte('computed_at', cutoff)").length, 0)
  assert.equal(scanSource('lib/x.ts', "const COLS = 'rank,roi,computed_at,season_id'").length, 0)
})

test('flags computed_at rendered as a date in a component', () => {
  const hits = scanSource('app/c.tsx', '<span>{formatTimeAgo(row.computed_at, language)}</span>')
  assert.deepEqual(
    hits.map((hit) => hit.rule),
    ['render-computed-at']
  )
  // The render rule is component-only; server age math in .ts is not display.
  assert.equal(scanSource('lib/h.ts', 'Date.now() - new Date(x.computed_at).getTime()').length, 0)
})

test('flags trackedSince as an updated-time fallback', () => {
  const source = 'lastUpdated:\n  data?.lastUpdated ??\n  data?.trackedSince ??\n  other,'
  assert.deepEqual(
    scanSource('app/p.tsx', source).map((hit) => hit.rule),
    ['tracked-since-as-updated']
  )
})

test('new hits fail and the allowlist may only shrink', () => {
  const allowlist = {
    entries: [{ file: 'a.ts', rule: 'display-key-from-computed-at', count: 1 }],
  }
  const hit = { file: 'a.ts', rule: 'display-key-from-computed-at', line: 1 }
  assert.deepEqual(compareWithAllowlist([hit], allowlist), [])
  assert.equal(compareWithAllowlist([hit, { ...hit, line: 2 }], allowlist).length, 1)
  assert.match(compareWithAllowlist([], allowlist)[0], /remove it from the allowlist/)
  assert.match(
    compareWithAllowlist([{ ...hit, file: 'b.ts' }], allowlist)[0],
    /new data-time violation/
  )
})

test('the repository matches its allowlist exactly', () => {
  assert.deepEqual(compareWithAllowlist(scanRepository(REPO), ALLOWLIST), [])
})
