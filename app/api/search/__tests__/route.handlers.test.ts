/**
 * Behaviour of the search route outside the cache-hit path: trending, hot,
 * click tracking, exchange and stats queries, and the Meilisearch fallback.
 * Dependencies are mocked at module level so each branch is driven directly.
 */
jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
    }
    async json() {
      return this._body
    }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }
  class MockNextRequest {
    url: string
    nextUrl: URL
    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
    }
  }
  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockCacheGet = jest.fn()
const mockCacheSet = jest.fn()
jest.mock('@/lib/cache', () => ({
  get: (...args: unknown[]) => mockCacheGet(...args),
  set: (...args: unknown[]) => mockCacheSet(...args),
  getOrSetWithLock: (_key: string, factory: () => Promise<unknown>) => factory(),
}))

const mockSearchTraders = jest.fn()
const mockGetSuggestions = jest.fn()
const mockGetLeaderboard = jest.fn()
jest.mock('@/lib/data/unified', () => ({
  searchTraders: (...args: unknown[]) => mockSearchTraders(...args),
  getSearchSuggestions: (...args: unknown[]) => mockGetSuggestions(...args),
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
}))

const mockMaterialize = jest.fn()
jest.mock('@/lib/data/trader/queries', () => ({
  materializePublicSearchTraders: (...args: unknown[]) => mockMaterialize(...args),
}))

const mockMeiliAvailable = jest.fn()
const mockMeiliSearch = jest.fn()
jest.mock('@/lib/search/meilisearch', () => ({
  isMeilisearchAvailable: () => mockMeiliAvailable(),
  searchTradersMeili: (...args: unknown[]) => mockMeiliSearch(...args),
}))

jest.mock('@/lib/data/service-post-audience', () => ({
  filterServiceReadablePostRows: async (_supabase: unknown, rows: unknown[]) => rows,
}))

type Result = { data: unknown; error: unknown }
const tableResults = new Map<string, Result>()
const inserts: Array<{ table: string; row: Record<string, unknown> }> = []

function chainFor(table: string) {
  const result = tableResults.get(table) ?? { data: [], error: null }
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject)
        }
        if (prop === 'insert') {
          return (row: Record<string, unknown>) => {
            inserts.push({ table, row })
            return proxy
          }
        }
        return () => proxy
      },
    }
  )
  return proxy
}

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (ctx: unknown) => unknown) => async (req: unknown) =>
    handler({ supabase: { from: (table: string) => chainFor(table) }, request: req }),
}))

