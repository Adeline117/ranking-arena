jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
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
    method: string
    _body: unknown
    body: ReadableStream<Uint8Array> | null
    headers: Headers

    constructor(
      url: string,
      init?: { method?: string; body?: unknown; headers?: Record<string, string> }
    ) {
      this.url = url
      this.method = init?.method ?? 'POST'
      this._body = init?.body
      this.headers = new Headers(init?.headers)
      const rawBody =
        typeof init?.body === 'string' ? init.body : (JSON.stringify(init?.body) ?? '')
      const bytes = new TextEncoder().encode(rawBody)
      let consumed = false
      this.body = {
        getReader: () => ({
          cancel: async () => undefined,
          read: async () => {
            if (consumed) return { done: true as const, value: undefined }
            consumed = true
            return { done: false as const, value: bytes }
          },
        }),
      } as ReadableStream<Uint8Array>
    }

    async json() {
      return this._body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'viewer-a@example.com',
}
const mockSupabaseRpc = jest.fn()
const mockResolveTrader = jest.fn()
const mockResolveExchangeUid = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => async (request: unknown) =>
      handler({ request, user: mockUser }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  }),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

jest.mock('@/lib/validators/exchange-uid-resolver', () => ({
  resolveExchangeUid: (...args: unknown[]) => mockResolveExchangeUid(...args),
}))

