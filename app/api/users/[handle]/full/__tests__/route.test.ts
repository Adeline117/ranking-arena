jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockFrom = jest.fn()
const mockResolveTrader = jest.fn()
const mockGetTraderDetail = jest.fn()
const mockToTraderPageData = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockReadPublicProfileAudienceByHandle = jest.fn()
const mockReadSealedRankingGeneration = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
  getTraderDetail: (...args: unknown[]) => mockGetTraderDetail(...args),
  toTraderPageData: (...args: unknown[]) => mockToTraderPageData(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: {} },
}))

jest.mock('@/lib/profile/public-audience', () => ({
  readPublicProfileAudienceByHandle: (...args: unknown[]) =>
    mockReadPublicProfileAudienceByHandle(...args),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

type QueryEnvelope = {
  data: unknown
  error: { message: string } | null
}

function queryResult(data: unknown, error: QueryEnvelope['error'] = null) {
  const result: QueryEnvelope = { data, error }
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: QueryEnvelope) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        const key = String(property)
        methods[key] ??= jest.fn(() => proxy)
        return methods[key]
      },
    }
  )
  return { proxy, methods }
}

import { GET } from '../route'

describe('GET /api/users/:handle/full authority boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockResolveTrader.mockResolvedValue({
      handle: 'Trader One',
      traderKey: 'trader-1',
      platform: 'binance_futures',
      avatarUrl: null,
    })
    mockReadPublicProfileAudienceByHandle.mockResolvedValue({
      status: 'active',
      profile: { id: 'user-1' },
    })
    mockGetTraderDetail.mockResolvedValue({ trader: { source_trader_id: 'trader-1' } })
    mockToTraderPageData.mockReturnValue({
      performance: { roi_90d: 12 },
      stats: { additionalStats: {} },
      portfolio: [],
    })
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _supabase: unknown,
        input: { season: '90D'; sources: string[] },
        reader: (publication: {
          state: 'sealed'
          season: '90D'
          scoreCohortId: string
          proofs: Array<Record<string, unknown>>
        }) => Promise<unknown>
      ) => {
        const publication = {
          state: 'sealed' as const,
          season: input.season,
          scoreCohortId: '11111111-1111-4111-8111-111111111111',
          proofs: [],
        }
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
  })

  it('reads current subscription state and binds similar traders to the sealed cohort', async () => {
    const subscription = queryResult({
      subscription_tier: 'pro',
      show_pro_badge: false,
      follower_count: 12,
      following_count: 8,
    })
    const similar = queryResult([
      {
        source_trader_id: 'trader-2',
        handle: 'Peer',
        source: 'binance_futures',
        roi: 9,
        followers: 3,
        season_id: '90D',
      },
      {
        source_trader_id: 'trader-1',
        handle: 'Self leaked by backend',
        source: 'binance_futures',
        roi: 12,
        followers: 4,
        season_id: '90D',
      },
    ])
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return subscription.proxy
      if (table === 'leaderboard_ranks') return similar.proxy
      throw new Error(`unexpected table: ${table}`)
    })

    const response = await GET({} as never, {
      params: Promise.resolve({ handle: 'Trader%20One' }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(body.profile).toEqual(
      expect.objectContaining({
        followers: 12,
        following: 8,
        subscription_tier: 'pro',
        show_pro_badge: false,
      })
    )
    expect(
      body.similarTraders.map((row: { source_trader_id: string }) => row.source_trader_id)
    ).toEqual(['trader-2'])
    expect(mockGetTraderDetail).toHaveBeenCalledWith(expect.anything(), {
      platform: 'binance_futures',
      traderKey: 'trader-1',
    })
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      expect.anything(),
      { season: '90D', sources: ['binance_futures'] },
      expect.any(Function),
      { timeoutMs: 15_000 }
    )
    expect(similar.methods.filter).toHaveBeenCalledWith(
      'rank_publication_id',
      'eq',
      '11111111-1111-4111-8111-111111111111'
    )
    expect(similar.methods.neq).toHaveBeenCalledWith('source_trader_id', 'trader-1')
  })

  it('fails closed instead of downgrading to free when subscription lookup errors', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return queryResult(null, { message: 'subscription store unavailable' }).proxy
      }
      if (table === 'leaderboard_ranks') return queryResult([]).proxy
      throw new Error(`unexpected table: ${table}`)
    })

    const response = await GET({} as never, {
      params: Promise.resolve({ handle: 'Trader%20One' }),
    })
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ success: false, error: 'Internal server error' })
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[API] Error fetching user full data:',
      expect.objectContaining({
        message: expect.stringContaining('subscription profile query failed'),
      })
    )
  })

  it('fails closed when the sealed similar-trader query errors', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return queryResult({
          subscription_tier: 'free',
          show_pro_badge: true,
          follower_count: 4,
          following_count: 0,
        }).proxy
      }
      if (table === 'leaderboard_ranks') {
        return queryResult(null, { message: 'ranking read unavailable' }).proxy
      }
      throw new Error(`unexpected table: ${table}`)
    })

    const response = await GET({} as never, {
      params: Promise.resolve({ handle: 'Trader%20One' }),
    })

    expect(response.status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[API] Error fetching user full data:',
      expect.objectContaining({ message: expect.stringContaining('similar traders query failed') })
    )
  })

  it('never touches ranking storage for a quarantined source', async () => {
    mockResolveTrader.mockResolvedValue({
      handle: 'Quarantined',
      traderKey: 'trader-q',
      platform: 'okx_web3_solana',
      avatarUrl: null,
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return queryResult({
          subscription_tier: 'free',
          show_pro_badge: true,
          follower_count: 1,
          following_count: 0,
        }).proxy
      }
      throw new Error(`unexpected table: ${table}`)
    })

    const response = await GET({} as never, {
      params: Promise.resolve({ handle: 'Quarantined' }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.similarTraders).toEqual([])
    expect(body.performance).toBeNull()
    expect(body.stats).toBeNull()
    expect(mockGetTraderDetail).not.toHaveBeenCalled()
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
  })
})
