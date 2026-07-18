import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { isOptionalOnchainDegradation, servingPageReadiness } from './serving-page-readiness.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const coverage = readFileSync(resolve(root, 'scripts/qa/pipeline-coverage-audit.mjs'), 'utf8')
const rankCacheDiff = readFileSync(resolve(root, 'scripts/ingest-shadow-diff.ts'), 'utf8')
const acceptance = readFileSync(resolve(root, 'scripts/qa/serving-acceptance.mjs'), 'utf8')
const profileRender = readFileSync(resolve(root, 'scripts/qa/serving-profiles-e2e.mjs'), 'utf8')

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

test('dormant profile acceptance selects the zero-activity period before asserting', () => {
  assert.match(profileRender, /expectedDormantPeriod/)
  assert.match(profileRender, /name: `\$\{expectedDormantPeriod\} period`/)
  assert.match(profileRender, /getAttribute\('aria-pressed'\) === 'true'/)
  assert.match(profileRender, /c\.kind === 'dormant' \? '30D' : null/)
})

test('profile acceptance waits for core content instead of optional provider idleness', () => {
  assert.deepEqual(servingPageReadiness('active:okx_web3_solana'), {
    waitUntil: 'domcontentloaded',
    readySelector: 'main#main-content h1:visible',
    readyTimeoutMs: 15_000,
    observeMs: 5_000,
  })
  assert.match(profileRender, /\?platform=\$\{encodeURIComponent\(c\.slug\)\}/)
  assert.doesNotMatch(profileRender, /\?source=\$\{c\.slug\}/)
})

test('only a retryable optional on-chain capacity response degrades softly', () => {
  const retryable = {
    status: 503,
    method: 'POST',
    pathname: '/api/trader/onchain-enrich',
    retryAfter: '300',
  }
  assert.equal(isOptionalOnchainDegradation(retryable), true)
  assert.equal(isOptionalOnchainDegradation({ ...retryable, retryAfter: null }), false)
  assert.equal(isOptionalOnchainDegradation({ ...retryable, status: 500 }), false)
  assert.equal(isOptionalOnchainDegradation({ ...retryable, pathname: '/api/rankings' }), false)
})
