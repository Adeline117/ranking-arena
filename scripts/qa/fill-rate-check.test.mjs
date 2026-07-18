import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  LEGACY_TREND_SQL,
  MEASUREMENT_SQL,
  SOURCE_CONTRACT_SQL,
  buildContractCells,
  completenessContractHash,
  deriveMeasurementState,
  evaluateEvidence,
} from './fill-rate-check.mjs'
import { TYPED_METRICS } from './metric-columns.mjs'

function source(overrides = {}) {
  return {
    source_id: 7,
    slug: 'example',
    filter_source: 'example_public',
    timeframes_native: [7, 30],
    timeframes_derived: [30, 90],
    expected_metrics: ['roi', 'pnl'],
    ...overrides,
  }
}

test('registry contract expands the exact distinct source x window x metric set', () => {
  const cells = buildContractCells([source()])

  assert.equal(cells.length, 6)
  assert.deepEqual(
    cells.map(({ source_id, timeframe, metric }) => [source_id, timeframe, metric]),
    [
      [7, 7, 'pnl'],
      [7, 7, 'roi'],
      [7, 30, 'pnl'],
      [7, 30, 'roi'],
      [7, 90, 'pnl'],
      [7, 90, 'roi'],
    ]
  )
})

test('registry contract rejects missing, duplicate, and invented expected metrics', () => {
  const invalid = [
    source({ expected_metrics: undefined }),
    source({ expected_metrics: null }),
    source({ expected_metrics: { roi: true } }),
    source({ expected_metrics: [] }),
    source({ expected_metrics: [''] }),
    source({ expected_metrics: [' roi'] }),
    source({ expected_metrics: ['roi', 7] }),
    source({ expected_metrics: ['roi', 'roi'] }),
    source({ expected_metrics: ['roi', 'sortino'] }),
  ]

  for (const row of invalid) {
    assert.throws(() => buildContractCells([row]), /expected_metrics/)
  }
})

test('registry contract rejects empty sources and sources without ranking windows', () => {
  assert.throws(() => buildContractCells([]), /contract is empty/)
  assert.throws(
    () => buildContractCells([source({ timeframes_native: [0, 14], timeframes_derived: [] })]),
    /no ranking timeframe/
  )
})

test('contract hash is stable across registry row order and changes with freshness policy', () => {
  const left = source()
  const right = source({
    source_id: 9,
    slug: 'second',
    filter_source: 'second',
    timeframes_native: [90],
    timeframes_derived: [],
    expected_metrics: ['mdd'],
  })
  const first = buildContractCells([left, right])
  const reordered = buildContractCells([right, left])

  assert.equal(completenessContractHash(first, 48), completenessContractHash(reordered, 48))
  assert.notEqual(completenessContractHash(first, 48), completenessContractHash(first, 24))
})

test('measurement state is exhaustive and uses board/watermark priority', () => {
  const measuredAt = '2026-07-18T12:00:00.000Z'
  const healthy = {
    slug: 'example',
    timeframe: 7,
    board_snapshot_at: '2026-07-18T11:00:00.000Z',
    upstream_source_as_of: '2026-07-18T10:00:00.000Z',
    population_total: 10,
    stats_total: 8,
    fresh_stats_total: 7,
  }

  assert.equal(
    deriveMeasurementState({ ...healthy, board_snapshot_at: null }, measuredAt, 48),
    'missing_board_snapshot'
  )
  assert.equal(
    deriveMeasurementState(
      { ...healthy, board_snapshot_at: '2026-07-15T11:00:00.000Z' },
      measuredAt,
      48
    ),
    'stale_board_snapshot'
  )
  assert.equal(
    deriveMeasurementState({ ...healthy, upstream_source_as_of: null }, measuredAt, 48),
    'missing_upstream_watermark'
  )
  assert.equal(
    deriveMeasurementState(
      { ...healthy, upstream_source_as_of: '2026-07-15T11:00:00.000Z' },
      measuredAt,
      48
    ),
    'stale_upstream_watermark'
  )
  assert.equal(
    deriveMeasurementState({ ...healthy, population_total: 0 }, measuredAt, 48),
    'empty_population'
  )
  assert.equal(deriveMeasurementState({ ...healthy, stats_total: 0 }, measuredAt, 48), 'no_stats')
  assert.equal(
    deriveMeasurementState({ ...healthy, fresh_stats_total: 0 }, measuredAt, 48),
    'no_fresh_stats'
  )
  assert.equal(deriveMeasurementState(healthy, measuredAt, 48), 'measured')
  assert.throws(
    () =>
      deriveMeasurementState(
        { ...healthy, upstream_source_as_of: '2026-07-18T12:05:00.001Z' },
        measuredAt,
        48
      ),
    /future/
  )
})