jest.mock('@/lib/api/response', () => ({
  success: (data: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NextResponse } = require('next/server')
    return NextResponse.json(data)
  },
  badRequest: (message: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NextResponse } = require('next/server')
    return NextResponse.json({ error: message }, { status: 400 })
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

async function call(query: string) {
  const res = await GET(new NextRequest(`http://localhost/api/search?${query}`))
  return { status: res.status, body: await res.json() }
}

const liveCohort = new Map<string, Record<string, unknown>>()

// A trader as both the nominator and the live cohort see it.
function trader(key: string, overrides: Record<string, unknown> = {}) {
  const row = {
    platform: 'binance_futures',
    traderKey: key,
    handle: key,
    avatarUrl: null,
    traderType: null,
    rank: 1,
    roi: 10,
    arenaScore: 50,
    ...overrides,
  }
  liveCohort.set(`${row.platform}:${row.traderKey}`, row)
  return row
}

beforeEach(() => {
  jest.clearAllMocks()
  tableResults.clear()
  inserts.length = 0
  mockCacheGet.mockResolvedValue(null)
  mockMeiliAvailable.mockReturnValue(false)
  mockSearchTraders.mockResolvedValue([])
  mockGetSuggestions.mockResolvedValue([])
  mockGetLeaderboard.mockResolvedValue({ traders: [] })
  // Nominations carry identity only; metrics come from the live cohort.
  liveCohort.clear()
  mockMaterialize.mockImplementation(
    async (_s: unknown, candidates: Array<{ platform: string; traderKey: string }>) =>
      candidates.flatMap((c) => liveCohort.get(`${c.platform}:${c.traderKey}`) ?? [])
  )
})

describe('parameter validation', () => {
  it('rejects an unknown search type', async () => {
    const { status } = await call('type=bogus')
    expect(status).toBe(400)
  })

  it('rejects an over-long query', async () => {
    const { status } = await call(`q=${'a'.repeat(201)}`)
    expect(status).toBe(400)
  })
})

describe('trending searches', () => {
  function analytics(rows: Array<[string, number]>) {
    tableResults.set('search_analytics', {
      data: rows.map(([query, result_count]) => ({ query, result_count, created_at: '' })),
      error: null,
    })
  }

  it('ranks queries searched at least three times and categorises them', async () => {
    const repeated = (query: string, times: number) =>
      Array.from({ length: times }, () => [query, 5] as [string, number])
    analytics([
      ...repeated('BTC', 6),
      ...repeated('binance whale', 5),
      ...repeated('long term', 4),
      ...repeated('eth', 3),
      ...repeated('sol', 3),
      ...repeated('rare', 2),
      ...repeated("' or 1=1 --", 9),
    ])

    const { body } = await call('type=trending')

    expect(body.trending.map((item: { query: string }) => item.query)).toEqual([
      'btc',
      'binance whale',
      'long term',
      'eth',
      'sol',
    ])
    expect(body.trending[0]).toMatchObject({ rank: 1, searchCount: 6, category: 'token' })
    expect(body.trending[1].category).toBe('trader')
    expect(body.trending[2].category).toBe('general')
    expect(body.fallback).toContain('BTC')
  })

  it('returns only the fallback when fewer than five queries qualify', async () => {
    analytics([
      ['btc', 1],
      ['btc', 1],
      ['btc', 1],
    ])
    const { body } = await call('type=trending')
    expect(body.trending).toEqual([])
    expect(body.fallback.length).toBeGreaterThan(0)
  })

  it('returns only the fallback when analytics cannot be read', async () => {
    tableResults.set('search_analytics', { data: null, error: { message: 'boom' } })
    const { body } = await call('type=trending')
    expect(body.trending).toEqual([])
  })
})

describe('hot searches', () => {
  it('extracts symbols, hashtags and short titles without duplicates', async () => {
    tableResults.set('posts', {
      data: [
        { id: '1', title: 'Buying $pepe today', hot_score: 80 },
        { id: '2', title: 'More $PEPE talk', hot_score: 70 },
        { id: '3', title: 'Thoughts on #airdrop season', hot_score: 30 },
        { id: '4', title: '【Weekly】 market recap and outlook', hot_score: null, view_count: 10 },
        { id: '5', title: null, hot_score: 99 },
      ],
      error: null,
    })

    const { body } = await call('type=hot')

    expect(body.hotSearches).toEqual([
      { keyword: 'PEPE', count: 80, trend: 'up' },
      { keyword: 'airdrop', count: 30, trend: 'stable' },
      // "Weekly market" would exceed the 12-character keyword cap.
      { keyword: 'Weekly', count: 1, trend: 'down' },
    ])
    expect(mockCacheSet).toHaveBeenCalledWith('search:hot:v2:candidates', expect.any(Array), {
      ttl: 300,
    })
  })

  it('uses cached candidates without querying posts', async () => {
    mockCacheGet.mockResolvedValue([{ id: '1', title: '$SOL breakout', hot_score: 10 }])
    tableResults.set('posts', { data: [{ id: '2', title: '$ETH', hot_score: 99 }], error: null })
    const { body } = await call('type=hot')
    expect(body.hotSearches).toEqual([{ keyword: 'SOL', count: 10, trend: 'down' }])
  })

  it('falls back to fixed keywords when no post yields one', async () => {
    const { body } = await call('type=hot')
    expect(body.hotSearches.map((item: { keyword: string }) => item.keyword)).toEqual([
      'BTC',
      'ETH',
      'SOL',
    ])
  })
})

describe('click tracking', () => {
  it('records nothing without a query and result id', async () => {
    const { body } = await call('type=click&q=btc')
    expect(body).toEqual({ ok: true })
    expect(inserts).toEqual([])
  })

  it('records the click', async () => {
    const { body } = await call('type=click&q=%20btc%20&id=binance:abc&rtype=trader')
    expect(body).toEqual({ ok: true })
    expect(inserts).toEqual([
      {
        table: 'search_analytics',
        row: {
          query: 'btc',
          result_count: 1,
          source: 'click',
          clicked_result_id: 'binance:abc',
          clicked_result_type: 'trader',
        },
      },
    ])
  })
})

describe('unified search', () => {
  it('treats an exchange name as a ranking intent, falling back to the leaderboard', async () => {
    mockGetLeaderboard.mockResolvedValue({
      traders: [trader('low', { arenaScore: 10, rank: 2 }), trader('high', { arenaScore: 90 })],
    })

    const { body } = await call('q=binance')

    expect(mockSearchTraders).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: '', platform: 'binance_futures', limit: 10 })
    )
    expect(mockGetLeaderboard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ platform: 'binance_futures', period: '90D' })
    )
    expect(body.matchedExchange).toBe('binance_futures')
    expect(body.results.traders.map((t: { id: string }) => t.id)).toEqual([
      'binance_futures:high',
      'binance_futures:low',
    ])
    expect(body.suggestions).toBeUndefined()
  })

  it('applies an ROI threshold and drops unranked traders', async () => {
    mockSearchTraders.mockResolvedValue([
      trader('small', { roi: 50 }),
      trader('big', { roi: 500 }),
      trader('bigger', { roi: 900 }),
      trader('unranked', { roi: 999, rank: null }),
    ])

    const { body } = await call('q=roi%20%3E%20100')

    expect(body.results.traders.map((t: { id: string }) => t.id)).toEqual([
      'binance_futures:bigger',
      'binance_futures:big',
    ])
  })

  it('orders identity matches exact, then prefix, then contains', async () => {
    mockSearchTraders.mockResolvedValue([
      trader('the-whale'),
      trader('whale-hunter'),
      trader('whale'),
    ])

    const { body } = await call('q=whale')

    expect(body.results.traders.map((t: { title: string }) => t.title)).toEqual([
      '@whale',
      '@whale-hunter',
      '@the-whale',
    ])
  })

  it('formats trader subtitles and keeps posts, users and groups', async () => {
    mockSearchTraders.mockResolvedValue([trader('k', { roi: 1500, rank: 3, arenaScore: 72.4 })])
    tableResults.set('posts', {
      data: [{ id: 'p', title: null, author_handle: 'amy', view_count: 4 }],
      error: null,
    })
    tableResults.set('public_user_profiles', {
      data: [{ id: 'u', handle: 'kay', avatar_url: null, bio: null }],
      error: null,
    })
    tableResults.set('groups', {
      data: [{ id: 'g', name: 'k club', member_count: 3, description: null }],
      error: null,
    })

    const { body } = await call('q=k')

    expect(body.results.traders[0].subtitle).toBe('Binance · #3 · +1.5K% · Score 72')
    expect(body.results.posts).toEqual([
      expect.objectContaining({ title: 'Untitled', subtitle: '@amy', href: '/post/p' }),
    ])
    expect(body.results.users).toEqual([expect.objectContaining({ href: '/u/kay' })])
    expect(body.total).toBe(4)
    expect(inserts).toEqual([
      { table: 'search_analytics', row: { query: 'k', result_count: 4, source: 'unified' } },
    ])
  })

  it('offers suggestions when few results are found', async () => {
    mockGetSuggestions.mockResolvedValue(['whalers'])
    const { body } = await call('q=whaler')
    expect(body.suggestions).toEqual(['whalers'])
    expect(body.total).toBe(0)
  })

  it('does not record analytics for a malicious query', async () => {
    await call(`q=${encodeURIComponent("' or 1=1 --")}`)
    expect(inserts.filter((entry) => entry.row.source === 'unified')).toEqual([])
  })

  it('falls back to Supabase and marks the response degraded when Meilisearch fails', async () => {
    mockMeiliAvailable.mockReturnValue(true)
    mockMeiliSearch.mockRejectedValue(new Error('down'))
    mockSearchTraders.mockResolvedValue([trader('whale')])

    const { body } = await call('q=whale')

    expect(body.degraded).toBe(true)
    expect(body.results.traders.map((t: { id: string }) => t.id)).toEqual(['binance_futures:whale'])
  })

  it('uses Meilisearch nominations and facets when available', async () => {
    mockMeiliAvailable.mockReturnValue(true)
    trader('abc')
    mockMeiliSearch.mockResolvedValue({
      hits: [{ id: 'binance_futures--abc--90D', handle: 'abc', platform: 'binance_futures' }],
      facetDistribution: { platform: { binance_futures: 1 } },
    })

    const { body } = await call('q=abc')

    expect(mockSearchTraders).not.toHaveBeenCalled()
    expect(body.results.traders[0].id).toBe('binance_futures:abc')
    expect(body.facetDistribution).toEqual({ platform: { binance_futures: 1 } })
  })
})
