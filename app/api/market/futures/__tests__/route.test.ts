jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown; status: number
    constructor(body?: unknown, init: any = {}) {
      this._body = body; this.status = init.status || 200
    }
    async json() { return this._body }
    static json(data: unknown, init?: any) { return new MockNextResponse(data, init) }
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
