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

const mockFrom = jest.fn()
const mockCheckRateLimit = jest.fn()
jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { public: {} },
}))

const mockGetOrSetWithLock = jest.fn()
const mockDel = jest.fn()
jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
  del: (...args: unknown[]) => mockDel(...args),
}))

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
}))

function queryResult(data: unknown[], error: unknown = null) {
  const result = { data, error }
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
  return { proxy, methods }
}

import { GET } from '../route'

const CURRENT_COHORT_ID = '11111111-1111-4111-8111-111111111111'

function publicationFor(sources: string[], scoreCohortId = CURRENT_COHORT_ID) {
  return {
    state: 'sealed' as const,
    season: '90D' as const,
    scoreCohortId,
    proofs: sources.map((source) => ({
      season_id: '90D',
      source,
      source_as_of: '2026-07-29T10:00:00.000000Z',
      recorded_at: '2026-07-29T10:01:00.000000Z',
      score_cohort_id: scoreCohortId,
      rank_mutation_seq: 9,
      current_mutation_seq: 9,
      published_rank_count: 3,
      published_identity_sha256: 'a'.repeat(64),
      is_sealed: true,
    })),
  }
}

function sealedMoversEntry(scoreCohortId = CURRENT_COHORT_ID, traderKey = 'cached') {
  const publication = publicationFor(['binance_futures'], scoreCohortId)
  return {
    contract: 'sealed-ranking-cache@1',
    season: '90D',
    publicationIdentity: JSON.stringify(publication),
    publication,
    cachedAt: '2026-07-29T10:02:00.000Z',
    value: {
      risers: [
        {
          platform: 'binance_futures',
          trader_key: traderKey,
          rank: 1,
          arena_score: 90,
          roiDelta: 2,
          handle: null,
          avatar_url: null,
        },
      ],
      fallers: [],
      period: '90D',
      snapshotDate: '2026-07-28',
      compareDate: '2026-07-29',
    },
  }
}

describe('GET /api/rankings/movers sealed generation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockDel.mockResolvedValue(true)
    mockGetOrSetWithLock.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) =>
      fetcher()
    )
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
        const publication = publicationFor(input.sources)
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
  })

  it('binds exact platform identities to the sealed cohort and orders biggest fallers first', async () => {
    const dates = queryResult([{ date: '2026-07-29' }, { date: '2026-07-28' }])
    const snapshots = queryResult([
      { platform: 'binance_futures', trader_key: 'riser', roi: 10 },
      { platform: 'binance_futures', trader_key: 'big-faller', roi: 10 },
      { platform: 'binance_futures', trader_key: 'small-faller', roi: 10 },
    ])
    const ranks = queryResult([
      {
        source: 'binance_futures',
        source_trader_id: 'riser',
        rank: 1,
        arena_score: 90,
        roi: 20,
        handle: 'Riser',
        avatar_url: null,
      },
      {
        source: 'binance_futures',
        source_trader_id: 'big-faller',
        rank: 2,
        arena_score: 80,
        roi: 5,
        handle: 'Big',
        avatar_url: null,
      },
      {
        source: 'binance_futures',
        source_trader_id: 'small-faller',
        rank: 3,
        arena_score: 70,
        roi: 9,
        handle: 'Small',
        avatar_url: null,
      },
    ])
    let snapshotReads = 0
    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_daily_snapshots') {
        snapshotReads += 1
        return snapshotReads === 1 ? dates.proxy : snapshots.proxy
      }
      if (table === 'leaderboard_ranks') return ranks.proxy
      throw new Error(`unexpected table: ${table}`)
    })

    const response = await GET({} as never)
    const body = await response.json()

    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      expect.stringContaining('api:rankings:movers:sealed-v3'),
      expect.any(Function),
      expect.any(Object)
    )
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      expect.anything(),
      { season: '90D', sources: ['binance_futures'] },
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(ranks.methods.eq).toHaveBeenCalledWith('source', 'binance_futures')
    expect(ranks.methods.filter).toHaveBeenCalledWith(
      'rank_publication_id',
      'eq',
      '11111111-1111-4111-8111-111111111111'
    )
    expect(body.risers.map((mover: { trader_key: string }) => mover.trader_key)).toEqual(['riser'])
    expect(body.fallers.map((mover: { trader_key: string }) => mover.trader_key)).toEqual([
      'big-faller',
      'small-faller',
    ])
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('evicts a sealed movers page after the publication advances', async () => {
    mockGetOrSetWithLock
      .mockResolvedValueOnce(
        sealedMoversEntry('22222222-2222-4222-8222-222222222222', 'old-cache-row')
      )
      .mockResolvedValueOnce(sealedMoversEntry(CURRENT_COHORT_ID, 'current-cache-row'))

    const response = await GET({} as never)
    const body = await response.json()

    expect(body.risers).toEqual([
      expect.objectContaining({ platform: 'binance_futures', trader_key: 'current-cache-row' }),
    ])
    expect(JSON.stringify(body)).not.toContain('old-cache-row')
    expect(mockDel).toHaveBeenCalledWith(expect.stringContaining('api:rankings:movers:sealed-v3'))
    expect(mockGetOrSetWithLock).toHaveBeenCalledTimes(2)
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(2)
  })

  it('rejects a generic movers cache payload', async () => {
    mockGetOrSetWithLock.mockResolvedValue({
      risers: [{ platform: 'binance_futures', trader_key: 'poison' }],
      fallers: [],
      period: '90D',
    })

    const response = await GET({} as never)
    const body = await response.json()

    expect(body).toEqual({ risers: [], fallers: [], period: '90D' })
    expect(JSON.stringify(body)).not.toContain('poison')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockDel).toHaveBeenCalledWith(expect.stringContaining('api:rankings:movers:sealed-v3'))
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })
})
