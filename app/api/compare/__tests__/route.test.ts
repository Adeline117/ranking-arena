/**
 * /api/compare route tests
 *
 * Tests authentication, premium access control, input validation,
 * and error handling for the trader comparison API.
 */

// --- Mocks ---

const mockCheckRateLimit = jest.fn().mockResolvedValue(null)
const mockRequireAuth = jest.fn()
const mockSupabaseFrom = jest.fn()

jest.mock('@/lib/api', () => {
  return {
    getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockSupabaseFrom(...args) })),
    requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
    success: jest.fn((data: unknown) => {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      return NextResponse.json({ success: true, data, meta: { timestamp: new Date().toISOString() } })
    }),
    error: jest.fn((message: string, status: number) => {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      return NextResponse.json({ success: false, error: { message } }, { status })
    }),
    handleError: jest.fn((err: unknown) => {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      const statusCode = (err as any)?.statusCode || 500
      const message = err instanceof Error ? err.message : 'Internal error'
      return NextResponse.json({ success: false, error: { message } }, { status: statusCode })
    }),
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    RateLimitPresets: { authenticated: { limit: 60, window: 60 } },
  }
})

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
    }
    async json() { return this._body }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers: Map<string, string>
    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map()
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/types/premium', () => ({
  hasFeatureAccess: jest.fn().mockReturnValue(true),
  getFeatureLimits: jest.fn().mockReturnValue({ comparisonReportsPerMonth: 100 }),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
import { hasFeatureAccess } from '@/lib/types/premium'

// Helper to build a chainable Supabase mock
function buildFromMock(overrides: Record<string, unknown> = {}) {
  const defaultResult = { data: [], error: null, count: 0 }
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(overrides.result ?? defaultResult)
      }
      if (prop === 'catch' || prop === 'finally') return undefined
      return jest.fn(() => new Proxy({}, handler))
    },
  }
  return new Proxy({}, handler)
}

describe('GET /api/compare', () => {
  const mockUser = { id: 'user-pro-1', email: 'pro@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockRequireAuth.mockResolvedValue(mockUser)
    ;(hasFeatureAccess as jest.Mock).mockReturnValue(true)

    // Default: subscription query returns pro tier
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return buildFromMock({ result: { data: { tier: 'pro' }, error: null } })
      }
      return buildFromMock()
    })
  })

  // --- Rate Limiting ---

  it('returns rate limit response when rate limited', async () => {
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    mockCheckRateLimit.mockResolvedValue(NextResponse.json({ error: 'Rate limited' }, { status: 429 }))

    const req = new NextRequest('http://localhost/api/compare?ids=t1,t2')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body.error).toBe('Rate limited')
  })

  // --- Authentication ---

  it('returns 401 when not authenticated', async () => {
    const authError = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    mockRequireAuth.mockRejectedValue(authError)

    const req = new NextRequest('http://localhost/api/compare?ids=t1,t2')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(401)
  })

  // --- Premium Access ---

  it('returns 403 when user lacks pro access', async () => {
    ;(hasFeatureAccess as jest.Mock).mockReturnValue(false)

    const req = new NextRequest('http://localhost/api/compare?ids=t1,t2')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error.message).toMatch(/Pro membership required/)
  })

  // --- Input Validation ---

  it('returns 400 when ids parameter is missing', async () => {
    const req = new NextRequest('http://localhost/api/compare')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.message).toMatch(/Missing ids/)
  })

  it('returns 400 when ids is empty after parsing', async () => {
    const req = new NextRequest('http://localhost/api/compare?ids=')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
  })

  it('returns 400 when more than 5 trader IDs provided', async () => {
    const ids = 't1,t2,t3,t4,t5,t6'
    const req = new NextRequest(`http://localhost/api/compare?ids=${ids}`)
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.message).toMatch(/Maximum 5/)
  })

  // --- Success Case ---

  it('returns comparison data for valid trader IDs', async () => {
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return buildFromMock({ result: { data: { tier: 'pro' }, error: null } })
      }
      if (table === 'trader_sources') {
        return buildFromMock({
          result: {
            data: [
              { source_trader_id: 't1', source: 'binance_futures', handle: 'Trader1', avatar_url: null },
              { source_trader_id: 't2', source: 'bybit', handle: 'Trader2', avatar_url: null },
            ],
            error: null,
          },
        })
      }
      if (table === 'trader_snapshots') {
        return buildFromMock({
          result: {
            data: [
              { source_trader_id: 't1', source: 'binance_futures', roi: 45.2, pnl: 10000, win_rate: 0.65, max_drawdown: -12, trades_count: 200, arena_score: 85, arena_score_v3: 88, profitability_score: 90, risk_control_score: 80, execution_score: 75 },
              { source_trader_id: 't2', source: 'bybit', roi: 32.1, pnl: 5000, win_rate: 0.72, max_drawdown: -8, trades_count: 150, arena_score: 78, arena_score_v3: null, profitability_score: 82, risk_control_score: 85, execution_score: 70 },
            ],
            error: null,
          },
        })
      }
      if (table === 'trader_follows') {
        return buildFromMock({ result: { count: 42, error: null } })
      }
      return buildFromMock()
    })

    const req = new NextRequest('http://localhost/api/compare?ids=t1,t2')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.traders).toHaveLength(2)
    expect(body.data.requestedIds).toEqual(['t1', 't2'])
    expect(body.data.foundCount).toBe(2)
  })

  // --- DB Error ---

  it('returns 500 when trader_sources query fails', async () => {
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return buildFromMock({ result: { data: { tier: 'pro' }, error: null } })
      }
      if (table === 'trader_sources') {
        return buildFromMock({
          result: { data: null, error: { message: 'DB error', code: '500' } },
        })
      }
      return buildFromMock()
    })

    const req = new NextRequest('http://localhost/api/compare?ids=t1')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error.message).toMatch(/Failed to fetch/)
  })
})
