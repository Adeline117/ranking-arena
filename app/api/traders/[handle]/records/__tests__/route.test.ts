/** @jest-environment node */

import type { NextRequest } from 'next/server'
import {
  RECORDS_CURSOR_INVALIDATED_CODE,
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
    withCache: (response: InstanceType<typeof RouteResponse>) => response,
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

function request(kind: Exclude<RecordKind, 'copiers'>, cursor?: string): NextRequest {
  const url = new URL(
    `https://arena.example/api/traders/trader-1/records?kind=${kind}&source=bitget_futures&tf=30`
  )
  if (cursor !== undefined) url.searchParams.set('cursor', cursor)
  return { nextUrl: url } as NextRequest
}

async function callRoute(kind: Exclude<RecordKind, 'copiers'>, cursor?: string) {
  return GET(request(kind, cursor), { params: Promise.resolve({ handle: 'trader-1' }) })
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

  it.each(['position_history'] as const)(
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
    }
  )

  it.each(['orders', 'transfers'] as const)(
    'does not attach a position-history verdict to pending %s',
    async (kind) => {
      const response = await callRoute(kind)
      const body = await response.json()
      expect(body.data.cacheState).toBe('pending')
      expect(body.data.completeness).toBeUndefined()
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
})
