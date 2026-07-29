const mockCheckRateLimit = jest.fn()
const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
const mockGetSortedSetSize = jest.fn()
const mockGetTopTraders = jest.fn()
const mockFrom = jest.fn()
const mockReadSealedRankingGeneration = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers = new Headers()

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: {} },
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
}))

jest.mock('@/lib/realtime/ranking-store', () => ({
  getSortedSetSize: (...args: unknown[]) => mockGetSortedSetSize(...args),
  getTopTraders: (...args: unknown[]) => mockGetTopTraders(...args),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

type DatabaseRow = Record<string, unknown>

function queryResult(data: DatabaseRow[], count = data.length, error: unknown = null) {
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          const result = { data, count, error }
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

/**
 * Emulate PostgREST's filter-before-range semantics. A forbidden row at the
 * front therefore consumes a slot unless the route applies source authority
 * before calling range().
 */
function sourceFilteredQuery(data: DatabaseRow[]) {
  let allowedSources: Set<unknown> | null = null
  let excludedSources = new Set<string>()
  let range: [number, number] | null = null
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          const filtered = data
            .filter((row) => allowedSources === null || allowedSources.has(row.source))
            .filter((row) => !excludedSources.has(String(row.source)))
          const page = range ? filtered.slice(range[0], range[1] + 1) : filtered
          const result = { data: page, count: filtered.length, error: null }
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }

        const key = String(property)
        if (key === 'in') {
          methods.in ??= jest.fn((column: string, values: unknown[]) => {
            if (column === 'source') allowedSources = new Set(values)
            return proxy
          })
          return methods.in
        }
        if (key === 'not') {
          methods.not ??= jest.fn((column: string, operator: string, value: string) => {
            if (column === 'source' && operator === 'in') {
              excludedSources = new Set(value.replace(/^\(|\)$/g, '').split(','))
            }
            return proxy
          })
          return methods.not
        }
        if (key === 'range') {
          methods.range ??= jest.fn((from: number, to: number) => {
            range = [from, to]
            return proxy
          })
          return methods.range
        }
        methods[key] ??= jest.fn(() => proxy)
        return methods[key]
      },
    }
  )
  return proxy
}

function row(source: string, id: string, rank: number): DatabaseRow {
  return {
    source,
    source_trader_id: id,
    source_type: source === 'hyperliquid' ? 'web3' : 'futures',
    handle: id,
    arena_score: 100 - rank,
    rank,
    roi: 10,
  }
}

import type { NextRequest } from 'next/server'
import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import {
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  filterPublicRankingSources,
} from '@/lib/rankings/publication-policy'
import { GET } from '../route'

function request() {
  return {
    nextUrl: new URL('http://localhost/api/rankings/live?period=90D&limit=2&offset=0'),
  } as NextRequest
}

