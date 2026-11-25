const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
}))

jest.mock('../ResultPageClient', () => ({
  __esModule: true,
  default: 'quiz-result-client',
}))

import QuizResultPage from '../page'

function publicRankedRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'quiz-trader',
    handle: 'Verified Quiz Trader',
    avatar_url: 'https://images.example/quiz-trader.png',
    season_id: '90D',
    rank: 7,
    roi: 12.5,
    arena_score: 83,
    pnl: 1000,
    win_rate: 61,
    max_drawdown: 14,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function publicRankedQuery(result: { data: unknown[] | null; error: { message: string } | null }) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    not: jest.fn(),
    order: jest.fn(),
    limit: jest.fn().mockResolvedValue(result),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.not.mockReturnValue(query)
  query.order.mockReturnValue(query)
  return query
}

function quizProps(type = 'sniper') {
  return {
    searchParams: Promise.resolve({ type }),
  }
}

describe('/quiz/result public recommendation authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses only the sealed public cohort for score-bearing trader recommendations', async () => {
    const query = publicRankedQuery({ data: [publicRankedRow()], error: null })
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard') return query
      throw new Error(`unexpected relation: ${relation}`)
    })

    const page = (await QuizResultPage(quizProps())) as {
      props: { recommendedTraders: Array<Record<string, unknown>> }
    }

    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(query.select).toHaveBeenCalledWith(
      'source,source_trader_id,handle,avatar_url,roi,arena_score,win_rate,pnl,rank,season_id,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at'
    )
    expect(query.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(page.props.recommendedTraders).toEqual([
      {
        handle: 'Verified Quiz Trader',
        name: 'Verified Quiz Trader',
        avatar_url: 'https://images.example/quiz-trader.png',
        platform: 'binance_futures',
        roi_90d: 12.5,
        arena_score: 83,
        win_rate: 61,
        pnl_90d: 1000,
      },
    ])
  })

  it('keeps a ranked trader without a win rate in the recommendation cohort', async () => {
    const query = publicRankedQuery({
      data: [
        publicRankedRow(),
        publicRankedRow({
          source_trader_id: 'no-win-rate',
          handle: 'No Win Rate',
          rank: 8,
          win_rate: null,
          score_completeness: 'partial',
        }),
        publicRankedRow({
          source_trader_id: 'roi-pnl-only',
          handle: 'ROI PnL Only',
          rank: 9,
          roi: -4,
          pnl: -80,
          win_rate: null,
          max_drawdown: null,
          score_completeness: 'minimal',
        }),
      ],
      error: null,
    })
    mockFrom.mockImplementation(() => query)

    const page = (await QuizResultPage(quizProps('narrator'))) as {
      props: { recommendedTraders: Array<Record<string, unknown>> }
    }

    expect(page.props.recommendedTraders.map((trader) => [trader.handle, trader.win_rate])).toEqual(
      [
        ['Verified Quiz Trader', 61],
        ['No Win Rate', null],
        ['ROI PnL Only', null],
      ]
    )
  })

  it('fails closed instead of replacing an unproved top-three row with a lower recommendation', async () => {
    const query = publicRankedQuery({
      data: [
        publicRankedRow({ source_trader_id: 'safe-row', handle: 'Safe Row' }),
        publicRankedRow({
          source_trader_id: 'partial-row',
          handle: 'Partial Row',
          rank: 8,
          metrics_estimated: true,
        }),
      ],
      error: null,
    })
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard') return query
      throw new Error(`unexpected relation: ${relation}`)
    })

    const page = (await QuizResultPage(quizProps())) as {
      props: { recommendedTraders: Array<Record<string, unknown>> }
    }

    expect(page.props.recommendedTraders).toEqual([])
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
  })
})
