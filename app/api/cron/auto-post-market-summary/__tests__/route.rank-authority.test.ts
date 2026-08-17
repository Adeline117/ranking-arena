/** @jest-environment node */

const mockFrom = jest.fn()
const queryCalls: string[] = []
const insertedPosts: Array<Record<string, unknown>> = []

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    auth: {
      admin: {
        getUserById: jest.fn().mockResolvedValue({ data: { user: { id: 'arena-bot' } } }),
      },
    },
    from: mockFrom,
  })),
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (
      _jobName: string,
      handler: (request: Request, context: unknown) => Promise<Record<string, unknown>>
    ) =>
    async (request: Request) => {
      const result = await handler(request, {})
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

type QueryState = {
  season?: string
  insert?: Record<string, unknown>
}

let marketRows: unknown[] = []
let rowsBySeason: Record<string, unknown[]> = {}
let rankingErrorsBySeason: Record<string, { message: string } | null> = {}

function verifiedRow(period: '7D' | '30D', suffix: string) {
  return {
    season_id: period,
    source: 'binance_futures',
    source_trader_id: `trader-${suffix}`,
    handle: `alpha-${suffix}`,
    roi: 25,
    pnl: 2_000,
    arena_score: 80,
    rank: 15,
    win_rate: 55,
    max_drawdown: 12,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
  }
}

function queryChain(relation: string): unknown {
  const state: QueryState = {}
  const query: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
            let result: unknown = { data: null, error: null }
            if (relation === 'market_benchmarks') result = { data: marketRows, error: null }
            if (relation === 'public_ranked_leaderboard') {
              const season = state.season ?? ''
              result = {
                data: rowsBySeason[season] ?? [],
                error: rankingErrorsBySeason[season] ?? null,
              }
            }
            if (relation === 'posts') {
              if (state.insert) {
                insertedPosts.push(state.insert)
                result = { data: { id: 'post-1' }, error: null }
              } else {
                result = { data: null, error: null }
              }
            }
            return Promise.resolve(result).then(resolve, reject)
          }
        }
        return (...args: unknown[]) => {
          if (property === 'eq' && args[0] === 'season_id' && typeof args[1] === 'string') {
            state.season = args[1]
          }
          if (property === 'insert' && args[0] && typeof args[0] === 'object') {
            state.insert = args[0] as Record<string, unknown>
          }
          return query
        }
      },
    }
  )
  return query
}

describe('GET /api/cron/auto-post-market-summary public ranking authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    queryCalls.length = 0
    insertedPosts.length = 0
    marketRows = [{ symbol: 'BTC', close_price: 100_000, daily_return_pct: 2.5 }]
    rowsBySeason = {
      '7D': [verifiedRow('7D', '7d')],
      '30D': [verifiedRow('30D', '30d')],
    }
    rankingErrorsBySeason = {}
    mockFrom.mockImplementation((relation: string) => {
      queryCalls.push(relation)
      return queryChain(relation)
    })
  })

  it('writes ranking content only from the sealed public cohort', async () => {
    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/auto-post-market-summary')
    )

    await expect(response.json()).resolves.toMatchObject({ count: 1, postId: 'post-1' })
    expect(queryCalls).toContain('public_ranked_leaderboard')
    expect(queryCalls).not.toContain('leaderboard_ranks')
    expect(insertedPosts).toHaveLength(1)
    expect(insertedPosts[0].content).toContain('Score: 80.0')
    expect(insertedPosts[0].content).toContain('ROI: +25.00%')
  })

  it('posts only safe market data when every ranking row is unverified', async () => {
    rowsBySeason = {
      '7D': [{ ...verifiedRow('7D', 'unsafe'), metrics_estimated: true }],
      '30D': [{ ...verifiedRow('30D', 'unsafe'), metrics_estimated: true }],
    }

    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/auto-post-market-summary')
    )

    await expect(response.json()).resolves.toMatchObject({ count: 1, postId: 'post-1' })
    expect(queryCalls).not.toContain('leaderboard_ranks')
    expect(insertedPosts).toHaveLength(1)
    expect(insertedPosts[0].content).toContain('Verified ranking evidence is unavailable')
    expect(insertedPosts[0].content).not.toContain('Score:')
    expect(insertedPosts[0].content).not.toContain('ROI:')
  })

  it('posts only safe market data when the public ranking read errors', async () => {
    rankingErrorsBySeason = {
      '7D': { message: 'public cohort unavailable' },
      '30D': { message: 'public cohort unavailable' },
    }

    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/auto-post-market-summary')
    )

    await expect(response.json()).resolves.toMatchObject({ count: 1, postId: 'post-1' })
    expect(queryCalls).not.toContain('leaderboard_ranks')
    expect(insertedPosts).toHaveLength(1)
    expect(insertedPosts[0].content).toContain('Verified ranking evidence is unavailable')
    expect(insertedPosts[0].content).not.toContain('Score:')
    expect(insertedPosts[0].content).not.toContain('ROI:')
  })
})
