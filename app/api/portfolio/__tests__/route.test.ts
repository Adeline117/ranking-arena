jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number

    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    private readonly body: unknown

    constructor(url: string, init: { body?: unknown } = {}) {
      this.url = url
      this.nextUrl = new URL(url)
      this.body = init.body
    }

    async json() {
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRequireAuth = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockEncryptApiKey = jest.fn((value: string, userId: string) => `${userId}:${value}`)
const mockValidateReadOnlyAccess = jest.fn()

jest.mock('@/lib/api', () => {
  const { NextResponse } = require('next/server')
  return {
    getSupabaseAdmin: () => mockGetSupabaseAdmin(),
    requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    RateLimitPresets: { read: {}, write: {} },
    success: (data: unknown, status = 200) => NextResponse.json({ data }, { status }),
    handleError: () => NextResponse.json({ error: 'Internal error' }, { status: 500 }),
  }
})

jest.mock('@/lib/exchange/secure-encryption', () => ({
  encryptApiKey: (...args: [string, string]) => mockEncryptApiKey(...args),
}))

jest.mock('@/lib/validators/api-key-validator', () => ({
  READ_ONLY_ACCESS_PLATFORMS: ['binance', 'bybit', 'okx', 'bitget'],
  validateExchangeReadOnlyAccess: (...args: unknown[]) => mockValidateReadOnlyAccess(...args),
}))

import { NextRequest } from 'next/server'
import { DELETE, POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PORTFOLIO_ID = '22222222-2222-4222-8222-222222222222'

function deleteRequest() {
  return new NextRequest(`http://localhost/api/portfolio?id=${PORTFOLIO_ID}`)
}

function deleteQuery(result: { data: unknown; error: unknown }) {
  const query: Record<string, jest.Mock> = {}
  query.delete = jest.fn(() => query)
  query.eq = jest.fn(() => query)
  query.select = jest.fn(() => query)
  query.maybeSingle = jest.fn().mockResolvedValue(result)
  return query
}

const stored = {
  id: PORTFOLIO_ID,
  exchange: 'binance',
  label: 'Main',
  created_at: '2026-07-29T00:00:00.000Z',
}

function saved(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      status: 'saved',
      user_id: USER_ID,
      portfolio_id: PORTFOLIO_ID,
      exchange: 'binance',
      label: 'Main',
      credential_generation: 1,
      created_at: stored.created_at,
      ...overrides,
    },
    error: null,
  }
}

describe('portfolio destructive ownership and identity ACKs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockRequireAuth.mockResolvedValue({ id: USER_ID })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom, rpc: mockRpc })
    mockValidateReadOnlyAccess.mockResolvedValue({ isValid: true, permissions: ['read'] })
    mockRpc.mockResolvedValue(saved())
  })

  it('deletes through one statement constrained by both id and authenticated owner', async () => {
    const query = deleteQuery({ data: { id: PORTFOLIO_ID }, error: null })
    mockFrom.mockReturnValue(query)

    const response = await DELETE(deleteRequest())

    expect(response.status).toBe(200)
    expect(query.delete).toHaveBeenCalledTimes(1)
    expect(query.eq).toHaveBeenNthCalledWith(1, 'id', PORTFOLIO_ID)
    expect(query.eq).toHaveBeenNthCalledWith(2, 'user_id', USER_ID)
    expect(query.select).toHaveBeenCalledWith('id')
    expect(await response.json()).toEqual({
      data: { deleted: true, portfolio_id: PORTFOLIO_ID, viewer_id: USER_ID },
    })
  })

  it('returns not found when the owner-constrained delete affects no row', async () => {
    mockFrom.mockReturnValue(deleteQuery({ data: null, error: null }))

    const response = await DELETE(deleteRequest())

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Portfolio not found' })
  })

  it('stores the proof and ciphertext through the active-account authority', async () => {
    const request = new NextRequest('http://localhost/api/portfolio', {
      body: {
        exchange: 'BINANCE',
        api_key: 'key',
        api_secret: 'secret',
        label: 'Main',
      },
    })

    const response = await POST(request)

    expect(response.status).toBe(201)
    expect(mockValidateReadOnlyAccess).toHaveBeenCalledWith('binance', {
      apiKey: 'key',
      apiSecret: 'secret',
      passphrase: undefined,
    })
    expect(mockRpc).toHaveBeenCalledWith('save_user_portfolio_for_active_profile_atomic', {
      p_api_key_encrypted: `${USER_ID}:key`,
      p_api_passphrase_encrypted: null,
      p_api_secret_encrypted: `${USER_ID}:secret`,
      p_exchange: 'binance',
      p_label: 'Main',
      p_read_only_permissions: ['read'],
      p_user_id: USER_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({ data: { ...stored, viewer_id: USER_ID } })
  })

  it('fails closed when the account becomes suspended during remote validation', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'suspended' }, error: null })
    const request = new NextRequest('http://localhost/api/portfolio', {
      body: { exchange: 'binance', api_key: 'key', api_secret: 'secret' },
    })

    const response = await POST(request)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Account is inactive' })
  })

  it('never silently replaces an existing portfolio or its financial history', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'already_exists' }, error: null })
    const request = new NextRequest('http://localhost/api/portfolio', {
      body: { exchange: 'binance', api_key: 'key', api_secret: 'secret', label: 'Main' },
    })

    const response = await POST(request)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'A portfolio with this exchange and label already exists',
    })
  })

  it('does not acknowledge a contradictory portfolio identity', async () => {
    mockRpc.mockResolvedValue(saved({ user_id: '33333333-3333-4333-8333-333333333333' }))
    const request = new NextRequest('http://localhost/api/portfolio', {
      body: { exchange: 'binance', api_key: 'key', api_secret: 'secret', label: 'Main' },
    })

    const response = await POST(request)

    expect(response.status).toBe(500)
  })

  it('does not encrypt or persist a credential without an exchange read-only proof', async () => {
    mockValidateReadOnlyAccess.mockResolvedValue({
      isValid: false,
      error: 'API key must be read-only.',
    })
    const request = new NextRequest('http://localhost/api/portfolio', {
      body: {
        exchange: 'bybit',
        api_key: 'write-capable-key',
        api_secret: 'write-capable-secret',
      },
    })

    const response = await POST(request)

    expect(response.status).toBe(400)
    expect(mockEncryptApiKey).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects exchanges whose permission scope cannot be proven before validation', async () => {
    const request = new NextRequest('http://localhost/api/portfolio', {
      body: {
        exchange: 'mexc',
        api_key: 'unverifiable-key',
        api_secret: 'unverifiable-secret',
      },
    })

    const response = await POST(request)

    expect(response.status).toBe(400)
    expect(mockValidateReadOnlyAccess).not.toHaveBeenCalled()
    expect(mockEncryptApiKey).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })
})
