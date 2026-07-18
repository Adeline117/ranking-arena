import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { TYPED_METRICS } from './metric-columns.mjs'

const MIGRATION_PATH = 'supabase/migrations/20260718140000_add_metric_completeness_daily.sql'

test('metric completeness table accepts every typed trader_stats metric exactly once', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8')
  const metricCheck = sql.match(
    /CHECK \(metric IN \(\s*([\s\S]*?)\s*\)\),\s*-- Membership denominator:/
  )

  assert.ok(metricCheck, 'metric CHECK constraint is missing')
  const sqlMetrics = [...metricCheck[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1])

  assert.deepEqual([...new Set(sqlMetrics)].sort(), [...TYPED_METRICS].sort())
  assert.equal(sqlMetrics.length, TYPED_METRICS.length, 'metric CHECK contains duplicates')
})

test('completeness evidence separates board publication time from upstream freshness', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8')
  const compactSql = sql.replace(/\s+/g, ' ')

  assert.match(sql, /\bboard_snapshot_at timestamptz/)
  assert.match(sql, /\bupstream_source_as_of timestamptz/)
  assert.match(sql, /\bmeasurement_state text NOT NULL/)
  assert.doesNotMatch(sql, /\bsource_as_of timestamptz/)
  assert.match(sql, /'stale_board_snapshot'/)
  assert.ok(
    compactSql.includes(
      "measurement_state = CASE WHEN board_snapshot_at IS NULL THEN 'missing_board_snapshot'"
    ),
    'measurement state must be derived exhaustively from evidence'
  )
  assert.ok(
    compactSql.includes("WHEN upstream_source_as_of IS NULL THEN 'missing_upstream_watermark'")
  )
  assert.ok(
    compactSql.includes("WHEN fresh_stats_total = 0 THEN 'no_fresh_stats' ELSE 'measured' END")
  )
})

test('completeness evidence rejects future timestamps and non-UTC day buckets', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8')

  assert.match(sql, /taken_on = \(measured_at AT TIME ZONE 'UTC'\)::date/)
  assert.match(sql, /board_snapshot_at <= measured_at \+ interval '5 minutes'/)
  assert.match(sql, /upstream_source_as_of <= measured_at \+ interval '5 minutes'/)
  assert.match(sql, /newest_stats_as_of <= measured_at \+ interval '5 minutes'/)
})
