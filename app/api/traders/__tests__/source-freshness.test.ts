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
  withPublic: (handler: (context: unknown) => unknown) => (request: { nextUrl: URL }) =>
    handler({ supabase: { from: mockFrom }, request }),
}))

const mockGetOrSetWithLock = jest.fn()
jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))

jest.mock('@/lib/data/verified-traders', () => ({
  getVerifiedTraderKeys: jest.fn(async () => new Set()),
  verifiedTraderKey: (source: string, traderId: string) => `${source}:${traderId}`,
}))

jest.mock('@/lib/data/avatar-mirrors', () => ({
  attachAvatarMirrors: jest.fn(async (_supabase: unknown, traders: unknown[]) => traders),
}))

jest.mock('@/lib/api/traders-response-schema', () => ({
  validateTradersResponse: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
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
  return proxy
}

import { GET } from '../route'

describe('GET /api/traders source freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetOrSetWithLock.mockImplementation(
      async (_key: string, fetcher: () => Promise<unknown>) => await fetcher()
    )
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('keeps stale rows visible while exposing source timestamps per row and page', async () => {
    const generation = '2026-07-18T11:55:00.000Z'
    let rankingQuery: ReturnType<typeof queryResult> | undefined
    let freshnessQuery: ReturnType<typeof queryResult> | undefined
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = queryResult([
          {
            source: 'binance_futures',
            source_trader_id: 'fresh',
            source_type: 'futures',
            handle: 'Fresh',
            roi: 10,
            pnl: 100,
            arena_score: 90,
            rank: 1,
            computed_at: '2026-07-18T11:59:00.000Z',
          },
          {
            source: 'hyperliquid',
            source_trader_id: 'stale',
            source_type: 'web3',
            handle: 'Stale',
            roi: 9,
            pnl: 90,
            arena_score: 80,
            rank: 2,
            computed_at: '2026-07-18T11:59:00.000Z',
          },
        ])
        return rankingQuery
      }
      if (table === 'leaderboard_count_cache') {
        return queryResult([
          { source: '_all_gt0', total_count: 3, updated_at: generation },
          { source: 'binance_futures_gt0', total_count: 1, updated_at: generation },
          { source: 'okx_web3_solana_gt0', total_count: 1, updated_at: generation },
          { source: 'hyperliquid_gt0', total_count: 1, updated_at: generation },
        ])
      }
      if (table === 'leaderboard_source_freshness') {
        freshnessQuery = queryResult([
          {
            source: 'binance_futures',
            source_as_of: '2026-07-18T11:00:00.000Z',
          },
          {
            source: 'okx_web3_solana',
            source_as_of: '2026-07-01T00:00:00.000Z',
          },
          {
            source: 'hyperliquid',
            source_as_of: '2026-07-16T09:00:00.000Z',
          },
        ])
        return freshnessQuery
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unexpected table ${table}`)
    })

    const response = await GET({
      nextUrl: new URL('http://localhost/api/traders?timeRange=90D'),
    } as never)
    const body = await response.json()

    expect(body.lastUpdated).toBe('2026-07-16T09:00:00.000Z')
    expect(body.isStale).toBe(true)
    expect(body.totalCount).toBe(2)
    expect(body.availableSources).toEqual(['binance_futures', 'hyperliquid'])
    expect(body.source_freshness).toHaveLength(2)
    expect(body.traders).toEqual([
      expect.objectContaining({
        source: 'binance_futures',
        updated_at: '2026-07-18T11:00:00.000Z',
        is_stale: false,
        computed_at: '2026-07-18T11:59:00.000Z',
      }),
      expect.objectContaining({
        source: 'hyperliquid',
        updated_at: '2026-07-16T09:00:00.000Z',
        is_stale: true,
        computed_at: '2026-07-18T11:59:00.000Z',
      }),
    ])
    expect(rankingQuery?.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
    )
    expect(freshnessQuery?.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
    )
  })

  it('sanitizes a polluted cache hit without truncating safe rows after the quarantine', async () => {
    const first = { source: 'binance_futures', id: 'first' }
    const last = { source: 'hyperliquid', id: 'last' }
    mockGetOrSetWithLock.mockResolvedValue({
      traders: [first, { source: 'okx_web3_solana', id: 'blocked' }, last],
      timeRange: '90D',
      totalCount: 999,
      hasMore: true,
      nextCursor: 50,
      lastUpdated: 'blocked-aggregate-watermark',
      dataAgeMinutes: 1,
      isStale: false,
      availableSources: ['binance_futures', 'okx_web3_solana', 'hyperliquid'],
      source_freshness: [
        { source: 'binance_futures', updated_at: 'safe' },
        { source: 'okx_web3_solana', updated_at: 'blocked' },
        { source: 'hyperliquid', updated_at: 'safe' },
      ],
    })

    const response = await GET({
      nextUrl: new URL('http://localhost/api/traders?timeRange=90D'),
    } as never)
    const body = await response.json()

    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      expect.stringMatching(/^public-rank-policy-v4:leaderboard:v3:/),
      expect.any(Function),
      expect.any(Object)
    )
    expect(body.traders).toEqual([first, last])
    expect(body.totalCount).toBe(2)
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
    expect(body.lastUpdated).toBeNull()
    expect(body.dataAgeMinutes).toBeNull()
    expect(body.isStale).toBe(true)
    expect(body.availableSources).toEqual(['binance_futures', 'hyperliquid'])
    expect(body.source_freshness.map((row: { source: string }) => row.source)).toEqual([
      'binance_futures',
      'hyperliquid',
    ])
  })

  it('returns an honest empty board for an explicitly quarantined source without DB access', async () => {
    const response = await GET({
      nextUrl: new URL('http://localhost/api/traders?timeRange=90D&exchange=okx_web3_solana'),
    } as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(
      expect.objectContaining({ traders: [], totalCount: 0, availableSources: [] })
    )
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
