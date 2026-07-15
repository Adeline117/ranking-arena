import type { BoardSeriesBlock, SourceRow } from '../../core/types'

const query = jest.fn()
const release = jest.fn()

jest.mock('../../db', () => ({
  ingestClientConnect: jest.fn(async () => ({ query, release })),
  getIngestPool: jest.fn(),
}))

import { publishBoardSeries } from '../publish'

const src = { id: 29, slug: 'binance_web3_bsc', currency: 'USDT' } as SourceRow
const series = new Map<string, BoardSeriesBlock[]>([
  [
    'wallet-a',
    [
      {
        timeframe: 90,
        metric: 'pnl_daily',
        points: [{ ts: '2026-07-01T00:00:00.000Z', value: 10 }],
      },
    ],
  ],
])
const traderIds = new Map([['wallet-a', 42]])

describe('publishBoardSeries transaction boundary', () => {
  beforeEach(() => {
    query.mockReset()
    release.mockReset()
  })

  it('locks the source and commits only after the exact insert count', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => ({
      rowCount: sql.includes('INSERT INTO arena.trader_series')
        ? JSON.parse(String(params?.[0])).length
        : 0,
    }))

    await expect(publishBoardSeries(src, series, traderIds)).resolves.toEqual({
      traders: 1,
      points: 1,
    })
    expect(query.mock.calls.map(([sql]) => String(sql).trim().split('\n')[0])).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'INSERT INTO arena.trader_series (trader_id, timeframe, metric, ts, value, currency)',
      'COMMIT',
    ])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back the full source batch on a chunk count mismatch', async () => {
    query.mockImplementation(async (sql: string) => ({
      rowCount: sql.includes('INSERT INTO arena.trader_series') ? 0 : null,
    }))

    await expect(publishBoardSeries(src, series, traderIds)).rejects.toThrow('write count mismatch')
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toContain('ROLLBACK')
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).not.toContain('COMMIT')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('preserves a begin failure without attempting a rollback', async () => {
    query.mockRejectedValueOnce(new Error('begin failed'))

    await expect(publishBoardSeries(src, series, traderIds)).rejects.toThrow('begin failed')
    expect(query).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back before writing when a replay snapshot is no longer latest', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT ON (timeframe)')) {
        return { rows: [{ timeframe: 90, id: 778 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(
      publishBoardSeries(src, series, traderIds, {
        expectedLatestSnapshots: new Map([
          [
            90,
            {
              id: 777,
              rawObjectId: 9001,
              scrapedAt: '2026-07-15T00:00:00.000Z',
            },
          ],
        ]),
      })
    ).rejects.toThrow('stale replay snapshot')
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO arena.trader_series'))
    ).toBe(false)
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toContain('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('writes when the guarded snapshot identity is still exact', async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT DISTINCT ON (timeframe)')) {
        return {
          rows: [
            {
              timeframe: 90,
              id: 777,
              raw_object_id: 9001,
              scraped_at: '2026-07-15 00:00:00+00',
            },
          ],
          rowCount: 1,
        }
      }
      return {
        rows: [],
        rowCount: sql.includes('INSERT INTO arena.trader_series')
          ? JSON.parse(String(params?.[0])).length
          : 0,
      }
    })

    await expect(
      publishBoardSeries(src, series, traderIds, {
        expectedLatestSnapshots: new Map([
          [
            90,
            {
              id: 777,
              rawObjectId: 9001,
              scrapedAt: '2026-07-15T00:00:00.000Z',
            },
          ],
        ]),
      })
    ).resolves.toEqual({ traders: 1, points: 1 })
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toContain('COMMIT')
  })
})
