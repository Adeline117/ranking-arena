/**
 * /api/traders/[handle] route tests
 *
 * Tests the trader detail API: input validation, 404 handling,
 * cache behavior, and error handling.
 */

// --- Mocks (must be before imports) ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    _headers: Map<string, string>

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
      this._headers = new Map(Object.entries(init.headers || {}))
    }

    get headers() {
      return {
        get: (key: string) => this._headers.get(key) || null,
        set: (key: string, value: string) => this._headers.set(key, value),
      }
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

    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map()
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

// Recursive proxy mock that handles any Supabase query chain.
// `maybeSingle()` and direct awaits resolve to { data: null, error: null }.
let maybeSingleError: Error | null = null

function buildChainMock(): unknown {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      // Make the chain awaitable - resolves to { data: null, error: null, count: 0 }
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => {
          if (maybeSingleError) return Promise.reject(maybeSingleError).then(resolve)
          return resolve({ data: null, error: null, count: 0 })
        }
      }
      if (prop === 'catch' || prop === 'finally') return undefined
      if (prop === 'maybeSingle') {
        return jest.fn(() => {
          if (maybeSingleError) return Promise.reject(maybeSingleError)
          return Promise.resolve({ data: null, error: null })
        })
      }
      // All chainable methods return a new proxy
      return jest.fn(() => new Proxy({}, handler))
    },
  }
  return new Proxy({}, handler)
}

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => buildChainMock()),
  })),
}))

const mockGetServerCache = jest.fn().mockReturnValue(null)
const mockSetServerCache = jest.fn()

jest.mock('@/lib/utils/server-cache', () => ({
  getServerCache: (...args: unknown[]) => mockGetServerCache(...args),
  setServerCache: (...args: unknown[]) => mockSetServerCache(...args),
  CacheTTL: { SHORT: 60, MEDIUM: 300, LONG: 3600 },
}))

jest.mock('@/lib/utils/arena-score', () => ({
  calculateArenaScore: jest.fn().mockReturnValue(75),
  calculateOverallScore: jest.fn().mockReturnValue(80),
}))

jest.mock('@/lib/utils/logger', () => {
  const inst = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  }
  return {
    createLogger: jest.fn(() => inst),
    logger: inst,
    fireAndForget: jest.fn(),
    captureError: jest.fn(),
    captureMessage: jest.fn(),
  }
})

jest.mock('@/lib/constants/exchanges', () => ({
  ALL_SOURCES: ['binance_futures', 'bybit', 'okx_futures', 'hyperliquid'],
}))

import { GET } from '../route'

describe('GET /api/traders/[handle]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerCache.mockReturnValue(null)
    maybeSingleError = null
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  // --- Input Validation ---

  it('returns 400 for empty handle', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/') }
    const params = Promise.resolve({ handle: '' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Invalid handle parameter')
  })

  it('returns 400 for handle exceeding max length', async () => {
    const longHandle = 'a'.repeat(256)
    const request = { nextUrl: new URL(`http://localhost/api/traders/${longHandle}`) }
    const params = Promise.resolve({ handle: longHandle })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Invalid handle parameter')
  })

  it('accepts single character handle (valid)', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/x') }
    const params = Promise.resolve({ handle: 'x' })

    const res = await GET(request as any, { params })
    expect(res.status).not.toBe(400)
  })

  it('accepts 0x-prefixed address handle', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/0x1234abcd') }
    const params = Promise.resolve({ handle: '0x1234abcd' })

    const res = await GET(request as any, { params })
    expect(res.status).not.toBe(400)
  })

  // --- 404 Not Found ---

  it('returns 404 when trader is not found', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/nonexistent') }
    const params = Promise.resolve({ handle: 'nonexistent' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe('Trader not found')
    expect(body.handle).toBe('nonexistent')
  })

  it('sets Cache-Control header on 404 responses', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/ghost') }
    const params = Promise.resolve({ handle: 'ghost' })

    const res = await GET(request as any, { params })

    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300')
  })

  // --- Cache Hit ---

  it('returns cached data when available', async () => {
    const cachedData = {
      traderId: 'trader123',
      handle: 'CachedTrader',
      source: 'binance_futures',
      roi: 42.5,
    }
    mockGetServerCache.mockReturnValue(Promise.resolve(cachedData))

    const request = { nextUrl: new URL('http://localhost/api/traders/CachedTrader') }
    const params = Promise.resolve({ handle: 'CachedTrader' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.cached).toBe(true)
    expect(body.traderId).toBe('trader123')
  })

  // --- Error Handling ---

  it('returns 500 on unexpected database error', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/crasher') }
    const params = Promise.resolve({ handle: 'crasher' })

    maybeSingleError = new Error('DB connection lost')

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toBe('Internal server error')
  })

  it('returns 500 when params promise rejects', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/test') }
    const params = Promise.reject(new Error('params error'))

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toBe('Internal server error')
  })
})
