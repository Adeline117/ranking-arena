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
  withPublic: (handler: (context: unknown) => unknown) => (request: { url: string }) =>
    handler({ supabase: { from: mockFrom }, request }),
}))

const mockGetOrSetWithLock = jest.fn()
jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))

function queryResult(data: unknown[], error: unknown = null, count: number | null = null) {
  const result = { data, error, count }
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
import { EXCHANGE_SLUG_ALIASES, PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { RETIRED_SOURCES } from '@/lib/constants/retired-sources'
import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'

describe('GET /api/v2/rankings source freshness', () => {
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

  it('uses the requested platform watermark instead of its recent score compute time', async () => {
    let rankingQuery: ReturnType<typeof queryResult> | undefined
    let freshnessQuery: ReturnType<typeof queryResult> | undefined
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = queryResult(
          [
            {
              source: 'binance_futures',
              source_trader_id: 'trader',
              source_type: 'futures',
              handle: 'Trader',
              roi: 10,
              pnl: 100,
              arena_score: 90,
              rank: 1,
              computed_at: '2026-07-18T11:59:00.000Z',
              season_id: '90D',
            },
          ],
          null,
          1
        )
        return rankingQuery
      }
      if (table === 'leaderboard_source_freshness') {
        freshnessQuery = queryResult([
          {
            source: 'binance_futures',
            source_as_of: '2026-07-16T09:00:00.000Z',
          },
        ])
        return freshnessQuery
      }
      throw new Error(`unexpected table ${table}`)
    })

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures',
    } as never)
    const body = await response.json()

    expect(body.meta).toEqual(
      expect.objectContaining({
        updated_at: '2026-07-16T09:00:00.000Z',
        staleness_seconds: 51 * 3600,
        is_stale: true,
      })
    )
    expect(body.traders[0]).toEqual(
      expect.objectContaining({
        updated_at: '2026-07-16T09:00:00.000Z',
        is_stale: true,
        computed_at: '2026-07-18T11:59:00.000Z',
      })
    )
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

  it('sanitizes a polluted cache hit and epochs the reader/writer key together', async () => {
    const first = { source: 'binance_futures', source_trader_id: 'first' }
    const last = { source: 'binance_futures', source_trader_id: 'last' }
    mockGetOrSetWithLock.mockResolvedValue({
      traders: [first, { source: 'okx_web3_solana', source_trader_id: 'blocked' }, last],
      meta: {
        platform: 'binance_futures',
        market_type: 'futures',
        window: '90d',
        total_count: 999,
        updated_at: 'blocked-aggregate-watermark',
        staleness_seconds: 1,
        is_stale: false,
        source_freshness: [
          { source: 'binance_futures', updated_at: 'safe' },
          { source: 'okx_web3_solana', updated_at: 'blocked' },
        ],
      },
    })

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures',
    } as never)
    const body = await response.json()

    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      expect.stringMatching(/^public-rank-policy-v3:v2-rankings:v3:/),
      expect.any(Function),
      expect.any(Object)
    )
    expect(body.traders).toEqual([first, last])
    expect(body.meta.total_count).toBe(2)
    expect(body.meta.updated_at).toBeNull()
    expect(body.meta.staleness_seconds).toBeNull()
    expect(body.meta.is_stale).toBe(true)
    expect(body.meta.source_freshness).toEqual([{ source: 'binance_futures', updated_at: 'safe' }])
  })

  it.each(PUBLIC_ACTIVE_RANKING_SOURCES)(
    'accepts canonical active platform %s at the v2 public API boundary',
    async (platform) => {
      mockFrom.mockImplementation(() => queryResult([]))

      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)

      expect(response.status).toBe(200)
    }
  )

  it.each(PUBLIC_RANKING_QUARANTINED_SOURCES)(
    'returns 200 empty for quarantined platform %s without DB or cache access',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.traders).toEqual([])
      expect(body.meta).toEqual(expect.objectContaining({ platform, total_count: 0 }))
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each([...RETIRED_SOURCES])(
    'rejects retired platform %s before cache or database access',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each(Object.keys(EXCHANGE_SLUG_ALIASES))(
    'rejects non-canonical platform alias %s consistently',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${encodeURIComponent(platform)}`,
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('continues to reject unknown platforms', async () => {
    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=fake_exchange',
    } as never)

    expect(response.status).toBe(400)
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
