/** Real-SQL atomic replacement coverage for board-level series. */

jest.mock('@/lib/ingest/db', () => require('./test-db').mockDbModule())

import type { BoardSeriesBlock, SourceRow } from '@/lib/ingest/core/types'
import { publishBoardSeries } from '@/lib/ingest/serving/publish'
import {
  TEST_SCHEMA,
  createTestSchema,
  dropTestSchema,
  getRawPool,
  insertSourceRow,
  makeSource,
  resetTables,
} from './test-db'

const OLD_DAILY = '2026-05-01T00:00:00.000Z'
const RECENT_DAILY = '2026-07-15T00:00:00.000Z'
const NEW_DAILY = '2026-07-16T00:00:00.000Z'

interface SeededReplacement {
  src: SourceRow
  traderId: number
  snapshotId: number
  snapshotScrapedAt: string
}

async function seedReplacement(): Promise<SeededReplacement> {
  const src = makeSource({ slug: 'xt_test', adapter_slug: 'xt', expected_count: 1 })
  await insertSourceRow(src)
  const pool = getRawPool()
  const { rows: traders } = await pool.query<{ id: number }>(
    `INSERT INTO ${TEST_SCHEMA}.traders (source_id, exchange_trader_id)
     VALUES ($1, 'xt-1') RETURNING id`,
    [src.id]
  )
  const traderId = traders[0].id
  const { rows: snapshots } = await pool.query<{ id: number; scraped_at: string }>(
    `INSERT INTO ${TEST_SCHEMA}.leaderboard_snapshots
       (source_id, timeframe, scraped_at, expected_count, actual_count,
        baseline_used, count_check_passed, raw_object_id)
     VALUES ($1, 30, '2026-07-16T00:01:00.000Z', 1, 1, 1, true, 9001)
     RETURNING id, scraped_at::text`,
    [src.id]
  )
  await pool.query(
    `INSERT INTO ${TEST_SCHEMA}.trader_series
       (trader_id, timeframe, metric, ts, value, currency)
     VALUES ($1, 30, 'pnl', $2, 10, $4),
            ($1, 30, 'pnl', $3, 20, $4)`,
    [traderId, OLD_DAILY, RECENT_DAILY, src.currency]
  )
  await pool.query(
    `INSERT INTO ${TEST_SCHEMA}.trader_series_weekly
       (trader_id, timeframe, metric, week_start, value, currency)
     VALUES ($1, 30, 'pnl', '2026-04-27', 5, $2)`,
    [traderId, src.currency]
  )
  return {
    src,
    traderId,
    snapshotId: snapshots[0].id,
    snapshotScrapedAt: new Date(snapshots[0].scraped_at).toISOString(),
  }
}

function replacementSeries(): Map<string, BoardSeriesBlock[]> {
  return new Map([
    [
      'xt-1',
      [
        {
          timeframe: 30,
          metric: 'pnl',
          replaceSeries: true,
          points: [{ ts: NEW_DAILY, value: 30 }],
        },
      ],
    ],
  ])
}

function guard(seed: SeededReplacement) {
  return {
    expectedLatestSnapshots: new Map([
      [
        30,
        {
          id: seed.snapshotId,
          rawObjectId: 9001,
          scrapedAt: seed.snapshotScrapedAt,
        },
      ],
    ]),
  }
}

describe('publishBoardSeries — atomic complete snapshot replacement', () => {
  beforeAll(async () => {
    await createTestSchema()
  }, 120_000)

  afterAll(async () => {
    await dropTestSchema()
  })

  beforeEach(async () => {
    await resetTables()
  })

  test('replaces daily and weekly rows with the exact guarded snapshot', async () => {
    const seed = await seedReplacement()

    await expect(
      publishBoardSeries(
        seed.src,
        replacementSeries(),
        new Map([['xt-1', seed.traderId]]),
        guard(seed)
      )
    ).resolves.toEqual({ traders: 1, points: 1 })

    const { rows: daily } = await getRawPool().query<{ ts: string; value: number }>(
      `SELECT ts::text, value
         FROM ${TEST_SCHEMA}.trader_series
        WHERE trader_id = $1 AND timeframe = 30 AND metric = 'pnl'`,
      [seed.traderId]
    )
    expect(daily).toHaveLength(1)
    expect(new Date(daily[0].ts).toISOString()).toBe(NEW_DAILY)
    expect(daily[0].value).toBe(30)

    const { rows: weekly } = await getRawPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM ${TEST_SCHEMA}.trader_series_weekly
        WHERE trader_id = $1 AND timeframe = 30 AND metric = 'pnl'`,
      [seed.traderId]
    )
    expect(weekly[0].n).toBe(0)
  })

  test('restores both stores when insertion fails after the deletes', async () => {
    const seed = await seedReplacement()
    const invalidCurrency = { ...seed.src, currency: null } as unknown as SourceRow

    await expect(
      publishBoardSeries(
        invalidCurrency,
        replacementSeries(),
        new Map([['xt-1', seed.traderId]]),
        guard(seed)
      )
    ).rejects.toThrow()

    const { rows } = await getRawPool().query<{ daily: number; weekly: number }>(
      `SELECT
         (SELECT count(*)::int FROM ${TEST_SCHEMA}.trader_series
           WHERE trader_id = $1 AND timeframe = 30 AND metric = 'pnl') AS daily,
         (SELECT count(*)::int FROM ${TEST_SCHEMA}.trader_series_weekly
           WHERE trader_id = $1 AND timeframe = 30 AND metric = 'pnl') AS weekly`,
      [seed.traderId]
    )
    expect(rows[0]).toEqual({ daily: 2, weekly: 1 })
  })
})
