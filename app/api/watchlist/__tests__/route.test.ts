const mockFrom = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Headers()

    constructor(
      private readonly body: unknown,
      init: { status?: number } = {}
    ) {
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: 'user-1' },
        supabase: { from: mockFrom },
        request,
      }),
}))

jest.mock('@/lib/utils/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { createLogger: () => logger, logger }
})

function watchlistQuery(result: { data: unknown[] | null; error: unknown }) {
  const builder: Record<string, jest.Mock> = {}
  builder.select = jest.fn(() => builder)
  builder.eq = jest.fn(() => builder)
  builder.order = jest.fn(() => builder)
  builder.in = jest.fn(() => builder)
  builder.not = jest.fn(() => builder)
  builder.limit = jest.fn().mockResolvedValue(result)
  return builder
}

function publicRankedRow(row: Record<string, unknown>) {
  return {
    source: 'bybit',
    source_trader_id: 'trader-1',
    roi: 10,
    pnl: 100,
    rank: 1,
    arena_score: 80,
    win_rate: 60,
    avatar_url: 'https://example.com/published.png',
    max_drawdown: 5,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    season_id: '90D',
    ...row,
  }
}

import { GET } from '../route'

describe('GET /api/watchlist availability', () => {
  beforeEach(() => jest.clearAllMocks())

  it('keeps a real empty watchlist as a successful empty result', async () => {
    mockFrom.mockReturnValue(watchlistQuery({ data: [], error: null }))

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ watchlist: [] })
  })

  it('enriches a saved trader only from the published complete cohort', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_watchlist') {
        return watchlistQuery({
          data: [
            {
              source: 'bybit',
              source_trader_id: 'trader-1',
              handle: 'Saved identity',
              created_at: '2026-08-17T00:00:00.000Z',
            },
          ],
          error: null,
        })
      }
      if (table === 'public_ranked_leaderboard') {
        return watchlistQuery({ data: [publicRankedRow({})], error: null })
      }
      throw new Error(`unexpected relation ${table}`)
    })

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      watchlist: [
        expect.objectContaining({
          source: 'bybit',
          source_trader_id: 'trader-1',
          handle: 'Saved identity',
          rank: 1,
          roi: 10,
          pnl: 100,
          arena_score: 80,
          win_rate: 60,
          avatar_url: 'https://example.com/published.png',
          ranking_visibility: 'verified',
          ranking_visibility_reason: null,
        }),
      ],
    })
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('keeps the saved identity but clears an incomplete ranking row', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_watchlist') {
        return watchlistQuery({
          data: [
            {
              source: 'bybit',
              source_trader_id: 'partial-trader',
              handle: 'Saved identity',
              created_at: '2026-08-17T00:00:00.000Z',
            },
          ],
          error: null,
        })
      }
      if (table === 'public_ranked_leaderboard') {
        return watchlistQuery({
          data: [
            publicRankedRow({
              source_trader_id: 'partial-trader',
              roi: 777,
              pnl: 999,
              rank: 1,
              arena_score: 99,
              score_completeness: 'partial',
            }),
          ],
          error: null,
        })
      }
      throw new Error(`unexpected relation ${table}`)
    })

    const response = await GET({} as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      watchlist: [
        expect.objectContaining({
          source: 'bybit',
          source_trader_id: 'partial-trader',
          handle: 'Saved identity',
          rank: null,
          roi: null,
          pnl: null,
          arena_score: null,
          win_rate: null,
          avatar_url: null,
          ranking_visibility: 'partial',
          ranking_visibility_reason: 'public_cohort_unverified',
        }),
      ],
    })
    expect(JSON.stringify(body)).not.toContain('777')
    expect(JSON.stringify(body)).not.toContain('999')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('returns saved identity with unknown ranking fields when the public cohort is unavailable', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_watchlist') {
        return watchlistQuery({
          data: [
            {
              source: 'bybit',
              source_trader_id: 'unavailable-trader',
              handle: 'Saved identity',
              created_at: '2026-08-17T00:00:00.000Z',
            },
          ],
          error: null,
        })
      }
      if (table === 'public_ranked_leaderboard') {
        return watchlistQuery({ data: null, error: { message: 'view unavailable' } })
      }
      throw new Error(`unexpected relation ${table}`)
    })

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      watchlist: [
        expect.objectContaining({
          source: 'bybit',
          source_trader_id: 'unavailable-trader',
          handle: 'Saved identity',
          rank: null,
          roi: null,
          pnl: null,
          arena_score: null,
          ranking_visibility: 'unknown',
          ranking_visibility_reason: 'public_cohort_unavailable',
        }),
      ],
    })
  })

  it.each([
    { code: 'PGRST205', message: 'Could not find the table' },
    { code: '42P01', message: 'relation does not exist' },
  ])('returns 503 instead of a fabricated empty list for $code', async (databaseError) => {
    mockFrom.mockReturnValue(watchlistQuery({ data: null, error: databaseError }))

    const response = await GET({} as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Watchlist is temporarily unavailable (feature table missing)',
      },
    })
  })

  it('keeps unrelated database failures distinct from a real empty list', async () => {
    mockFrom.mockReturnValue(
      watchlistQuery({ data: null, error: { code: 'XX000', message: 'database unavailable' } })
    )

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR' },
    })
  })
})
