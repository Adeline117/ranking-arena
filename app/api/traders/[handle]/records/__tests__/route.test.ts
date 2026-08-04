/** @jest-environment node */

import type { NextRequest } from 'next/server'
import type { CopierAggregate, RecordsPage } from '@/lib/data/serving/types'

const mockSupabase = { marker: 'records-route' }
const mockResolveServingTrader = jest.fn()
const mockGetRecordsPage = jest.fn()
const mockGetCopierAggregate = jest.fn()
const mockRecordsPageFromTierC = jest.fn()
const mockRequestTierC = jest.fn()
const mockAfter = jest.fn((callback: () => unknown) => callback())

jest.mock('next/server', () => ({
  after: (callback: () => unknown) => mockAfter(callback),
}))

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
  kind: 'positions' | 'position_history' | 'orders' | 'transfers' | 'copiers' = 'position_history',
  cursor?: string,
  tf: '7' | '30' | '90' | 'inception' = '30'
): NextRequest {
  const url = new URL(
    `https://arena.example/api/traders/Trader%20One/records?kind=${kind}&source=bitget_futures&tf=${tf}`
  )
  if (cursor) url.searchParams.set('cursor', cursor)
  return { nextUrl: url } as NextRequest
}

async function callRoute(
  kind: 'positions' | 'position_history' | 'orders' | 'transfers' | 'copiers' = 'position_history',
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
    provenance: provenance(new Date().toISOString()),
    completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    ...overrides,
  }
}

describe('records route provenance and completeness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveServingTrader.mockResolvedValue(resolvedTrader)
    mockGetRecordsPage.mockResolvedValue(null)
    mockGetCopierAggregate.mockResolvedValue(null)
    mockRequestTierC.mockResolvedValue(null)
    mockRecordsPageFromTierC.mockReturnValue(null)
    mockAfter.mockImplementation((callback: () => unknown) => callback())
  })

  it('never serves unknown warm history and falls back to the bounded Tier-C preview', async () => {
    const page: RecordsPage = {
      rows: [{ symbol: 'BTCUSDT' }],
      nextCursor: null,
      provenance: provenance(),
      cacheState: 'warm',
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    }
    mockGetRecordsPage.mockResolvedValue(page)
    const workerPayload = { rows: [{ symbol: 'ETHUSDT' }] }
    const fetched: RecordsPage = {
      rows: [{ symbol: 'ETHUSDT' }],
      nextCursor: null,
      provenance: provenance('2026-08-03T12:00:00.000Z'),
      cacheState: 'cold-fetched',
      completeness: { state: 'partial', reason: 'interactive_preview' },
    }
    mockRequestTierC.mockResolvedValue(workerPayload)
    mockRecordsPageFromTierC.mockReturnValue(fetched)

    const response = await callRoute()
    const body = await response.json()

    expect(body.data).toEqual(fetched)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(mockRequestTierC).toHaveBeenCalled()
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

  it('returns the Tier-C preview with no-store and exact routing coordinates', async () => {
    const workerPayload = { rows: [{ symbol: 'ETHUSDT' }] }
    const fetched: RecordsPage = {
      rows: [{ symbol: 'ETHUSDT' }],
      nextCursor: null,
      provenance: provenance('2026-08-03T12:00:00.000Z'),
      cacheState: 'cold-fetched',
      completeness: { state: 'partial', reason: 'interactive_preview' },
    }
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

  it('does not echo legacy warm history when the Tier-C preview is unavailable', async () => {
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

  it('never fills a fully cold pending page with the request time', async () => {
    const response = await callRoute()
    const body = await response.json()

    expect(body.data).toMatchObject({
      cacheState: 'pending',
      provenance: provenance(),
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    })
    expect(body.data.provenance).not.toHaveProperty('asOf')
  })

  it.each(['position_history', 'orders', 'transfers'] as const)(
    'does not replay the first Tier-C %s preview for a stale cursor',
    async (kind) => {
      const page: RecordsPage = {
        rows: [],
        nextCursor: null,
        provenance: provenance(),
        cacheState: 'warm',
        completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
      }
      mockGetRecordsPage.mockResolvedValue(kind === 'position_history' ? page : null)

      const response = await callRoute(kind, 'legacy-history-cursor')
      const body = await response.json()

      expect(body.data).toEqual({ ...page, cacheState: 'pending' })
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(mockRequestTierC).not.toHaveBeenCalled()
    }
  )
})

describe('records route copier cold start', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveServingTrader.mockResolvedValue(resolvedTrader)
    mockGetRecordsPage.mockResolvedValue(null)
    mockGetCopierAggregate.mockResolvedValue(null)
    mockRequestTierC.mockResolvedValue(null)
    mockRecordsPageFromTierC.mockReturnValue(null)
    mockAfter.mockImplementation((callback: () => unknown) => callback())
  })

  it.each(['7', '30', '90', 'inception'] as const)(
    'serves fresh aggregate evidence without a Tier-C request or shared cache for tf=%s',
    async (tf) => {
      const aggregate = copierAggregate()
      mockGetCopierAggregate.mockResolvedValue(aggregate)

      const response = await callRoute('copiers', undefined, tf)
      const body = await response.json()

      expect(body.data).toEqual(aggregate)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
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
      expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
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

  it('serves a committed aggregate found by the mandatory post-timeout re-read', async () => {
    const committedDuringPoll = copierAggregate({ copierCount: 9 })
    mockRequestTierC.mockResolvedValue(null)
    mockGetCopierAggregate.mockResolvedValueOnce(null).mockResolvedValueOnce(committedDuringPoll)

    const response = await callRoute('copiers')
    const body = await response.json()

    expect(body.data).toEqual(committedDuringPoll)
    expect(mockGetCopierAggregate).toHaveBeenCalledTimes(2)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it.each([
    ['stale', provenance('2000-01-01T00:00:00.000Z')],
    ['missing-provenance', provenance(null)],
  ])(
    'returns a %s aggregate immediately and schedules one authority refresh',
    async (_state, p) => {
      const aggregate = copierAggregate({ provenance: p })
      mockGetCopierAggregate.mockResolvedValue(aggregate)

      const response = await callRoute('copiers')
      const body = await response.json()

      expect(body.data).toEqual(aggregate)
      expect(mockAfter).toHaveBeenCalledTimes(1)
      expect(mockRequestTierC).toHaveBeenCalledWith(
        {
          sourceSlug: 'bitget_futures',
          fetchRegion: 'vps_sg',
          exchangeTraderId: 'trader-1',
          timeframe: 0,
          surface: 'copiers',
        },
        { fireAndForget: true }
      )
      expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    }
  )

  it('never queues a source-level not-applicable copier surface', async () => {
    const aggregate = copierAggregate({
      copierCount: null,
      depth: 'none',
      provenance: provenance(null),
    })
    mockGetCopierAggregate.mockResolvedValue(aggregate)

    const response = await callRoute('copiers')
    const body = await response.json()

    expect(body.data).toEqual(aggregate)
    expect(mockAfter).not.toHaveBeenCalled()
    expect(mockRequestTierC).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })
})
