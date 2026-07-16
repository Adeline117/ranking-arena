/**
 * Integration tests — publishLeaderboardSnapshot gate behavior (spec §5.1).
 *
 * Runs against a dedicated arena_test schema (see test-db.ts); the prod
 * arena/public schemas are never written. Covers:
 *   - pass: transactional publish of entries/traders/headline stats
 *   - gate: failed count-check leaves snapshot+rejects only
 *   - bootstrap tolerance: ±30% vs expected_count until 3 passing crawls
 *   - rolling median: ±10% vs median of last 7 PASSING crawls
 *   - failed snapshots excluded from the baseline pool (smoke-SOP lesson)
 *   - derived boards: null expected override → bootstrap passes on actual
 */

jest.mock('@/lib/ingest/db', () => require('./test-db').mockDbModule())

import { publishLeaderboardSnapshot } from '@/lib/ingest/serving/publish'
import {
  TEST_SCHEMA,
  countRows,
  createTestSchema,
  dropTestSchema,
  getRawPool,
  insertSourceRow,
  makeRows,
  makeSource,
  resetTables,
  seedSnapshot,
} from './test-db'

describe('publishLeaderboardSnapshot — count-check gate', () => {
  beforeAll(async () => {
    await createTestSchema()
  }, 120_000)

  afterAll(async () => {
    await dropTestSchema()
  })

  beforeEach(async () => {
    await resetTables()
  })

  test('pass: within tolerance publishes entries/traders/stats transactionally', async () => {
    const src = makeSource({ expected_count: 100 })
    await insertSourceRow(src)

    const res = await publishLeaderboardSnapshot({
      src,
      timeframe: 7,
      rows: makeRows(95),
      rejects: [{ reason: 'zod:test-reject', payload: { broken: true } }],
      rawObjectId: null,
    })

    expect(res.published).toBe(true)
    expect(res.verdict.passed).toBe(true)
    expect(res.verdict.baselineUsed).toBe(100)
    expect(res.traderIds.size).toBe(95)

    expect(await countRows('traders')).toBe(95)
    expect(await countRows('leaderboard_entries')).toBe(95)
    expect(await countRows('trader_stats')).toBe(95)
    expect(await countRows('staging_rejects')).toBe(1)

    const { rows: snaps } = await getRawPool().query(
      `SELECT actual_count, baseline_used, count_check_passed
         FROM ${TEST_SCHEMA}.leaderboard_snapshots`
    )
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({
      actual_count: 95,
      baseline_used: 100,
      count_check_passed: true,
    })

    // Headline stats reached serving with board-authoritative values.
    const { rows: stats } = await getRawPool().query(
      `SELECT st.roi, st.pnl, st.win_rate, st.currency
         FROM ${TEST_SCHEMA}.trader_stats st
         JOIN ${TEST_SCHEMA}.traders t ON t.id = st.trader_id
        WHERE t.exchange_trader_id = 't-1' AND st.timeframe = 7`
    )
    expect(stats).toHaveLength(1)
    expect(stats[0]).toMatchObject({ roi: 12.5, pnl: 1000, win_rate: 55, currency: 'USDT' })
  })

  test('sparse native boards preserve the oldest retained metric freshness', async () => {
    const src = makeSource({ expected_count: 1 })
    await insertSourceRow(src)

    const first = await publishLeaderboardSnapshot({
      src,
      timeframe: 30,
      rows: makeRows(1, {
        headlineRoi: 10,
        headlinePnl: 100,
        headlineWinRate: 50,
        headlineMdd: 5,
        headlineSharpe: 1.2,
        headlineAum: 1000,
        headlineExtras: { risk_label: 'seeded-profile-width' },
      }),
      rejects: [],
      rawObjectId: null,
    })
    expect(first.published).toBe(true)

    const readStats = async () =>
      getRawPool().query(
        `SELECT as_of::text, roi, pnl, win_rate, mdd, sharpe, aum, extras
           FROM ${TEST_SCHEMA}.trader_stats st
           JOIN ${TEST_SCHEMA}.traders t ON t.id = st.trader_id
          WHERE t.exchange_trader_id = 't-1' AND st.timeframe = 30`
      )
    const before = await readStats()
    expect(before.rows).toHaveLength(1)

    const second = await publishLeaderboardSnapshot({
      src,
      timeframe: 30,
      rows: makeRows(1, {
        headlineRoi: 20,
        headlinePnl: 200,
        headlineWinRate: 60,
      }),
      rejects: [],
      rawObjectId: null,
    })
    expect(second.published).toBe(true)

    const after = await readStats()
    expect(after.rows[0]).toMatchObject({
      roi: 20,
      pnl: 200,
      win_rate: 60,
      mdd: 5,
      sharpe: 1.2,
      aum: 1000,
      extras: { risk_label: 'seeded-profile-width' },
    })
    expect(after.rows[0].as_of).toBe(before.rows[0].as_of)
  })

  test('gate: deviation beyond tolerance records snapshot + rejects but publishes nothing', async () => {
    const src = makeSource({ expected_count: 100 })
    await insertSourceRow(src)

    // 50 vs expected 100 = 50% deviation > 30% bootstrap tolerance.
    const res = await publishLeaderboardSnapshot({
      src,
      timeframe: 7,
      rows: makeRows(50),
      rejects: [{ reason: 'degenerate_page', payload: {} }],
      rawObjectId: null,
    })

    expect(res.published).toBe(false)
    expect(res.verdict.passed).toBe(false)
    expect(res.traderIds.size).toBe(0)

    // Failed snapshot is still recorded (audit trail) …
    const { rows: snaps } = await getRawPool().query(
      `SELECT count_check_passed, actual_count, baseline_used
         FROM ${TEST_SCHEMA}.leaderboard_snapshots`
    )
    expect(snaps).toHaveLength(1)
    expect(snaps[0]).toMatchObject({
      count_check_passed: false,
      actual_count: 50,
      baseline_used: 100,
    })
    // … rejects are quarantined …
    expect(await countRows('staging_rejects')).toBe(1)
    // … but NOTHING reaches serving.
    expect(await countRows('traders')).toBe(0)
    expect(await countRows('leaderboard_entries')).toBe(0)
    expect(await countRows('trader_stats')).toBe(0)
  })

  test('bootstrap tolerance: 25% drift from a stale survey count still passes', async () => {
    const src = makeSource({ expected_count: 100 })
    await insertSourceRow(src)

    // 75 vs 100 = 25% deviation — would fail the rolling ±10%, passes
    // the ±30% bootstrap sanity floor (survey counts age, spec §5.1).
    const res = await publishLeaderboardSnapshot({
      src,
      timeframe: 7,
      rows: makeRows(75),
      rejects: [],
      rawObjectId: null,
    })

    expect(res.published).toBe(true)
    expect(res.verdict.baselineUsed).toBe(100)
    expect(await countRows('leaderboard_entries')).toBe(75)
  })

  test('rolling median: ≥3 passing crawls replace expected_count as baseline', async () => {
    const src = makeSource({ expected_count: 5 }) // absurd survey number — must be ignored
    await insertSourceRow(src)

    for (const [i, count] of [98, 100, 102, 104, 106].entries()) {
      await seedSnapshot({ actualCount: count, passed: true, minutesAgo: 60 - i * 10 })
    }

    // |95 - 102| / 102 = 6.9% ≤ 10% → passes against the rolling median.
    const res = await publishLeaderboardSnapshot({
      src,
      timeframe: 7,
      rows: makeRows(95),
      rejects: [],
      rawObjectId: null,
    })

    expect(res.published).toBe(true)
    expect(res.verdict.baselineUsed).toBe(102) // median, NOT expected_count
    expect(await countRows('leaderboard_entries')).toBe(95)
  })

  test('rolling median: >10% deviation is gated even though bootstrap would allow it', async () => {
    const src = makeSource({ expected_count: 100 })
    await insertSourceRow(src)

    for (const [i, count] of [98, 100, 102, 104, 106].entries()) {
      await seedSnapshot({ actualCount: count, passed: true, minutesAgo: 60 - i * 10 })
    }

    // |80 - 102| / 102 = 21.6% > 10% rolling tolerance (bootstrap's 30%
    // would have passed — proves the strict rolling check took over).
    const res = await publishLeaderboardSnapshot({
      src,
      timeframe: 7,
      rows: makeRows(80),
      rejects: [],
      rawObjectId: null,
    })

    expect(res.published).toBe(false)
    expect(res.verdict.baselineUsed).toBe(102)
    expect(await countRows('leaderboard_entries')).toBe(0)
  })

  test('failed snapshots never enter the baseline pool', async () => {
    const src = makeSource({ expected_count: 100 })
    await insertSourceRow(src)

    // 3 honest passing crawls, then 4 newer FAILED outliers. Keep the
    // outliers intentionally inconsistent so they cannot qualify as the
    // separate sustained-level-shift escape hatch.
    for (const [i, count] of [100, 100, 100].entries()) {
      await seedSnapshot({ actualCount: count, passed: true, minutesAgo: 120 - i * 10 })
    }
    for (const [i, count] of [500, 900, 300, 700].entries()) {
      await seedSnapshot({ actualCount: count, passed: false, minutesAgo: 40 - i * 10 })
    }

    // Baseline must be median of PASSING crawls (100), not skewed by the
    // failed outliers — 99 passes; against any of them it would be gated.
    const res = await publishLeaderboardSnapshot({
      src,
      timeframe: 7,
      rows: makeRows(99),
      rejects: [],
      rawObjectId: null,
    })

    expect(res.published).toBe(true)
    expect(res.verdict.baselineUsed).toBe(100)
  })

  test('baseline is scoped per timeframe', async () => {
    const src = makeSource({ expected_count: 100 })
    await insertSourceRow(src)

    // Plenty of passing 30D history at a very different count — must not
    // bleed into the 7D baseline (still bootstrap → expected_count).
    for (let i = 0; i < 5; i++) {
      await seedSnapshot({
        actualCount: 1000,
        passed: true,
        minutesAgo: 60 - i * 10,
        timeframe: 30,
      })
    }

    const res = await publishLeaderboardSnapshot({
      src,
      timeframe: 7,
      rows: makeRows(95),
      rejects: [],
      rawObjectId: null,
    })

    expect(res.published).toBe(true)
    expect(res.verdict.baselineUsed).toBe(100)
  })

  test('derived boards: publish ranks without refreshing their stats substrate', async () => {
    const src = makeSource({ expected_count: 7 })
    await insertSourceRow(src)

    const seeded = await publishLeaderboardSnapshot({
      src,
      timeframe: 30,
      rows: makeRows(7),
      rejects: [],
      rawObjectId: null,
    })
    expect(seeded.published).toBe(true)

    const statsForFirstTrader = async () =>
      getRawPool().query(
        `SELECT st.as_of::text, st.roi::text, st.pnl::text, st.win_rate::text
           FROM ${TEST_SCHEMA}.trader_stats st
           JOIN ${TEST_SCHEMA}.traders t ON t.id = st.trader_id
          WHERE t.exchange_trader_id = 't-1' AND st.timeframe = 30`
      )
    const before = await statsForFirstTrader()
    expect(before.rows).toHaveLength(1)

    const res = await publishLeaderboardSnapshot({
      src,
      timeframe: 30,
      rows: makeRows(7, {
        headlineRoi: 999,
        headlinePnl: 99999,
        headlineWinRate: 99,
      }),
      rejects: [],
      rawObjectId: null,
      isDerived: true,
      expectedCountOverride: null, // derived boards have no upstream count
    })

    expect(res.published).toBe(true)
    expect(res.verdict.baselineUsed).toBeNull()
    expect(await countRows('traders')).toBe(7)
    expect(await countRows('leaderboard_entries')).toBe(14)
    expect(await countRows('trader_stats')).toBe(7)

    const after = await statsForFirstTrader()
    expect(after.rows).toEqual(before.rows)

    const { rows: derivedEntry } = await getRawPool().query(
      `SELECT le.headline_roi, le.headline_pnl, le.headline_win_rate
         FROM ${TEST_SCHEMA}.leaderboard_entries le
         JOIN ${TEST_SCHEMA}.traders t ON t.id = le.trader_id
        WHERE le.snapshot_id = $1 AND t.exchange_trader_id = 't-1'`,
      [res.snapshotId]
    )
    expect(derivedEntry).toHaveLength(1)
    expect(derivedEntry[0]).toMatchObject({
      headline_roi: 999,
      headline_pnl: 99999,
      headline_win_rate: 99,
    })

    const { rows: snaps } = await getRawPool().query(
      `SELECT is_derived, count_check_passed
         FROM ${TEST_SCHEMA}.leaderboard_snapshots
        WHERE id = $1`,
      [res.snapshotId]
    )
    expect(snaps[0]).toMatchObject({ is_derived: true, count_check_passed: true })
  })
})
