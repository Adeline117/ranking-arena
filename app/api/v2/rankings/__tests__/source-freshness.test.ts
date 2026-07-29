/**
 * @jest-environment node
 */

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Headers()

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockFrom = jest.fn()
jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: unknown) => unknown) => (request: { url: string }) =>
    handler({ request }),
}))

const mockGetOrSetWithLock = jest.fn()
const mockDel = jest.fn()
jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
  del: (...args: unknown[]) => mockDel(...args),
}))

jest.mock('@/lib/supabase/read-replica', () => ({
  getReadReplica: () => ({ from: mockFrom }),
}))

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
  sealedRankingPublicationIdentity: (publication: unknown) => JSON.stringify(publication),
}))

const SCORE_COHORT_ID = '11111111-1111-4111-8111-111111111111'
let currentCohortId = SCORE_COHORT_ID
const EXPECTED_SOURCE_AS_OF = '2026-07-16T09:00:00.000Z'
let mockSourceAsOf = '2026-07-16T09:00:00.000000Z'
let mockPublishedRankCount = 1

function sealedPublication(season: string, source: string, scoreCohortId = currentCohortId) {
  return {
    state: 'sealed' as const,
    season,
    scoreCohortId,
    proofs: [
      {
        season_id: season,
        source,
        source_as_of: mockSourceAsOf,
        recorded_at: '2026-07-18T11:59:30.000000Z',
        score_cohort_id: scoreCohortId,
        rank_mutation_seq: 7,
        current_mutation_seq: 7,
        published_rank_count: mockPublishedRankCount,
        published_identity_sha256: 'a'.repeat(64),
        is_sealed: true as const,
      },
    ],
  }
}

function sealedCacheEntry(value: unknown, scoreCohortId = currentCohortId) {
  const publication = sealedPublication('90D', 'binance_futures', scoreCohortId)
  return {
    contract: 'sealed-ranking-cache@1',
    season: '90D',
    publicationIdentity: JSON.stringify(publication),
    publication,
    cachedAt: '2026-07-18T11:59:40.000Z',
    value,
  }
}

function queryResult(data: unknown[], error: unknown = null, count: number | null = null) {
  const result = { data, error, count }
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        const key = String(property)
        methods[key] ??= jest.fn(() => proxy)
        return methods[key]
      },
    }
  )
  return proxy
}

