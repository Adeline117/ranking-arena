jest.mock('next/server', () => {
  class MockHeaders {
    private _headers: Record<string, string> = {}
    set(key: string, value: string) { this._headers[key] = value }
    get(key: string) { return this._headers[key] }
  }
  class MockNextResponse {
    _body: unknown; status: number; headers: MockHeaders
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body; this.status = init.status || 200; this.headers = new MockHeaders()
    }
    async json() { return this._body }
    static json(data: unknown, init?: { status?: number }) { return new MockNextResponse(data, init) }
  }
  return { NextResponse: MockNextResponse }
})

const mockLimit = jest.fn()
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: mockLimit,
    })),
  }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: mockLimit,
    })),
  })),
}))

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: jest.fn(async (_key: string, fetcher: () => unknown) => fetcher()),
}))

const originalFetch = global.fetch

import { GET } from '../route'

describe('GET /api/market/futures', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLimit.mockResolvedValue({
      data: [
        { symbol: 'BTCUSDT', platform: 'binance', funding_rate: 0.0001, funding_time: '2024-01-01' },
      ],
    })
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { symbol: 'btc', current_price: 50000, price_change_percentage_24h: 2.5, total_volume: 1e9 },
      ],
    }) as unknown as typeof fetch
  })

  afterEach(() => { global.fetch = originalFetch })

  it('returns 200 with aggregated futures data', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})
