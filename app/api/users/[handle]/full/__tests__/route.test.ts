import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private readonly body: unknown
    private readonly values = new Map<string, string>()

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body
      this.status = init.status ?? 200
      for (const [name, value] of Object.entries(init.headers ?? {})) this.values.set(name, value)
    }

    get headers() {
      return {
        get: (name: string) => this.values.get(name) ?? null,
        set: (name: string, value: string) => this.values.set(name, value),
      }
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextRequest: class MockNextRequest {}, NextResponse: MockNextResponse }
})

const mockGetSupabaseAdmin = jest.fn()
const mockRateLimit = jest.fn()
const mockReadAudience = jest.fn()
const mockFetchPublicProfileRankingRows = jest.fn()
const mockFetchSimilarTraders = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockRateLimit(...args),
  RateLimitPresets: { read: { name: 'read' } },
}))
jest.mock('@/lib/profile/public-audience', () => ({
  readPublicProfileAudienceByHandle: (...args: unknown[]) => mockReadAudience(...args),
}))
jest.mock('@/lib/data/trader/public-profile-ranking', () => ({
  fetchPublicProfileRankingRows: (...args: unknown[]) => mockFetchPublicProfileRankingRows(...args),
  PUBLIC_PROFILE_RANKING_PERIODS: ['7D', '30D', '90D'],
}))
jest.mock('@/lib/data/trader/similar', () => ({
  fetchSimilarTraders: (...args: unknown[]) => mockFetchSimilarTraders(...args),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { GET } from '../route'

function publishedRow() {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    season_id: '90D',
    rank: 1,
    arena_score: 88,
    roi: 12.5,
    pnl: 5000,
    win_rate: 62,
    max_drawdown: 9,
    trades_count: 42,
    followers: 12,
    copiers: 7,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: '2026-08-17T00:00:00.000Z',
  }
}

function similarRow() {
  return {
    platform: 'binance_futures',
    traderKey: 'similar-1',
    handle: 'similar',
    avatarUrl: null,
    followers: 2,
    copiers: 1,
    tradesCount: 8,
    rank: 2,
    arenaScore: 80,
    roi: 9,
    pnl: 300,
    winRate: 60,
    maxDrawdown: 8,
  }
}

function context() {
  return { params: Promise.resolve({ handle: 'alice' }) }
}

function traderSourceQuery(data: unknown[] = []) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    limit: jest.fn().mockResolvedValue({ data, error: null }),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

describe('GET /api/users/[handle]/full public ranking authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRateLimit.mockResolvedValue(null)
    mockGetSupabaseAdmin.mockReturnValue({
      from: jest.fn((relation: string) =>
        relation === 'trader_sources'
          ? traderSourceQuery([
              {
                source: 'binance_futures',
                source_trader_id: 'trader-1',
                handle: 'alice',
                avatar_url: 'https://example.test/avatar.png',
              },
            ])
          : traderSourceQuery()
      ),
    })
    mockReadAudience.mockResolvedValue({ status: 'unregistered' })
    mockFetchSimilarTraders.mockResolvedValue([similarRow()])
  })

  it('re-reads the sealed cohort and cannot replay a ranked cache payload after proof disappears', async () => {
    mockFetchPublicProfileRankingRows
      .mockResolvedValueOnce({
        rows: [publishedRow()],
        rankingVisibility: 'verified',
        rankingVisibilityReason: null,
      })
      .mockResolvedValueOnce({
        rows: [],
        rankingVisibility: 'unknown',
        rankingVisibilityReason: 'public_cohort_unavailable',
      })

    const first = await GET({} as never, context())
    const firstBody = await first.json()
    const second = await GET({} as never, context())
    const secondBody = await second.json()

    expect(mockFetchPublicProfileRankingRows).toHaveBeenCalledTimes(2)
    expect(firstBody).toMatchObject({
      ranking_visibility: 'verified',
      profile: { followers: 12, copiers: 7 },
      performance: { rank: 1, roi_90d: 12.5, pnl: 5000, arena_score: 88 },
      similarTraders: [{ id: 'similar-1', rank: 2, roi_90d: 9 }],
      portfolio: [],
      _errors: { portfolio: 'legacy_metric_publication_unavailable' },
    })
    expect(secondBody).toMatchObject({
      ranking_visibility: 'unknown',
      ranking_visibility_reason: 'public_cohort_unavailable',
      profile: { followers: null, copiers: null },
      performance: null,
      stats: null,
      similarTraders: [],
    })
    expect(second.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(second.headers.get('CDN-Cache-Control')).toBe('no-store')
  })

  it('uses a known app-social count, including zero, without falling back to raw trader counts', async () => {
    const subscriptionQuery = {
      select: jest.fn(),
      eq: jest.fn(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: {
          subscription_tier: 'pro',
          show_pro_badge: false,
          follower_count: 0,
          following_count: 0,
        },
        error: null,
      }),
    }
    subscriptionQuery.select.mockReturnValue(subscriptionQuery)
    subscriptionQuery.eq.mockReturnValue(subscriptionQuery)
    mockGetSupabaseAdmin.mockReturnValue({
      from: jest.fn((relation: string) =>
        relation === 'user_profiles'
          ? subscriptionQuery
          : relation === 'trader_sources'
            ? traderSourceQuery([
                {
                  source: 'binance_futures',
                  source_trader_id: 'trader-1',
                  handle: 'alice',
                  avatar_url: null,
                },
              ])
            : traderSourceQuery()
      ),
    })
    mockReadAudience.mockResolvedValue({
      status: 'active',
      profile: { id: 'user-1' },
    })
    mockFetchPublicProfileRankingRows.mockResolvedValue({
      rows: [publishedRow()],
      rankingVisibility: 'verified',
      rankingVisibilityReason: null,
    })

    const response = await GET({} as never, context())

    await expect(response.json()).resolves.toMatchObject({
      profile: {
        followers: 0,
        following: 0,
        copiers: 7,
        subscription_tier: 'pro',
        show_pro_badge: false,
      },
    })
  })

  it('fails a duplicate source identity closed before it can read a public ranking cohort', async () => {
    mockGetSupabaseAdmin.mockReturnValue({
      from: jest.fn((relation: string) =>
        relation === 'trader_sources'
          ? traderSourceQuery([
              {
                source: 'binance_futures',
                source_trader_id: 'trader-1',
                handle: 'alice',
                avatar_url: null,
              },
              {
                source: 'bybit',
                source_trader_id: 'trader-2',
                handle: 'alice',
                avatar_url: null,
              },
            ])
          : traderSourceQuery()
      ),
    })

    const response = await GET({} as never, context())

    expect(response.status).toBe(404)
    expect(mockFetchPublicProfileRankingRows).not.toHaveBeenCalled()
    expect(mockFetchSimilarTraders).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it('contains no aggregate ranking cache or direct raw leaderboard reader', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/users/[handle]/full/route.ts'), 'utf8')

    expect(source).toContain('fetchPublicProfileRankingRows(')
    expect(source).toContain('sanitizePublicFullSimilarTraders(')
    expect(source).not.toContain('getOrSetWithLock(')
    expect(source).not.toContain("from('leaderboard_ranks')")
    expect(source).not.toContain('getTraderPerformance(')
    expect(source).not.toContain('getTraderStats(')
    expect(source).not.toContain('getTraderPortfolio(')
    expect(source).not.toContain('getTraderByHandle(')
    expect(source).not.toContain("from('trader_portfolio')")
    expect(source).toContain('legacy_metric_publication_unavailable')
  })
})
