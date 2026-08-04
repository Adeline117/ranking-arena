jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers: Headers

    constructor(body: unknown, init: ResponseInit = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    constructor(readonly url: string) {}
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

jest.mock('@/lib/api', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { public: {} },
}))

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { getOrSetWithLock } from '@/lib/cache'
import { MARKET_DEFAULT_PAIR_SYMBOLS } from '@/lib/market/market-core-client-contract'
import { GET } from '../route'

const mockedCache = jest.mocked(getOrSetWithLock)

describe('GET /api/market provider coverage receipt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps the default 25-pair request receipt aligned with the client contract', async () => {
    mockedCache.mockResolvedValue({
      rows: [{ symbol: 'BTC-USD', price: '100,000', changePct: '+1.00%', direction: 'up' }],
      source: 'coingecko',
      collectedAt: '2026-08-03T12:00:00.000Z',
      stale: false,
    })

    const response = await GET(new NextRequest('http://localhost/api/market'))
    const body = await response.json()

    expect(body.requestedPairs).toEqual(MARKET_DEFAULT_PAIR_SYMBOLS)
    expect(body.expectedCount).toBe(25)
    expect(body.foundCount).toBe(1)
    expect(body.missingPairs).toEqual(MARKET_DEFAULT_PAIR_SYMBOLS.slice(1))
    expect(body.partial).toBe(true)
    expect(body.cached).toBe(true)
    expect(body.stale).toBe(false)
  })

  it('reports requested, found, and missing pairs without filling provider gaps', async () => {
    mockedCache.mockResolvedValue({
      rows: [{ symbol: 'BTC-USD', price: '100,000', changePct: '+1.00%', direction: 'up' }],
      source: 'coingecko',
      collectedAt: '2026-08-03T12:00:00.000Z',
      stale: false,
    })

    const response = await GET(new NextRequest('http://localhost/api/market?pairs=BTC-USD,ETH-USD'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      rows: [{ symbol: 'BTC-USD' }],
      requestedPairs: ['BTC-USD', 'ETH-USD'],
      expectedCount: 2,
      foundCount: 1,
      missingPairs: ['ETH-USD'],
      partial: true,
      source: 'coingecko',
      collectedAt: '2026-08-03T12:00:00.000Z',
    })
  })

  it('returns a real failure instead of a healthy empty receipt when every provider fails', async () => {
    mockedCache.mockRejectedValue(new Error('all providers unavailable'))

    const response = await GET(new NextRequest('http://localhost/api/market?pairs=SOL-USD'))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ rows: [], error: 'all providers unavailable' })
  })
})
