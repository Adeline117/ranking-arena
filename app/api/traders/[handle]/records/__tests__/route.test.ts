/** @jest-environment node */

import type { NextRequest } from 'next/server'
import type { RecordsPage } from '@/lib/data/serving/types'

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

function request(cursor?: string): NextRequest {
  const url = new URL(
    'https://arena.example/api/traders/Trader%20One/records?kind=position_history&source=bitget_futures&tf=30'
  )
  if (cursor) url.searchParams.set('cursor', cursor)
  return { nextUrl: url } as NextRequest
}

async function callRoute(cursor?: string) {
  return GET(request(cursor), { params: Promise.resolve({ handle: 'Trader%20One' }) })
}

describe('records route provenance and completeness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveServingTrader.mockResolvedValue(resolvedTrader)
    mockGetRecordsPage.mockResolvedValue(null)
    mockRequestTierC.mockResolvedValue(null)
    mockRecordsPageFromTierC.mockReturnValue(null)
  })

  it('returns warm history without invoking Tier-C or changing trust metadata', async () => {
    const page: RecordsPage = {
      rows: [{ symbol: 'BTCUSDT' }],
      nextCursor: null,
      provenance: provenance(),
      cacheState: 'warm',
      completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
    }
    mockGetRecordsPage.mockResolvedValue(page)

    const response = await callRoute()
    const body = await response.json()

    expect(body.data).toEqual(page)
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=30, s-maxage=30, stale-while-revalidate=120'
    )
    expect(mockRequestTierC).not.toHaveBeenCalled()
  })

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
})