import { GET } from '../route'
import { EXCHANGE_SLUG_ALIASES, PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { RETIRED_SOURCES } from '@/lib/constants/retired-sources'
import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'

describe('GET /api/v2/rankings source freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    currentCohortId = SCORE_COHORT_ID
    mockSourceAsOf = '2026-07-16T09:00:00.000000Z'
    mockPublishedRankCount = 1
    mockDel.mockResolvedValue(true)
    mockGetOrSetWithLock.mockImplementation(
      async (_key: string, fetcher: () => Promise<unknown>) => await fetcher()
    )
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _client: unknown,
        input: { season: string; sources: string[] },
        reader: (publication: ReturnType<typeof sealedPublication>) => Promise<unknown>
      ) => {
        const publication = sealedPublication(input.season, input.sources[0])
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses the requested platform watermark instead of its recent score compute time', async () => {
    let rankingQuery: ReturnType<typeof queryResult> | undefined
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = queryResult(
          [
            {
              source: 'binance_futures',
              source_trader_id: 'trader',
              source_type: 'futures',
              handle: 'Trader',
              roi: 10,
              pnl: 100,
              arena_score: 90,
              rank: 1,
              computed_at: '2026-07-18T11:59:00.000Z',
              season_id: '90D',
            },
          ],
          null,
          1
        )
        return rankingQuery
      }
      throw new Error(`unexpected table ${table}`)
    })

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures',
    } as never)
    const body = await response.json()

    expect(body.meta).toEqual(
      expect.objectContaining({
        updated_at: EXPECTED_SOURCE_AS_OF,
        total_count: 1,
        staleness_seconds: 51 * 3600,
        is_stale: true,
      })
    )
    expect(body.traders[0]).toEqual(
      expect.objectContaining({
        updated_at: EXPECTED_SOURCE_AS_OF,
        is_stale: true,
        computed_at: '2026-07-18T11:59:00.000Z',
      })
    )
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      expect.any(Object),
      { season: '90D', sources: ['binance_futures'] },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(rankingQuery?.filter).toHaveBeenCalledWith('rank_publication_id', 'eq', SCORE_COHORT_ID)
    expect(rankingQuery?.in).toHaveBeenCalledWith('source', ['binance_futures'])
    expect(rankingQuery?.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
    )
  })

  it('rejects a generic polluted cache hit and refills a source-scoped sealed entry', async () => {
    mockPublishedRankCount = 2
    const polluted = {
      traders: [
        { source: 'binance_futures', source_trader_id: 'first' },
        { source: 'okx_web3_solana', source_trader_id: 'blocked' },
        { source: 'binance_futures', source_trader_id: 'last' },
      ],
      meta: {
        platform: 'binance_futures',
        market_type: 'futures',
        window: '90d',
        total_count: 999,
        updated_at: 'blocked-aggregate-watermark',
        staleness_seconds: 1,
        is_stale: false,
        source_freshness: [
          { source: 'binance_futures', updated_at: 'safe' },
          { source: 'okx_web3_solana', updated_at: 'blocked' },
        ],
      },
    }
    mockGetOrSetWithLock
      .mockResolvedValueOnce(polluted)
      .mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) => await fetcher())
    mockFrom.mockImplementation(() =>
      queryResult([
        {
          source: 'binance_futures',
          source_trader_id: 'first',
          source_type: 'futures',
          arena_score: 90,
          rank: 1,
        },
        {
          source: 'binance_futures',
          source_trader_id: 'last',
          source_type: 'futures',
          arena_score: 80,
          rank: 2,
        },
      ])
    )

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&market_type=futures',
    } as never)
    const body = await response.json()

    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^public-rank-policy-v4:v2-rankings:sealed-v4:binance_futures:90d:futures:/
      ),
      expect.any(Function),
      expect.any(Object)
    )
    expect(mockGetOrSetWithLock).toHaveBeenCalledTimes(2)
    expect(mockDel).toHaveBeenCalledWith(
      expect.stringMatching(/^public-rank-policy-v4:v2-rankings:sealed-v4:/)
    )
    expect(body.traders.map((trader: { trader_key: string }) => trader.trader_key)).toEqual([
      'first',
      'last',
    ])
    expect(body.meta.total_count).toBe(2)
    expect(body.meta.updated_at).toBe(EXPECTED_SOURCE_AS_OF)
    expect(body.meta.staleness_seconds).toBe(51 * 3600)
    expect(body.meta.is_stale).toBe(true)
    expect(body.meta.source_freshness).toEqual([
      {
        source: 'binance_futures',
        updated_at: EXPECTED_SOURCE_AS_OF,
        is_stale: true,
        age_seconds: 51 * 3600,
      },
    ])
  })

  it('evicts a sealed page after the platform authority advances to another cohort', async () => {
    const cachedValue = {
      traders: [{ platform: 'binance_futures', trader_key: 'old-cache-row' }],
      meta: {
        platform: 'binance_futures',
        market_type: 'futures',
        window: '90d',
        total_count: 1,
        updated_at: EXPECTED_SOURCE_AS_OF,
        staleness_seconds: 0,
        is_stale: false,
        source_freshness: [],
      },
    }
    mockGetOrSetWithLock
      .mockResolvedValueOnce(sealedCacheEntry(cachedValue, '22222222-2222-4222-8222-222222222222'))
      .mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) => fetcher())
    mockFrom.mockReturnValue(queryResult([]))

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures',
    } as never)
    const body = await response.json()

    expect(body.traders).toEqual([])
    expect(JSON.stringify(body)).not.toContain('old-cache-row')
    expect(mockDel).toHaveBeenCalledWith(expect.stringContaining('v2-rankings:sealed-v4:'))
    expect(mockGetOrSetWithLock).toHaveBeenCalledTimes(2)
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(3)
  })

  it('applies a zero-valued alpha proxy filter and returns its exact cohort-bound count', async () => {
    const rankingQuery = queryResult([], null, 3)
    mockFrom.mockReturnValue(rankingQuery)

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&min_alpha=0',
    } as never)
    const body = await response.json()

    expect(rankingQuery.gte).toHaveBeenCalledWith('arena_score', 0)
    expect(body.meta.total_count).toBe(3)
  })

  it('fails closed when a filtered cohort query omits its exact count', async () => {
    mockFrom.mockReturnValue(queryResult([], null, null))

    await expect(
      GET({
        url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&min_pnl=0',
      } as never)
    ).rejects.toThrow('Filtered database query returned no exact count')
  })

  it.each(PUBLIC_ACTIVE_RANKING_SOURCES)(
    'accepts canonical active platform %s at the v2 public API boundary',
    async (platform) => {
      mockFrom.mockImplementation(() => queryResult([]))

      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)

      expect(response.status).toBe(200)
    }
  )

  it.each(PUBLIC_RANKING_QUARANTINED_SOURCES)(
    'returns 200 empty for quarantined platform %s without DB or cache access',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.traders).toEqual([])
      expect(body.meta).toEqual(expect.objectContaining({ platform, total_count: 0 }))
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each([...RETIRED_SOURCES])(
    'rejects retired platform %s before cache or database access',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each(Object.keys(EXCHANGE_SLUG_ALIASES))(
    'rejects non-canonical platform alias %s consistently',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${encodeURIComponent(platform)}`,
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('rejects an unknown market type before cache or database access', async () => {
    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&market_type=unknown',
    } as never)

    expect(response.status).toBe(400)
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('continues to reject unknown platforms', async () => {
    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=fake_exchange',
    } as never)

    expect(response.status).toBe(400)
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
