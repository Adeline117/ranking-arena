const mockClientQuery = jest.fn()
const mockClientRelease = jest.fn()
const mockPoolQuery = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockPoolQuery })),
  ingestClientConnect: jest.fn(async () => ({
    query: mockClientQuery,
    release: mockClientRelease,
  })),
}))

import type { HistoryKind, ParsedHistoryRow, SourceRow } from '../../core/types'
import type { IngestQueryExecutor } from '../../db'
import type { QueryResult, QueryResultRow } from 'pg'
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
const order: ParsedHistoryRow = {
  kind: 'orders',
  ts: '2026-08-02T00:00:00.000Z',
  orderKind: 'close_long',
  symbol: 'BTCUSDT',
  side: 'long',
  price: 110,
  qty: 1,
  dedupeHash: 'order-1',
  raw: { id: 'order-1' },
}
const nextCursor = '2026-08-02T00:00:00.000Z'

function successfulQuery() {
  return jest.fn(async (sqlInput: unknown) => {
    const sql = String(sqlInput)
    return sql.includes('INSERT INTO arena.order_records')
      ? { rows: [], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  })
}

function executor(query: jest.Mock): IngestQueryExecutor {
  return {
    query: async <R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[]
    ): Promise<QueryResult<R>> => query(text, values),
  }
}

describe('history transaction publication', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses only the caller executor for rows and the monotonic cursor', async () => {
    const query = successfulQuery()
    const transaction = executor(query)

    await expect(
      publishHistoryRowsInTransaction(transaction, source, 11, 'orders', [order], nextCursor)
    ).resolves.toBe(1)

    expect(query).toHaveBeenCalledTimes(3)
    expect(String(query.mock.calls[0][0])).toContain('arena.ensure_history_partitions')
    expect(String(query.mock.calls[1][0])).toContain('INSERT INTO arena.order_records')
    expect(query.mock.calls[1][1]).toEqual([
      11,
      'USDT',
      JSON.stringify([
        {
          ts: order.ts,
          order_kind: order.orderKind,
          symbol: order.symbol,
          side: order.side,
          price: order.price,
          qty: order.qty,
          dedupe_hash: order.dedupeHash,
          raw: order.raw,
        },
      ]),
    ])
    expect(String(query.mock.calls[2][0])).toContain('INSERT INTO arena.ingest_cursors')
    expect(query.mock.calls[2][1]).toEqual([11, 'orders', nextCursor])
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain('BEGIN')
    expect(query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT')
    expect(mockClientQuery).not.toHaveBeenCalled()
  })

  it('keeps the legacy wrapper transaction and release behavior', async () => {
    mockClientQuery.mockImplementation(successfulQuery())

    await expect(publishHistoryRows(source, 11, 'orders', [order], nextCursor)).resolves.toBe(1)

    expect(mockClientQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      expect.stringContaining('arena.ensure_history_partitions'),
      expect.stringContaining('INSERT INTO arena.order_records'),
      expect.stringContaining('INSERT INTO arena.ingest_cursors'),
      'COMMIT',
    ])
    expect(mockClientRelease).toHaveBeenCalledTimes(1)
  })

  it('rejects a mixed-kind batch before queries or cursor progress', async () => {
    const query = successfulQuery()
    const transaction = executor(query)

    await expect(
      publishHistoryRowsInTransaction(transaction, source, 11, 'orders', [position], nextCursor)
    ).rejects.toThrow('row kind does not match orders')
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects every generic position-history call before queries or connection work', async () => {
    const query = successfulQuery()
    const transaction = executor(query)
    const unsafeInTransaction = publishHistoryRowsInTransaction as unknown as (
      transaction: IngestQueryExecutor,
      src: SourceRow,
      traderId: number,
      kind: HistoryKind,
      rows: ParsedHistoryRow[],
      cursor: string | null
    ) => Promise<number>
    const unsafeWrapper = publishHistoryRows as unknown as (
      src: SourceRow,
      traderId: number,
      kind: HistoryKind,
      rows: ParsedHistoryRow[],
      cursor: string | null
    ) => Promise<number>

    for (const rows of [[position], []] as ParsedHistoryRow[][]) {
      await expect(
        unsafeInTransaction(transaction, source, 11, 'position_history', rows, null)
      ).rejects.toThrow('position_history requires parser-conservation publication')
      await expect(unsafeWrapper(source, 11, 'position_history', rows, null)).rejects.toThrow(
        'position_history requires parser-conservation publication'
      )
    }

    expect(query).not.toHaveBeenCalled()
    expect(mockClientQuery).not.toHaveBeenCalled()
    expect(mockClientRelease).not.toHaveBeenCalled()
  })
})
