/**
 * Integration tests — compat dual-write semantics (cutover plan `shadow`).
 *
 * compatWriteTraderLatest must mirror lib/pipeline/types.ts field
 * semantics into public.trader_latest (cloned into arena_test here):
 * clamps, currency guard, serving_mode guard, legacy_platform override,
 * and "latest PASSED snapshot only" sourcing.
 */

jest.mock('@/lib/ingest/db', () => require('./test-db').mockDbModule())

import { publishLeaderboardSnapshot } from '@/lib/ingest/serving/publish'
import { compatWriteTraderLatest } from '@/lib/ingest/serving/compat-trader-latest'
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
} from './test-db'
import type { SourceRow } from '@/lib/ingest/core/types'

async function publishPassed(src: SourceRow, n: number, timeframe: 7 | 30 | 90 = 7) {
  const res = await publishLeaderboardSnapshot({
    src,
    timeframe,
    rows: makeRows(n),
    rejects: [],
    rawObjectId: null,
  })
  expect(res.published).toBe(true)
  return res
}

describe('compatWriteTraderLatest — legacy dual-write semantics', () => {
  beforeAll(async () => {
    await createTestSchema()
  }, 120_000)

  afterAll(async () => {
    await dropTestSchema()
  })

  beforeEach(async () => {
    await resetTables()
  })

  test('shadow + USDT: upserts latest passed snapshot into trader_latest + trader_sources', async () => {
    const src = makeSource({ expected_count: 10, serving_mode: 'shadow' })
    await insertSourceRow(src)
    await publishPassed(src, 10, 30)

    const result = await compatWriteTraderLatest(src, 30)
    expect(result).toEqual({ written: 10, skipped: null })

    const { rows } = await getRawPool().query(
      `SELECT platform, market_type, "window", roi_pct, pnl_usd, win_rate,
              provenance->>'pipeline' AS pipeline
         FROM ${TEST_SCHEMA}.trader_latest
        WHERE trader_key = 't-1'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      platform: 'arena_test_src',
      market_type: 'futures',
      window: '30D',
      roi_pct: 12.5,
      pnl_usd: 1000,
      win_rate: 55,
      pipeline: 'arena_ingest_v2',
    })

    // Legacy identity table follows along (resolution/search reads it).
    expect(await countRows('trader_sources')).toBe(10)
    const { rows: ts } = await getRawPool().query(
      `SELECT handle, is_active FROM ${TEST_SCHEMA}.trader_sources
        WHERE source = 'arena_test_src' AND source_trader_id = 't-1'`
    )
    expect(ts[0]).toMatchObject({ handle: 'Trader 1', is_active: true })

    // Idempotent: second write upserts, no duplicates.
    const again = await compatWriteTraderLatest(src, 30)
    expect(again.written).toBe(10)
    expect(await countRows('trader_latest')).toBe(10)
  })

  test('clamps: roi ±10000, win_rate 0-100, mdd abs() 0-100', async () => {
    const src = makeSource({ expected_count: 2, serving_mode: 'shadow' })
    await insertSourceRow(src)

    const rows = makeRows(2)
    rows[0] = { ...rows[0], headlineRoi: 99_999, headlineWinRate: 150 }
    rows[1] = { ...rows[1], headlineRoi: -99_999, headlineWinRate: -5 }
    const res = await publishLeaderboardSnapshot({
      src,
      timeframe: 7,
      rows,
      rejects: [],
      rawObjectId: null,
    })
    expect(res.published).toBe(true)

    // mdd comes from trader_stats (profile-crawl field) — simulate one
    // stored as a negative fraction-of-100 to exercise abs()+clamp.
    await getRawPool().query(
      `UPDATE ${TEST_SCHEMA}.trader_stats SET mdd = -150
        WHERE trader_id IN (
          SELECT id FROM ${TEST_SCHEMA}.traders WHERE exchange_trader_id = 't-1'
        ) AND timeframe = 7`
    )

    const result = await compatWriteTraderLatest(src, 7)
    expect(result.written).toBe(2)

    const { rows: out } = await getRawPool().query(
      `SELECT trader_key, roi_pct, win_rate, max_drawdown
         FROM ${TEST_SCHEMA}.trader_latest ORDER BY trader_key`
    )
    expect(out[0]).toMatchObject({
      trader_key: 't-1',
      roi_pct: 10_000,
      win_rate: 100,
      max_drawdown: 100,
    })
    expect(out[1]).toMatchObject({ trader_key: 't-2', roi_pct: -10_000, win_rate: 0 })
  })

  test('serving_mode=legacy: skipped, nothing written', async () => {
    const src = makeSource({ expected_count: 5, serving_mode: 'legacy' })
    await insertSourceRow(src)
    await publishPassed(src, 5)

    const result = await compatWriteTraderLatest(src, 7)
    expect(result).toEqual({ written: 0, skipped: 'legacy mode' })
    expect(await countRows('trader_latest')).toBe(0)
    expect(await countRows('trader_sources')).toBe(0)
  })

  test('dollar-pegged non-USDT units (USDx/USDC/USD) DO compat-write — ranking layer is implicitly $', async () => {
    // 2026-06-12 semantics change: the USDT-only skip froze non-USDT
    // sources' leaderboard_ranks at cutover (hyperliquid/gmx/bybit_mt5…).
    // trader_latest was always implicitly dollar-denominated; all four
    // units are dollar-pegged, so the ranking layer writes them unconverted.
    // spec §5.8 no-coerce stays enforced in the serving/UI layer (arena.*
    // reads carry honest per-row currency labels).
    const src = makeSource({ expected_count: 5, serving_mode: 'shadow', currency: 'USDx' })
    await insertSourceRow(src)
    await publishPassed(src, 5)

    const result = await compatWriteTraderLatest(src, 7)
    expect(result.skipped).toBeNull()
    expect(result.written).toBe(5)
    expect(await countRows('trader_latest')).toBe(5)
  })

  test('meta.legacy_platform: explicit null disables, string overrides the slug', async () => {
    const disabled = makeSource({
      expected_count: 5,
      serving_mode: 'shadow',
      meta: { legacy_platform: null },
    })
    await insertSourceRow(disabled)
    await publishPassed(disabled, 5)
    expect(await compatWriteTraderLatest(disabled, 7)).toEqual({
      written: 0,
      skipped: 'legacy_platform disabled',
    })
    expect(await countRows('trader_latest')).toBe(0)

    await resetTables()

    const renamed = makeSource({
      expected_count: 5,
      serving_mode: 'shadow',
      meta: { legacy_platform: 'bitget_v2_test' },
    })
    await insertSourceRow(renamed)
    await publishPassed(renamed, 5)
    const result = await compatWriteTraderLatest(renamed, 7)
    expect(result.written).toBe(5)
    const { rows } = await getRawPool().query(
      `SELECT DISTINCT platform FROM ${TEST_SCHEMA}.trader_latest`
    )
    expect(rows).toEqual([{ platform: 'bitget_v2_test' }])
  })

  test('sources only the latest PASSED snapshot: a newer gated crawl never leaks', async () => {
    const src = makeSource({ expected_count: 10, serving_mode: 'shadow' })
    await insertSourceRow(src)
    await publishPassed(src, 10)

    // A newer, truncated crawl fails the gate (3 vs 10 = 70% deviation).
    const gated = await publishLeaderboardSnapshot({
      src,
      timeframe: 7,
      rows: makeRows(3),
      rejects: [],
      rawObjectId: null,
    })
    expect(gated.published).toBe(false)

    // Compat still serves the 10-row passed snapshot.
    const result = await compatWriteTraderLatest(src, 7)
    expect(result.written).toBe(10)
    expect(await countRows('trader_latest')).toBe(10)
  })

  test('no passed snapshot yet: skipped', async () => {
    const src = makeSource({ expected_count: 10, serving_mode: 'shadow' })
    await insertSourceRow(src)

    const result = await compatWriteTraderLatest(src, 7)
    expect(result).toEqual({ written: 0, skipped: 'no passed snapshot' })
  })
})
