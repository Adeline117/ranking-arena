/** @jest-environment node */

import type { NextRequest } from 'next/server'
import {
  RECORDS_CURSOR_INVALIDATED_CODE,
  type CopierAggregate,
  type RecordKind,
  type RecordsPage,
} from '@/lib/data/serving/types'

const mockSupabase = { marker: 'records-route' }
const mockResolveServingTrader = jest.fn()
const mockGetRecordsPage = jest.fn()
const mockGetCopierAggregate = jest.fn()
const mockRecordsPageFromTierC = jest.fn()
const mockRequestTierC = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: unknown) => unknown) => (request: unknown) =>
    handler({ supabase: mockSupabase, request }),
}))
jest.mock('@/lib/api/response', () => {
  class HeaderBag {
    private readonly values = new Map<string, string>()

    constructor(init?: Record<string, string>) {
      for (const [key, value] of Object.entries(init ?? {})) this.set(key, value)
    }

    get(key: string) {
      return this.values.get(key.toLowerCase()) ?? null
    }

    set(key: string, value: string) {
      this.values.set(key.toLowerCase(), value)
    }
  }

  class RouteResponse {
    readonly headers: HeaderBag

    constructor(
      private readonly body: unknown,
      readonly status = 200,
      headers?: Record<string, string>
    ) {
      this.headers = new HeaderBag(headers)
    }

    async json() {
      return this.body
    }
  }

  return {
    success: (data: unknown, status = 200, headers?: Record<string, string>) =>
      new RouteResponse({ success: true, data }, status, headers),
    withCache: (
      response: InstanceType<typeof RouteResponse>,
      options: { maxAge?: number; staleWhileRevalidate?: number }
    ) => {
      const maxAge = options.maxAge ?? 60
      const staleWhileRevalidate = options.staleWhileRevalidate ?? 300
      response.headers.set(
        'Cache-Control',
        `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`
      )
      return response
    },
  }
})
jest.mock('@/lib/data/serving/resolve', () => ({
  resolveServingTrader: (...args: unknown[]) => mockResolveServingTrader(...args),
}))
jest.mock('@/lib/data/serving/records', () => ({
  getRecordsPage: (...args: unknown[]) => mockGetRecordsPage(...args),
  getCopierAggregate: (...args: unknown[]) => mockGetCopierAggregate(...args),
  recordsPageFromTierC: (...args: unknown[]) => mockRecordsPageFromTierC(...args),
}))
jest.mock('@/lib/data/serving/tier-c', () => ({
  requestTierC: (...args: unknown[]) => mockRequestTierC(...args),
}))

import { GET } from '../route'

const resolvedTrader = {
  source: 'bitget_futures',
  fetchRegion: 'vps_sg',
  exchangeTraderId: 'trader-1',
}

function provenance(observedAt: string | null = null) {
  return {
    source: 'bitget_futures',
    sourceAsOf: null,
    observedAt,
    publishedAt: null,
  }
}

function request(
  kind: RecordKind = 'position_history',
  cursor?: string,
  tf: '7' | '30' | '90' | 'inception' = '30'
): NextRequest {
  const url = new URL(
    `https://arena.example/api/traders/Trader%20One/records?kind=${kind}&source=bitget_futures&tf=${tf}`
  )
  if (cursor !== undefined) url.searchParams.set('cursor', cursor)
  return { nextUrl: url } as NextRequest
}

async function callRoute(
  kind: RecordKind = 'position_history',
  cursor?: string,
  tf: '7' | '30' | '90' | 'inception' = '30'
) {
  return GET(request(kind, cursor, tf), { params: Promise.resolve({ handle: 'Trader%20One' }) })
}

function copierAggregate(overrides: Partial<CopierAggregate> = {}): CopierAggregate {
  return {
    copierCount: 12,
    copierCountMax: null,
    totalCopierPnl: null,
    pnlDistribution: [],
    depth: 'full',
    receiptBound: true,
    provenance: provenance('2026-08-03T12:00:00.000Z'),
    completeness: {
      state: 'complete',
      reason: 'verified_copier_snapshot',
      evidenceState: 'verified',
      scanTerminalState: 'exhausted',
      blockerReasons: [],
    },
    ...overrides,
  }
}

