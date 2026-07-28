jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Map<string, string>()
    private readonly body: unknown

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }

    async json() {
      return this.body
    }
  }

  class MockNextRequest {
    constructor(readonly url: string) {}
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockFrom = jest.fn()
const mockSelect = jest.fn()
const mockEq = jest.fn()
const mockMaybeSingle = jest.fn()

jest.mock('@/lib/api', () => {
  const { NextResponse } = jest.requireMock<typeof import('next/server')>('next/server')
  return {
    getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    RateLimitPresets: { read: { name: 'read-test-policy' } },
    success: (data: unknown) => NextResponse.json({ success: true, data }),
    handleError: () =>
      NextResponse.json({ success: false, error: 'internal error' }, { status: 500 }),
  }
})

import { NextRequest } from 'next/server'
import { GET } from '../route'

const query = {
  select: mockSelect,
  eq: mockEq,
  maybeSingle: mockMaybeSingle,
}

function request(queryString = 'trader_id=account-42&source=binance_futures') {
  return new NextRequest(`http://localhost/api/traders/claim/status?${queryString}`)
}

function expectNoStore(response: { headers: { get(name: string): string | null } }) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  expect(response.headers.get('Pragma')).toBe('no-cache')
}

describe('GET /api/traders/claim/status', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockFrom.mockReturnValue(query)
    mockSelect.mockReturnValue(query)
    mockEq.mockReturnValue(query)
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  })

  it('echoes exact identity and disables caching for a verified profile', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'verified-id',
        user_id: 'owner-id',
        display_name: 'Exact profile',
        bio: 'Exact bio',
        avatar_url: null,
        twitter_url: null,
        telegram_url: null,
        discord_url: null,
        website_url: null,
      },
      error: null,
    })

    const response = await GET(request())

    expectNoStore(response)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        trader_id: 'account-42',
        source: 'binance_futures',
        is_verified: true,
        owner_id: 'owner-id',
        profile: { display_name: 'Exact profile', bio: 'Exact bio' },
      },
    })
    expect(mockEq).toHaveBeenNthCalledWith(1, 'trader_id', 'account-42')
    expect(mockEq).toHaveBeenNthCalledWith(2, 'source', 'binance_futures')
  })

  it('echoes exact identity and disables caching for an unverified profile', async () => {
    const response = await GET(request('trader_id=account-99&source=bybit'))

    expectNoStore(response)
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { trader_id: 'account-99', source: 'bybit', is_verified: false },
    })
  })

  it('disables caching on validation and internal error responses', async () => {
    const validationResponse = await GET(request('source=bybit'))
    expectNoStore(validationResponse)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()

    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST000', message: 'database unavailable' },
    })
    const errorResponse = await GET(request())
    expectNoStore(errorResponse)
    expect(errorResponse.status).toBe(500)
  })
})
