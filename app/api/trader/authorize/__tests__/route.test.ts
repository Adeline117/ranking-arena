import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    _body: unknown
    constructor(
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
    ) {
      this.url = url
      this.method = init.method ?? 'GET'
      this._body = init.body
      this.headers = new Map(
        Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
      )
    }
    async json() {
      return this._body
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
const mockBindApiKey = jest.fn()
const mockRevokeApiKey = jest.fn()
const mockEnqueueFirstPartySync = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: {
    read: { name: 'read-test-policy' },
    write: { name: 'write-test-policy' },
  },
}))

jest.mock('@/lib/services/api-key-binder', () => ({
  bindApiKey: (...args: unknown[]) => mockBindApiKey(...args),
  revokeApiKey: (...args: unknown[]) => mockRevokeApiKey(...args),
}))

jest.mock('@/lib/ingest/first-party/enqueue', () => ({
  enqueueFirstPartySync: (...args: unknown[]) => mockEnqueueFirstPartySync(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    apiError: jest.fn(),
    dbError: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
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
}

function request(method: 'GET' | 'DELETE', id?: string, authenticated = true) {
  const search = id === undefined ? '' : `?id=${encodeURIComponent(id)}`
  return new NextRequest(`http://localhost/api/trader/authorize${search}`, {
    method,
    headers: authenticated ? { Authorization: 'Bearer verified-token' } : {},
  })
}

function postRequest(body: unknown, authenticated = true) {
  return new NextRequest('http://localhost/api/trader/authorize', {
    method: 'POST',
    headers: authenticated ? { Authorization: 'Bearer verified-token' } : {},
    body,
  } as never)
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
    mockOrder.mockResolvedValue({
      data: [{ id: AUTHORIZATION_ID, platform: 'binance', status: 'active' }],
      error: null,
    })
    mockBindApiKey.mockResolvedValue({
      success: true,
      authorizationId: AUTHORIZATION_ID,
      traderId: 'exchange-uid-42',
      nickname: 'Primary',
      permissions: ['read'],
    })
    mockRevokeApiKey.mockResolvedValue({ success: true })
    mockEnqueueFirstPartySync.mockResolvedValue(true)
  })

  it('binds through the atomic service without publishing the private account as a profile', async () => {
    const response = await POST(
      postRequest({
        platform: 'binance',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
        label: 'Primary',
        syncFrequency: '5min',
      })
    )

    expect(response.status).toBe(200)
    expect(mockBindApiKey).toHaveBeenCalledTimes(1)
    expect(mockBindApiKey).toHaveBeenCalledWith(
      { from: mockFrom },
      USER_ID,
      expect.objectContaining({
        platform: 'binance',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
        label: 'Primary',
        syncFrequency: '5min',
      })
    )
    expect(mockEnqueueFirstPartySync).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      authorizationId: AUTHORIZATION_ID,
      traderId: 'exchange-uid-42',
      initialSyncQueued: false,
      publicProfilePublishing: false,
      message:
        'Read-only account connection saved. It is not linked to or publishing a public leaderboard profile.',
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('does not queue and returns 500 when the atomic projection rolls back', async () => {
    mockBindApiKey.mockResolvedValue({
      success: false,
      error: 'Failed to store API key binding. Please try again.',
      errorCode: 'storage_failed',
    })

    const response = await POST(
      postRequest({
        platform: 'binance',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      })
    )

    expect(response.status).toBe(500)
    expect(mockEnqueueFirstPartySync).not.toHaveBeenCalled()
  })

  it.each(['okx', 'binance_spot', 'bybit_spot', 'bitget_futures'])(
    'rejects non-public V1 platform %s before service access',
    async (platform) => {
      const response = await POST(
        postRequest({ platform, apiKey: 'api-key', apiSecret: 'api-secret' })
      )

      expect(response.status).toBe(400)
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
      expect(mockBindApiKey).not.toHaveBeenCalled()
      await expect(response.json()).resolves.toEqual({
        error: 'Unsupported V1 account-connection platform',
      })
    }
  )

  it.each([
    [{ platform: 'binance', apiKey: 'k', apiSecret: 's', extra: true }, 'unknown field'],
    [{ platform: 'binance', apiKey: 'k', apiSecret: 's', passphrase: 1 }, 'passphrase type'],
    [{ platform: 'binance', apiKey: 'k', apiSecret: 's', label: null }, 'label type'],
    [{ platform: 'binance', apiKey: 'k', apiSecret: 's', syncFrequency: 'daily' }, 'sync enum'],
    [{ platform: 'binance', apiKey: 'k'.repeat(1025), apiSecret: 's' }, 'key length'],
    [{ platform: 'binance', apiKey: 'k', apiSecret: 's'.repeat(4097) }, 'secret length'],
  ])('rejects malformed authorize input before service access (%s: %s)', async (body) => {
    const response = await POST(postRequest(body))

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockBindApiKey).not.toHaveBeenCalled()
  })

  it('returns 400 for an exchange validation failure', async () => {
    mockBindApiKey.mockResolvedValue({
      success: false,
      error: 'API key must be read-only',
      errorCode: 'validation_failed',
    })

    const response = await POST(
      postRequest({
        platform: 'binance',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'API key validation failed',
      details: 'API key must be read-only',
    })
  })

  it('does not initialize or call the atomic binder without an exact bearer token', async () => {
    const response = await POST(
      postRequest({ platform: 'binance', apiKey: 'api-key', apiSecret: 'api-secret' }, false)
    )

    expect(response.status).toBe(401)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockBindApiKey).not.toHaveBeenCalled()
  })

  it('contains no legacy direct table writer in the POST implementation', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/trader/authorize/route.ts'), 'utf8')
    const postSource = source.slice(
      source.indexOf('export async function POST'),
      source.indexOf('export async function GET')
    )

    expect(postSource).toContain('bindApiKey(getSupabaseAdmin()')
    expect(postSource).not.toContain("from('trader_authorizations')")
    expect(postSource).not.toContain("from('user_exchange_connections')")
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
    expect(mockCheckRateLimit).toHaveBeenCalledWith(req, { name: 'read-test-policy' })
    await expect(response.json()).resolves.toEqual({
      authorizations: [{ id: AUTHORIZATION_ID, platform: 'binance', status: 'active' }],
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
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

  it('revokes the caller-owned account lifecycle through the atomic service RPC', async () => {
    const req = request('DELETE', AUTHORIZATION_ID)
    const response = await DELETE(req)

    expect(response.status).toBe(200)
    expect(mockRevokeApiKey).toHaveBeenCalledWith({ from: mockFrom }, USER_ID, AUTHORIZATION_ID)
    expect(mockFrom).not.toHaveBeenCalled()
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
    mockRevokeApiKey.mockResolvedValue({
      success: false,
      error: 'Account connection not found',
      errorCode: 'not_found',
    })

    const response = await DELETE(request('DELETE', AUTHORIZATION_ID))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Authorization not found' })
  })

  it('does not report success when the revoke write fails', async () => {
    mockRevokeApiKey.mockResolvedValue({
      success: false,
      error: 'Failed to revoke API key',
      errorCode: 'storage_failed',
    })

    const response = await DELETE(request('DELETE', AUTHORIZATION_ID))

    expect(response.status).toBe(500)
  })

  it('contains no direct lifecycle table update in the DELETE implementation', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/trader/authorize/route.ts'), 'utf8')
    const deleteSource = source.slice(source.indexOf('export async function DELETE'))

    expect(deleteSource).toContain('revokeApiKey(getSupabaseAdmin()')
    expect(deleteSource).not.toContain("from('trader_authorizations')")
    expect(deleteSource).not.toContain("from('user_exchange_connections')")
    expect(deleteSource).not.toContain('.update(')
  })
})
