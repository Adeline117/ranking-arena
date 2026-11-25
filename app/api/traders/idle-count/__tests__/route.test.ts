/**
 * GET /api/traders/idle-count — how many idle-window rows a board is hiding.
 * An exact count from the public view with the board's own scope; unknown is
 * null, never zero.
 */

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map(Object.entries(init.headers || {}))
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers: Map<string, string>
    method: string

    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(
        Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(opts?.headers || {}) })
      )
      this.method = opts?.method || 'GET'
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { read: {}, write: {}, public: {} },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}))

const mockSupabaseQuery = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: (...args: unknown[]) => mockSupabaseQuery(...args),
  })),
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  generateCsrfToken: jest.fn().mockReturnValue('test-csrf'),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('test-cid'),
  runWithCorrelationId: jest.fn((_id: string, fn: () => unknown) => fn()),
  getCorrelationId: jest.fn().mockReturnValue('test-cid'),
}))

jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', deprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

type CountResult = { count: number | null; error: { message: string } | null }

function countQuery(result: CountResult) {
  const storage: Record<string, jest.Mock> = {}
  const chain: Record<string, unknown> = new Proxy(storage, {
    get(target, prop) {
      const key = prop as string
      if (key === 'then') {
        return (resolve: (value: CountResult) => void) => Promise.resolve(result).then(resolve)
      }
      if (key === 'catch' || key === 'finally') return undefined
      if (!target[key]) target[key] = jest.fn(() => chain)
      return target[key]
    },
  })
  return chain as Record<string, jest.Mock>
}

async function call(query: string, result: CountResult = { count: 5016, error: null }) {
  const q = countQuery(result)
  mockSupabaseQuery.mockReturnValue(q)
  const response = await GET(new NextRequest(`http://localhost/api/traders/idle-count${query}`))
  const body = (await response.json()) as { data?: { count: number | null } }
  return { response, body, q }
}

describe('GET /api/traders/idle-count', () => {
  beforeEach(() => jest.clearAllMocks())

  it('counts idle rows of the default 90D board from the public view', async () => {
    const { response, body, q } = await call('')
    expect(response.status).toBe(200)
    expect(body.data).toEqual({ count: 5016 })
    expect(mockSupabaseQuery).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(q.select).toHaveBeenCalledWith('source_trader_id', { count: 'exact', head: true })
    expect(q.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(q.eq).toHaveBeenCalledWith('idle_window', true)
    // The same cohort predicate as the list (score floor, ROI bound, freshness).
    expect(q.gt).toHaveBeenCalledWith('arena_score', 0)
  })

  it('scopes to the exchange, or else to the category (onchain is stored as web3)', async () => {
    const exchange = await call('?timeRange=7D&exchange=bybit&category=spot')
    expect(exchange.q.eq).toHaveBeenCalledWith('season_id', '7D')
    expect(exchange.q.eq).toHaveBeenCalledWith('source', 'bybit')
    expect(exchange.q.eq).not.toHaveBeenCalledWith('source_type', expect.anything())

    const category = await call('?category=onchain')
    expect(category.q.eq).toHaveBeenCalledWith('source_type', 'web3')
  })

  it('reports an unreadable count as unknown, not as zero', async () => {
    const failed = await call('', { count: null, error: { message: 'boom' } })
    expect(failed.response.status).toBe(200)
    expect(failed.body.data).toEqual({ count: null })
    const odd = await call('', { count: -1, error: null })
    expect(odd.body.data).toEqual({ count: null })
  })

  it('answers zero for a quarantined source without reading the database', async () => {
    const { body } = await call('?exchange=bingx')
    expect(body.data).toEqual({ count: 0 })
    expect(mockSupabaseQuery).not.toHaveBeenCalled()
  })

  it.each(['?timeRange=1D', '?category=options', '?exchange=not_a_source'])(
    'rejects %s before database access',
    async (query) => {
      const { response } = await call(query)
      expect(response.status).toBe(400)
      expect(mockSupabaseQuery).not.toHaveBeenCalled()
    }
  )
})
