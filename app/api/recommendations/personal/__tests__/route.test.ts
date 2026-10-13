jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    headers: Headers

    constructor(body: unknown, init: { headers?: HeadersInit } = {}) {
      this._body = body
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { headers?: HeadersInit }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockTieredGetOrSet = jest.fn()
const mockGetCandidates = jest.fn()
const mockMaterialize = jest.fn()

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))
jest.mock('@/lib/recommendations/personal', () => ({
  getPersonalRecommendationCandidates: (...args: unknown[]) => mockGetCandidates(...args),
  materializePersonalRecommendations: (...args: unknown[]) => mockMaterialize(...args),
}))
jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: { user: { id: string }; request: Request }) => unknown) =>
    (request: Request) =>
      handler({ user: { id: 'user-1' }, request }),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
}))

import { GET } from '../route'

describe('GET /api/recommendations/personal cache boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMaterialize.mockResolvedValue({
      recommendations: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_rank_unavailable',
    })
  })

  it('re-materializes current public metrics on a cache hit instead of returning cached metrics', async () => {
    const legacyShapedCacheValue = [
      {
        source: 'bybit',
        source_trader_id: 'current-trader',
        reason: 'top_performer',
        arena_score: 999,
        roi: 999,
        pnl: 999,
      },
    ]
    mockTieredGetOrSet.mockResolvedValue(legacyShapedCacheValue)
    mockMaterialize.mockResolvedValue({
      recommendations: [
        {
          source: 'bybit',
          source_trader_id: 'current-trader',
          handle: 'Current',
          avatar_url: null,
          arena_score: 72,
          roi: 4,
          pnl: 5,
          win_rate: 55,
          reason: 'top_performer',
          reason_detail: 'Top arena score on bybit',
        },
      ],
      rankingVisibility: 'verified',
      rankingVisibilityReason: null,
    })

    const response = await GET(
      new Request('https://arena.test/api/recommendations/personal?limit=1') as never
    )
    const body = await response.json()

    expect(mockGetCandidates).not.toHaveBeenCalled()
    expect(mockMaterialize).toHaveBeenCalledWith(legacyShapedCacheValue, 1)
    expect(body).toEqual({
      success: true,
      data: {
        data: [
          {
            source: 'bybit',
            source_trader_id: 'current-trader',
            handle: 'Current',
            avatar_url: null,
            arena_score: 72,
            roi: 4,
            pnl: 5,
            win_rate: 55,
            reason: 'top_performer',
            reason_detail: 'Top arena score on bybit',
          },
        ],
        meta: { count: 1, userId: 'user-1' },
        ranking_visibility: 'verified',
      },
    })
    expect(JSON.stringify(body)).not.toContain('999')
    expect(response.headers.get('Cache-Control')).toBe(
      'private, no-store, max-age=0, must-revalidate'
    )
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('caches only metric-free candidates and exposes an explicit partial/unknown state', async () => {
    const candidates = [
      {
        source: 'bybit',
        source_trader_id: 'candidate-1',
        reason: 'top_performer',
      },
    ]
    mockTieredGetOrSet.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) =>
      fetcher()
    )
    mockGetCandidates.mockResolvedValue(candidates)
    mockMaterialize.mockResolvedValue({
      recommendations: [],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'cached_candidate_unverified',
    })

    const response = await GET(
      new Request('https://arena.test/api/recommendations/personal?limit=4') as never
    )

    expect(mockTieredGetOrSet).toHaveBeenCalledWith(
      'recommendations:personal:v2:candidates:user-1',
      expect.any(Function),
      'hot',
      ['recommendations', 'user:user-1']
    )
    expect(mockGetCandidates).toHaveBeenCalledWith('user-1', 50)
    expect(mockMaterialize).toHaveBeenCalledWith(candidates, 4)
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        data: [],
        meta: { count: 0, userId: 'user-1' },
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'cached_candidate_unverified',
        ranking_visibility_reasons: ['cached_candidate_unverified'],
      },
    })
  })
})
