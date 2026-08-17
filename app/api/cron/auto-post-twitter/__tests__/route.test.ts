/** @jest-environment node */

const mockFrom = jest.fn()
const mockFormatDailyTopMovers = jest.fn()
const mockPostTweet = jest.fn()
const queryCalls: string[] = []

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: mockFrom })),
}))

jest.mock('@/lib/services/twitter-bot', () => ({
  formatDailyTopMovers: (...args: unknown[]) => mockFormatDailyTopMovers(...args),
  postTweet: (...args: unknown[]) => mockPostTweet(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (
      _jobName: string,
      handler: (request: Request, context: unknown) => Promise<Record<string, unknown>>
    ) =>
    async (request: Request) => {
      const result = await handler(request, { plog: {} })
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      })
    },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function queryChain(result: unknown): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => void) => resolve(result)
        }
        return () => proxy
      },
    }
  )
  return proxy
}

function mockRankingRows(rows: unknown[], error: { message: string } | null = null) {
  mockFrom.mockImplementation((relation: string) => {
    queryCalls.push(relation)
    return queryChain({ data: rows, error })
  })
}

function verifiedRow() {
  return {
    season_id: '7D',
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    handle: 'alpha',
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

describe('GET /api/cron/auto-post-twitter public ranking authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    queryCalls.length = 0
    mockFormatDailyTopMovers.mockReturnValue({ text: 'verified cohort tweet' })
    mockPostTweet.mockResolvedValue('tweet-1')
  })

  it('formats and posts only rows from the sealed public cohort', async () => {
    mockRankingRows([verifiedRow()])

    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/auto-post-twitter')
    )
    const body = await response.json()

    expect(body).toMatchObject({ count: 1, tweetId: 'tweet-1' })
    expect(queryCalls).toEqual(['public_ranked_leaderboard'])
    expect(queryCalls).not.toContain('leaderboard_ranks')
    expect(mockFormatDailyTopMovers).toHaveBeenCalledWith([
      expect.objectContaining({
        source: 'binance_futures',
        source_trader_id: 'trader-1',
        roi: 25,
        pnl: 2_000,
        arena_score: 80,
      }),
    ])
    expect(mockPostTweet).toHaveBeenCalledWith({ text: 'verified cohort tweet' })
  })

  it('does not publish when sanitization finds a partial cohort', async () => {
    mockRankingRows([{ ...verifiedRow(), metrics_estimated: true }])

    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/auto-post-twitter')
    )

    await expect(response.json()).resolves.toEqual({
      count: 0,
      skipped: true,
      reason: 'public ranking cohort unavailable',
    })
    expect(mockFormatDailyTopMovers).not.toHaveBeenCalled()
    expect(mockPostTweet).not.toHaveBeenCalled()
  })

  it('does not publish when the sealed cohort has no rows', async () => {
    mockRankingRows([])

    const response = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/auto-post-twitter')
    )

    await expect(response.json()).resolves.toEqual({
      count: 0,
      skipped: true,
      reason: 'public ranking cohort unavailable',
    })
    expect(mockFormatDailyTopMovers).not.toHaveBeenCalled()
    expect(mockPostTweet).not.toHaveBeenCalled()
  })
})
