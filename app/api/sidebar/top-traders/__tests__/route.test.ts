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

const mockGetOrSetWithLock = jest.fn()
const mockDel = jest.fn()

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
  del: (...args: unknown[]) => mockDel(...args),
}))

const mockFrom = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: unknown) => unknown) => () => handler({}),
}))

jest.mock('@/lib/supabase/read-replica', () => ({
  getReadReplica: () => ({ from: mockFrom }),
}))

const mockReadSealedRankingAuthorityGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
  sealedRankingPublicationIdentity: (publication: unknown) => JSON.stringify(publication),
}))

const COHORT_ID = '11111111-1111-4111-8111-111111111111'
const TEST_AUTHORITY_SOURCES = ['binance_futures', 'hyperliquid']

function publicationFor(scoreCohortId = COHORT_ID) {
  return {
    state: 'sealed' as const,
    season: '90D' as const,
    scoreCohortId,
    proofs: TEST_AUTHORITY_SOURCES.map((source) => ({
      season_id: '90D',
      source,
      source_as_of: '2026-07-29T09:00:00.000000Z',
      recorded_at: '2026-07-29T09:05:00.000000Z',
      score_cohort_id: scoreCohortId,
      rank_mutation_seq: 3,
      current_mutation_seq: 3,
      published_rank_count: 0,
      published_identity_sha256: 'a'.repeat(64),
      is_sealed: true,
    })),
  }
}

function sealedCacheEntry(value: unknown, scoreCohortId = COHORT_ID) {
  const publication = publicationFor(scoreCohortId)
  return {
    contract: 'sealed-ranking-cache@1',
    season: '90D',
    publicationIdentity: JSON.stringify(publication),
    publication,
    cachedAt: '2026-07-29T09:06:00.000Z',
    value,
  }
}

function makeQuery(result: { data: unknown[] | null; error: unknown }) {
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
        return jest.fn(() => proxy)
      },
    }
  )
  return proxy
}

import { GET } from '../route'

describe('GET /api/sidebar/top-traders', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDel.mockResolvedValue(true)
    mockGetOrSetWithLock.mockImplementation(async (_key: string, loader: () => Promise<unknown>) =>
      loader()
    )
    mockReadSealedRankingAuthorityGeneration.mockImplementation(
      async (
        _client: unknown,
        season: '90D',
        reader: (publication: {
          state: 'sealed'
          season: '90D'
          scoreCohortId: string
          proofs: Array<Record<string, unknown>>
        }) => Promise<unknown>
      ) => {
        const publication = publicationFor()
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
  })

  it('keeps a real empty leaderboard as a successful empty result', async () => {
    mockFrom.mockReturnValue(makeQuery({ data: [], error: null }))

    const response = await GET()

    await expect(response.json()).resolves.toEqual({ traders: [] })
  })

  it('propagates a leaderboard read failure instead of caching it as empty', async () => {
    const databaseError = new Error('leaderboard unavailable')
    mockFrom.mockReturnValue(makeQuery({ data: null, error: databaseError }))

    await expect(GET()).rejects.toThrow('sidebar cohort query failed: leaderboard unavailable')
    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      'public-rank-policy-v4:sidebar:top-traders-sealed-v3:90D',
      expect.any(Function),
      expect.objectContaining({ ttl: 300 })
    )
  })

  it('evicts a sealed page when the current authority has advanced to another cohort', async () => {
    const oldEntry = sealedCacheEntry(
      { traders: [{ source: 'binance_futures', source_trader_id: 'old-cache-row' }] },
      '22222222-2222-4222-8222-222222222222'
    )
    mockGetOrSetWithLock
      .mockResolvedValueOnce(oldEntry)
      .mockImplementation(async (_key: string, loader: () => Promise<unknown>) => loader())
    mockFrom.mockReturnValue(
      makeQuery({
        data: [
          {
            source: 'binance_futures',
            source_trader_id: 'current-row',
            handle: 'Current',
            avatar_url: null,
            roi: 20,
            pnl: 10,
            arena_score: 80,
          },
        ],
        error: null,
      })
    )

    const response = await GET()
    const body = await response.json()

    expect(body).toEqual({
      traders: [expect.objectContaining({ source_trader_id: 'current-row' })],
    })
    expect(JSON.stringify(body)).not.toContain('old-cache-row')
    expect(mockDel).toHaveBeenCalledWith('public-rank-policy-v4:sidebar:top-traders-sealed-v3:90D')
    expect(mockGetOrSetWithLock).toHaveBeenCalledTimes(2)
  })
})
