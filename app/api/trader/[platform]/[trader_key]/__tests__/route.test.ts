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

  return {
    NextResponse: MockNextResponse,
    after: (callback: () => unknown) => callback(),
  }
})

const mockFrom = jest.fn()
const mockReadSealedRankingGeneration = jest.fn()
const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic:
    (
      handler: (context: {
        supabase: { from: typeof mockFrom }
        request: unknown
      }) => Promise<unknown>
    ) =>
    (request: unknown) =>
      handler({ supabase: { from: mockFrom }, request }),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn() }),
}))

import { createHash } from 'node:crypto'

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

function installSuccessfulQueries() {
  const leaderboardQueries: Array<ReturnType<typeof queryResult>> = []
  const seasons = ['7D', '30D', '90D'] as const
  let leaderboardIndex = 0

  mockFrom.mockImplementation((table: string) => {
    if (table === 'trader_profiles_v2') return queryResult(null).proxy
    if (table === 'trader_timeseries') return queryResult([]).proxy
    if (table === 'refresh_jobs') return queryResult(null).proxy
    if (table === 'trader_equity_curve') return queryResult([]).proxy
    if (table === 'trader_asset_breakdown') return queryResult([]).proxy
    if (table === 'leaderboard_ranks') {
      const season = seasons[leaderboardIndex++]
      const query = queryResult([
        {
          source: 'binance_futures',
          source_trader_id: 'trader-1',
          season_id: season,
          handle: 'Sealed Trader',
          avatar_url: null,
          roi: 10,
          pnl: 20,
          win_rate: 75,
          max_drawdown: 5,
          trades_count: 3,
          followers: 4,
          arena_score: 80,
          rank: 2,
          computed_at: '2026-07-29T10:00:00Z',
        },
      ])
      leaderboardQueries.push(query)
      return query.proxy
    }
    throw new Error(`unexpected table: ${table}`)
  })

  return leaderboardQueries
}

import { GET } from '../route'

