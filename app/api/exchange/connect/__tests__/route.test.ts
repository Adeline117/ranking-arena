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
    async json() {
      return this._body
    }
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
    constructor(
      url: string,
      opts?: { headers?: Record<string, string>; method?: string; body?: unknown }
    ) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries({ 'user-agent': 'Jest Test Runner', ...opts?.headers }))
      this.method = opts?.method || 'POST'
      this._body = opts?.body
    }
    async json() {
      return this._body
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { read: {}, write: {}, public: {}, sensitive: {}, authenticated: {} },
}))

const mockRequireAuth = jest.fn()
const mockSupabaseRpc = jest.fn()

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
      return await handler({
        user,
        supabase: getSupabaseAdmin(),
        request: req,
        version: { current: 'v1' },
      })
    } catch {
      const { NextResponse: NR } = require('next/server')
      return NR.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
  },
  withPublic: (handler: Function) => handler,
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  })),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getAuthUser: jest.fn(),
  getUserHandle: jest.fn(),
  getUserProfile: jest.fn(),
}))

const mockValidateReadOnlyAccess = jest.fn()
jest.mock('@/lib/exchange/read-only-platforms', () => ({
  API_KEY_CONNECTION_PLATFORMS: ['binance', 'bybit', 'bitget'] as const,
}))

jest.mock('@/lib/validators/api-key-validator', () => ({
  validateExchangeReadOnlyAccess: (...args: unknown[]) => mockValidateReadOnlyAccess(...args),
}))

const mockEncrypt = jest.fn((val: string) => `encrypted_${val}`)
jest.mock('@/lib/exchange/encryption', () => ({
  encrypt: (val: string) => mockEncrypt(val),
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
  const mockUser = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'test@test.com',
  }
  const connectionId = '22222222-2222-4222-8222-222222222222'

  function atomicSaveResult(
    savedConnection: unknown = {
      status: 'saved',
      user_id: mockUser.id,
      exchange: 'binance',
      connection_id: connectionId,
      generation: 1,
      verified: false,
    },
    saveError: unknown = null
  ) {
    return { data: savedConnection, error: saveError }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue(mockUser)
    mockValidateReadOnlyAccess.mockResolvedValue({ isValid: true, permissions: ['read'] })
    mockSupabaseRpc.mockResolvedValue(atomicSaveResult())
  })

  // --- Authentication ---

  it('returns error when not authenticated', async () => {
    mockRequireAuth.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))

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
      body: {
        exchange: 'unknown_exchange',
        apiKey: 'test-key-12345',
        apiSecret: 'test-secret-12345',
      },
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

  it.each([
    null,
    {
      exchange: 'binance',
      apiKey: 'test-key-12345',
      apiSecret: 'test-secret-12345',
      extra: true,
    },
    {
      exchange: 'binance',
      apiKey: 'x'.repeat(513),
      apiSecret: 'test-secret-12345',
    },
    {
      exchange: 'bitget',
      apiKey: 'test-key-12345',
      apiSecret: 'test-secret-12345',
      passphrase: 'x'.repeat(513),
    },
  ])('rejects a malformed or oversized body before credential validation: %p', async (body) => {
    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body,
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(mockValidateReadOnlyAccess).not.toHaveBeenCalled()
    expect(mockEncrypt).not.toHaveBeenCalled()
    expect(mockSupabaseRpc).not.toHaveBeenCalled()
  })

  // --- Credential Validation ---

  it('returns 400 when credentials are invalid', async () => {
    mockValidateReadOnlyAccess.mockResolvedValue({
      isValid: false,
      error: 'API key must be read-only.',
    })

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'invalid-key-12345', apiSecret: 'invalid-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
    expect(mockEncrypt).not.toHaveBeenCalled()
    expect(mockSupabaseRpc).not.toHaveBeenCalled()
  })

  it('does not encrypt or persist a key when the exchange cannot prove read-only scope', async () => {
    mockValidateReadOnlyAccess.mockResolvedValue({
      isValid: false,
      error: 'Could not verify API key permissions',
    })

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: {
        exchange: 'binance',
        apiKey: 'unproven-key-12345',
        apiSecret: 'unproven-secret-12345',
      },
    })
    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(mockEncrypt).not.toHaveBeenCalled()
    expect(mockSupabaseRpc).not.toHaveBeenCalled()
  })

  // --- Success ---

  it('connects exchange successfully with valid credentials', async () => {
    mockValidateReadOnlyAccess.mockResolvedValue({ isValid: true, permissions: ['read'] })

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'valid-api-key-12345', apiSecret: 'valid-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: { viewerId: mockUser.id, exchange: 'binance' },
    })
    expect(mockSupabaseRpc).toHaveBeenCalledWith(
      'upsert_exchange_api_connection_for_active_profile_atomic',
      {
        p_user_id: mockUser.id,
        p_exchange: 'binance',
        p_api_key_encrypted: 'encrypted_valid-api-key-12345',
        p_api_secret_encrypted: 'encrypted_valid-secret-12345',
        p_passphrase_encrypted: null,
        p_verified_uid: null,
        p_scope_permissions: ['read'],
      }
    )
  })

  it('uses the same atomic authority for reconnecting an existing exchange', async () => {
    mockValidateReadOnlyAccess.mockResolvedValue({ isValid: true, permissions: ['read'] })

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'new-api-key-12345', apiSecret: 'new-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(mockSupabaseRpc).toHaveBeenCalledTimes(1)
  })

  it('fails instead of acknowledging a missing or mismatched persisted row', async () => {
    mockValidateReadOnlyAccess.mockResolvedValue({ isValid: true, permissions: ['read'] })
    mockSupabaseRpc.mockResolvedValue(
      atomicSaveResult({
        status: 'saved',
        user_id: '33333333-3333-4333-8333-333333333333',
        exchange: 'binance',
        connection_id: connectionId,
        generation: 1,
        verified: false,
      })
    )

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'valid-api-key-12345', apiSecret: 'valid-secret-12345' },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).not.toBe(true)
  })

  it('fails closed when the account becomes unavailable after exchange validation', async () => {
    mockSupabaseRpc.mockResolvedValue(atomicSaveResult({ status: 'suspended' }))

    const req = new NextRequest('http://localhost/api/exchange/connect', {
      method: 'POST',
      body: { exchange: 'binance', apiKey: 'valid-api-key-12345', apiSecret: 'valid-secret-12345' },
    })
    const res = await POST(req)

    expect(res.status).toBe(403)
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
