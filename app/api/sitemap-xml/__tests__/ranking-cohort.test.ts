const mockCreateClient = jest.fn()
const mockFrom = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}))

jest.mock('next/server', () => {
  class MockNextResponse {
    readonly body: unknown
    readonly status: number
    readonly headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async text() {
      return typeof this.body === 'string' ? this.body : JSON.stringify(this.body)
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

import { GET } from '../route'

type QueryResult = {
  data: unknown[] | null
  error: { message: string } | null
  count?: number | null
}

type QueryMock = Record<string, jest.Mock> & PromiseLike<QueryResult>

function query(result: QueryResult): QueryMock {
  const methods: Record<string, jest.Mock> = {}
  const chain = new Proxy(methods, {
    get(target, property) {
      if (property === 'then') {
        return (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve)
      }
      const key = String(property)
      target[key] ??= jest.fn(() => chain)
      return target[key]
    },
  })
  return chain as unknown as QueryMock
}

function publicRankedRow(overrides: Record<string, unknown> = {}) {
  return {
    handle: 'Top Trader',
    source_trader_id: 'trader-1',
    source: 'binance_futures',
    rank: 1,
    computed_at: '2026-08-16T12:00:00.000Z',
    ...overrides,
  }
}

function request(path: string) {
  return { nextUrl: new URL(path) } as never
}

describe('XML trader sitemap public ranking cohort', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateClient.mockReturnValue({ from: mockFrom })
  })

  it('filters and orders the public cohort before querying a fixed shard range', async () => {
    const rankingQuery = query({ data: [publicRankedRow()], error: null })
    mockFrom.mockReturnValue(rankingQuery)

    const response = await GET(request('http://localhost/api/sitemap-xml?shard=2'))
    const xml = await response.text()

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(rankingQuery.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(rankingQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(rankingQuery.order.mock.calls).toEqual([
      ['rank', { ascending: true, nullsFirst: false }],
      ['source', { ascending: true, nullsFirst: false }],
      ['source_trader_id', { ascending: true, nullsFirst: false }],
    ])
    expect(rankingQuery.range).toHaveBeenCalledWith(5000, 9999)
    expect(xml).toContain('https://www.arenafi.org/trader/Top%20Trader?platform=binance_futures')
  })

  it('uses the same public cohort for the shard-count authority', async () => {
    const countQuery = query({ data: null, count: 5001, error: null })
    mockFrom.mockReturnValue(countQuery)

    const response = await GET(request('http://localhost/api/sitemap-xml'))
    const xml = await response.text()

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(countQuery.select).toHaveBeenCalledWith('id', { count: 'exact', head: true })
    expect(countQuery.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(countQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(xml).toContain('sitemap-xml?shard=2')
    expect(xml).not.toContain('sitemap-xml?shard=3')
  })

  it('does not invent a trader shard when the public cohort count is unavailable', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    mockFrom.mockReturnValue(
      query({ data: null, count: null, error: { message: 'view unavailable' } })
    )

    try {
      const response = await GET(request('http://localhost/api/sitemap-xml'))
      const xml = await response.text()

      expect(response.status).toBe(200)
      expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
      expect(xml).toContain('sitemap-xml?shard=0')
      expect(xml).toContain('sitemap-xml?shard=999')
      expect(xml).not.toContain('sitemap-xml?shard=1</loc>')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not emit a partial finite shard when a view row is malformed', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    mockFrom.mockReturnValue(query({ data: [publicRankedRow({ source: null })], error: null }))

    try {
      const response = await GET(request('http://localhost/api/sitemap-xml?shard=1'))
      const xml = await response.text()

      expect(response.status).toBe(200)
      expect(xml).not.toContain('/trader/')
    } finally {
      consoleError.mockRestore()
    }
  })
})
