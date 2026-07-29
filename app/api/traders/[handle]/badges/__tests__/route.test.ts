jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      return new MockNextResponse(body, init)
    }
  }
  return { NextResponse: MockNextResponse }
})

const mockCheckRateLimit = jest.fn()
jest.mock('@/lib/api', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { public: {} },
}))

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

const mockResolveTrader = jest.fn()
jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
}))

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

function rankQuery(row: Record<string, unknown> | null) {
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'filter']) {
    query[method] = jest.fn(() => query)
  }
  query.maybeSingle = jest.fn().mockResolvedValue({ data: row, error: null })
  return query
}

import { GET } from '../route'

describe('GET /api/traders/[handle]/badges sealed rank', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockResolveTrader.mockResolvedValue({
      platform: 'binance_futures',
      traderKey: 'trader/key',
      handle: 'Trader',
      avatarUrl: null,
    })
    mockTieredGet.mockResolvedValue({
      data: {
        badges: [{ id: 'poison', metadata: { rank: 1 } }],
      },
    })
    mockTieredSet.mockResolvedValue(undefined)
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
        const scoreCohortId = '11111111-1111-4111-8111-111111111111'
        const publication = {
          state: 'sealed' as const,
          season: input.season,
          scoreCohortId,
          proofs: input.sources.map((source) => ({
            season_id: input.season,
            source,
            source_as_of: '2026-07-29T10:00:00.000000Z',
            recorded_at: '2026-07-29T10:01:00.000000Z',
            score_cohort_id: scoreCohortId,
            rank_mutation_seq: 9,
            current_mutation_seq: 9,
            published_rank_count: 1,
            published_identity_sha256: 'a'.repeat(64),
            is_sealed: true,
          })),
        }
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
  })

  it('rejects a generic cache and calculates the badge from the sealed cohort row', async () => {
    const query = rankQuery({
      source: 'binance_futures',
      source_trader_id: 'trader/key',
      season_id: '90D',
      rank: 7,
    })
    mockFrom.mockReturnValue(query)

    const response = await GET({} as never, {
      params: Promise.resolve({ handle: 'Trader' }),
    })
    const body = await response.json()

    expect(mockTieredGet).toHaveBeenCalledWith(
      expect.stringContaining('badges:sealed-v2:binance_futures:trader%2Fkey'),
      'warm'
    )
    expect(query.filter).toHaveBeenCalledWith(
      'rank_publication_id',
      'eq',
      '11111111-1111-4111-8111-111111111111'
    )
    expect(body.badges).toEqual([
      expect.objectContaining({
        id: 'top10',
        metadata: { rank: 7 },
      }),
    ])
    expect(JSON.stringify(body)).not.toContain('poison')
    expect(mockTieredSet).toHaveBeenCalledWith(
      expect.stringContaining('badges:sealed-v2'),
      expect.objectContaining({ contract: 'sealed-ranking-cache@1' }),
      'warm'
    )
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })
})
