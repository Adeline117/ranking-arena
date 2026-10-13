/** @jest-environment node */

const mockFrom = jest.fn()
const queryCalls: string[] = []
const insertedPosts: Array<Record<string, unknown>> = []

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: mockFrom })),
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

import { NextRequest } from 'next/server'
import { GET } from '../route'

type QueryState = { insert?: Record<string, unknown> }
let rankingRows: unknown[] = []
let rankingError: { message: string } | null = null

function verifiedRow(source: string, suffix: string) {
  return {
    season_id: '7D',
    source,
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
    trader_type: null,
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
            if (relation === 'public_ranked_leaderboard') {
              result = { data: rankingRows, error: rankingError }
            }
            if (relation === 'posts') {
              if (state.insert) {
                insertedPosts.push(state.insert)
                result = { data: { id: 'recap-1' }, error: null }
              } else {
                result = { data: null, error: null }
              }
            }
            return Promise.resolve(result).then(resolve, reject)
          }
        }
        return (...args: unknown[]) => {
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

// 18be58f3e paused Arena Bot publication (owner: bot posts are retired). The
// route must fail closed before any ranking read or post write, whatever the
// public cohort would contain, until a publication receipt can prove content.
const PAUSED_PUBLICATION = {
  count: 0,
  skipped: true,
  reason: 'arena_bot_publication_evidence_unavailable',
  ranking_visibility: 'unknown',
}

describe('GET /api/cron/auto-post-weekly-recap public ranking authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    queryCalls.length = 0
    insertedPosts.length = 0
    rankingRows = [
      verifiedRow('binance_futures', 'binance'),
      verifiedRow('hyperliquid', 'hyperliquid'),
      verifiedRow('okx_futures', 'okx'),
    ]
    rankingError = null
    mockFrom.mockImplementation((relation: string) => {
      queryCalls.push(relation)
      return queryChain(relation)
    })
  })

  it('does not read or publish a recap even from a fully verified public cohort', async () => {
    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/auto-post-weekly-recap')
    )

    await expect(response.json()).resolves.toEqual(PAUSED_PUBLICATION)
    expect(queryCalls).toEqual([])
    expect(insertedPosts).toHaveLength(0)
  })

  it('does not read or publish a recap when the cohort is unverified', async () => {
    rankingRows = [{ ...verifiedRow('binance_futures', 'unsafe'), metrics_estimated: true }]

    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/auto-post-weekly-recap')
    )

    await expect(response.json()).resolves.toEqual(PAUSED_PUBLICATION)
    expect(queryCalls).toEqual([])
    expect(insertedPosts).toHaveLength(0)
  })

  it('does not read or publish a recap when the public ranking read would error', async () => {
    rankingError = { message: 'public cohort unavailable' }

    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/auto-post-weekly-recap')
    )

    await expect(response.json()).resolves.toEqual(PAUSED_PUBLICATION)
    expect(queryCalls).toEqual([])
    expect(insertedPosts).toHaveLength(0)
  })
})