describe('GET /api/rankings/live publication authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockTieredGet.mockResolvedValue({ data: null, layer: null })
    mockTieredSet.mockResolvedValue(undefined)
    mockGetSortedSetSize.mockResolvedValue(0)
    mockGetTopTraders.mockResolvedValue([])
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _supabase: unknown,
        input: { season: '7D' | '30D' | '90D'; sources: string[] },
        reader: (publication: {
          state: 'sealed'
          season: '7D' | '30D' | '90D'
          scoreCohortId: string
          proofs: Array<{ published_rank_count: number }>
        }) => Promise<unknown>
      ) => {
        const scoreCohortId = '11111111-1111-4111-8111-111111111111'
        const publication = {
          state: 'sealed' as const,
          season: input.season,
          scoreCohortId,
          proofs: [...input.sources].sort().map((source) => ({
            season_id: input.season,
            source,
            source_as_of: '2026-07-29T10:00:00.000000Z',
            recorded_at: '2026-07-29T10:01:00.000000Z',
            score_cohort_id: scoreCohortId,
            rank_mutation_seq: 9,
            current_mutation_seq: 9,
            published_rank_count: source === 'binance_futures' || source === 'hyperliquid' ? 1 : 0,
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

  it('filters active and quarantined sources before the sealed DB range', async () => {
    const query = sourceFilteredQuery([
      row('copin', 'retired-slot', 1),
      row('okx_web3_solana', 'quarantined-slot', 2),
      row('binance_futures', 'safe-one', 3),
      row('hyperliquid', 'safe-two', 4),
    ])
    mockFrom.mockReturnValue(query)

    const response = await GET(request())
    const body = await response.json()

    expect(query.in).toHaveBeenCalledWith(
      'source',
      filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)
    )
    expect(query.filter).toHaveBeenCalledWith(
      'rank_publication_id',
      'eq',
      '11111111-1111-4111-8111-111111111111'
    )
    expect(query.not).toHaveBeenCalledWith('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
    expect(query.range).toHaveBeenCalledWith(0, 1)
    expect(body.traders.map(({ id }: { id: string }) => id)).toEqual(['safe-one', 'safe-two'])
    expect(body.totalCount).toBe(2)
    expect(JSON.stringify(body)).not.toMatch(/retired-slot|quarantined-slot/)
    expect(mockTieredSet).toHaveBeenCalledWith(
      'public-rank-policy-v4:rankings:live:sealed-v5:90D:2:0',
      expect.objectContaining({
        contract: 'sealed-ranking-cache@1',
        season: '90D',
        value: expect.objectContaining({
          traders: expect.arrayContaining([
            expect.objectContaining({ id: 'safe-one', source: 'binance_futures' }),
            expect.objectContaining({ id: 'safe-two', source: 'hyperliquid' }),
          ]),
        }),
      }),
      'hot',
      ['rankings', 'live:90D']
    )
    expect(JSON.stringify(mockTieredSet.mock.calls)).not.toMatch(/retired-slot|quarantined-slot/)
  })

  it('filters a forbidden raw DB row before mapping or caching even if the query layer violates filters', async () => {
    const query = queryResult([
      row('copin', 'hyperliquid:0xpoison', 1),
      row('binance_futures', 'safe-db-row', 2),
    ])
    mockFrom.mockReturnValue(query)

    const response = await GET(request())
    const body = await response.json()

    expect(body.traders).toEqual([
      expect.objectContaining({ id: 'safe-db-row', source: 'binance_futures' }),
    ])
    expect(body).toEqual(expect.objectContaining({ total: 1, totalCount: 1, hasMore: false }))
    expect(JSON.stringify(body)).not.toContain('0xpoison')
    expect(JSON.stringify(mockTieredSet.mock.calls)).not.toContain('0xpoison')
  })

  it('rejects a generic cache page even when its policy epoch is current', async () => {
    mockTieredGet.mockResolvedValue({
      layer: 'redis',
      data: {
        traders: [
          row('binance_futures', 'safe-cache-row', 1),
          row('copin', 'retired-cache-row', 2),
          row('okx_web3_solana', 'quarantined-cache-row', 3),
        ],
        total: 3,
        totalCount: 3,
        period: '90D',
        source: 'redis',
        hasMore: true,
      },
    })
    mockFrom.mockReturnValue(queryResult([row('binance_futures', 'sealed-db-row', 1)]))

    const response = await GET(request())
    const body = await response.json()

    expect(mockTieredGet).toHaveBeenCalledWith(
      'public-rank-policy-v4:rankings:live:sealed-v5:90D:2:0',
      'hot'
    )
    expect(body.traders).toEqual([
      expect.objectContaining({ source: 'binance_futures', id: 'sealed-db-row' }),
    ])
    expect(JSON.stringify(body)).not.toMatch(
      /safe-cache-row|retired-cache-row|quarantined-cache-row/
    )
    expect(response.headers.get('X-Cache')).toBe('MISS')
    expect(mockGetSortedSetSize).not.toHaveBeenCalled()
    expect(mockGetTopTraders).not.toHaveBeenCalled()
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(1)
    expect(mockFrom).toHaveBeenCalledWith('leaderboard_ranks')
    expect(mockTieredSet).toHaveBeenCalledTimes(1)
  })
})
