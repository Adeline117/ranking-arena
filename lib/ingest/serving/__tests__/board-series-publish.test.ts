import type { BoardSeriesBlock, SourceRow } from '../../core/types'
import type { IngestQueryExecutor } from '../../db'

jest.mock('../../db', () => ({
  ingestClientConnect: jest.fn(() => {
    throw new Error('board-series transaction body must not open a connection')
  }),
  getIngestPool: jest.fn(),
}))

import { validateWorkerDbFencedWriteStatement } from '@/worker/src/ingest/worker-db-fence'

import { prepareBoardSeriesPublication, publishBoardSeriesInTransaction } from '../publish'

const src = {
  id: 29,
  slug: 'binance_web3_bsc',
  currency: 'USDT',
  fetch_region: 'local',
} as SourceRow
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
const exactSnapshot = {
  timeframe: 90,
  id: 777,
  raw_object_id: 9001,
  scraped_at: '2026-07-15 00:00:00.123456+00',
}
const exactGuard = {
  expectedLatestSnapshots: new Map([
    [
      90,
      {
        id: 777,
        rawObjectId: 9001,
        scrapedAt: '2026-07-15T00:00:00.123Z',
      },
    ],
  ]),
}

function successfulQueryResult(sql: string, params?: readonly unknown[]) {
  if (sql.includes('FROM arena.sources')) {
    return {
      rows: [{ id: src.id, slug: src.slug, fetch_region: src.fetch_region }],
      rowCount: 1,
    }
  }
  if (sql.includes('SELECT DISTINCT ON (timeframe)')) {
    return { rows: [exactSnapshot], rowCount: 1 }
  }
  if (sql.includes('JOIN arena.leaderboard_entries AS entry')) {
    const expected = JSON.parse(String(params?.[0])) as Array<{
      exchange_trader_id: string
      trader_id: number
      timeframe: number
      snapshot_id: number
    }>
    return {
      rows: expected.map(({ exchange_trader_id, trader_id, timeframe, snapshot_id }) => ({
        exchange_trader_id,
        trader_id,
        timeframe,
        snapshot_id,
      })),
      rowCount: expected.length,
    }
  }
  if (sql.includes('INSERT INTO arena.trader_series')) {
    return {
      rows: [],
      rowCount: JSON.parse(String(params?.[0])).length,
    }
  }
  if (sql.includes('UPDATE arena.trader_stats')) {
    return {
      rows: [],
      rowCount: JSON.parse(String(params?.[0])).length,
    }
  }
  return { rows: [], rowCount: 0 }
}

function statementHeads(calls: jest.Mock['mock']['calls']): string[] {
  return calls.map(([sql]) => String(sql).trim().split('\n')[0])
}

function validatedTransaction() {
  const transactionQuery = jest.fn(async (sql: string, params?: readonly unknown[]) => {
    validateWorkerDbFencedWriteStatement(sql)
    return successfulQueryResult(sql, params)
  })
  return {
    transaction: { query: transactionQuery } as unknown as IngestQueryExecutor,
    transactionQuery,
  }
}

function exactSourceAuthorityGuard(expectedSource: SourceRow = src) {
  return jest.fn(async (transaction: IngestQueryExecutor) => {
    const result = await transaction.query<{
      id: number
      slug: string
      fetch_region: string
    }>(
      `SELECT id, slug, fetch_region
         FROM arena.sources
        WHERE id = $1::smallint
          AND slug = $2::text
          AND fetch_region = $3::text`,
      [expectedSource.id, expectedSource.slug, expectedSource.fetch_region]
    )
    if (
      result.rowCount !== 1 ||
      result.rows[0]?.id !== expectedSource.id ||
      result.rows[0]?.slug !== expectedSource.slug ||
      result.rows[0]?.fetch_region !== expectedSource.fetch_region
    ) {
      throw new Error('source authority changed')
    }
  })
}