test('evaluation deduplicates state failures and uses fresh population coverage', () => {
  const base = {
    source_id: 7,
    slug: 'example',
    timeframe: 7,
    population_total: 1_000,
    measurement_state: 'missing_board_snapshot',
    fresh_filled: 0,
  }
  const evidence = [
    { ...base, metric: 'roi' },
    { ...base, metric: 'pnl' },
    {
      ...base,
      timeframe: 30,
      metric: 'roi',
      population_total: 1_000,
      fresh_filled: 100,
      measurement_state: 'measured',
    },
  ]

  const result = evaluateEvidence(evidence, { lowFillPct: 0.2, lowFillMinRows: 200 })

  assert.deepEqual(result.violations, ['example[tf7] completeness state=missing_board_snapshot'])
  assert.deepEqual(result.lowFill, [
    {
      slug: 'example',
      timeframe: 30,
      metric: 'roi',
      ratio: 0.1,
      fresh_filled: 100,
      population_total: 1_000,
    },
  ])

  const strict = evaluateEvidence(evidence, {
    lowFillPct: 0.2,
    lowFillMinRows: 200,
    strictLowFill: true,
  })
  assert.match(strict.violations.at(-1), /fresh coverage 10\.0%/)
})

test('SQL closes over passed-board membership and independent source freshness', () => {
  assert.match(SOURCE_CONTRACT_SQL, /source_row\.serving_mode = 'serving'/)
  assert.match(SOURCE_CONTRACT_SQL, /source_row\.meta->'expected_metrics'/)
  assert.doesNotMatch(SOURCE_CONTRACT_SQL, /mv_source_capabilities/)
  assert.match(MEASUREMENT_SQL, /snapshot\.count_check_passed/)
  assert.match(MEASUREMENT_SQL, /arena\.leaderboard_entries/)
  assert.match(MEASUREMENT_SQL, /snapshot\.actual_count/)
  assert.match(MEASUREMENT_SQL, /count\(distinct entry\.trader_id\)/)
  assert.match(MEASUREMENT_SQL, /member\.source_id = latest\.source_id/)
  assert.match(MEASUREMENT_SQL, /arena\.trader_stats/)
  assert.match(MEASUREMENT_SQL, /public\.leaderboard_source_freshness/)
  assert.doesNotMatch(MEASUREMENT_SQL, /leaderboard_ranks|computed_at/)
  assert.match(LEGACY_TREND_SQL, /group by trader\.source_id/)
  assert.doesNotMatch(LEGACY_TREND_SQL, /stats\.timeframe|population_total/)

  for (const metric of TYPED_METRICS) {
    assert.match(MEASUREMENT_SQL, new RegExp(`count\\(stats\\.${metric}\\)::bigint as ${metric}`))
    assert.match(MEASUREMENT_SQL, new RegExp(`as fresh_${metric}`))
    assert.match(MEASUREMENT_SQL, new RegExp(`when '${metric}' then cohort\\.${metric}`))
    assert.match(LEGACY_TREND_SQL, new RegExp(`count\\(stats\\.${metric}\\)::bigint as ${metric}`))
    assert.match(LEGACY_TREND_SQL, new RegExp(`when '${metric}' then fill\\.${metric}`))
  }
})

test('scheduled mode requires DATABASE_URL while local mode may skip', () => {
  const script = 'scripts/qa/fill-rate-check.mjs'
  const env = { ...process.env }
  delete env.DATABASE_URL

  const required = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...env, REQUIRE_DATABASE_URL: '1' },
    encoding: 'utf8',
  })
  assert.equal(required.status, 1)
  assert.match(required.stderr, /requires DATABASE_URL/)

  const local = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...env, REQUIRE_DATABASE_URL: '0' },
    encoding: 'utf8',
  })
  assert.equal(local.status, 0)
  assert.match(local.stdout, /SKIPPED/)
})

test('the scheduled schema canary opts into the required database gate', () => {
  const workflow = readFileSync('.github/workflows/openclaw-sentinels.yml', 'utf8')

  assert.match(
    workflow,
    /schema-canary:[\s\S]*DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}[\s\S]*REQUIRE_DATABASE_URL: '1'[\s\S]*run: node scripts\/openclaw\/schema-canary-sentinel\.mjs/
  )
})

test('a configured but unreachable database fails closed', () => {
  const env = { ...process.env }
  const failed = spawnSync(process.execPath, ['scripts/qa/fill-rate-check.mjs'], {
    cwd: process.cwd(),
    env: {
      ...env,
      DATABASE_URL: 'postgresql://127.0.0.1:1/postgres?connect_timeout=1&sslmode=disable',
      REQUIRE_DATABASE_URL: '1',
    },
    encoding: 'utf8',
    timeout: 5_000,
  })

  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /infrastructure\/contract error/)
})