jest.mock('@/lib/exchange/encryption', () => ({
  encrypt: (value: string) => `encrypted:${value}`,
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

type PersistedConnection = {
  status: 'saved'
  exchange: string
  user_id: string
  connection_id: string
  generation: number
  verified: boolean
}

function atomicSaveResult(
  savedConnection: PersistedConnection | null = {
    status: 'saved',
    exchange: 'binance',
    user_id: mockUser.id,
    connection_id: '22222222-2222-4222-8222-222222222222',
    generation: 1,
    verified: true,
  },
  error: unknown = null
) {
  return { data: savedConnection, error }
}

function request(overrides: Record<string, unknown> = {}) {
  return rawRequest({
    exchange: 'binance_futures',
    traderId: 'account-42',
    source: 'binance_futures',
    apiKey: 'read-only-key',
    apiSecret: 'read-only-secret',
    ...overrides,
  })
}

function rawRequest(body: unknown, headers?: Record<string, string>) {
  return new NextRequest('http://localhost/api/exchange/verify-ownership', {
    method: 'POST',
    body,
    headers,
  })
}

describe('POST /api/exchange/verify-ownership identity contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveTrader.mockResolvedValue({ platform: 'binance_futures', traderKey: 'account-42' })
    mockResolveExchangeUid.mockResolvedValue({
      success: true,
      uid: 'account-42',
      isReadOnly: true,
      permissions: ['read'],
    })
    mockSupabaseRpc.mockResolvedValue(atomicSaveResult())
  })

  it('accepts a supported suffixed leaderboard source and persists its base connection', async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockResolveTrader).toHaveBeenCalledWith(expect.anything(), {
      handle: 'account-42',
      platform: 'binance_futures',
    })
    expect(mockResolveExchangeUid).toHaveBeenCalledWith(
      'binance_futures',
      expect.objectContaining({ apiKey: 'read-only-key', apiSecret: 'read-only-secret' })
    )
    expect(mockSupabaseRpc).toHaveBeenCalledWith(
      'upsert_exchange_api_connection_for_active_profile_atomic',
      {
        p_user_id: mockUser.id,
        p_exchange: 'binance',
        p_api_key_encrypted: 'encrypted:read-only-key',
        p_api_secret_encrypted: 'encrypted:read-only-secret',
        p_passphrase_encrypted: null,
        p_verified_uid: 'account-42',
        p_scope_permissions: ['read'],
      }
    )
    expect(body).toMatchObject({
      success: true,
      verified: true,
      uid: 'account-42',
      data: {
        viewerId: mockUser.id,
        exchange: 'binance',
        source: 'binance_futures',
        traderId: 'account-42',
        verifiedUid: 'account-42',
      },
    })
  })

  it('returns the canonical resolved trader identity instead of echoing a requested handle', async () => {
    mockResolveTrader.mockResolvedValue({
      platform: 'binance_futures',
      traderKey: 'account-42',
    })

    const response = await POST(request({ traderId: 'Alice Trader' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockResolveTrader).toHaveBeenCalledWith(expect.anything(), {
      handle: 'Alice Trader',
      platform: 'binance_futures',
    })
    expect(body.data).toMatchObject({
      source: 'binance_futures',
      traderId: 'account-42',
      verifiedUid: 'account-42',
    })
  })

  it('fails closed when trader resolution crosses the requested source', async () => {
    mockResolveTrader.mockResolvedValue({ platform: 'binance_spot', traderKey: 'account-42' })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockResolveExchangeUid).not.toHaveBeenCalled()
    expect(mockSupabaseRpc).not.toHaveBeenCalled()
  })

  it('rejects an exchange that does not match the selected trader source', async () => {
    const response = await POST(request({ exchange: 'bybit' }))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.success).toBe(false)
    expect(mockResolveTrader).not.toHaveBeenCalled()
    expect(mockSupabaseRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['a null JSON body', null],
    ['an array JSON body', []],
    ['an extra request field', { extra: true }],
    ['an oversized API key', { apiKey: 'k'.repeat(513) }],
  ])('rejects %s before resolving a trader or credentials', async (_label, body) => {
    const response = await POST(
      body === null || Array.isArray(body) ? rawRequest(body) : request(body)
    )

    expect(response.status).toBe(400)
    expect(mockResolveTrader).not.toHaveBeenCalled()
    expect(mockResolveExchangeUid).not.toHaveBeenCalled()
    expect(mockSupabaseRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['a declared oversized body', JSON.stringify({}), { 'content-length': String(4 * 1024 + 1) }],
    ['an actually oversized body without a length header', `${' '.repeat(4 * 1024)}{}`, undefined],
  ])('returns 413 for %s', async (_label, body, headers) => {
    const response = await POST(rawRequest(body, headers))

    expect(response.status).toBe(413)
    expect(mockResolveTrader).not.toHaveBeenCalled()
    expect(mockResolveExchangeUid).not.toHaveBeenCalled()
    expect(mockSupabaseRpc).not.toHaveBeenCalled()
  })

  it.each(['binance_web3', 'bitget_cfd', 'binance_impersonator'])(
    'rejects the non-verifiable source %s instead of matching a brand prefix',
    async (source) => {
      const response = await POST(request({ exchange: source, source }))

      expect(response.status).toBe(400)
      expect(mockResolveTrader).not.toHaveBeenCalled()
      expect(mockResolveExchangeUid).not.toHaveBeenCalled()
      expect(mockSupabaseRpc).not.toHaveBeenCalled()
    }
  )

  it('fails closed when the persisted connection acknowledgement is mismatched', async () => {
    mockSupabaseRpc.mockResolvedValue(
      atomicSaveResult({
        status: 'saved',
        exchange: 'binance',
        user_id: '33333333-3333-4333-8333-333333333333',
        connection_id: '22222222-2222-4222-8222-222222222222',
        generation: 1,
        verified: true,
      })
    )

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error.message).toContain('failed to store credentials')
  })

  it.each([
    ['the wrong exchange', { exchange: 'bybit' }],
    ['an unverified write', { verified: false }],
    ['an extra field', { verified_uid: 'account-42' }],
  ])('fails closed when persistence acknowledges %s', async (_label, overrides) => {
    mockSupabaseRpc.mockResolvedValue(
      atomicSaveResult({
        status: 'saved',
        exchange: 'binance',
        user_id: mockUser.id,
        connection_id: '22222222-2222-4222-8222-222222222222',
        generation: 1,
        verified: true,
        ...overrides,
      } as PersistedConnection)
    )

    const response = await POST(request())

    expect(response.status).toBe(500)
  })
})
