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

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: jest.fn(
    async (_key: string, fetcher: () => Promise<unknown>) => await fetcher()
  ),
}))

function queryResult(data: unknown[], error: unknown = null, count: number | null = null) {
  const result = { data, error, count }
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

describe('GET /api/v2/rankings source freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses the requested platform watermark instead of its recent score compute time', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        return queryResult(
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
      }
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          {
            source: 'binance_futures',
            source_as_of: '2026-07-16T09:00:00.000Z',
          },
        ])
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
  })
})
