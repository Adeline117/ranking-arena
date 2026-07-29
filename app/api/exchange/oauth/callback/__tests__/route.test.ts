jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private readonly body: unknown

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    url: string
    headers: { get: (name: string) => string | null }
    cookies: { get: (name: string) => { value: string } | undefined }
    private readonly body: unknown

    constructor(
      url: string,
      init: {
        body?: unknown
        headers?: Record<string, string>
        cookies?: Record<string, string>
      } = {}
    ) {
      this.url = url
      this.body = init.body
      const headers = new Map(
        Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
      )
      const cookies = new Map(Object.entries(init.cookies ?? {}))
      this.headers = { get: (name) => headers.get(name.toLowerCase()) ?? null }
      this.cookies = {
        get: (name) => {
          const value = cookies.get(name)
          return value === undefined ? undefined : { value }
        },
      }
    }

    async json() {
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockRpc = jest.fn()
const mockUpsert = jest.fn()
const mockValidateCsrfToken = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (table: string) => {
      if (table !== 'user_exchange_connections') throw new Error(`Unexpected table: ${table}`)
      return { upsert: (...args: unknown[]) => mockUpsert(...args) }
    },
  }),
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: (...args: unknown[]) => mockValidateCsrfToken(...args),
  CSRF_COOKIE_NAME: 'arena-csrf',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))

jest.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'http://localhost:3000' },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  fireAndForget: jest.fn(),
}))

import { NextRequest } from 'next/server'

type CallbackHandler = (request: InstanceType<typeof NextRequest>) => Promise<{
  status: number
  json: () => Promise<Record<string, unknown>>
}>

const USER_A = '10000000-0000-4000-8000-000000000001'
const CLAIM_ID = '20000000-0000-4000-8000-000000000001'
const CLAIM_TOKEN = '30000000-0000-4000-8000-000000000001'

function callbackRequest(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/exchange/oauth/callback', {
    body: {
      exchange: 'binance',
      code: 'authorization-code',
      state: 'oauth-state',
      ...body,
    },
    headers: { 'x-csrf-token': 'csrf-token' },
    cookies: { 'arena-csrf': 'csrf-token' },
  })
}

function installRpcSuccess() {
  mockRpc.mockImplementation(async (name: string, args: { p_succeeded?: boolean }) => {
    if (name === 'claim_exchange_oauth_state_atomic') {
      return {
        data: {
          status: 'claimed',
          id: CLAIM_ID,
          code_verifier: 'pkce-verifier',
          claim_token: CLAIM_TOKEN,
        },
        error: null,
      }
    }
    if (name === 'finish_exchange_oauth_state_claim_atomic') {
      return {
        data: { status: args.p_succeeded ? 'consumed' : 'released' },
        error: null,
      }
    }
    throw new Error(`Unexpected RPC: ${name}`)
  })
}

function installTokenSuccess() {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({
        access_token: 'exchange-access-token',
        refresh_token: 'exchange-refresh-token',
        expires_in: 3600,
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValue({ data: { userId: 'binance-user-a' } }),
    }) as jest.Mock
}

describe('POST /api/exchange/oauth/callback', () => {
  let POST: CallbackHandler
  const originalEnvironment = { ...process.env }

  beforeAll(async () => {
    process.env.BINANCE_OAUTH_CLIENT_ID = 'binance-client-id'
    process.env.BINANCE_OAUTH_CLIENT_SECRET = 'binance-client-secret'
    process.env.ENCRYPTION_KEY = '0'.repeat(64)
    POST = (await import('../route')).POST as unknown as CallbackHandler
  })

  afterAll(() => {
    process.env = originalEnvironment
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: USER_A })
    mockValidateCsrfToken.mockReturnValue(true)
    mockUpsert.mockResolvedValue({ error: null })
    installRpcSuccess()
    installTokenSuccess()
  })

  it('requires the authenticated viewer and CSRF proof', async () => {
    mockGetAuthUser.mockResolvedValueOnce(null)
    const unauthorized = await POST(callbackRequest())
    expect(unauthorized.status).toBe(401)

    mockValidateCsrfToken.mockReturnValueOnce(false)
    const forbidden = await POST(callbackRequest())
    expect(forbidden.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects missing callback parameters before claiming state', async () => {
    const response = await POST(callbackRequest({ state: '' }))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('binds the atomic claim, connection write, and strict ACK to the token viewer', async () => {
    const response = await POST(callbackRequest({ userId: 'attacker-controlled-user' }))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      success: true,
      exchangeUserId: 'binance-user-a',
      data: {
        viewerId: USER_A,
        exchange: 'binance',
        exchangeUserId: 'binance-user-a',
      },
    })
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'claim_exchange_oauth_state_atomic', {
      p_user_id: USER_A,
      p_exchange: 'binance',
      p_state: 'oauth-state',
      p_lease_seconds: 300,
    })
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER_A, exchange: 'binance' }),
      { onConflict: 'user_id,exchange' }
    )
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'finish_exchange_oauth_state_claim_atomic', {
      p_user_id: USER_A,
      p_exchange: 'binance',
      p_state: 'oauth-state',
      p_claim_token: CLAIM_TOKEN,
      p_succeeded: true,
    })
    expect(mockRpc).toHaveBeenCalledTimes(2)

    const tokenRequest = (global.fetch as jest.Mock).mock.calls[0]
    expect(tokenRequest[1].body).toContain('code_verifier=pkce-verifier')
  })

  it('fails closed when the state is expired, already claimed, or malformed', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'invalid_or_claimed' }, error: null })

    const response = await POST(callbackRequest())

    expect(response.status).toBe(400)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('returns a server error when the atomic claim cannot be established', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc unavailable' } })

    const response = await POST(callbackRequest())

    expect(response.status).toBe(500)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('releases the exact lease when token exchange fails so the callback can retry', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      text: jest.fn().mockResolvedValue('{"error":"temporarily_unavailable"}'),
    }) as jest.Mock

    const response = await POST(callbackRequest())

    expect(response.status).toBe(400)
    expect(mockRpc).toHaveBeenLastCalledWith('finish_exchange_oauth_state_claim_atomic', {
      p_user_id: USER_A,
      p_exchange: 'binance',
      p_state: 'oauth-state',
      p_claim_token: CLAIM_TOKEN,
      p_succeeded: false,
    })
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('releases the lease when the connection write fails', async () => {
    mockUpsert.mockResolvedValueOnce({ error: { message: 'database unavailable' } })

    const response = await POST(callbackRequest())

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenLastCalledWith(
      'finish_exchange_oauth_state_claim_atomic',
      expect.objectContaining({ p_claim_token: CLAIM_TOKEN, p_succeeded: false })
    )
  })

  it('does not acknowledge success when the state lease cannot be consumed', async () => {
    mockRpc.mockImplementation(async (name: string, args: { p_succeeded?: boolean }) => {
      if (name === 'claim_exchange_oauth_state_atomic') {
        return {
          data: {
            status: 'claimed',
            id: CLAIM_ID,
            code_verifier: null,
            claim_token: CLAIM_TOKEN,
          },
          error: null,
        }
      }
      return {
        data: { status: args.p_succeeded ? 'stale_claim' : 'released' },
        error: null,
      }
    })

    const response = await POST(callbackRequest())

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenNthCalledWith(
      2,
      'finish_exchange_oauth_state_claim_atomic',
      expect.objectContaining({ p_succeeded: true })
    )
    expect(mockRpc).toHaveBeenNthCalledWith(
      3,
      'finish_exchange_oauth_state_claim_atomic',
      expect.objectContaining({ p_succeeded: false })
    )
  })
})
