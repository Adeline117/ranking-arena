/**
 * @jest-environment node
 */

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Headers

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: HeadersInit } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(data: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))

const mockCheckRateLimit = jest.fn()
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: {} },
}))

const mockTieredGetOrSet = jest.fn()
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))

const mockReadSealedRankingAuthorityGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
  sealedRankingPublicationIdentity: (publication: unknown) => JSON.stringify(publication),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}))

import { GET } from '../route'

const publication = {
  state: 'sealed' as const,
  season: '90D' as const,
  scoreCohortId: '11111111-1111-4111-8111-111111111111',
  proofs: [{ source: 'bybit' }, { source: 'hyperliquid' }, { source: 'okx_web3_solana' }],
}

describe('GET /api/rankings/platform-stats', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockTieredGetOrSet.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) =>
      fetcher()
    )
    mockReadSealedRankingAuthorityGeneration.mockImplementation(
      async (
        _client: unknown,
        _season: string,
        reader: (proof: typeof publication) => Promise<unknown>
      ) => ({
        value: await reader(publication),
        publication,
        publicationIdentity: JSON.stringify(publication),
      })
    )
  })

  it('aggregates only the sealed cohort and live public source scope', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          platform: 'hyperliquid',
          trader_count: '12',
          avg_score: '81.25',
          avg_roi: '20.5',
          median_score: '80',
          avg_win_rate: '55.5',
        },
      ],
      error: null,
    })

    const response = await GET({} as never)
    const body = await response.json()

    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ rpc: mockRpc }),
      '90D',
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(mockRpc).toHaveBeenCalledWith('get_public_platform_stats', {
      p_season_id: '90D',
      p_score_cohort_id: publication.scoreCohortId,
      p_allowed_sources: ['bybit', 'hyperliquid'],
    })
    expect(mockRpc).not.toHaveBeenCalledWith('get_platform_stats', expect.anything())
    expect(mockTieredGetOrSet).toHaveBeenCalledWith(
      expect.stringMatching(/rankings:platform-stats:sealed-v2:/),
      expect.any(Function),
      'cold',
      ['rankings', 'platform-stats']
    )
    expect(body).toEqual({
      platforms: [
        {
          platform: 'hyperliquid',
          traderCount: 12,
          avgScore: 81.25,
          avgRoi: 20.5,
          medianScore: 80,
          avgWinRate: 55.5,
        },
      ],
      season: '90D',
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('fails closed if the aggregate RPC escapes publication authority', async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          platform: 'mexc',
          trader_count: 1,
          avg_score: 80,
          avg_roi: 20,
          median_score: 80,
          avg_win_rate: 50,
        },
      ],
      error: null,
    })

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' })
  })
})
