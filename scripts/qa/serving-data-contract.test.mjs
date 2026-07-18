import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const coverage = readFileSync(resolve(root, 'scripts/qa/pipeline-coverage-audit.mjs'), 'utf8')
const rankCacheDiff = readFileSync(resolve(root, 'scripts/ingest-shadow-diff.ts'), 'utf8')
const acceptance = readFileSync(resolve(root, 'scripts/qa/serving-acceptance.mjs'), 'utf8')

test('coverage audit checks every registry-declared window against the current serving generation', () => {
  assert.doesNotMatch(coverage, /public\.trader_latest\b/)
  assert.match(coverage, /public\.leaderboard_ranks/)
  assert.match(coverage, /public\.leaderboard_count_cache/)
  assert.match(coverage, /source_row\.status = 'active'/)
  assert.match(coverage, /snapshot\.timeframe = source_window\.timeframe/)
  assert.match(coverage, /rank_row\.arena_score > 0/)
  assert.match(coverage, /rank_row\.is_outlier IS NOT TRUE/)
  assert.match(coverage, /rank_row\.roi BETWEEN -50000 AND 50000/)
  assert.match(coverage, /source = '_all_gt0'/)
  assert.match(coverage, /cache_row\.source = source_window\.filter_source \|\| '_gt0'/)
  assert.match(coverage, /NO-SERVING-RANKS/)
  assert.match(coverage, /API-FILTER-DIFF/)
  assert.match(coverage, /API-IDENTITY-COLLISION/)
})

test('rank/cache diff preserves composite identity and the API 0x normalization boundary', () => {
  assert.doesNotMatch(rankCacheDiff, /public\.trader_latest\b/)
  assert.match(rankCacheDiff, /public\.leaderboard_ranks/)
  assert.match(rankCacheDiff, /public\.leaderboard_count_cache/)
  assert.match(rankCacheDiff, /COUNT\(DISTINCT \(rank_row\.source, rank_row\.source_trader_id\)\)/)
  assert.match(
    rankCacheDiff,
    /WHEN rank_row\.source_trader_id LIKE '0x%'[\s\S]*THEN lower\(rank_row\.source_trader_id\)/
  )
  assert.match(rankCacheDiff, /rank_row\.arena_score > 0/)
  assert.match(rankCacheDiff, /rank_row\.is_outlier IS NOT TRUE/)
  assert.match(rankCacheDiff, /rank_row\.roi BETWEEN -50000 AND 50000/)
  assert.match(rankCacheDiff, /source_row\.status = 'active'/)
  assert.match(rankCacheDiff, /source_row\.serving_mode = 'serving'/)
})

test('rank/cache diff rejects ranked rows outside an active declared source window', () => {
  assert.match(rankCacheDiff, /allowed_windows AS MATERIALIZED/)
  assert.match(rankCacheDiff, /FULL OUTER JOIN cached_windows/)
  assert.match(rankCacheDiff, /allowed\.filter_source IS NULL/)
  assert.match(rankCacheDiff, /UNREGISTERED-WINDOW/)
  assert.match(rankCacheDiff, /const prefix = process\.argv\[2\] \?\? ''/)
})

test('serving acceptance names the canonical DB probe honestly', () => {
  assert.match(acceptance, /Serving rank\/cache diff/)
  assert.doesNotMatch(acceptance, /Shadow compat diff/)
})