describe('records route history trust boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveServingTrader.mockResolvedValue(resolvedTrader)
    mockGetRecordsPage.mockResolvedValue(null)
    mockGetCopierAggregate.mockResolvedValue(null)
    mockRequestTierC.mockResolvedValue(null)
    mockRecordsPageFromTierC.mockReturnValue(null)
  })

  it.each(['position_history', 'orders', 'transfers'] as const)(
    'passes the exact %s kind into the Tier-C mapper',
    async (kind) => {
      const workerPayload = { rows: [{ symbol: 'BTCUSDT' }] }
      const fetched: RecordsPage = {
        rows: [{ symbol: 'BTCUSDT' }],
        nextCursor: null,
        provenance: {
          source: 'bitget_futures',
          sourceAsOf: null,
          observedAt: '2026-08-03T12:00:00.000Z',
          publishedAt: null,
        },
        cacheState: 'cold-fetched',
        completeness: { state: 'partial', reason: 'interactive_preview' },
      }
      mockRequestTierC.mockResolvedValue(workerPayload)
      mockRecordsPageFromTierC.mockReturnValue(fetched)

      const response = await callRoute(kind)
      const body = await response.json()

      expect(body.data).toEqual(fetched)
      expect(mockRequestTierC).toHaveBeenCalledWith({
        sourceSlug: 'bitget_futures',
        fetchRegion: 'vps_sg',
        exchangeTraderId: 'trader-1',
        timeframe: 30,
        surface: kind,
      })
      expect(mockRecordsPageFromTierC).toHaveBeenCalledWith('bitget_futures', kind, workerPayload)
      expect(mockResolveServingTrader).toHaveBeenCalledWith(mockSupabase, {
        handle: 'Trader One',
        source: 'bitget_futures',
      })
    }
  )

  it.each(['orders', 'transfers'] as const)(
    'marks pending append-only %s completeness unknown',
    async (kind) => {
      const response = await callRoute(kind)
      const body = await response.json()
      expect(body.data.cacheState).toBe('pending')
      expect(body.data.completeness).toEqual({
        state: 'unknown',
        reason: 'history_evidence_not_bound',
      })
      expect(body.data.nextCursor).toBeNull()
    }
  )

  it.each(['position_history'] as const)(
    'fails a pending %s page closed when no evidence is available',
    async (kind) => {
      const response = await callRoute(kind)
      const body = await response.json()

      expect(body.data).toMatchObject({
        rows: [],
        nextCursor: null,
        cacheState: 'pending',
        provenance: {
          source: 'bitget_futures',
          sourceAsOf: null,
          observedAt: null,
          publishedAt: null,
        },
        completeness: {
          state: 'unknown',
          reason: 'history_evidence_not_bound',
        },
      })
      expect(body.data.provenance).not.toHaveProperty('asOf')
    }
  )

  it('does not attach a history verdict to pending current positions', async () => {
    const response = await callRoute('positions')
    const body = await response.json()

    expect(body.data.cacheState).toBe('pending')
    expect(body.data.completeness).toBeUndefined()
  })

  it('returns a verified complete empty history page without a Tier-C request', async () => {
    const completeEmpty: RecordsPage = {
      rows: [],
      nextCursor: null,
      provenance: {
        source: 'bitget_futures',
        sourceAsOf: null,
        observedAt: '2026-08-03T12:00:00.000Z',
        publishedAt: '2026-08-03T12:00:01.000Z',
      },
      cacheState: 'warm',
      completeness: {
        state: 'complete',
        reason: 'verified_terminal_history',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      },
    }
    mockGetRecordsPage.mockResolvedValue(completeEmpty)

    const response = await callRoute('position_history')
    const body = await response.json()

    expect(body.data).toEqual(completeEmpty)
    expect(mockRequestTierC).not.toHaveBeenCalled()
  })

  it.each(['positions', 'position_history', 'orders', 'transfers'] as const)(
    'never substitutes a Tier-C first page for an invalid %s cursor',
    async (kind) => {
      const response = await callRoute(kind, 'stale-cursor')
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(body).toEqual({
        success: false,
        error: {
          code: RECORDS_CURSOR_INVALIDATED_CODE,
          message: 'Record pagination changed; restart from the first page',
          resetRequired: true,
        },
      })
      expect(mockRequestTierC).not.toHaveBeenCalled()
      expect(mockRecordsPageFromTierC).not.toHaveBeenCalled()
    }
  )

  it('invalidates an unverified warm history cursor without a Tier-C request', async () => {
    const warmEmpty = {
      rows: [],
      nextCursor: null,
      provenance: {
        source: 'bitget_futures',
        sourceAsOf: null,
        observedAt: null,
        publishedAt: null,
      },
      cacheState: 'warm',
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    } satisfies RecordsPage
    mockGetRecordsPage.mockResolvedValue(warmEmpty)

    const response = await callRoute('position_history', 'valid-cursor')
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(body.error).toMatchObject({
      code: RECORDS_CURSOR_INVALIDATED_CODE,
      resetRequired: true,
    })
    expect(mockRequestTierC).not.toHaveBeenCalled()
  })

  it('does not cache an unverified quarantined history first page', async () => {
    mockGetRecordsPage.mockResolvedValue({
      rows: [{ symbol: 'BTCUSDT' }],
      nextCursor: 'legacy-cursor',
      provenance: {
        source: 'bitget_futures',
        sourceAsOf: null,
        observedAt: null,
        publishedAt: null,
      },
      cacheState: 'warm',
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    } satisfies RecordsPage)

    const response = await callRoute('position_history')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(body.data).toMatchObject({
      rows: [],
      nextCursor: null,
      cacheState: 'pending',
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    })
    expect(mockRequestTierC).toHaveBeenCalledTimes(1)
  })

  it.each(['', '  '] as const)('rejects a non-canonical cursor %j', async (cursor) => {
    await expect(callRoute('orders', cursor)).rejects.toMatchObject({ statusCode: 400 })
    expect(mockGetRecordsPage).not.toHaveBeenCalled()
    expect(mockRequestTierC).not.toHaveBeenCalled()
  })

  it.each(['orders', 'transfers'] as const)(
    'serves warm %s with explicit unknown completeness',
    async (kind) => {
      const page: RecordsPage = {
        rows: [{ id: `${kind}-1` }],
        nextCursor: `${kind}-next`,
        provenance: provenance('2026-08-03T11:00:00.000Z'),
        cacheState: 'warm',
        completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
      }
      mockGetRecordsPage.mockResolvedValue(page)

      const response = await callRoute(kind)
      const body = await response.json()

      expect(body.data).toEqual(page)
      expect(response.headers.get('Cache-Control')).toContain('s-maxage=30')
      expect(mockRequestTierC).not.toHaveBeenCalled()
    }
  )

  it('uses a bounded Tier-C preview when warm position history lacks @2 evidence', async () => {
    const warmUnverified: RecordsPage = {
      rows: [{ symbol: 'must-not-serve' }],
      nextCursor: 'legacy-cursor',
      provenance: provenance('2026-08-03T11:00:00.000Z'),
      cacheState: 'warm',
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    }
    const workerPayload = { rows: [{ symbol: 'ETHUSDT' }] }
    const fetched: RecordsPage = {
      rows: [{ symbol: 'ETHUSDT' }],
      nextCursor: null,
      provenance: provenance('2026-08-03T12:00:00.000Z'),
      cacheState: 'cold-fetched',
      completeness: { state: 'partial', reason: 'interactive_preview' },
    }
    mockGetRecordsPage.mockResolvedValue(warmUnverified)
    mockRequestTierC.mockResolvedValue(workerPayload)
    mockRecordsPageFromTierC.mockReturnValue(fetched)

    const response = await callRoute()
    const body = await response.json()

    expect(body.data).toEqual(fetched)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mockRequestTierC).toHaveBeenCalledWith({
      sourceSlug: 'bitget_futures',
      fetchRegion: 'vps_sg',
      exchangeTraderId: 'trader-1',
      timeframe: 30,
      surface: 'position_history',
    })
    expect(mockRecordsPageFromTierC).toHaveBeenCalledWith(
      'bitget_futures',
      'position_history',
      workerPayload
    )
  })

  it('preserves a warm empty page observation while Tier-C is pending', async () => {
    const emptyWarm: RecordsPage = {
      rows: [],
      nextCursor: null,
      provenance: provenance('2026-08-03T11:00:00.000Z'),
      cacheState: 'warm',
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    }
    mockGetRecordsPage.mockResolvedValue(emptyWarm)

    const response = await callRoute()
    const body = await response.json()

    expect(body.data).toEqual({ ...emptyWarm, cacheState: 'pending' })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('does not echo unverified warm history when the Tier-C preview is unavailable', async () => {
    const legacyWarm: RecordsPage = {
      rows: [{ symbol: 'BTCUSDT', realized_pnl: 99 }],
      nextCursor: 'legacy-next',
      provenance: provenance('2026-08-03T11:00:00.000Z'),
      cacheState: 'warm',
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    }
    mockGetRecordsPage.mockResolvedValue(legacyWarm)

    const response = await callRoute()
    const body = await response.json()

    expect(body.data).toEqual({
      ...legacyWarm,
      rows: [],
      nextCursor: null,
      cacheState: 'pending',
    })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('serves only a receipt-bound copier aggregate', async () => {
    const aggregate = {
      copierCount: 2,
      copierCountMax: null,
      totalCopierPnl: null,
      pnlDistribution: [],
      depth: 'full',
      receiptBound: true,
      provenance: provenance('2026-08-03T11:00:00.000Z'),
      completeness: {
        state: 'complete',
        reason: 'verified_copier_snapshot',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      },
    }
    mockGetCopierAggregate.mockResolvedValue(aggregate)

    const response = await callRoute('copiers')
    const body = await response.json()

    expect(body.data).toEqual(aggregate)
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=300')
    expect(mockGetCopierAggregate).toHaveBeenCalledWith(mockSupabase, 'bitget_futures', 'trader-1')
    expect(mockGetRecordsPage).not.toHaveBeenCalled()
    expect(mockRequestTierC).not.toHaveBeenCalled()
  })
})

describe('records route copier cold start', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveServingTrader.mockResolvedValue(resolvedTrader)
    mockGetRecordsPage.mockResolvedValue(null)
    mockGetCopierAggregate.mockResolvedValue(null)
    mockRequestTierC.mockResolvedValue(null)
    mockRecordsPageFromTierC.mockReturnValue(null)
  })

  it.each(['7', '30', '90', 'inception'] as const)(
    'serves warm aggregate evidence without a Tier-C request for tf=%s',
    async (tf) => {
      const aggregate = copierAggregate()
      mockGetCopierAggregate.mockResolvedValue(aggregate)

      const response = await callRoute('copiers', undefined, tf)
      const body = await response.json()

      expect(body.data).toEqual(aggregate)
      expect(response.headers.get('Cache-Control')).toContain('s-maxage=300')
      expect(mockGetCopierAggregate).toHaveBeenCalledTimes(1)
      expect(mockRequestTierC).not.toHaveBeenCalled()
    }
  )

  it.each(['7', '30', '90', 'inception'] as const)(
    'uses one canonical timeframe=0 cold-flight coordinate for tf=%s',
    async (tf) => {
      const refreshed = copierAggregate({ copierCount: 5 })
      mockGetCopierAggregate.mockResolvedValueOnce(null).mockResolvedValueOnce(refreshed)
      mockRequestTierC.mockResolvedValue({
        rows: [{ copierLabel: 'private-user', email: 'secret@example.invalid', pnl: 900 }],
        raw: { private: true },
      })

      const response = await callRoute('copiers', undefined, tf)
      const body = await response.json()

      expect(mockRequestTierC).toHaveBeenCalledWith({
        sourceSlug: 'bitget_futures',
        fetchRegion: 'vps_sg',
        exchangeTraderId: 'trader-1',
        timeframe: 0,
        surface: 'copiers',
      })
      expect(mockGetCopierAggregate).toHaveBeenCalledTimes(2)
      expect(body.data).toEqual(refreshed)
      expect(JSON.stringify(body)).not.toMatch(/private-user|secret@example\.invalid|"raw"/)
      expect(response.headers.get('Cache-Control')).toContain('s-maxage=300')
      expect(mockRecordsPageFromTierC).not.toHaveBeenCalled()
    }
  )

  it('re-reads the aggregate after a bridge timeout and otherwise stays pending/no-store', async () => {
    const response = await callRoute('copiers')
    const body = await response.json()

    expect(mockRequestTierC).toHaveBeenCalledTimes(1)
    expect(mockGetCopierAggregate).toHaveBeenCalledTimes(2)
    expect(body.data).toEqual({ cacheState: 'pending' })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('never exposes an unbound legacy aggregate before or after refresh', async () => {
    const unbound = copierAggregate({
      copierCount: 99,
      receiptBound: false,
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    })
    mockGetCopierAggregate.mockResolvedValue(unbound)

    const response = await callRoute('copiers')
    const body = await response.json()

    expect(mockRequestTierC).toHaveBeenCalledTimes(1)
    expect(mockGetCopierAggregate).toHaveBeenCalledTimes(2)
    expect(body.data).toEqual({ cacheState: 'pending' })
    expect(JSON.stringify(body)).not.toContain('99')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('preserves an explicit source-level copier N/A without enqueueing collection', async () => {
    const notApplicable = copierAggregate({
      copierCount: null,
      depth: 'none',
      receiptBound: false,
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    })
    mockGetCopierAggregate.mockResolvedValue(notApplicable)

    const response = await callRoute('copiers')
    const body = await response.json()

    expect(body.data).toEqual(notApplicable)
    expect(mockRequestTierC).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=300')
  })

  it('serves a committed aggregate found by the mandatory post-timeout re-read', async () => {
    const committedDuringPoll = copierAggregate({ copierCount: 9 })
    mockRequestTierC.mockResolvedValue(null)
    mockGetCopierAggregate.mockResolvedValueOnce(null).mockResolvedValueOnce(committedDuringPoll)

    const response = await callRoute('copiers')
    const body = await response.json()

    expect(body.data).toEqual(committedDuringPoll)
    expect(mockGetCopierAggregate).toHaveBeenCalledTimes(2)
    expect(response.headers.get('Cache-Control')).toContain('s-maxage=300')
  })
})
