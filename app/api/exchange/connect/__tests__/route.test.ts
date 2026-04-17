/**
 * /api/exchange/connect route tests
 *
 * Tests exchange connection endpoint: auth, input validation,
 * credential verification, and error handling.
 */

// --- Mocks ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map()
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
    method: string
    _body: unknown
    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string; body?: unknown }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries({ 'user-agent': 'Jest Test Runner', ...opts?.headers }))
      this.method = opts?.method || 'POST'
      this._body = opts?.body
    }
    async json() { return this._body }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { read: {}, write: {}, public: {}, sensitive: {}, authenticated: {} },
}))

const mockRequireAuth = jest.fn()
const mockSupabaseFrom = jest.fn()

// Mock middleware to pass through to existing mockRequireAuth
jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function, _opts?: unknown) => async (req: unknown) => {
    try {
      const user = await mockRequireAuth(req)
      if (!user) {
        const { NextResponse: NR } = require('next/server')
        return NR.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }
      const { getSupabaseAdmin } = require('@/lib/supabase/server')
      return handler({ user, supabase: getSupabaseAdmin(), request: req, version: { current: 'v1' } })
    } catch {
      const { NextResponse: NR } = require('next/server')
      return NR.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
  },
  withPublic: (handler: Function) => handler,
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  })),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getAuthUser: jest.fn(),
  getUserHandle: jest.fn(),
  getUserProfile: jest.fn(),
}))

const mockValidateCredentials = jest.fn()
jest.mock('@/lib/exchange', () => ({
  validateExchangeCredentials: (...args: unknown[]) => mockValidateCredentials(...args),
  SUPPORTED_EXCHANGES: ['binance', 'bybit', 'okx', 'bitget'] as const,
}))

jest.mock('@/lib/exchange/encryption', () => ({
  encrypt: jest.fn((val: string) => `encrypted_${val}`),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  fireAndForget: jest.fn(),
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

describe('POST /api/exchange/connect', () => {
  const mockUser = { id: 'user-1', email: 'test@test.com' }

  function createMockSupabase(existingConnection: unknown = null) {
    const chain: Record<string, jest.Mock> = {}
    chain.select = jest.fn(() => chain)
    chain.eq = jest.fn(() => chain)
    chain.maybeSingle = jest.fn().mockResolvedValue({ data: existingConnection, error: null })
    chain.insert = jest.fn(() => Promise.resolve({ data: null, error: null }))
    chain.update = jest.fn(() => chain)
    return chain
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue(mockUser)
    mockValidateCredentials.mockResolvedValue(true)
    mockSupabaseFrom.mockReturnValue(createMockSupabase())
  })

  // --- Authentication ---

  it('returns error when not authenticated', async () => {
    mockRequireAuth.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    )

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'test-key-12345', apiSecret: 'test-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
  })

  // --- Input Validation ---

  it('returns 400 when exchange is missing', async () => {
    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { apiKey: 'test-key-12345', apiSecret: 'test-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
  })

  it('returns 400 for unsupported exchange', async () => {
    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'unknown_exchange', apiKey: 'test-key-12345', apiSecret: 'test-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
  })

  it('returns 400 when API key is missing', async () => {
    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiSecret: 'test-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
  })

  it('returns 400 when API secret is missing', async () => {
    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'test-key-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
  })

  it('returns 400 when API key is too short', async () => {
    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'short', apiSecret: 'test-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
  })

  // --- Credential Validation ---

  it('returns 400 when credentials are invalid', async () => {
    mockValidateCredentials.mockResolvedValue(false)

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'invalid-key-12345', apiSecret: 'invalid-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
  })

  // --- Success ---

  it('connects exchange successfully with valid credentials', async () => {
    mockValidateCredentials.mockResolvedValue(true)
    mockSupabaseFrom.mockReturnValue(createMockSupabase(null))

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'valid-api-key-12345', apiSecret: 'valid-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('updates existing connection', async () => {
    mockValidateCredentials.mockResolvedValue(true)
    const existingChain = createMockSupabase({ id: 'conn-1' })
    mockSupabaseFrom.mockReturnValue(existingChain)

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'new-api-key-12345', apiSecret: 'new-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
  })

  // --- Bitget Passphrase ---

  it('returns 400 for bitget without passphrase', async () => {
    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'bitget', apiKey: 'bitget-key-12345', apiSecret: 'bitget-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
  })
})