describe('GET /api/trader/:platform/:trader_key publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredGet.mockResolvedValue({ data: null, layer: null })
    mockTieredSet.mockResolvedValue(undefined)
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _supabase: unknown,
        input: { season: '7D' | '30D' | '90D'; sources: string[] },
        reader: (publication: {
          state: 'sealed'
          season: '7D' | '30D' | '90D'
          scoreCohortId: string
          proofs: Array<{ source_as_of: string }>
        }) => Promise<unknown>
      ) => {
        const scoreCohortId = `11111111-1111-4111-8111-1111111111${input.season.slice(0, 2)}`
        const publication = {
          state: 'sealed' as const,
          season: input.season,
          scoreCohortId,
          proofs: [{ source_as_of: '2026-07-29T09:00:00.000000Z' }],
        }
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
  })

  it('reads each ranking window through its own sealed cohort', async () => {
    const leaderboardQueries = installSuccessfulQueries()

    const response = await GET({} as never, {
      params: Promise.resolve({ platform: 'binance_futures', trader_key: 'trader-1' }),
    })
    const body = await response.json()

    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(3)
    expect(mockReadSealedRankingGeneration.mock.calls.map((call) => call[1])).toEqual([
      { season: '7D', sources: ['binance_futures'] },
      { season: '30D', sources: ['binance_futures'] },
      { season: '90D', sources: ['binance_futures'] },
    ])
    for (const query of leaderboardQueries) {
      expect(query.methods.filter).toHaveBeenCalledWith(
        'rank_publication_id',
        'eq',
        expect.any(String)
      )
    }
    expect(body.profile.display_name).toBe('Sealed Trader')
    expect(body.snapshots['7D'].rank).toBe(2)
    expect(body.snapshots['30D'].rank).toBe(2)
    expect(body.snapshots['90D'].rank).toBe(2)
    expect(body.updated_at).toBe('2026-07-29T09:00:00.000Z')
    expect(response.headers.get('X-Cache')).toBe('MISS')
    expect(mockTieredSet).toHaveBeenCalledWith(
      expect.stringContaining('trader:sealed-v1:binance_futures:trader-1'),
      expect.objectContaining({ contract: 'sealed-trader-detail-cache@1' }),
      'warm',
      ['trader', 'binance_futures']
    )
  })

  it('rejects retired, aliased, and quarantined public ranking sources before any read', async () => {
    for (const platform of ['binance', 'copin', 'okx_web3_solana']) {
      const response = await GET({} as never, {
        params: Promise.resolve({ platform, trader_key: 'trader-1' }),
      })
      expect(response.status).toBe(400)
    }

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
  })

  it('rejects a legacy generic cache payload without publication proofs', async () => {
    mockTieredGet.mockResolvedValue({
      data: {
        profile: {
          platform: 'binance_futures',
          trader_key: 'trader-1',
          display_name: 'Poisoned cache',
        },
        snapshots: {},
      },
      layer: 'memory',
    })
    installSuccessfulQueries()

    const response = await GET({} as never, {
      params: Promise.resolve({ platform: 'binance_futures', trader_key: 'trader-1' }),
    })
    const body = await response.json()

    expect(response.headers.get('X-Cache')).toBe('MISS')
    expect(body.profile.display_name).toBe('Sealed Trader')
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(3)
  })

  it('serves a response only when all three cached windows carry the same sealed binding', async () => {
    const sourceAsOf = '2026-07-29T09:00:00.000000Z'
    const cachedResponse = {
      profile: {
        platform: 'binance_futures',
        trader_key: 'trader-1',
        display_name: 'Verified cache',
      },
      snapshots: { '7D': null, '30D': null, '90D': null },
      timeseries: { equity_curve: null, daily_pnl: null, asset_breakdown: null },
      updated_at: '2026-07-29T09:00:00.000Z',
      is_stale: false,
      staleness_seconds: 0,
      refresh_job: null,
    }
    const binding = {
      contract: 'sealed-trader-detail-binding@1',
      platform: 'binance_futures',
      traderKey: 'trader-1',
      responseSha256: createHash('sha256').update(JSON.stringify(cachedResponse)).digest('hex'),
    }
    const windows = Object.fromEntries(
      (['7D', '30D', '90D'] as const).map((season, index) => {
        const scoreCohortId = `11111111-1111-4111-8111-11111111111${index}`
        const publication = {
          state: 'sealed',
          season,
          scoreCohortId,
          proofs: [
            {
              season_id: season,
              source: 'binance_futures',
              source_as_of: sourceAsOf,
              recorded_at: '2026-07-29T09:01:00.000000Z',
              score_cohort_id: scoreCohortId,
              rank_mutation_seq: 1,
              current_mutation_seq: 1,
              published_rank_count: 1,
              published_identity_sha256: 'a'.repeat(64),
              is_sealed: true,
            },
          ],
        }
        return [
          season,
          {
            contract: 'sealed-ranking-cache@1',
            season,
            publicationIdentity: JSON.stringify(publication),
            publication,
            cachedAt: '2026-07-29T09:02:00.000Z',
            value: binding,
          },
        ]
      })
    )
    mockTieredGet.mockResolvedValue({
      data: {
        contract: 'sealed-trader-detail-cache@1',
        response: cachedResponse,
        windows,
      },
      layer: 'memory',
    })

    const response = await GET({} as never, {
      params: Promise.resolve({ platform: 'binance_futures', trader_key: 'trader-1' }),
    })
    const body = await response.json()

    expect(response.headers.get('X-Cache')).toBe('HIT')
    expect(response.headers.get('X-Cache-Layer')).toBe('memory')
    expect(body.profile.display_name).toBe('Verified cache')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
  })

  it('fails closed when a phase-one enrichment query errors', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_profiles_v2') return queryResult(null).proxy
      if (table === 'trader_timeseries') {
        return queryResult(null, { message: 'timeseries unavailable' }).proxy
      }
      if (table === 'refresh_jobs') return queryResult(null).proxy
      if (table === 'trader_equity_curve') return queryResult([]).proxy
      if (table === 'trader_asset_breakdown') return queryResult([]).proxy
      throw new Error(`unexpected table: ${table}`)
    })

    await expect(
      GET({} as never, {
        params: Promise.resolve({ platform: 'binance_futures', trader_key: 'trader-1' }),
      })
    ).rejects.toThrow('trader timeseries query failed')
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
  })
})
