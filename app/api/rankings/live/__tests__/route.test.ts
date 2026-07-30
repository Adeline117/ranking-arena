const mockCheckRateLimit = jest.fn()
const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
const mockReadSharedCacheWriteFence = jest.fn()
const mockFrom = jest.fn()

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

jest.mock('@/lib/cache', () => ({
  readSharedCacheWriteFence: (...args: unknown[]) => mockReadSharedCacheWriteFence(...args),
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
  let requirePublishedRank = false
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
            .filter((row) => !requirePublishedRank || row.rank != null)
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
          methods.not ??= jest.fn((column: string, operator: string, value: unknown) => {
            if (column === 'source' && operator === 'in') {
              excludedSources = new Set(
                String(value)
                  .replace(/^\(|\)$/g, '')
                  .split(',')
              )
            }
            if (column === 'rank' && operator === 'is' && value === null) {
              requirePublishedRank = true
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
import { PUBLIC_RANKING_POSTGREST_EXCLUSION } from '@/lib/rankings/publication-policy'
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
    mockReadSharedCacheWriteFence.mockResolvedValue({
      key: 'public-rankings:write-fence:v1',
      token: '7',
    })
  })

  it('filters active and quarantined sources before the cold-v4 DB range', async () => {
    const query = sourceFilteredQuery([
      row('copin', 'retired-slot', 1),
      row('okx_web3_solana', 'quarantined-slot', 2),
      { ...row('binance_futures', 'unranked-slot', 3), rank: null },
      row('binance_futures', 'safe-one', 3),
      row('hyperliquid', 'safe-two', 4),
    ])
    mockFrom.mockReturnValue(query)

    const response = await GET(request())
    const body = await response.json()

    expect(query.in).toHaveBeenCalledWith('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])
    expect(query.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(query.not).toHaveBeenCalledWith('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
    expect(query.range).toHaveBeenCalledWith(0, 1)
    expect(body.traders.map(({ id }: { id: string }) => id)).toEqual(['safe-one', 'safe-two'])
    expect(body.totalCount).toBe(2)
    expect(JSON.stringify(body)).not.toMatch(/retired-slot|quarantined-slot|unranked-slot/)
    expect(mockTieredSet).toHaveBeenCalledWith(
      'public-rank-policy-v6:rankings:live:90D:2:0',
      expect.objectContaining({
        traders: expect.arrayContaining([
          expect.objectContaining({ id: 'safe-one', source: 'binance_futures' }),
          expect.objectContaining({ id: 'safe-two', source: 'hyperliquid' }),
        ]),
      }),
      'hot',
      ['rankings:public-rank-policy-v6', 'live:90D'],
      {
        skipMemory: true,
        writeFence: { key: 'public-rankings:write-fence:v1', token: '7' },
      }
    )
    expect(JSON.stringify(mockTieredSet.mock.calls)).not.toMatch(/retired-slot|quarantined-slot/)
  })

  it('filters a forbidden raw DB row before mapping or caching even if the query layer violates filters', async () => {
    const query = queryResult([
      row('copin', 'hyperliquid:0xpoison', 1),
      { ...row('binance_futures', 'unranked-db-row', 2), rank: null },
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
    expect(JSON.stringify(body)).not.toContain('unranked-db-row')
    expect(JSON.stringify(mockTieredSet.mock.calls)).not.toContain('0xpoison')
  })

  it('sanitizes a polluted current-v4 cache hit without querying or writing it back', async () => {
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

    const response = await GET(request())
    const body = await response.json()

    expect(mockTieredGet).toHaveBeenCalledWith(
      'public-rank-policy-v6:rankings:live:90D:2:0',
      'hot',
      {
        skipMemory: true,
        writeFence: { key: 'public-rankings:write-fence:v1', token: '7' },
      }
    )
    expect(body.traders).toEqual([
      expect.objectContaining({ source: 'binance_futures', source_trader_id: 'safe-cache-row' }),
    ])
    expect(body).toEqual(
      expect.objectContaining({
        total: 1,
        totalCount: 1,
        hasMore: false,
        ranking_visibility_reason: 'publication_policy_filtered',
      })
    )
    expect(response.headers.get('X-Cache')).toBe('HIT')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockTieredSet).not.toHaveBeenCalled()
  })
})
