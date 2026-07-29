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

const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
  sealedRankingPublicationIdentity: (publication: unknown) => JSON.stringify(publication),
}))

const COHORT_ID = '11111111-1111-4111-8111-111111111111'

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
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _client: unknown,
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
          scoreCohortId: COHORT_ID,
          proofs: input.sources.map((source) => ({
            season_id: input.season,
            source,
            source_as_of: '2026-07-29T09:00:00.000000Z',
            recorded_at: '2026-07-29T09:05:00.000000Z',
            score_cohort_id: COHORT_ID,
            rank_mutation_seq: 3,
            current_mutation_seq: 3,
            published_rank_count: 0,
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
      'public-rank-policy-v4:sidebar:top-traders-sealed-v2:90D',
      expect.any(Function),
      expect.objectContaining({ ttl: 300 })
    )
  })
})
