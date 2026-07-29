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

function insertQuery() {
  const stored = {
    id: PORTFOLIO_ID,
    exchange: 'binance',
    label: 'Main',
    created_at: '2026-07-29T00:00:00.000Z',
  }
  const query: Record<string, jest.Mock> = {}
  query.insert = jest.fn(() => query)
  query.select = jest.fn(() => query)
  query.single = jest.fn().mockResolvedValue({ data: stored, error: null })
  return { query, stored }
}

describe('portfolio destructive ownership and identity ACKs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockRequireAuth.mockResolvedValue({ id: USER_ID })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockValidateReadOnlyAccess.mockResolvedValue({ isValid: true, permissions: ['read'] })
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

  it('returns the authenticated viewer in the add ACK', async () => {
    const { query, stored } = insertQuery()
    mockFrom.mockReturnValue(query)
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
    expect(query.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        api_key_encrypted: `${USER_ID}:key`,
        api_secret_encrypted: `${USER_ID}:secret`,
        exchange: 'binance',
        user_id: USER_ID,
      })
    )
    expect(await response.json()).toEqual({ data: { ...stored, viewer_id: USER_ID } })
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
