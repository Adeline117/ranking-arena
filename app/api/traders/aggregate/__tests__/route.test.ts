jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Headers
    private readonly body: unknown

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }

    async json() {
      return this.body
    }
  }

  class MockNextRequest {
    readonly nextUrl: URL
    readonly headers = new Headers()
    readonly method = 'GET'

    constructor(readonly url: string) {
      this.nextUrl = new URL(url)
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockFindUserByTrader = jest.fn()
const mockGetAggregatedStats = jest.fn()

jest.mock('@/lib/api', () => {
  const { NextResponse } = jest.requireMock<typeof import('next/server')>('next/server')
  return {
    getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    RateLimitPresets: { read: { name: 'read-test-policy' } },
    badRequest: (message: string) =>
      NextResponse.json({ success: false, error: message }, { status: 400 }),
    handleError: () =>
      NextResponse.json({ success: false, error: 'internal error' }, { status: 500 }),
  }
})

jest.mock('@/lib/data/linked-traders', () => ({
  findUserByTrader: (...args: unknown[]) => mockFindUserByTrader(...args),
  getAggregatedStats: (...args: unknown[]) => mockGetAggregatedStats(...args),
}))

import { NextRequest, NextResponse } from 'next/server'
import { GET } from '../route'

const VALID_URL =
  'http://localhost/api/traders/aggregate?contract=2&platform=bybit&trader_key=account-42'

function expectNoStore(response: { headers: Headers }) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Pragma')).toBe('no-cache')
}

function internalAccount(
  platform: string,
  traderKey: string,
  isPrimary: boolean
): Record<string, unknown> {
  return {
    id: `internal-${traderKey}`,
    userId: 'private-owner-id',
    linkedAt: '2026-07-01T00:00:00Z',
    platform,
    traderKey,
    handle: traderKey,
    label: 'Owner private label',
    isPrimary,
    roi: 25,
    pnl: 50_000,
    arenaScore: 88,
    winRate: 60,
    maxDrawdown: -12,
    rank: 9,
  }
}

describe('GET /api/traders/aggregate public contract v2', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetSupabaseAdmin.mockReturnValue({ marker: 'admin-client' })
    mockFindUserByTrader.mockResolvedValue('user-1')
    mockGetAggregatedStats.mockResolvedValue({
      accounts: [
        internalAccount('bybit', 'account-42', true),
        internalAccount('okx', 'account-2', false),
      ],
      totalAccounts: 2,
      combinedPnl: 50_000,
      bestRoi: { value: 25, platform: 'bybit', traderKey: 'account-42' },
      weightedScore: 88,
    })
  })

  it('returns an exact subject-bound allowlist with complete no-store headers', async () => {
    const response = await GET(new NextRequest(VALID_URL))
    const body = await response.json()

    expect(response.status).toBe(200)
    expectNoStore(response)
    expect(body.data).toMatchObject({
      subject: { platform: 'bybit', traderKey: 'account-42' },
      aggregated: { combinedPnl: null, bestRoi: null, weightedScore: null },
      totalAccounts: 2,
      accounts: [
        expect.objectContaining({
          id: 'bybit:account-42',
          label: null,
          rankingVisibility: 'unknown',
          rankingVisibilityReason: 'public_cohort_unavailable',
          pnl: null,
          arenaScore: null,
          rank: null,
          roi: null,
          winRate: null,
          maxDrawdown: null,
        }),
        expect.any(Object),
      ],
    })
    expect(JSON.stringify(body)).not.toMatch(/private-owner-id|Owner private label|linkedAt|50000/)
  })

  it.each([
    '',
    '?platform=bybit&trader_key=account-42',
    '?contract=1&platform=bybit&trader_key=account-42',
    '?contract=2&platform=bybit',
    '?contract=2&trader_key=account-42',
    '?contract=2&platform=bybit&trader_key=account-42&user_id=private-id',
    '?contract=2&platform=bybit&trader_key=account-42&handle=owner',
    '?contract=2&platform=%20bybit&trader_key=account-42',
    '?contract=2&contract=2&platform=bybit&trader_key=account-42',
    '?contract=2&platform=bybit&platform=okx&trader_key=account-42',
    '?contract=2&platform=bybit&trader_key=account-42&extra=unsafe',
  ])('rejects unsafe or incomplete selectors before database access: %s', async (query) => {
    const response = await GET(new NextRequest(`http://localhost/api/traders/aggregate${query}`))

    expect(response.status).toBe(400)
    expectNoStore(response)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockFindUserByTrader).not.toHaveBeenCalled()
  })

  it('returns a subject-bound authoritative empty result when no owner exists', async () => {
    mockFindUserByTrader.mockResolvedValueOnce(null)
    const response = await GET(new NextRequest(VALID_URL))

    expectNoStore(response)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        subject: { platform: 'bybit', traderKey: 'account-42' },
        aggregated: null,
        accounts: [],
        totalAccounts: 0,
      },
    })
    expect(mockGetAggregatedStats).not.toHaveBeenCalled()
  })

  it('reports one linked account as one while keeping aggregate numerics unavailable', async () => {
    mockGetAggregatedStats.mockResolvedValueOnce({
      accounts: [internalAccount('bybit', 'account-42', true)],
      totalAccounts: 1,
      combinedPnl: null,
      bestRoi: null,
      weightedScore: null,
    })
    const response = await GET(new NextRequest(VALID_URL))

    expectNoStore(response)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        subject: { platform: 'bybit', traderKey: 'account-42' },
        aggregated: null,
        accounts: [expect.objectContaining({ id: 'bybit:account-42' })],
        totalAccounts: 1,
      },
    })
  })

  it('returns an error rather than disguising malformed stats as zero accounts', async () => {
    mockGetAggregatedStats.mockResolvedValueOnce({ accounts: 'malformed' })
    const response = await GET(new NextRequest(VALID_URL))

    expect(response.status).toBe(500)
    expectNoStore(response)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'internal error',
    })
  })

  it('marks database errors no-store and never converts them into empty success', async () => {
    mockFindUserByTrader.mockRejectedValueOnce(new Error('database unavailable'))
    const response = await GET(new NextRequest(VALID_URL))

    expect(response.status).toBe(500)
    expectNoStore(response)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'internal error',
    })
  })

  it('marks rate-limit responses no-store without touching the database', async () => {
    mockCheckRateLimit.mockResolvedValueOnce(
      NextResponse.json({ success: false, error: 'limited' }, { status: 429 })
    )
    const response = await GET(new NextRequest(VALID_URL))

    expect(response.status).toBe(429)
    expectNoStore(response)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })
})
