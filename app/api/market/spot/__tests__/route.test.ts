const mockJsonFn = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown; status: number; _headers: Map<string, string>
    constructor(body?: unknown, init: any = {}) {
      this._body = body; this.status = init.status || 200
      this._headers = new Map(Object.entries(init.headers || {}))
    }
    get headers() {
      return { get: (k: string) => this._headers.get(k) || null, set: (k: string, v: string) => this._headers.set(k, v) }
    }
    async json() { return this._body }
    static json(data: unknown, init?: any) {
      mockJsonFn(data, init)
      return new MockNextResponse(data, init)
    }
  }
  class MockNextRequest {
    url: string; nextUrl: any
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

const mockedTiered = tieredGetOrSet as jest.MockedFunction<typeof tieredGetOrSet>

describe('GET /api/market/spot', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns cached market data as JSON', async () => {
    const mockData = [{ id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', price: 50000, rank: 1 }]
    mockedTiered.mockResolvedValue(mockData)

    const req = new NextRequest('http://localhost/api/market/spot')
    const res = await GET(req)
    const body = await res.json()

    expect(body).toEqual(mockData)
  })

  it('returns 200 with empty array on error (graceful degradation)', async () => {
    mockedTiered.mockRejectedValue(new Error('CoinGecko down'))

    const req = new NextRequest('http://localhost/api/market/spot')
    const res = await GET(req)
    const body = await res.json()

    // Route returns 200 with empty array so the ticker shows "–" instead of crashing
    expect(res.status).toBe(200)
    expect(body).toEqual([])
  })
})
