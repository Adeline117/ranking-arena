const mockCheckRateLimit = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockGetPopularTokenRankingSnapshot = jest.fn()
const mockGetTokenTraderRankingSnapshot = jest.fn()
const mockLoggerError = jest.fn()
const mockLoggerWarn = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    readonly url: string
    readonly nextUrl: URL
    readonly headers: Headers

    constructor(url: string, init: { headers?: HeadersInit } = {}) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Headers(init.headers)
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: { name: 'read-test-policy' } },
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}))

jest.mock('@/lib/rankings/token-ranking-snapshot', () => {
  type MockErrorKind =
    | 'invalid_input'
    | 'not_published'
    | 'generation_changed'
    | 'publication_busy'
    | 'contract'
    | 'database'

  class MockTokenRankingReadError extends Error {
    constructor(
      public readonly kind: MockErrorKind,
      message: string,
      public readonly databaseCode?: string,
      public readonly details?: string,
      public readonly currentGeneration?: string
    ) {
      super(message)
      this.name = 'TokenRankingReadError'
    }
  }

  return {
    TOKEN_RANKING_API_TIMEOUT_MS: 12_000,
    TOKEN_RANKING_MAX_GENERATION: 9_007_199_254_740_000,
    TOKEN_RANKING_MAX_OFFSET: 2_000_000,
    TokenRankingReadError: MockTokenRankingReadError,
    getPopularTokenRankingSnapshot: (...args: unknown[]) =>
      mockGetPopularTokenRankingSnapshot(...args),
    getTokenTraderRankingSnapshot: (...args: unknown[]) =>
      mockGetTokenTraderRankingSnapshot(...args),
  }
})

import { NextRequest } from 'next/server'
import { GET } from '../route'
import { TokenRankingReadError } from '@/lib/rankings/token-ranking-snapshot'
import { RateLimitPresets } from '@/lib/utils/rate-limit'

