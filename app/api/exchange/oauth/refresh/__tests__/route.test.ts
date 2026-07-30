import crypto from 'crypto'
import { decryptOAuthToken, encryptOAuthToken } from '@/lib/exchange/oauth-token-encryption'

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
    private readonly invalidJson: boolean

    constructor(
      url: string,
      init: {
        body?: unknown
        headers?: Record<string, string>
        cookies?: Record<string, string>
        invalidJson?: boolean
      } = {}
    ) {
      this.url = url
      this.body = init.body
      this.invalidJson = init.invalidJson ?? false
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
      if (this.invalidJson) throw new Error('invalid json')
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockValidateCsrfToken = jest.fn()
const mockFetchOAuthJsonWithTimeout = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: (...args: unknown[]) => mockValidateCsrfToken(...args),
  CSRF_COOKIE_NAME: 'arena-csrf',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/exchange/oauth-http', () => ({
  fetchOAuthJsonWithTimeout: (...args: unknown[]) => mockFetchOAuthJsonWithTimeout(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { NextRequest } from 'next/server'

type RefreshHandler = (request: InstanceType<typeof NextRequest>) => Promise<{
  status: number
  json: () => Promise<Record<string, unknown>>
}>

type QueryResult = { data: Record<string, unknown> | null; error: unknown }

type UpdateCall = {
  equals: Array<[string, unknown]>
  payload: Record<string, unknown>
  select: string | null
}

type UpdateResult = QueryResult | ((call: UpdateCall) => QueryResult)

const USER_A = '10000000-0000-4000-8000-000000000001'
const USER_B = '10000000-0000-4000-8000-000000000002'
const CONNECTION_ID = '20000000-0000-4000-8000-000000000001'
const KEY = '01'.repeat(32)
const ACCESS_CONTEXT = { viewerId: USER_A, exchange: 'binance', purpose: 'access' as const }
const REFRESH_CONTEXT = { viewerId: USER_A, exchange: 'binance', purpose: 'refresh' as const }

let connectionResult: QueryResult
let updateResults: UpdateResult[]
let selectEquals: Array<[string, unknown]>
let updateCalls: UpdateCall[]

function legacyEncrypt(plaintext: string): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(KEY, 'hex'), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${ciphertext.toString('hex')}`
}

function refreshLease(tokenCiphertext: string, expiresAt: number): string {
  return `refresh-lease-v1:${expiresAt}:${'ab'.repeat(16)}:${Buffer.from(tokenCiphertext).toString('base64url')}`
}

function installSupabaseMock() {
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'user_exchange_connections') throw new Error(`Unexpected table: ${table}`)
    return {
      select: (columns: string) => {
        expect(columns).toBe('id, user_id, exchange, refresh_token_encrypted')
        const chain = {
          eq: (column: string, value: unknown) => {
            selectEquals.push([column, value])
            return chain
          },
          single: async () => connectionResult,
        }
        return chain
      },
      update: (payload: Record<string, unknown>) => {
        const call = {
          equals: [] as Array<[string, unknown]>,
          payload,
          select: null as string | null,
        }
        updateCalls.push(call)
        const result = updateResults.shift() ?? { data: null, error: null }
        const chain = {
          eq: (column: string, value: unknown) => {
            call.equals.push([column, value])
            return chain
          },
          select: (columns: string) => {
            call.select = columns
            return chain
          },
          maybeSingle: async () => (typeof result === 'function' ? result(call) : result),
        }
        return chain
      },
    }
  })
}

function request(body: Record<string, unknown> = {}, invalidJson = false) {
  return new NextRequest('https://ranking.example/api/exchange/oauth/refresh', {
    body: { exchange: 'binance', ...body },
    headers: { 'x-csrf-token': 'csrf-token' },
    cookies: { 'arena-csrf': 'csrf-token' },
    invalidJson,
  })
}

function providerResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    data,
  }
}

function successAck(
  expiresAt: string | null = '2026-07-29T20:00:00.000Z'
): (call: UpdateCall) => QueryResult {
  return (call) => ({
    data: {
      id: CONNECTION_ID,
      user_id: USER_A,
      exchange: 'binance',
      access_token_encrypted: call.payload.access_token_encrypted,
      refresh_token_encrypted: call.payload.refresh_token_encrypted,
      expires_at: expiresAt,
      last_sync_status: 'success',
    },
    error: null,
  })
}

function failureAck(call: UpdateCall): QueryResult {
  return {
    data: {
      id: CONNECTION_ID,
      user_id: USER_A,
      exchange: 'binance',
      refresh_token_encrypted: call.payload.refresh_token_encrypted,
    },
    error: null,
  }
}

function installRpcSuccess() {
  mockRpc.mockImplementation(
    async (
      name: string,
      args: {
        p_connection_id: string
        p_exchange: string
        p_lease_refresh_token_encrypted: string
        p_user_id: string
      }
    ) => {
      if (name !== 'claim_exchange_oauth_refresh_atomic') {
        throw new Error(`Unexpected RPC: ${name}`)
      }
      return {
        data: {
          success: true,
          status: 'claimed',
          connection_id: args.p_connection_id,
          user_id: args.p_user_id,
          exchange: args.p_exchange,
          refresh_token_encrypted: args.p_lease_refresh_token_encrypted,
        },
        error: null,
      }
    }
  )
}

function refreshClaimArgs(index = 0) {
  return mockRpc.mock.calls[index][1] as {
    p_connection_id: string
    p_exchange: string
    p_expected_refresh_token_encrypted: string
    p_lease_refresh_token_encrypted: string
    p_user_id: string
  }
}

describe('POST /api/exchange/oauth/refresh', () => {
  let POST: RefreshHandler
  const originalEnvironment = { ...process.env }
  let capturedRefreshCiphertext: string

  beforeAll(async () => {
    process.env.BINANCE_OAUTH_CLIENT_ID = 'binance-client-id'
    process.env.BINANCE_OAUTH_CLIENT_SECRET = 'binance-client-secret'
    process.env.ENCRYPTION_KEY = KEY
    POST = (await import('../route')).POST as unknown as RefreshHandler
  })

  afterAll(() => {
    process.env = originalEnvironment
  })

  beforeEach(() => {
    jest.clearAllMocks()
    selectEquals = []
    updateCalls = []
    updateResults = []
    capturedRefreshCiphertext = legacyEncrypt('legacy-refresh-token')
    connectionResult = {
      data: {
        id: CONNECTION_ID,
        user_id: USER_A,
        exchange: 'binance',
        refresh_token_encrypted: capturedRefreshCiphertext,
      },
      error: null,
    }
    mockGetAuthUser.mockResolvedValue({ id: USER_A })
    mockValidateCsrfToken.mockReturnValue(true)
    installSupabaseMock()
    installRpcSuccess()
  })

  it('requires the authenticated viewer, CSRF proof, and a valid body', async () => {
    mockGetAuthUser.mockResolvedValueOnce(null)
    expect((await POST(request())).status).toBe(401)

    mockValidateCsrfToken.mockReturnValueOnce(false)
    expect((await POST(request())).status).toBe(403)

    expect((await POST(request({}, true))).status).toBe(400)
    expect((await POST(request({ exchange: '' }))).status).toBe(400)
    expect(mockFetchOAuthJsonWithTimeout).not.toHaveBeenCalled()
  })

  it('reads and publishes only the exact viewer/exchange/token generation', async () => {
    updateResults.push(successAck())
    mockFetchOAuthJsonWithTimeout.mockResolvedValue(
      providerResponse(200, {
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
      })
    )

    const response = await POST(request({ userId: USER_B }))
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      success: true,
      expiresAt: '2026-07-29T20:00:00.000Z',
      data: {
        viewerId: USER_A,
        exchange: 'binance',
        connectionId: CONNECTION_ID,
        expiresAt: '2026-07-29T20:00:00.000Z',
      },
    })
    expect(selectEquals).toEqual([
      ['user_id', USER_A],
      ['exchange', 'binance'],
      ['is_active', true],
    ])
    expect(mockFetchOAuthJsonWithTimeout).toHaveBeenCalledWith(
      'https://accounts.binance.com/oauth/token',
      expect.objectContaining({ method: 'POST' }),
      20_000
    )
    const requestBody = mockFetchOAuthJsonWithTimeout.mock.calls[0][1].body as string
    expect(requestBody).toContain('refresh_token=legacy-refresh-token')
    expect(mockRpc).toHaveBeenCalledWith('claim_exchange_oauth_refresh_atomic', {
      p_user_id: USER_A,
      p_exchange: 'binance',
      p_connection_id: CONNECTION_ID,
      p_expected_refresh_token_encrypted: capturedRefreshCiphertext,
      p_lease_refresh_token_encrypted: expect.stringMatching(/^refresh-lease-v1:/),
    })
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].equals).toEqual([
      ['id', CONNECTION_ID],
      ['user_id', USER_A],
      ['exchange', 'binance'],
      ['is_active', true],
      ['refresh_token_encrypted', refreshClaimArgs().p_lease_refresh_token_encrypted],
    ])
    expect(updateCalls[0].payload).not.toHaveProperty('is_active')
    expect(updateCalls[0].payload.access_token_encrypted).toEqual(expect.stringMatching(/^v2:/))
    expect(updateCalls[0].payload.refresh_token_encrypted).toEqual(expect.stringMatching(/^v2:/))
    expect(
      decryptOAuthToken(
        updateCalls[0].payload.access_token_encrypted as string,
        KEY,
        ACCESS_CONTEXT
      )
    ).toBe('new-access-token')
    expect(
      decryptOAuthToken(
        updateCalls[0].payload.refresh_token_encrypted as string,
        KEY,
        REFRESH_CONTEXT
      )
    ).toBe('rotated-refresh-token')
  })

  it('migrates a legacy CBC refresh token even when the provider does not rotate it', async () => {
    updateResults.push(successAck())
    mockFetchOAuthJsonWithTimeout.mockResolvedValue(
      providerResponse(200, { access_token: 'new-access-token', expires_in: '3600' })
    )

    const response = await POST(request())

    expect(response.status).toBe(200)
    const rewritten = updateCalls[0].payload.refresh_token_encrypted as string
    expect(rewritten).toMatch(/^v2:/)
    expect(decryptOAuthToken(rewritten, KEY, REFRESH_CONTEXT)).toBe('legacy-refresh-token')
  })

  it('installs a pre-provider lease so a concurrent request cannot rotate the same token', async () => {
    let resolveProvider!: (value: ReturnType<typeof providerResponse>) => void
    const providerPending = new Promise<ReturnType<typeof providerResponse>>((resolve) => {
      resolveProvider = resolve
    })
    updateResults.push(successAck())
    mockRpc.mockImplementationOnce(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('claim_exchange_oauth_refresh_atomic')
      connectionResult.data = {
        ...connectionResult.data!,
        refresh_token_encrypted: args.p_lease_refresh_token_encrypted,
      }
      return {
        data: {
          success: true,
          status: 'claimed',
          connection_id: args.p_connection_id,
          user_id: args.p_user_id,
          exchange: args.p_exchange,
          refresh_token_encrypted: args.p_lease_refresh_token_encrypted,
        },
        error: null,
      }
    })
    mockFetchOAuthJsonWithTimeout.mockReturnValueOnce(providerPending)

    const firstRefresh = POST(request())
    for (let attempt = 0; attempt < 10 && mockRpc.mock.calls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    expect(mockFetchOAuthJsonWithTimeout).toHaveBeenCalledTimes(1)
    expect(updateCalls).toHaveLength(0)

    const concurrentRefresh = await POST(request())
    expect(concurrentRefresh.status).toBe(409)
    expect(mockFetchOAuthJsonWithTimeout).toHaveBeenCalledTimes(1)
    expect(updateCalls).toHaveLength(0)

    resolveProvider(
      providerResponse(200, {
        access_token: 'new-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
      })
    )
    expect((await firstRefresh).status).toBe(200)
    expect(updateCalls).toHaveLength(1)
  })

  it('reclaims an expired refresh lease without nesting the stored ciphertext', async () => {
    const expiredLease = refreshLease(capturedRefreshCiphertext, Date.now() - 1)
    connectionResult.data = {
      ...connectionResult.data!,
      refresh_token_encrypted: expiredLease,
    }
    updateResults.push(successAck())
    mockFetchOAuthJsonWithTimeout.mockResolvedValue(
      providerResponse(200, { access_token: 'new-access-token', expires_in: 3600 })
    )

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(refreshClaimArgs().p_expected_refresh_token_encrypted).toBe(expiredLease)
    expect(refreshClaimArgs().p_lease_refresh_token_encrypted).toEqual(
      expect.stringMatching(/^refresh-lease-v1:/)
    )
    expect(refreshClaimArgs().p_lease_refresh_token_encrypted).not.toContain(
      Buffer.from(expiredLease, 'utf8').toString('base64url')
    )
    const requestBody = mockFetchOAuthJsonWithTimeout.mock.calls[0][1].body as string
    expect(requestBody).toContain('refresh_token=legacy-refresh-token')
  })

  it('keeps an unexpired refresh lease exclusive and fails closed if claiming fails', async () => {
    connectionResult.data = {
      ...connectionResult.data!,
      refresh_token_encrypted: refreshLease(capturedRefreshCiphertext, Date.now() + 60_000),
    }
    expect((await POST(request())).status).toBe(409)
    expect(updateCalls).toHaveLength(0)
    expect(mockFetchOAuthJsonWithTimeout).not.toHaveBeenCalled()

    connectionResult.data = {
      ...connectionResult.data!,
      refresh_token_encrypted: capturedRefreshCiphertext,
    }
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'database unavailable' } })
    expect((await POST(request())).status).toBe(500)
    expect(mockFetchOAuthJsonWithTimeout).not.toHaveBeenCalled()
  })

  it('maps lifecycle and generation claim failures before provider access', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { success: false, reason: 'ACTOR_UNAVAILABLE' },
      error: null,
    })
    expect((await POST(request())).status).toBe(403)

    mockRpc.mockResolvedValueOnce({
      data: { success: false, reason: 'CONNECTION_CHANGED' },
      error: null,
    })
    expect((await POST(request())).status).toBe(409)

    expect(mockFetchOAuthJsonWithTimeout).not.toHaveBeenCalled()
    expect(updateCalls).toHaveLength(0)
  })

  it('rejects a refresh claim acknowledgement with the wrong identity', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        success: true,
        status: 'claimed',
        connection_id: CONNECTION_ID,
        user_id: USER_B,
        exchange: 'binance',
        refresh_token_encrypted: 'wrong-lease',
      },
      error: null,
    })

    expect((await POST(request())).status).toBe(500)
    expect(mockFetchOAuthJsonWithTimeout).not.toHaveBeenCalled()
    expect(updateCalls).toHaveLength(0)
  })

  it.each([
    {
      label: 'provider outage',
      response: providerResponse(503, { error: 'temporarily_unavailable' }),
      expectedStatus: 503,
    },
    {
      label: 'rate limit',
      response: providerResponse(429, { error: 'rate_limited' }),
      expectedStatus: 503,
    },
    {
      label: 'revoked grant',
      response: providerResponse(400, { error: 'invalid_grant' }),
      expectedStatus: 401,
    },
  ])('records $label without deactivating the connection', async ({ response, expectedStatus }) => {
    updateResults.push(failureAck)
    mockFetchOAuthJsonWithTimeout.mockResolvedValue(response)

    const result = await POST(request())

    expect(result.status).toBe(expectedStatus)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].payload).not.toHaveProperty('is_active')
    expect(updateCalls[0].payload.refresh_token_encrypted).toBe(capturedRefreshCiphertext)
    expect(updateCalls[0].equals).toContainEqual([
      'refresh_token_encrypted',
      refreshClaimArgs().p_lease_refresh_token_encrypted,
    ])
  })

  it('treats a bounded transport failure as retryable without deactivation', async () => {
    updateResults.push(failureAck)
    mockFetchOAuthJsonWithTimeout.mockRejectedValue(new DOMException('timed out', 'AbortError'))

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(updateCalls[0].payload).not.toHaveProperty('is_active')
    expect(updateCalls[0].payload.last_sync_error).toBe(
      'OAuth token refresh temporarily unavailable'
    )
  })

  it('drops a stale success when another refresh already changed the token generation', async () => {
    updateResults.push({ data: null, error: null })
    mockFetchOAuthJsonWithTimeout.mockResolvedValue(
      providerResponse(200, {
        access_token: 'stale-access-token',
        refresh_token: 'stale-refresh-token',
        expires_in: 3600,
      })
    )

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(updateCalls[0].equals).toContainEqual([
      'refresh_token_encrypted',
      refreshClaimArgs().p_lease_refresh_token_encrypted,
    ])
  })

  it('drops a stale provider failure after another refresh changed the generation', async () => {
    updateResults.push({ data: null, error: null })
    mockFetchOAuthJsonWithTimeout.mockResolvedValue(
      providerResponse(503, { error: 'temporarily_unavailable' })
    )

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(updateCalls[0].payload).not.toHaveProperty('is_active')
  })

  it('fails before provider access on owner mismatch or tampered GCM ciphertext', async () => {
    connectionResult.data = { ...connectionResult.data!, user_id: USER_B }
    expect((await POST(request())).status).toBe(409)

    const tampered = encryptOAuthToken('refresh-token', KEY, REFRESH_CONTEXT).split(':')
    tampered[2] = `${tampered[2].slice(0, -1)}${tampered[2].endsWith('0') ? '1' : '0'}`
    connectionResult.data = {
      id: CONNECTION_ID,
      user_id: USER_A,
      exchange: 'binance',
      refresh_token_encrypted: tampered.join(':'),
    }
    expect((await POST(request())).status).toBe(409)
    expect(mockFetchOAuthJsonWithTimeout).not.toHaveBeenCalled()
    expect(updateCalls).toHaveLength(0)
  })

  it('fails closed on malformed provider success and DB publication errors', async () => {
    updateResults.push(failureAck)
    mockFetchOAuthJsonWithTimeout.mockResolvedValue(providerResponse(200, { expires_in: 3600 }))
    expect((await POST(request())).status).toBe(503)

    updateResults.push({ data: null, error: { message: 'database unavailable' } })
    mockFetchOAuthJsonWithTimeout.mockResolvedValue(
      providerResponse(200, { access_token: 'new-access-token', expires_in: 3600 })
    )
    expect((await POST(request())).status).toBe(500)
  })
})
