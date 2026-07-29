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

    constructor(url: string) {
      this.url = url
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockInsert = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'oauth_states') throw new Error(`Unexpected table: ${table}`)
      return { insert: (...args: unknown[]) => mockInsert(...args) }
    },
  }),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {} },
}))

jest.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://ranking.example' },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  fireAndForget: jest.fn(),
}))

import { NextRequest } from 'next/server'

type AuthorizeHandler = (request: InstanceType<typeof NextRequest>) => Promise<{
  status: number
  json: () => Promise<Record<string, unknown>>
}>

const USER_A = '10000000-0000-4000-8000-000000000001'

describe('GET /api/exchange/oauth/authorize', () => {
  let GET: AuthorizeHandler
  const originalEnvironment = { ...process.env }

  beforeAll(async () => {
    process.env.BINANCE_OAUTH_CLIENT_ID = 'binance-client-id'
    GET = (await import('../route')).GET as unknown as AuthorizeHandler
  })

  afterAll(() => {
    process.env = originalEnvironment
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: USER_A })
    mockInsert.mockResolvedValue({ error: null })
  })

  it('requires an authenticated viewer', async () => {
    mockGetAuthUser.mockResolvedValueOnce(null)

    const response = await GET(
      new NextRequest('https://ranking.example/api/exchange/oauth/authorize?exchange=binance')
    )

    expect(response.status).toBe(401)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('stores exchange in the one-time state and returns a strict viewer ACK', async () => {
    const response = await GET(
      new NextRequest('https://ranking.example/api/exchange/oauth/authorize?exchange=binance')
    )
    const payload = await response.json()
    const data = payload.data as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(payload.success).toBe(true)
    expect(data.viewerId).toBe(USER_A)
    expect(data.exchange).toBe('binance')
    expect(data.state).toMatch(/^binance\.[0-9a-f]{40}$/)
    expect(data.authUrl).toEqual(expect.stringContaining('state=binance.'))
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER_A,
        exchange: 'binance',
        state: data.state,
      })
    )
  })

  it('fails closed when state persistence fails', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'database unavailable' } })

    const response = await GET(
      new NextRequest('https://ranking.example/api/exchange/oauth/authorize?exchange=binance')
    )

    expect(response.status).toBe(500)
  })
})
