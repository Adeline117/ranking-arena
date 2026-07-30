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
const mockValidateCsrfToken = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
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
const CONNECTION_ID = '40000000-0000-4000-8000-000000000001'
const VALID_STATE = 'binance.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function callbackRequest(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/exchange/oauth/callback', {
    body: {
      exchange: 'binance',
      code: 'authorization-code',
      state: VALID_STATE,
      ...body,
    },
    headers: { 'x-csrf-token': 'csrf-token' },
    cookies: { 'arena-csrf': 'csrf-token' },
  })
}

function installRpcSuccess() {
  mockRpc.mockImplementation(async (name: string) => {
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
    if (name === 'complete_exchange_oauth_callback_atomic') {
      return {
        data: {
          success: true,
          status: 'connected',
          user_id: USER_A,
          exchange: 'binance',
          state_id: CLAIM_ID,
          connection_id: CONNECTION_ID,
        },
        error: null,
      }
    }
    if (name === 'finish_exchange_oauth_state_claim_atomic') {
      return { data: { status: 'released' }, error: null }
    }
    throw new Error(`Unexpected RPC: ${name}`)
  })
}

function installTokenSuccess() {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          access_token: 'exchange-access-token',
          refresh_token: 'exchange-refresh-token',
          expires_in: 3600,
        })
      ),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: jest.fn().mockResolvedValue(JSON.stringify({ data: { userId: 'binance-user-a' } })),
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
        connectionId: CONNECTION_ID,
        exchangeUserId: 'binance-user-a',
      },
    })
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'claim_exchange_oauth_state_atomic', {
      p_user_id: USER_A,
      p_exchange: 'binance',
      p_state: VALID_STATE,
      p_lease_seconds: 300,
    })
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'complete_exchange_oauth_callback_atomic', {
      p_user_id: USER_A,
      p_exchange: 'binance',
      p_state: VALID_STATE,
      p_state_id: CLAIM_ID,
      p_claim_token: CLAIM_TOKEN,
      p_exchange_user_id: 'binance-user-a',
      p_access_token_encrypted: expect.stringMatching(/^v2:/),
      p_refresh_token_encrypted: expect.stringMatching(/^v2:/),
      p_expires_at: expect.any(String),
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
      status: 503,
      headers: new Headers(),
      text: jest.fn().mockResolvedValue('{"error":"temporarily_unavailable"}'),
    }) as jest.Mock

    const response = await POST(callbackRequest())

    expect(response.status).toBe(400)
    expect(mockRpc).toHaveBeenLastCalledWith('finish_exchange_oauth_state_claim_atomic', {
      p_user_id: USER_A,
      p_exchange: 'binance',
      p_state: VALID_STATE,
      p_claim_token: CLAIM_TOKEN,
      p_succeeded: false,
    })
  })

  it('releases the lease when the atomic completion RPC fails', async () => {
    mockRpc.mockImplementation(async (name: string) => {
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
      if (name === 'complete_exchange_oauth_callback_atomic') {
        return { data: null, error: { message: 'database unavailable' } }
      }
      return { data: { status: 'released' }, error: null }
    })

    const response = await POST(callbackRequest())

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenLastCalledWith(
      'finish_exchange_oauth_state_claim_atomic',
      expect.objectContaining({ p_claim_token: CLAIM_TOKEN, p_succeeded: false })
    )
  })

  it('does not acknowledge success when the atomic state lease became stale', async () => {
    mockRpc.mockImplementation(async (name: string) => {
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
      if (name === 'complete_exchange_oauth_callback_atomic') {
        return { data: { success: false, reason: 'STALE_CLAIM' }, error: null }
      }
      return { data: { status: 'released' }, error: null }
    })

    const response = await POST(callbackRequest())

    expect(response.status).toBe(409)
    expect(mockRpc).toHaveBeenNthCalledWith(
      2,
      'complete_exchange_oauth_callback_atomic',
      expect.objectContaining({ p_state_id: CLAIM_ID, p_claim_token: CLAIM_TOKEN })
    )
    expect(mockRpc).toHaveBeenNthCalledWith(
      3,
      'finish_exchange_oauth_state_claim_atomic',
      expect.objectContaining({ p_succeeded: false })
    )
  })

  it('rejects completion after the viewer account became unavailable', async () => {
    mockRpc.mockImplementation(async (name: string) => {
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
      if (name === 'complete_exchange_oauth_callback_atomic') {
        return { data: { success: false, reason: 'ACTOR_UNAVAILABLE' }, error: null }
      }
      return { data: { status: 'released' }, error: null }
    })

    const response = await POST(callbackRequest())

    expect(response.status).toBe(403)
    expect(mockRpc).toHaveBeenLastCalledWith(
      'finish_exchange_oauth_state_claim_atomic',
      expect.objectContaining({ p_succeeded: false })
    )
  })

  it('fails closed on a completion acknowledgement with the wrong identity', async () => {
    mockRpc.mockImplementation(async (name: string) => {
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
      if (name === 'complete_exchange_oauth_callback_atomic') {
        return {
          data: {
            success: true,
            status: 'connected',
            user_id: 'attacker-controlled-user',
            exchange: 'binance',
            state_id: CLAIM_ID,
            connection_id: CONNECTION_ID,
          },
          error: null,
        }
      }
      return { data: { status: 'released' }, error: null }
    })

    const response = await POST(callbackRequest())

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledTimes(3)
  })
})