describe('board-series fenced transaction body', () => {
  it('runs only validator-approved queries in lock, authority, guard, replace, write order', async () => {
    const prepared = prepareBoardSeriesPublication(src, replacementSeries, traderIds, exactGuard)
    const { transaction, transactionQuery } = validatedTransaction()
    const sourceAuthorityGuard = exactSourceAuthorityGuard()

    await expect(
      publishBoardSeriesInTransaction(transaction, prepared, sourceAuthorityGuard)
    ).resolves.toEqual({ traders: 1, points: 1 })

    expect(sourceAuthorityGuard).toHaveBeenCalledWith(transaction)
    expect(statementHeads(transactionQuery.mock.calls)).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'SELECT id, slug, fetch_region',
      'SELECT DISTINCT ON (timeframe)',
      'SELECT expected.exchange_trader_id, expected.trader_id,',
      'DELETE FROM arena.trader_series_weekly AS series',
      'DELETE FROM arena.trader_series AS series',
      'INSERT INTO arena.trader_series (trader_id, timeframe, metric, ts, value, currency)',
    ])
    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b/i.test(String(sql).trim())
      )
    ).toBe(false)
    expect(
      transactionQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE arena.trader_stats'))
    ).toBe(false)
  })

  it('derives and publishes risk only for a pure-DEX canonical series plan', async () => {
    const dexSource = { ...src, id: 31, slug: 'gmx' } as SourceRow
    const values = [2, -1, 3, -1, 2, -1, 4, -2]
    const dexSeries = new Map<string, BoardSeriesBlock[]>([
      [
        'wallet-a',
        [
          {
            timeframe: 90,
            metric: 'roi_daily',
            points: values.map((value, index) => ({
              ts: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
              value,
            })),
          },
        ],
      ],
    ])
    const prepared = prepareBoardSeriesPublication(dexSource, dexSeries, traderIds, exactGuard)
    expect(prepared.derivedRiskRows).toEqual([
      {
        trader_id: 42,
        timeframe: 90,
        sharpe: expect.any(Number),
        sortino: expect.any(Number),
        volatility: expect.any(Number),
      },
    ])

    const transactionQuery = jest.fn(async (sql: string, params?: readonly unknown[]) => {
      validateWorkerDbFencedWriteStatement(sql)
      if (sql.includes('FROM arena.sources')) {
        return {
          rows: [{ id: dexSource.id, slug: dexSource.slug, fetch_region: dexSource.fetch_region }],
          rowCount: 1,
        }
      }
      return successfulQueryResult(sql, params)
    })
    const transaction = { query: transactionQuery } as unknown as IngestQueryExecutor

    await expect(
      publishBoardSeriesInTransaction(transaction, prepared, exactSourceAuthorityGuard(dexSource))
    ).resolves.toEqual({ traders: 1, points: values.length })

    expect(statementHeads(transactionQuery.mock.calls)).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'SELECT id, slug, fetch_region',
      'SELECT DISTINCT ON (timeframe)',
      'SELECT expected.exchange_trader_id, expected.trader_id,',
      'UPDATE arena.trader_stats ts SET',
      'INSERT INTO arena.trader_series (trader_id, timeframe, metric, ts, value, currency)',
    ])
    const [riskSql, riskParams] = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE arena.trader_stats')
    ) as [string, unknown[]]
    expect(riskSql).toContain("jsonb_build_object('risk_self_derived', true)")
    expect(riskSql).not.toContain('"')
    expect(riskParams).toEqual([JSON.stringify(prepared.derivedRiskRows)])
  })

  it('snapshots and freezes every mutable producer input before transaction use', () => {
    const mutableSource = { ...src } as SourceRow
    const point = { ts: '2026-07-01T00:00:00.000Z', value: 10 }
    const block: BoardSeriesBlock = {
      timeframe: 90,
      metric: 'pnl_daily',
      replaceSeries: true,
      points: [point],
    }
    const mutableSeries = new Map<string, BoardSeriesBlock[]>([['wallet-a', [block]]])
    const mutableTraderIds = new Map([['wallet-a', 42]])
    const expected = {
      id: 777,
      rawObjectId: 9001,
      scrapedAt: '2026-07-15T00:00:00.000Z',
    }
    const expectedLatestSnapshots = new Map([[90, expected]])

    const prepared = prepareBoardSeriesPublication(mutableSource, mutableSeries, mutableTraderIds, {
      expectedLatestSnapshots,
    })

    mutableSource.id = 999
    mutableSource.slug = 'gmx'
    mutableSource.currency = 'USDC'
    mutableSource.fetch_region = 'vps_sg'
    point.ts = '2027-01-01T00:00:00.000Z'
    point.value = 999
    block.points.push({ ts: '2027-01-02T00:00:00.000Z', value: 1_000 })
    mutableSeries.clear()
    mutableTraderIds.set('wallet-a', 999)
    expected.id = 999
    expected.rawObjectId = 999
    expected.scrapedAt = '2027-01-01T00:00:00.000Z'
    expectedLatestSnapshots.clear()

    expect(prepared).toMatchObject({
      derivedRiskRows: [],
      source: {
        id: 29,
        slug: 'binance_web3_bsc',
        currency: 'USDT',
        fetch_region: 'local',
      },
      traders: 1,
    })
    expect(prepared.rows).toEqual([
      {
        trader_id: 42,
        timeframe: 90,
        metric: 'pnl_daily',
        ts: '2026-07-01T00:00:00.000Z',
        value: 10,
      },
    ])
    expect(prepared.replacements).toEqual([{ trader_id: 42, timeframe: 90, metric: 'pnl_daily' }])
    expect(prepared.expectedLatestSnapshots).toEqual([
      {
        timeframe: 90,
        id: 777,
        rawObjectId: 9001,
        scrapedAt: '2026-07-15T00:00:00.000Z',
      },
    ])
    expect(prepared.snapshotMemberships).toEqual([
      {
        exchange_trader_id: 'wallet-a',
        trader_id: 42,
        timeframe: 90,
        snapshot_id: 777,
        raw_object_id: 9001,
      },
    ])
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.source)).toBe(true)
    expect(Object.isFrozen(prepared.rows)).toBe(true)
    expect(Object.isFrozen(prepared.rows[0])).toBe(true)
    expect(Object.isFrozen(prepared.replacements)).toBe(true)
    expect(Object.isFrozen(prepared.replacements[0])).toBe(true)
    expect(Object.isFrozen(prepared.expectedLatestSnapshots)).toBe(true)
    expect(Object.isFrozen(prepared.expectedLatestSnapshots[0])).toBe(true)
    expect(Object.isFrozen(prepared.derivedRiskRows)).toBe(true)
    expect(Object.isFrozen(prepared.snapshotMemberships)).toBe(true)
    expect(Object.isFrozen(prepared.snapshotMemberships[0])).toBe(true)
  })

  it('rejects a trader outside the exact source snapshot before any DML', async () => {
    const prepared = prepareBoardSeriesPublication(src, series, traderIds, exactGuard)
    const transactionQuery = jest.fn(async (sql: string, params?: readonly unknown[]) => {
      validateWorkerDbFencedWriteStatement(sql)
      if (sql.includes('JOIN arena.leaderboard_entries AS entry')) {
        expect(params?.[1]).toBe(src.id)
        expect(sql).toMatch(/guarded_snapshot\.source_id = \$2/)
        expect(sql).toMatch(/trader\.exchange_trader_id = expected\.exchange_trader_id/)
        expect(sql).toMatch(/entry\.snapshot_id = guarded_snapshot\.id/)
        return { rows: [], rowCount: 0 }
      }
      return successfulQueryResult(sql, params)
    })
    const transaction = { query: transactionQuery } as unknown as IngestQueryExecutor

    await expect(
      publishBoardSeriesInTransaction(transaction, prepared, exactSourceAuthorityGuard())
    ).rejects.toThrow('[board-series] trader snapshot membership mismatch for binance_web3_bsc')

    expect(
      transactionQuery.mock.calls.some(([sql]) =>
        /^(?:UPDATE|DELETE|INSERT)\b/i.test(String(sql).trim())
      )
    ).toBe(false)
  })

  it('rejects a structurally forged prepared plan before invoking authority or SQL', async () => {
    const prepared = prepareBoardSeriesPublication(src, series, traderIds, exactGuard)
    const forged = { ...prepared } as typeof prepared
    const { transaction, transactionQuery } = validatedTransaction()
    const sourceAuthorityGuard = exactSourceAuthorityGuard()

    await expect(
      publishBoardSeriesInTransaction(transaction, forged, sourceAuthorityGuard)
    ).rejects.toThrow('[board-series] fenced publication requires a source authority guard')
    expect(sourceAuthorityGuard).not.toHaveBeenCalled()
    expect(transactionQuery).not.toHaveBeenCalled()
  })

  it('requires an exact snapshot guard for additive rows too', () => {
    expect(() =>
      prepareBoardSeriesPublication(src, series, traderIds, {
        expectedLatestSnapshots: new Map(),
      })
    ).toThrow('[board-series] snapshot guard missing for binance_web3_bsc: 90d')
  })

  it('rejects two exchange identities mapped to one database trader', () => {
    const aliasedSeries = new Map(series)
    aliasedSeries.set('wallet-b', series.get('wallet-a')!)

    expect(() =>
      prepareBoardSeriesPublication(
        src,
        aliasedSeries,
        new Map([
          ['wallet-a', 42],
          ['wallet-b', 42],
        ]),
        exactGuard
      )
    ).toThrow('[board-series] trader identity is ambiguous for binance_web3_bsc')
  })

  it('rejects malformed and unrelated snapshot guards before opening a transaction', () => {
    expect(() =>
      prepareBoardSeriesPublication(src, series, traderIds, {
        expectedLatestSnapshots: new Map([
          [
            90,
            {
              id: 777,
              rawObjectId: 9001,
              scrapedAt: '2026-07-15T00:00:00Z',
            },
          ],
        ]),
      })
    ).toThrow('[board-series] snapshot guard malformed for binance_web3_bsc')

    const idAccessor = jest.fn(() => 777)
    const accessorGuard = Object.defineProperties(
      {},
      {
        id: { enumerable: true, get: idAccessor },
        rawObjectId: { enumerable: true, value: 9001 },
        scrapedAt: { enumerable: true, value: '2026-07-15T00:00:00.123Z' },
      }
    ) as { id: number; rawObjectId: number; scrapedAt: string }
    expect(() =>
      prepareBoardSeriesPublication(src, series, traderIds, {
        expectedLatestSnapshots: new Map([[90, accessorGuard]]),
      })
    ).toThrow('[board-series] snapshot guard malformed for binance_web3_bsc')
    expect(idAccessor).not.toHaveBeenCalled()

    expect(() =>
      prepareBoardSeriesPublication(src, series, traderIds, {
        expectedLatestSnapshots: new Map([
          ...exactGuard.expectedLatestSnapshots,
          [
            30,
            {
              id: 778,
              rawObjectId: 9002,
              scrapedAt: '2026-07-15T00:00:00.000Z',
            },
          ] as const,
        ]),
      })
    ).toThrow('[board-series] snapshot guard has unrelated timeframe for binance_web3_bsc: 30d')
  })
})
