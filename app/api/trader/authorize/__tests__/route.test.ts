jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()
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
    method: string
    headers: Map<string, string>
    private readonly body: unknown
    constructor(
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
    ) {
      this.url = url
      this.method = init.method ?? 'GET'
      this.headers = new Map(
        Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
      )
      this.body = init.body
    }
    async json() {
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockFrom = jest.fn()
const mockSelect = jest.fn()
const mockEq = jest.fn()
const mockOrder = jest.fn()
const mockUpdate = jest.fn()
const mockMaybeSingle = jest.fn()
const mockBindApiKey = jest.fn()
const mockEnqueueFirstPartySync = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: { name: 'write-test-policy' } },
}))

jest.mock('@/lib/services/api-key-binder', () => ({
  bindApiKey: (...args: unknown[]) => mockBindApiKey(...args),
}))

jest.mock('@/lib/ingest/first-party/enqueue', () => ({
  enqueueFirstPartySync: (...args: unknown[]) => mockEnqueueFirstPartySync(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    apiError: jest.fn(),
    dbError: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

import { NextRequest } from 'next/server'
import { DELETE, GET, POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const AUTHORIZATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const query = {
  select: mockSelect,
  eq: mockEq,
  order: mockOrder,
  update: mockUpdate,
  maybeSingle: mockMaybeSingle,
}

function request(
  method: 'GET' | 'DELETE' | 'POST',
  id?: string,
  authenticated = true,
  body?: unknown
) {
  const search = id === undefined ? '' : `?id=${encodeURIComponent(id)}`
  return new NextRequest(`http://localhost/api/trader/authorize${search}`, {
    method,
    headers: authenticated ? { Authorization: 'Bearer verified-token' } : {},
    body,
  })
}

describe('/api/trader/authorize service-owned persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockFrom.mockReturnValue(query)
    mockSelect.mockReturnValue(query)
    mockEq.mockReturnValue(query)
    mockUpdate.mockReturnValue(query)
    mockOrder.mockResolvedValue({
      data: [{ id: AUTHORIZATION_ID, platform: 'binance', status: 'active' }],
      error: null,
    })
    mockMaybeSingle.mockResolvedValue({ data: { id: AUTHORIZATION_ID }, error: null })
    mockBindApiKey.mockResolvedValue({
      success: true,
      authorizationId: AUTHORIZATION_ID,
      traderId: 'exchange-uid',
      permissions: ['read'],
    })
    mockEnqueueFirstPartySync.mockResolvedValue(true)
  })

  it('routes POST through the shared lifecycle-atomic binder', async () => {
    const response = await POST(
      request('POST', undefined, true, {
        platform: 'binance',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      })
    )

    expect(response.status).toBe(200)
    expect(mockBindApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ from: mockFrom }),
      USER_ID,
      expect.objectContaining({
        platform: 'binance',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      })
    )
    expect(mockEnqueueFirstPartySync).toHaveBeenCalledWith(AUTHORIZATION_ID)
  })

  it('does not queue work when lifecycle admission rejects the bind', async () => {
    mockBindApiKey.mockResolvedValue({
      success: false,
      reason: 'account_unavailable',
      error: 'Account unavailable',
    })

    const response = await POST(
      request('POST', undefined, true, {
        platform: 'binance',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      })
    )

    expect(response.status).toBe(403)
    expect(mockEnqueueFirstPartySync).not.toHaveBeenCalled()
  })

  it('lists only a safe owner-scoped projection through the service client', async () => {
    const req = request('GET')
    const response = await GET(req)

    expect(response.status).toBe(200)
    expect(mockGetAuthUser).toHaveBeenCalledWith(req)
    expect(mockGetAuthUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetSupabaseAdmin.mock.invocationCallOrder[0]
    )
    expect(mockFrom).toHaveBeenCalledWith('trader_authorizations')
    const projection = mockSelect.mock.calls[0][0] as string
    expect(projection).toContain('read_only_verified_at')
    expect(projection).not.toMatch(/encrypted|secret|passphrase|access_token|refresh_token/i)
    expect(mockEq).toHaveBeenCalledWith('user_id', USER_ID)
    expect(mockEq).toHaveBeenCalledWith('status', 'active')
    await expect(response.json()).resolves.toEqual({
      authorizations: [{ id: AUTHORIZATION_ID, platform: 'binance', status: 'active' }],
    })
  })

  it('does not initialize service access without an exact bearer token', async () => {
    const response = await GET(request('GET', undefined, false))

    expect(response.status).toBe(401)
    expect(mockGetAuthUser).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('does not initialize service access for an invalid authenticated user', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await GET(request('GET'))

    expect(response.status).toBe(401)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('revokes only the caller-owned authorization and proves a row changed', async () => {
    const req = request('DELETE', AUTHORIZATION_ID)
    const response = await DELETE(req)

    expect(response.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith({
      status: 'revoked',
      updated_at: expect.any(String),
    })
    expect(mockEq).toHaveBeenNthCalledWith(1, 'id', AUTHORIZATION_ID)
    expect(mockEq).toHaveBeenNthCalledWith(2, 'user_id', USER_ID)
    expect(mockSelect).toHaveBeenCalledWith('id')
    expect(mockMaybeSingle).toHaveBeenCalled()
  })

  it.each([
    [undefined, 'missing'],
    ['not-a-uuid', 'malformed'],
  ])('rejects a %s authorization ID before service access (%s)', async (id) => {
    const response = await DELETE(request('DELETE', id))

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('fails closed when the owner-scoped revoke matches no row', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })

    const response = await DELETE(request('DELETE', AUTHORIZATION_ID))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Authorization not found' })
  })

  it('does not report success when the revoke write fails', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'write failed' } })

    const response = await DELETE(request('DELETE', AUTHORIZATION_ID))

    expect(response.status).toBe(500)
  })
})
