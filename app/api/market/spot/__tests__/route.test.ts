const mockJsonFn = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    _headers: Map<string, string>
    constructor(body?: unknown, init: any = {}) {
      this._body = body
      this.status = init.status || 200
      this._headers = new Map(Object.entries(init.headers || {}))
    }
    get headers() {
      return {
        get: (k: string) => this._headers.get(k) || null,
        set: (k: string, v: string) => this._headers.set(k, v),
      }
    }
    async json() {
      return this._body
    }
    static json(data: unknown, init?: any) {
      mockJsonFn(data, init)
      return new MockNextResponse(data, init)
    }
  }
  class MockNextRequest {
    url: string
    nextUrl: any
    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
    }
  }
  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: jest.fn(),
}))

import { GET } from '../route'
import { NextRequest } from 'next/server'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { createMarketSpotSnapshot } from '@/lib/market/market-spot-client-contract'

const mockedTiered = tieredGetOrSet as jest.MockedFunction<typeof tieredGetOrSet>

describe('GET /api/market/spot', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns cached market data as JSON', async () => {
    const mockData = [
      {
        id: 'bitcoin',
        symbol: 'BTC',
        name: 'Bitcoin',
        image: null,
        price: 50_000,
        change1h: null,
        change24h: 1,
        change7d: null,
        high24h: 51_000,
        low24h: 49_000,
        volume24h: 1_000_000,
        marketCap: 2_000_000,
        rank: 1,
      },
    ]
    mockedTiered.mockResolvedValue(
      createMarketSpotSnapshot({
        coins: mockData,
        source: 'coingecko',
        providerLimit: 100,
        collectedAt: '2026-08-03T12:00:00.000Z',
      })
    )

    const req = new NextRequest('http://localhost/api/market/spot')
    const res = await GET(req)
    const body = await res.json()

    expect(body).toEqual(mockData)
    expect(res.headers.get('X-Market-Source')).toBe('coingecko')
    expect(res.headers.get('X-Market-Requested-Count')).toBe('100')
    expect(res.headers.get('X-Market-Found-Count')).toBe('1')
    expect(res.headers.get('X-Market-Complete-Count')).toBe('1')
    expect(res.headers.get('X-Market-Partial')).toBe('true')
    expect(res.headers.get('X-Market-Collected-At')).toBe('2026-08-03T12:00:00.000Z')
  })

  it('returns an explicit unavailable response instead of a healthy empty array', async () => {
    mockedTiered.mockRejectedValue(new Error('CoinGecko down'))

    const req = new NextRequest('http://localhost/api/market/spot')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(503)
    expect(body).toEqual({ error: 'Market spot data unavailable' })
  })
})
