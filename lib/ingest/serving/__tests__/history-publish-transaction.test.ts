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

import type { ParsedHistoryRow, SourceRow } from '../../core/types'
import type { IngestQueryExecutor } from '../../db'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  getPositionHistoryPublicationCheckpoint,
  publishHistoryRows,
  publishHistoryRowsInTransaction,
  publishTierBVerifiedPositionHistoryInTransaction,
} from '../publish'

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
    const transaction = executor(query)
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

  it('reads the receipt-owned position-history checkpoint without consulting compatibility cursors', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          checkpoint: {
            publicationId: 91,
            cursor: '2026-08-02T00:00:00.000Z',
            observedAt: '2026-08-02T00:01:00.000Z',
          },
        },
      ],
      rowCount: 1,
    })

    await expect(getPositionHistoryPublicationCheckpoint(34, 11)).resolves.toEqual({
      publicationId: 91,
      cursor: '2026-08-02T00:00:00.000Z',
      observedAt: '2026-08-02T00:01:00.000Z',
    })

    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('arena.get_position_history_publication_checkpoint'),
      [34, 11]
    )
    expect(String(mockPoolQuery.mock.calls[0][0])).not.toContain('ingest_cursors')
  })

  it('accepts only a fully empty genesis checkpoint', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ checkpoint: { publicationId: null, cursor: null, observedAt: null } }],
      rowCount: 1,
    })

    await expect(getPositionHistoryPublicationCheckpoint(34, 11)).resolves.toEqual({
      publicationId: null,
      cursor: null,
      observedAt: null,
    })

    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          checkpoint: {
            publicationId: null,
            cursor: nextCursor,
            observedAt: '2026-08-02T00:01:00.000Z',
          },
        },
      ],
      rowCount: 1,
    })
    await expect(getPositionHistoryPublicationCheckpoint(34, 11)).rejects.toThrow(
      'empty publication checkpoint carries trusted state'
    )
  })

  it('rejects a checkpoint whose JSON shape drifts', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          checkpoint: {
            publicationId: 91,
            cursor: nextCursor,
            observedAt: '2026-08-02T00:01:00.000Z',
            legacyCursor: nextCursor,
          },
        },
      ],
      rowCount: 1,
    })

    await expect(getPositionHistoryPublicationCheckpoint(34, 11)).rejects.toThrow(
      'publication checkpoint fields do not match the database contract'
    )
  })

  it('publishes exact position rows through the receipt-owned writer', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          receipt: {
            publicationId: 92,
            rowsWritten: 1,
            parsedRowCount: 1,
            cursor: nextCursor,
            observedAt: '2026-08-02T00:01:00.000Z',
            publishedAt: '2026-08-02T00:01:01.000Z',
            replayed: false,
          },
        },
      ],
      rowCount: 1,
    })
    const transaction = executor(query)

    await expect(
      publishTierBVerifiedPositionHistoryInTransaction(transaction, {
        rawObjectId: 2_081_897,
        previousPublicationId: 91,
        effectiveCursorAfter: nextCursor,
        rows: [position],
      })
    ).resolves.toEqual({
      publicationId: 92,
      rowsWritten: 1,
      parsedRowCount: 1,
      cursor: nextCursor,
      observedAt: '2026-08-02T00:01:00.000Z',
      publishedAt: '2026-08-02T00:01:01.000Z',
      replayed: false,
    })

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('arena.publish_verified_position_history'),
      [
        2_081_897,
        91,
        nextCursor,
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
        'tier_b',
        'arena.ingest.position-history-publisher.worker@1',
      ]
    )
  })

  it('publishes a receipt even when a verified capture parses zero rows', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          receipt: {
            publicationId: 1,
            rowsWritten: 0,
            parsedRowCount: 0,
            cursor: null,
            observedAt: '2026-08-02T00:01:00.000Z',
            publishedAt: '2026-08-02T00:01:01.000Z',
            replayed: false,
          },
        },
      ],
      rowCount: 1,
    })
    const transaction = executor(query)

    await expect(
      publishTierBVerifiedPositionHistoryInTransaction(transaction, {
        rawObjectId: 2_081_897,
        previousPublicationId: null,
        effectiveCursorAfter: null,
        rows: [],
      })
    ).resolves.toMatchObject({ publicationId: 1, parsedRowCount: 0, rowsWritten: 0 })

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual([
      2_081_897,
      null,
      null,
      '[]',
      'tier_b',
      'arena.ingest.position-history-publisher.worker@1',
    ])
  })

  it('rejects a schema-invalid verified row before invoking the database writer', async () => {
    const query = jest.fn()
    const transaction = executor(query)
    const invalid = { ...position, realizedPnl: Number.NaN } as ParsedHistoryRow

    await expect(
      publishTierBVerifiedPositionHistoryInTransaction(transaction, {
        rawObjectId: 2_081_897,
        previousPublicationId: null,
        effectiveCursorAfter: nextCursor,
        rows: [invalid],
      })
    ).rejects.toThrow()

    expect(query).not.toHaveBeenCalled()
  })

  it('accepts an idempotent replay only when it reports zero newly written rows', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          receipt: {
            publicationId: 92,
            rowsWritten: 0,
            parsedRowCount: 1,
            cursor: nextCursor,
            observedAt: '2026-08-02T00:01:00.000Z',
            publishedAt: '2026-08-02T00:01:01.000Z',
            replayed: true,
          },
        },
      ],
      rowCount: 1,
    })
    const transaction = executor(query)

    await expect(
      publishTierBVerifiedPositionHistoryInTransaction(transaction, {
        rawObjectId: 2_081_897,
        previousPublicationId: 91,
        effectiveCursorAfter: nextCursor,
        rows: [position],
      })
    ).resolves.toMatchObject({ publicationId: 92, parsedRowCount: 1, rowsWritten: 0 })
  })

  it('fails closed when the writer receipt contradicts the requested write', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          receipt: {
            publicationId: 92,
            rowsWritten: 1,
            parsedRowCount: 1,
            cursor: nextCursor,
            observedAt: '2026-08-02T00:01:00.000Z',
            publishedAt: '2026-08-02T00:01:01.000Z',
            replayed: true,
          },
        },
      ],
      rowCount: 1,
    })
    const transaction = executor(query)

    await expect(
      publishTierBVerifiedPositionHistoryInTransaction(transaction, {
        rawObjectId: 2_081_897,
        previousPublicationId: 91,
        effectiveCursorAfter: nextCursor,
        rows: [position],
      })
    ).rejects.toThrow('publication receipt does not match the requested write')
  })
})
