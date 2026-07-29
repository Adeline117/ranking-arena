const mockRequireAuth = jest.fn()
const mockSuccess = jest.fn((data: unknown) => ({
  status: 200,
  json: async () => data,
}))
const mockError = jest.fn((message: string, status: number) => ({
  status,
  json: async () => ({ error: message }),
}))
const mockHandleError = jest.fn((error: unknown) => ({
  status: 500,
  json: async () => ({ error: error instanceof Error ? error.message : String(error) }),
}))
const mockCheckRateLimit = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  success: (...args: unknown[]) => mockSuccess(...args),
  error: (...args: unknown[]) => mockError(...args),
  handleError: (...args: unknown[]) => mockHandleError(...args),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: {} },
}))

const mockResolveTrader = jest.fn()
jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

jest.mock('@/lib/types/premium', () => ({
  hasFeatureAccess: () => true,
}))

const mockGetCanonicalSubscriptionTier = jest.fn()
jest.mock('@/lib/premium/server-entitlement', () => ({
  getCanonicalSubscriptionTier: (...args: unknown[]) => mockGetCanonicalSubscriptionTier(...args),
}))

const mockReadSealedRankingAuthorityGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
}))

function queryResult(result: Record<string, unknown>, maybeSingle = false) {
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        const key = String(property)
        if (key === 'then') {
          return (
            resolve: (value: Record<string, unknown>) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        if (key === 'maybeSingle' && maybeSingle) {
          methods[key] ??= jest.fn().mockResolvedValue(result)
          return methods[key]
        }
        methods[key] ??= jest.fn(() => proxy)
        return methods[key]
      },
    }
  )
  return { proxy, methods }
}

import { GET } from '../route'

const TEST_AUTHORITY_SOURCES = ['binance_futures', 'binance_spot', 'bybit', 'hyperliquid']

describe('GET /api/traders/[handle]/percentile sealed category cohort', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockRequireAuth.mockResolvedValue({ id: 'user-1' })
    mockGetCanonicalSubscriptionTier.mockResolvedValue('pro')
    mockResolveTrader.mockResolvedValue({
      platform: 'bybit',
      traderKey: 'trader-1',
      handle: 'Trader',
      avatarUrl: null,
    })
    mockReadSealedRankingAuthorityGeneration.mockImplementation(
      async (
        _supabase: unknown,
        season: '90D',
        reader: (publication: { scoreCohortId: string }) => Promise<unknown>
      ) => {
        const publication = {
          state: 'sealed' as const,
          season,
          scoreCohortId: '11111111-1111-4111-8111-111111111111',
          proofs: TEST_AUTHORITY_SOURCES.map((source) => ({ source })),
        }
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
  })

  it('uses the central futures mapping and binds every count to one cohort', async () => {
    const trader = queryResult(
      {
        data: {
          arena_score: 90,
          return_score: 80,
          drawdown_score: 70,
          stability_score: 60,
        },
        error: null,
      },
      true
    )
    const countValues = [80, 100, 70, 100, 60, 100, 50, 100]
    const counts = countValues.map((count) => queryResult({ data: null, count, error: null }))
    let leaderboardReads = 0
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        leaderboardReads += 1
        return leaderboardReads === 1 ? trader.proxy : counts[leaderboardReads - 2].proxy
      }
      throw new Error(`unexpected table: ${table}`)
    })

    const response = await GET({} as never, {
      params: Promise.resolve({ handle: 'Trader' }),
    })
    const body = await response.json()
    const futuresSources = ['binance_futures', 'bybit']

    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledWith(
      expect.anything(),
      '90D',
      expect.any(Function),
      { timeoutMs: 20_000 }
    )
    expect(trader.methods.filter).toHaveBeenCalledWith(
      'rank_publication_id',
      'eq',
      '11111111-1111-4111-8111-111111111111'
    )
    for (const count of counts) {
      expect(count.methods.in).toHaveBeenCalledWith('source', futuresSources)
      expect(count.methods.filter).toHaveBeenCalledWith(
        'rank_publication_id',
        'eq',
        '11111111-1111-4111-8111-111111111111'
      )
      expect(count.methods.ilike).toBeUndefined()
    }
    expect(body).toEqual({
      percentile: {
        overall: 80,
        return: 70,
        drawdown: 60,
        stability: 50,
        totalInCategory: 100,
      },
      category: 'futures',
    })
  })
})
