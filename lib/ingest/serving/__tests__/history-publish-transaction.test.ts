const mockClientQuery = jest.fn()
const mockClientRelease = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(),
  ingestClientConnect: jest.fn(async () => ({
    query: mockClientQuery,
    release: mockClientRelease,
  })),
}))

import type { ParsedHistoryRow, SourceRow } from '../../core/types'
import type { IngestQueryExecutor } from '../../db'
import { publishHistoryRows, publishHistoryRowsInTransaction } from '../publish'

const source = { slug: 'binance_futures', currency: 'USDT' } as SourceRow
const position: ParsedHistoryRow = {
  kind: 'position_history',
  openedAt: '2026-08-01T00:00:00.000Z',
  closedAt: '2026-08-02T00:00:00.000Z',
  symbol: 'BTCUSDT',
  side: 'long',
  leverage: 2,
  size: 1,
  entryPrice: 100,
  exitPrice: 110,
  realizedPnl: 10,
  dedupeHash: 'position-1',
  raw: { id: 'position-1' },
}
const nextCursor = '2026-08-02T00:00:00.000Z'

function successfulQuery() {
  return jest.fn(async (sqlInput: unknown) => {
    const sql = String(sqlInput)
    return sql.includes('INSERT INTO arena.position_history')
      ? { rows: [], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  })
}

describe('history transaction publication', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses only the caller executor for rows and the monotonic cursor', async () => {
    const query = successfulQuery()
    const transaction = { query } as unknown as IngestQueryExecutor

    await expect(
      publishHistoryRowsInTransaction(
        transaction,
        source,
        11,
        'position_history',
        [position],
        nextCursor
      )
    ).resolves.toBe(1)

    expect(query).toHaveBeenCalledTimes(2)
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO arena.position_history')
    expect(query.mock.calls[0][1]).toEqual([
      11,
      'USDT',
      JSON.stringify([
        {
          opened_at: position.openedAt,
          closed_at: position.closedAt,
          symbol: position.symbol,
          side: position.side,
          leverage: position.leverage,
          size: position.size,
          entry_price: position.entryPrice,
          exit_price: position.exitPrice,
          realized_pnl: position.realizedPnl,
          dedupe_hash: position.dedupeHash,
          raw: position.raw,
        },
      ]),
    ])
    expect(String(query.mock.calls[1][0])).toContain('INSERT INTO arena.ingest_cursors')
    expect(query.mock.calls[1][1]).toEqual([11, 'position_history', nextCursor])
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain('BEGIN')
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT')
    expect(mockClientQuery).not.toHaveBeenCalled()
  })

  it('keeps the legacy wrapper transaction and release behavior', async () => {
    mockClientQuery.mockImplementation(successfulQuery())

    await expect(
      publishHistoryRows(source, 11, 'position_history', [position], nextCursor)
    ).resolves.toBe(1)

    expect(mockClientQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO arena.position_history'),
      expect.stringContaining('INSERT INTO arena.ingest_cursors'),
      'COMMIT',
    ])
    expect(mockClientRelease).toHaveBeenCalledTimes(1)
  })

  it('rejects a mixed-kind batch before queries or cursor progress', async () => {
    const query = successfulQuery()
    const transaction = { query } as unknown as IngestQueryExecutor
    const order: ParsedHistoryRow = {
      kind: 'orders',
      ts: nextCursor,
      orderKind: 'close_long',
      symbol: 'BTCUSDT',
      side: 'long',
      price: 110,
      qty: 1,
      dedupeHash: 'order-1',
      raw: {},
    }

    await expect(
      publishHistoryRowsInTransaction(
        transaction,
        source,
        11,
        'position_history',
        [order],
        nextCursor
      )
    ).rejects.toThrow('row kind does not match position_history')
    expect(query).not.toHaveBeenCalled()
  })
})
