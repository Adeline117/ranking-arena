/** @jest-environment node */

const mockFrom = jest.fn()
const mockListUsers = jest.fn()
const mockSendEmail = jest.fn()
const mockBuildWeeklyDigestEmail = jest.fn()
const queryCalls: string[] = []

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: mockFrom,
    auth: { admin: { listUsers: mockListUsers } },
  })),
}))

jest.mock('@/lib/services/email', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  buildWeeklyDigestEmail: (...args: unknown[]) => mockBuildWeeklyDigestEmail(...args),
}))

jest.mock('@/lib/utils/unsubscribe-token', () => ({
  generateUnsubscribeToken: jest.fn(() => 'unsubscribe-token'),
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

let rankingRows: unknown[] = []
let rankingError: { message: string } | null = null

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

function queryChain(relation: string): unknown {
  const query: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
            let result: unknown = { data: null, error: null }
            if (relation === 'user_profiles') {
              result = { data: [{ id: 'user-1', handle: 'reader' }], error: null }
            }
            if (relation === 'public_ranked_leaderboard') {
              result = { data: rankingRows, error: rankingError }
            }
            if (relation === 'trader_sources') {
              result = { data: null, count: 10, error: null }
            }
            return Promise.resolve(result).then(resolve, reject)
          }
        }
        return () => query
      },
    }
  )
  return query
}

describe('GET /api/cron/weekly-digest public ranking authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    queryCalls.length = 0
    rankingRows = [verifiedRow()]
    rankingError = null
    mockFrom.mockImplementation((relation: string) => {
      queryCalls.push(relation)
      return queryChain(relation)
    })
    mockListUsers.mockResolvedValue({
      data: { users: [{ id: 'user-1', email: 'reader@example.com' }] },
      error: null,
    })
    mockSendEmail.mockResolvedValue(true)
    mockBuildWeeklyDigestEmail.mockReturnValue('<weekly-digest />')
  })

  it('emails movers only from the sealed public cohort and never reads activity text', async () => {
    const response = await GET(new NextRequest('https://www.arenafi.org/api/cron/weekly-digest'))

    await expect(response.json()).resolves.toMatchObject({ count: 1, topMovers: 1 })
    expect(queryCalls).toContain('public_ranked_leaderboard')
    expect(queryCalls).not.toContain('leaderboard_ranks')
    expect(queryCalls).not.toContain('trader_activities')
    expect(mockBuildWeeklyDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        topMovers: [
          {
            name: 'alpha',
            change: '+25.0% ROI',
            link: '/trader/alpha?platform=binance_futures',
          },
        ],
      })
    )
    expect(mockBuildWeeklyDigestEmail.mock.calls[0][0]).not.toHaveProperty('followedActivity')
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it('keeps non-ranking digest content but omits movers for a partial cohort', async () => {
    rankingRows = [{ ...verifiedRow(), metrics_estimated: true }]

    const response = await GET(new NextRequest('https://www.arenafi.org/api/cron/weekly-digest'))

    await expect(response.json()).resolves.toMatchObject({ count: 1, topMovers: 0 })
    expect(queryCalls).toContain('public_ranked_leaderboard')
    expect(queryCalls).not.toContain('leaderboard_ranks')
    expect(queryCalls).not.toContain('trader_activities')
    expect(mockBuildWeeklyDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({ topMovers: [] })
    )
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it('keeps non-ranking digest content but omits movers when the public read errors', async () => {
    rankingError = { message: 'public cohort unavailable' }

    const response = await GET(new NextRequest('https://www.arenafi.org/api/cron/weekly-digest'))

    await expect(response.json()).resolves.toMatchObject({ count: 1, topMovers: 0 })
    expect(queryCalls).toContain('public_ranked_leaderboard')
    expect(queryCalls).not.toContain('leaderboard_ranks')
    expect(queryCalls).not.toContain('trader_activities')
    expect(mockBuildWeeklyDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({ topMovers: [] })
    )
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })
})