const PRIVATE_NO_STORE = 'private, no-store, max-age=0, must-revalidate'
const supabase = { rpc: jest.fn() }

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/rankings/by-token${query}`)
}

function expectPrivateNoStore(response: { headers: Headers }): void {
  expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
  expect(response.headers.get('cache-control')).not.toMatch(/\bpublic\b|s-maxage/i)
}

function rankingError(
  kind: ConstructorParameters<typeof TokenRankingReadError>[0],
  options: {
    databaseCode?: string
    details?: string
    currentGeneration?: string
  } = {}
): TokenRankingReadError {
  return new TokenRankingReadError(
    kind,
    `test ${kind}`,
    options.databaseCode,
    options.details,
    options.currentGeneration
  )
}

describe('GET /api/rankings/by-token', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetSupabaseAdmin.mockReturnValue(supabase)
    mockGetTokenTraderRankingSnapshot.mockResolvedValue({
      contract: 'token-ranking-page@1',
      generation: '41',
      token: 'BTC',
      traders: [],
    })
    mockGetPopularTokenRankingSnapshot.mockResolvedValue({
      contract: 'popular-token-page@1',
      generation: '41',
      tokens: [],
    })
  })

  it('uses the read rate-limit policy before serving a request', async () => {
    const incoming = request('?token=BTC')

    const response = await GET(incoming)

    expect(response.status).toBe(200)
    expect(mockCheckRateLimit).toHaveBeenCalledWith(incoming, RateLimitPresets.read)
    expectPrivateNoStore(response)
  })

  it.each([
    ['missing token', ''],
    ['unsupported action', '?action=delete&token=BTC'],
    ['invalid token', '?token=BTC-USD'],
    ['numeric-only token', '?token=107'],
    ['invalid period', '?token=BTC&period=1D'],
    ['zero generation', '?token=BTC&generation=0'],
    ['leading-zero generation', '?token=BTC&generation=041'],
    ['generation above the safe contract maximum', '?token=BTC&generation=9007199254740001'],
    ['zero limit', '?token=BTC&limit=0'],
    ['empty limit', '?token=BTC&limit='],
    ['leading-zero limit', '?token=BTC&limit=050'],
    ['exponential limit', '?token=BTC&limit=5e1'],
    ['fractional limit', '?token=BTC&limit=1.5'],
    ['limit above maximum', '?token=BTC&limit=201'],
    ['negative offset', '?token=BTC&offset=-1'],
    ['leading-zero offset', '?token=BTC&offset=01'],
    ['offset above maximum', '?token=BTC&offset=2000001'],
  ])('rejects %s strictly', async (_case, query) => {
    const response = await GET(request(query))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: 'Invalid parameters',
        code: 'TOKEN_RANKING_INVALID_REQUEST',
      })
    )
    expectPrivateNoStore(response)
    expect(mockGetTokenTraderRankingSnapshot).not.toHaveBeenCalled()
    expect(mockGetPopularTokenRankingSnapshot).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown detail parameter', '?token=BTC&sort=roi'],
    ['duplicate detail token', '?token=BTC&token=ETH'],
    ['duplicate detail generation', '?token=BTC&generation=40&generation=41'],
    ['unknown popular parameter', '?action=popular-tokens&token=BTC'],
    ['duplicate popular action', '?action=popular-tokens&action=popular-tokens'],
    ['duplicate popular generation', '?action=popular-tokens&generation=40&generation=41'],
  ])('rejects an %s before calling the snapshot service', async (_case, query) => {
    const response = await GET(request(query))

    expect(response.status).toBe(400)
    expectPrivateNoStore(response)
    expect(mockGetTokenTraderRankingSnapshot).not.toHaveBeenCalled()
    expect(mockGetPopularTokenRankingSnapshot).not.toHaveBeenCalled()
  })

  it('normalizes detail parameters and passes the pinned generation to the snapshot service', async () => {
    const response = await GET(request('?token=btc&period=7d&limit=25&offset=50&generation=41'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(
      expect.objectContaining({ contract: 'token-ranking-page@1', generation: '41' })
    )
    expect(mockGetTokenTraderRankingSnapshot).toHaveBeenCalledWith(
      supabase,
      {
        token: 'BTC',
        period: '7D',
        limit: 25,
        offset: 50,
        generation: '41',
      },
      expect.objectContaining({ signal: expect.any(Object) })
    )
    expectPrivateNoStore(response)
  })

  it('passes the pinned generation through for popular tokens', async () => {
    const response = await GET(request('?action=popular-tokens&generation=41'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(
      expect.objectContaining({ contract: 'popular-token-page@1', generation: '41' })
    )
    expect(mockGetPopularTokenRankingSnapshot).toHaveBeenCalledWith(
      supabase,
      { generation: '41' },
      expect.objectContaining({ signal: expect.any(Object) })
    )
    expect(mockGetTokenTraderRankingSnapshot).not.toHaveBeenCalled()
    expectPrivateNoStore(response)
  })

  it('returns 409 with the current generation when a pinned generation changed', async () => {
    mockGetTokenTraderRankingSnapshot.mockRejectedValue(
      rankingError('generation_changed', {
        databaseCode: '40001',
        details: '42',
        currentGeneration: '42',
      })
    )

    const response = await GET(request('?token=BTC&generation=41'))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Token ranking generation changed',
      code: 'TOKEN_RANKING_GENERATION_CHANGED',
      current_generation: '42',
    })
    expectPrivateNoStore(response)
  })

  it('maps a 55000 not-published read to a long-lived verification hold', async () => {
    mockGetPopularTokenRankingSnapshot.mockRejectedValue(
      rankingError('not_published', { databaseCode: '55000' })
    )

    const response = await GET(request('?action=popular-tokens'))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('3600')
    expect(await response.json()).toEqual({
      error: 'Token rankings are withheld while verified authority snapshots are rebuilt',
      code: 'TOKEN_RANKING_NOT_PUBLISHED',
    })
    expectPrivateNoStore(response)
  })

  it('maps a repeatedly moving publication to retryable 503', async () => {
    mockGetTokenTraderRankingSnapshot.mockRejectedValue(
      rankingError('publication_busy', { currentGeneration: '43' })
    )

    const response = await GET(request('?token=ETH'))

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.json()).toEqual({
      error: 'Token ranking publication is changing; retry shortly',
      code: 'TOKEN_RANKING_PUBLICATION_BUSY',
      current_generation: '43',
    })
    expectPrivateNoStore(response)
  })

  it('maps a snapshot contract violation to 502', async () => {
    mockGetTokenTraderRankingSnapshot.mockRejectedValue(rankingError('contract'))

    const response = await GET(request('?token=SOL'))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'Token ranking publication contract is unavailable',
      code: 'TOKEN_RANKING_CONTRACT_INVALID',
    })
    expectPrivateNoStore(response)
  })

  it.each([
    [
      'ordinary database failure',
      'XX000',
      503,
      'TOKEN_RANKING_UNAVAILABLE',
      'Token rankings are temporarily unavailable',
    ],
    ['statement timeout', '57014', 504, 'TOKEN_RANKING_TIMEOUT', 'Token ranking request timed out'],
  ])(
    'maps %s to the expected retryable response',
    async (_case, databaseCode, status, code, error) => {
      mockGetTokenTraderRankingSnapshot.mockRejectedValue(
        rankingError('database', { databaseCode })
      )

      const response = await GET(request('?token=BTC'))

      expect(response.status).toBe(status)
      expect(response.headers.get('retry-after')).toBe('1')
      expect(await response.json()).toEqual({ error, code })
      expectPrivateNoStore(response)
    }
  )

  it('fails closed with a private 503 for an unclassified service exception', async () => {
    mockGetTokenTraderRankingSnapshot.mockRejectedValue(new Error('unexpected failure'))

    const response = await GET(request('?token=BTC'))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Token rankings are temporarily unavailable',
      code: 'TOKEN_RANKING_UNAVAILABLE',
    })
    expectPrivateNoStore(response)
  })
})
