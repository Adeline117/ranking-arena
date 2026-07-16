/** Real-SQL ordering/freshness coverage for publishProfile. */

jest.mock('@/lib/ingest/db', () => require('./test-db').mockDbModule())

import type { ParsedProfile } from '@/lib/ingest/core/types'
import { publishProfile, StaleProfilePublicationError } from '@/lib/ingest/serving/publish'
import {
  TEST_SCHEMA,
  createTestSchema,
  dropTestSchema,
  getRawPool,
  insertSourceRow,
  makeSource,
  resetTables,
} from './test-db'

const T0 = '2026-07-15T00:00:00.000Z'
const T1 = '2026-07-15T01:00:00.000Z'
const T2 = '2026-07-15T02:00:00.000Z'
const T3 = '2026-07-15T03:00:00.000Z'
const WATERMARK_KEY = '_arena_profile_publication_epoch_ms'

function profile(
  asOf: string,
  values: { roi: number; pnl: number; winRate: number; seriesValue: number },
  fillsComplete: boolean
): ParsedProfile {
  return {
    nickname: null,
    avatarUrlOrigin: null,
    stats: [
      {
        timeframe: 30,
        asOf,
        roi: values.roi,
        pnl: values.pnl,
        sharpe: null,
        mdd: null,
        winRate: values.winRate,
        winPositions: 1,
        totalPositions: 2,
        copierPnl: null,
        copierCount: null,
        aum: null,
        volume: null,
        profitShareRate: null,
        holdingDurationAvgHours: 2,
        tradingPreferences: null,
        extras: { fills_metrics_complete: fillsComplete },
      },
    ],
    replaceSeries: [{ timeframe: 30, metrics: ['pnl'] }],
    series: [
      {
        timeframe: 30,
        metric: 'pnl',
        points: [{ ts: asOf, value: values.seriesValue }],
      },
    ],
  }
}

describe('publishProfile — conservative freshness and ordering', () => {
  beforeAll(async () => {
    await createTestSchema()
  }, 120_000)

  afterAll(async () => {
    await dropTestSchema()
  })

  beforeEach(async () => {
    await resetTables()
  })

  test('keeps partial rows conservative and rejects delayed stats plus series atomically', async () => {
    const src = makeSource({ expected_count: 1 })
    await insertSourceRow(src)
    const { rows: traders } = await getRawPool().query<{ id: number }>(
      `INSERT INTO ${TEST_SCHEMA}.traders (source_id, exchange_trader_id)
       VALUES ($1, 'profile-ordering') RETURNING id`,
      [src.id]
    )
    const traderId = traders[0].id
    await getRawPool().query(
      `INSERT INTO ${TEST_SCHEMA}.trader_stats
         (trader_id, timeframe, as_of, currency, roi, pnl, win_rate,
          win_positions, total_positions, holding_duration_avg, extras)
       VALUES ($1, 30, $2, $3, 10, 100, 40, 4, 10,
               make_interval(hours => 4), '{}'::jsonb)`,
      [traderId, T0, src.currency]
    )
    await getRawPool().query(
      `INSERT INTO ${TEST_SCHEMA}.trader_series
         (trader_id, timeframe, metric, ts, value, currency)
       VALUES ($1, 30, 'pnl', $2, 10, $3)`,
      [traderId, T0, src.currency]
    )

    await publishProfile(
      src,
      traderId,
      profile(T2, { roi: 20, pnl: 200, winRate: 99, seriesValue: 20 }, false),
      { fullSeries: true }
    )

    const readState = async () => {
      const stats = await getRawPool().query(
        `SELECT as_of::text, roi, pnl, win_rate, win_positions, total_positions,
                extract(epoch FROM holding_duration_avg) / 3600 AS holding_hours,
                extras ->> $2 AS watermark
           FROM ${TEST_SCHEMA}.trader_stats
          WHERE trader_id = $1 AND timeframe = 30`,
        [traderId, WATERMARK_KEY]
      )
      const series = await getRawPool().query(
        `SELECT ts::text, value
           FROM ${TEST_SCHEMA}.trader_series
          WHERE trader_id = $1 AND timeframe = 30 AND metric = 'pnl'
          ORDER BY ts`,
        [traderId]
      )
      return { stats: stats.rows, series: series.rows }
    }

    const afterPartial = await readState()
    expect(afterPartial.stats[0]).toMatchObject({
      roi: 20,
      pnl: 200,
      win_rate: 40,
      win_positions: 4,
      total_positions: 10,
      holding_hours: 4,
      watermark: String(Date.parse(T2)),
    })
    expect(Date.parse(afterPartial.stats[0].as_of)).toBe(Date.parse(T0))
    expect(afterPartial.series).toHaveLength(1)
    expect(Date.parse(afterPartial.series[0].ts)).toBe(Date.parse(T2))
    expect(afterPartial.series[0].value).toBe(20)

    await expect(
      publishProfile(
        src,
        traderId,
        profile(T1, { roi: 15, pnl: 150, winRate: 50, seriesValue: 15 }, true),
        { fullSeries: true }
      )
    ).rejects.toBeInstanceOf(StaleProfilePublicationError)
    expect(await readState()).toEqual(afterPartial)

    await publishProfile(
      src,
      traderId,
      profile(T3, { roi: 30, pnl: 300, winRate: 60, seriesValue: 30 }, true),
      { fullSeries: true }
    )
    const afterComplete = await readState()
    expect(afterComplete.stats[0]).toMatchObject({
      roi: 30,
      pnl: 300,
      win_rate: 60,
      win_positions: 1,
      total_positions: 2,
      holding_hours: 2,
      watermark: String(Date.parse(T3)),
    })
    expect(Date.parse(afterComplete.stats[0].as_of)).toBe(Date.parse(T3))
    expect(afterComplete.series).toHaveLength(1)
    expect(Date.parse(afterComplete.series[0].ts)).toBe(Date.parse(T3))
    expect(afterComplete.series[0].value).toBe(30)
  })
})
