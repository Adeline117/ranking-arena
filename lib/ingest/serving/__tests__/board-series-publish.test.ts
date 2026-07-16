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
const replacementSeries = new Map<string, BoardSeriesBlock[]>([
  [
    'wallet-a',
    [
      {
        timeframe: 90,
        metric: 'pnl_daily',
        replaceSeries: true,
        points: [{ ts: '2026-07-01T00:00:00.000Z', value: 10 }],
      },
    ],
  ],
])
const traderIds = new Map([['wallet-a', 42]])
const exactGuard = {
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
}

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

  it('fails closed before opening a transaction when replacement lacks a snapshot guard', async () => {
    await expect(publishBoardSeries(src, replacementSeries, traderIds)).rejects.toThrow(
      'replacement snapshot guard missing'
    )
    expect(query).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('rolls back before writing when a guarded snapshot is no longer latest', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT DISTINCT ON (timeframe)')) {
        return { rows: [{ timeframe: 90, id: 778 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(publishBoardSeries(src, replacementSeries, traderIds, exactGuard)).rejects.toThrow(
      'stale snapshot'
    )
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO arena.trader_series'))
    ).toBe(false)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM'))).toBe(false)
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toContain('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('deletes weekly then daily and writes when the guarded replacement is exact', async () => {
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
      publishBoardSeries(src, replacementSeries, traderIds, exactGuard)
    ).resolves.toEqual({ traders: 1, points: 1 })
    expect(query.mock.calls.map(([sql]) => String(sql).trim().split('\n')[0])).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'SELECT DISTINCT ON (timeframe)',
      'DELETE FROM arena.trader_series_weekly AS series',
      'DELETE FROM arena.trader_series AS series',
      'INSERT INTO arena.trader_series (trader_id, timeframe, metric, ts, value, currency)',
      'COMMIT',
    ])
    const deleteParams = query.mock.calls
      .filter(([sql]) => String(sql).includes('DELETE FROM arena.trader_series'))
      .map(([, params]) => params)
    expect(deleteParams).toEqual([
      [JSON.stringify([{ trader_id: 42, timeframe: 90, metric: 'pnl_daily' }])],
      [JSON.stringify([{ trader_id: 42, timeframe: 90, metric: 'pnl_daily' }])],
    ])
  })

  it('rolls back replacement deletes when the subsequent insert count mismatches', async () => {
    query.mockImplementation(async (sql: string) => {
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
        rowCount: sql.includes('INSERT INTO arena.trader_series') ? 0 : 0,
      }
    })

    await expect(publishBoardSeries(src, replacementSeries, traderIds, exactGuard)).rejects.toThrow(
      'write count mismatch'
    )
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM'))).toHaveLength(2)
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toContain('ROLLBACK')
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).not.toContain('COMMIT')
  })
})
