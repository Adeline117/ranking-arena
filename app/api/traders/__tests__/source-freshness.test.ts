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

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: jest.fn(
    async (_key: string, fetcher: () => Promise<unknown>) => await fetcher()
  ),
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

describe('GET /api/traders source freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('keeps stale rows visible while exposing source timestamps per row and page', async () => {
    const generation = '2026-07-18T11:55:00.000Z'
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        return queryResult([
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
      }
      if (table === 'leaderboard_count_cache') {
        return queryResult([
          { source: '_all_gt0', total_count: 2, updated_at: generation },
          { source: 'binance_futures_gt0', total_count: 1, updated_at: generation },
          { source: 'hyperliquid_gt0', total_count: 1, updated_at: generation },
        ])
      }
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          {
            source: 'binance_futures',
            source_as_of: '2026-07-18T11:00:00.000Z',
          },
          {
            source: 'hyperliquid',
            source_as_of: '2026-07-16T09:00:00.000Z',
          },
        ])
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
  })
})
