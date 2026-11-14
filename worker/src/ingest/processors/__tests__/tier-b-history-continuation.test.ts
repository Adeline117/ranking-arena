import type { SourceAdapter } from '@/lib/ingest/core/adapter'
import type { ParseCtx, ParsedHistoryRow, RawPage, SourceRow } from '@/lib/ingest/core/types'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import { HistoryPageCapReachedError } from '@/lib/ingest/core/history-page-cap'
import type { HistoryFetchOptions } from '@/lib/ingest/core/history-continuation'

const mockDbQuery = jest.fn()
const mockWriteRawObject = jest.fn()
const mockPublishHistoryRows = jest.fn()
const mockLoggerError = jest.fn()
const mockLoggerWarn = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishHistoryRows: (...args: unknown[]) => mockPublishHistoryRows(...args),
}))
jest.mock('@/lib/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}))

import { continueTruncatedHistory, recordHistoryTruncation } from '../tier-b-history-continuation'

const src = { id: 9, slug: 'gate_futures', meta: {}, currency: 'USDT' } as unknown as SourceRow
const trader = { id: 42, exchange_trader_id: 'L1', meta: null }
const ctx = { sourceSlug: src.slug } as ParseCtx
const session = {} as FetchSession
const BOUNDARY = '2026-07-10T00:00:00.000Z'

const order = (ts: string): ParsedHistoryRow => ({
  kind: 'orders',
  ts,
  orderKind: 'open_long',
  symbol: 'BTCUSDT',
  side: 'long',
  price: 1,
  qty: 1,
  dedupeHash: ts,
  raw: {},
})

/** Pages carry their parsed rows directly; the adapter "parser" unwraps them. */
const rawPage = (pageIndex: number, rows: ParsedHistoryRow[]): RawPage => ({
  pageIndex,
  payload: rows,
  url: 'https://gate.test/orders',
  fetchedAt: '2026-07-20T00:00:00.000Z',
})

function adapter(
  stream: (options: HistoryFetchOptions | undefined) => AsyncIterable<RawPage>,
  capability: ReturnType<NonNullable<SourceAdapter['historyContinuation']>> | null = {
    supported: true,
    mode: 'page_offset',
  }
): SourceAdapter & { getHistory: jest.Mock } {
  return {
    getHistory: jest.fn((_s, _src, _id, _kind, _cursor, _meta, options) => stream(options)),
    parseHistory: (payload: unknown) => payload as ParsedHistoryRow[],
    ...(capability !== null ? { historyContinuation: () => capability } : {}),
  } as unknown as SourceAdapter & { getHistory: jest.Mock }
}

const storedMarker = {
  detected_at: '2026-07-11T00:00:00Z',
  page_cap: 2,
  oldest_captured_at: BOUNDARY,
  continuation: {
    state: 'pending',
    mode: 'page_offset',
    resume_page: 3,
    boundary_at: BOUNDARY,
    runs: 0,
    last_error: null,
  },
}

function markerRead(marker: unknown) {
  mockDbQuery.mockImplementation(async (sql: string) =>
    String(sql).startsWith('SELECT')
      ? { rows: marker === null ? [] : [{ marker }], rowCount: 1 }
      : { rows: [], rowCount: 1 }
  )
}

const writes = () => mockDbQuery.mock.calls.filter(([sql]) => String(sql).includes('UPDATE'))

beforeEach(() => {
  jest.clearAllMocks()
  mockWriteRawObject.mockResolvedValue({ id: 1 })
  mockPublishHistoryRows.mockImplementation(async (_s, _t, _k, rows: unknown[]) => rows.length)
})

describe('recordHistoryTruncation (cap hit → continuation saved)', () => {
  it('stores the resume page reported by the cut and the oldest captured event', async () => {
    markerRead(null)
    const state = await recordHistoryTruncation(
      adapter(async function* () {}),
      src,
      42,
      'orders',
      new HistoryPageCapReachedError('gate_futures', 'orders', 2, 3),
      [order('2026-07-12T00:00:00.000Z'), order(BOUNDARY)]
    )
    expect(state).toEqual(storedMarker.continuation)
    expect(writes()[0][1]).toEqual([42, 'orders', 2, BOUNDARY, JSON.stringify(state)])
  })
})

describe('continueTruncatedHistory', () => {
  it('does nothing without a truncation marker', async () => {
    markerRead(null)
    const a = adapter(async function* () {})
    await expect(continueTruncatedHistory(session, a, src, trader, 'orders', ctx)).resolves.toEqual(
      {
        outcome: 'no_marker',
        rowsWritten: 0,
      }
    )
    expect(a.getHistory).not.toHaveBeenCalled()
  })

  it('resume → fetches older pages from the overlap page, publishes deduped rows with a null cursor, advances', async () => {
    markerRead(storedMarker)
    const a = adapter(async function* () {
      yield rawPage(2, [order('2026-07-10T00:00:30.000Z'), order(BOUNDARY)])
      yield rawPage(3, [order('2026-07-08T00:00:00.000Z')])
      throw new HistoryPageCapReachedError('gate_futures', 'orders', 2, 4)
    })

    const result = await continueTruncatedHistory(session, a, src, trader, 'orders', ctx)

    expect(result).toEqual({ outcome: 'advanced', rowsWritten: 3 })
    expect(a.getHistory).toHaveBeenCalledWith(session, src, 'L1', 'orders', null, null, {
      continuation: { mode: 'page_offset', startPage: 2 },
    })
    // Overlap rows are re-sent; the publisher dedupes on (ts, dedupe_hash).
    expect(mockPublishHistoryRows).toHaveBeenCalledWith(src, 42, 'orders', expect.any(Array), null)
    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          continuation: true,
          caller_limited: true,
          fetch_failed: false,
        }),
      })
    )
    const cas = writes().at(-1)!
    expect(String(cas[0])).toContain("meta->'history_truncated'->$2::text = $3::jsonb")
    expect(cas[1]).toEqual([
      42,
      'orders',
      JSON.stringify(storedMarker),
      JSON.stringify({
        ...storedMarker.continuation,
        resume_page: 4,
        boundary_at: '2026-07-08T00:00:00.000Z',
        runs: 1,
      }),
    ])
  })

  it('exhaustion → clears the marker (compare-and-clear)', async () => {
    markerRead(storedMarker)
    const a = adapter(async function* () {
      yield rawPage(2, [order(BOUNDARY), order('2026-07-01T00:00:00.000Z')])
    })
    await expect(continueTruncatedHistory(session, a, src, trader, 'orders', ctx)).resolves.toEqual(
      {
        outcome: 'completed',
        rowsWritten: 2,
      }
    )
    const clear = writes().at(-1)!
    expect(String(clear[0])).toContain("meta - 'history_truncated'")
    expect(clear[1]).toEqual([42, 'orders', JSON.stringify(storedMarker)])
  })

  it('exhaustion with a concurrently re-armed marker leaves it in place', async () => {
    mockDbQuery.mockImplementation(async (sql: string) =>
      String(sql).startsWith('SELECT')
        ? { rows: [{ marker: storedMarker }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    )
    const a = adapter(async function* () {
      yield rawPage(2, [order(BOUNDARY)])
    })
    await expect(continueTruncatedHistory(session, a, src, trader, 'orders', ctx)).resolves.toEqual(
      {
        outcome: 'marker_changed',
        rowsWritten: 1,
      }
    )
  })

  it('unsupported source → records the limitation explicitly, never fetches', async () => {
    markerRead({ detected_at: 'x', page_cap: 2, oldest_captured_at: BOUNDARY })
    const a = adapter(async function* () {}, { supported: false, reason: 'surface_auth_gated' })
    await expect(continueTruncatedHistory(session, a, src, trader, 'orders', ctx)).resolves.toEqual(
      {
        outcome: 'unsupported',
        rowsWritten: 0,
      }
    )
    expect(a.getHistory).not.toHaveBeenCalled()
    expect(writes()[0][1][3]).toBe(
      JSON.stringify({ state: 'unsupported', reason: 'surface_auth_gated' })
    )
  })

  it('an adapter without a declaration is recorded as adapter_not_wired', async () => {
    markerRead({ detected_at: 'x', page_cap: 2, oldest_captured_at: BOUNDARY })
    const a = adapter(async function* () {}, null)
    await continueTruncatedHistory(session, a, src, trader, 'orders', ctx)
    expect(writes()[0][1][3]).toBe(
      JSON.stringify({ state: 'unsupported', reason: 'adapter_not_wired' })
    )
  })

  it('no overlap on the first page → nothing published, steps back', async () => {
    markerRead(storedMarker)
    const a = adapter(async function* () {
      yield rawPage(2, [order('2026-07-01T00:00:00.000Z')])
    })
    await expect(continueTruncatedHistory(session, a, src, trader, 'orders', ctx)).resolves.toEqual(
      {
        outcome: 'rejected',
        rowsWritten: 0,
      }
    )
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(mockWriteRawObject).toHaveBeenCalled()
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('overlap_not_proven'))
    expect(JSON.parse(writes().at(-1)![1][3])).toMatchObject({ state: 'pending', resume_page: 2 })
  })

  it('upstream failure → RAW kept, error logged and stored, marker stays, no publish', async () => {
    markerRead(storedMarker)
    const a = adapter(async function* () {
      yield rawPage(2, [order(BOUNDARY)])
      throw new Error('upstream 500')
    })
    await expect(continueTruncatedHistory(session, a, src, trader, 'orders', ctx)).resolves.toEqual(
      {
        outcome: 'fetch_failed',
        rowsWritten: 0,
      }
    )
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ fetch_failed: true }) })
    )
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('upstream 500'))
    expect(JSON.parse(writes().at(-1)![1][3])).toMatchObject({
      state: 'pending',
      resume_page: 3,
      runs: 1,
      last_error: 'upstream 500',
    })
  })

  it('invalid stored marker → fails closed and logs', async () => {
    markerRead({ page_cap: 'bad' })
    const a = adapter(async function* () {})
    await expect(continueTruncatedHistory(session, a, src, trader, 'orders', ctx)).resolves.toEqual(
      {
        outcome: 'invalid_marker',
        rowsWritten: 0,
      }
    )
    expect(a.getHistory).not.toHaveBeenCalled()
    expect(writes()).toHaveLength(0)
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('DB errors propagate (never swallowed)', async () => {
    mockDbQuery.mockRejectedValue(new Error('connection reset'))
    const a = adapter(async function* () {})
    await expect(continueTruncatedHistory(session, a, src, trader, 'orders', ctx)).rejects.toThrow(
      'connection reset'
    )
  })
})
