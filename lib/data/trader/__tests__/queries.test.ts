/**
 * trader/queries.ts — safeQuery wrapper tests
 *
 * Validates the safeQuery helper that converts Supabase query results
 * into DataResult, handling known non-fatal errors gracefully.
 */

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  }),
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../similar', () => ({
  fetchSimilarTraders: jest.fn().mockResolvedValue([]),
}))

import {
  getLeaderboard,
  getTraderDetail,
  materializePublicSearchTraders,
  safeQuery,
  searchTraders,
  withTimeout,
} from '../queries'

function chainableQuery(response: { data?: Record<string, unknown>[]; error?: unknown } = {}) {
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'in', 'not', 'or', 'gt', 'gte', 'order', 'range']) {
    query[method] = jest.fn(() => query)
  }
  query.abortSignal = jest.fn().mockResolvedValue({
    data: response.data ?? [],
    error: response.error ?? null,
  })
  query.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null })
  return query
}

function detailQuery(response: { data: unknown; error: { message?: string } | null }) {
  const query: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of ['select', 'eq', 'in', 'not', 'order', 'limit']) {
    query[method] = jest.fn(() => query)
  }
  query.abortSignal = jest.fn(() => query)
  query.maybeSingle = jest.fn().mockResolvedValue(response)
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject)
  return query
}

function publicRankRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    season_id: '90D',
    rank: 1,
    arena_score: 90,
    roi: 12.5,
    pnl: 5000,
    win_rate: 62,
    max_drawdown: 9,
    trades_count: 42,
    followers: 12,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function publicSearchQuery(response: { data: unknown[]; error?: { message: string } | null }) {
  const query: Record<string, jest.Mock | ((...args: unknown[]) => Promise<unknown>)> = {}
  for (const method of ['select', 'eq', 'in', 'not']) {
    query[method] = jest.fn(() => query)
  }
  query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: response.data, error: response.error ?? null }).then(resolve, reject)
  return query
}

function searchIdentityQuery(response: { data: unknown[]; error?: { message: string } | null }) {
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'or', 'eq']) {
    query[method] = jest.fn(() => query)
  }
  query.limit = jest.fn().mockResolvedValue({ data: response.data, error: response.error ?? null })
  return query
}

describe('safeQuery', () => {
  it('successful query → { ok: true, data: result }', async () => {
    const result = await safeQuery(async () => ({
      data: { id: 1, name: 'test' },
      error: null,
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ id: 1, name: 'test' })
    }
  })

  it('successful query returning null data → { ok: true, data: null }', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: null,
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('query error 42P01 (table not exist) → { ok: true, data: null } (graceful)', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { code: '42P01', message: 'relation "foo" does not exist' },
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('query error "does not exist" message → { ok: true, data: null } (graceful)', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { message: 'table does not exist' },
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('query error "relation" in message → { ok: true, data: null } (graceful)', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { message: 'relation "trader_snapshots_v3" not found' },
    }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toBeNull()
    }
  })

  it('query error (other) → { ok: false, error: message }', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('duplicate key value violates unique constraint')
    }
  })

  it('query error with no message → { ok: false, error: "Unknown query error" }', async () => {
    const result = await safeQuery(async () => ({
      data: null,
      error: { code: '99999' },
    }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Unknown query error')
    }
  })

  it('unexpected exception (Error) → { ok: false, error: message }', async () => {
    const result = await safeQuery(async () => {
      throw new Error('connection timeout')
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('connection timeout')
    }
  })

  it('unexpected exception (string) → { ok: false, error: message }', async () => {
    const result = await safeQuery(async () => {
      throw 'some string error'
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Unexpected query error')
    }
  })
})

describe('withTimeout', () => {
  it('resolves before timeout → returns result', async () => {
    const result = await withTimeout(Promise.resolve('hello'), 5000)
    expect(result).toBe('hello')
  })

  it('exceeds timeout → rejects with timeout error', async () => {
    const slowPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve('too late'), 5000)
    )
    await expect(withTimeout(slowPromise, 10)).rejects.toThrow('Query timeout after 10ms')
  })
})

describe('public search cohort materialization', () => {
  it('projects rank metrics only from the current sealed view', async () => {
    const query = publicSearchQuery({
      data: [
        publicRankRow({
          source_trader_id: 'verified-trader',
          handle: 'Published handle',
          arena_score: 84,
          roi: 17.5,
          pnl: 4200,
          rank: 7,
        }),
      ],
    })
    const supabase = { from: jest.fn(() => query) }

    const result = await materializePublicSearchTraders(supabase as never, [
      {
        platform: 'binance_futures',
        traderKey: 'verified-trader',
        handle: 'Search identity',
        avatarUrl: null,
      },
    ])

    expect(supabase.from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(supabase.from).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(query.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(query.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      platform: 'binance_futures',
      traderKey: 'verified-trader',
      handle: 'Search identity',
      rank: 7,
      roi: 17.5,
      pnl: 4200,
      arenaScore: 84,
    })
  })

  it('keeps identity-only candidates when current proof is missing, partial, or quarantined', async () => {
    const query = publicSearchQuery({
      data: [
        publicRankRow({
          source_trader_id: 'partial-trader',
          score_completeness: 'partial',
          arena_score: 99,
          roi: 999,
          pnl: 999999,
          rank: 1,
        }),
      ],
    })
    const supabase = { from: jest.fn(() => query) }

    const result = await materializePublicSearchTraders(supabase as never, [
      {
        platform: 'binance_futures',
        traderKey: 'partial-trader',
        handle: 'Partial candidate',
        avatarUrl: null,
      },
      {
        platform: 'binance_futures',
        traderKey: 'missing-trader',
        handle: 'Missing candidate',
        avatarUrl: null,
      },
      {
        platform: 'okx_web3_solana',
        traderKey: 'quarantined-trader',
        handle: 'Quarantined candidate',
        avatarUrl: null,
      },
    ])

    expect(query.in).toHaveBeenCalledWith('source', ['binance_futures'])
    expect(result.map((trader) => trader.handle)).toEqual([
      'Partial candidate',
      'Missing candidate',
      'Quarantined candidate',
    ])
    for (const trader of result) {
      expect(trader).toMatchObject({
        rank: null,
        roi: null,
        pnl: null,
        arenaScore: null,
        scoreConfidence: null,
      })
    }
  })

  it('does not trust fuzzy RPC metric or relevance fields, or query leaderboard_ranks', async () => {
    const publicQuery = publicSearchQuery({
      data: [
        publicRankRow({
          source_trader_id: 'fuzzy-trader',
          rank: 12,
          arena_score: 73,
          roi: 8.25,
          pnl: 100,
        }),
      ],
    })
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: [
          {
            source: 'binance_futures',
            source_trader_id: 'fuzzy-trader',
            handle: 'Fuzzy Trader',
            avatar_url: null,
            relevance_score: 500,
            // These are deliberately hostile index/RPC values. The helper
            // must never project, admit, or order by them.
            arena_score: 100,
            roi: 9999,
            pnl: 999999,
            rank: 1,
          },
        ],
        error: null,
      }),
      from: jest.fn(() => publicQuery),
    }

    const result = await searchTraders(supabase as never, { query: 'fuzzy', limit: 5 })

    expect(supabase.from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(supabase.from).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(result[0]).toMatchObject({
      rank: 12,
      arenaScore: 73,
      roi: 8.25,
      pnl: 100,
    })
  })

  it('does not admit a fuzzy RPC candidate solely from its raw relevance score', async () => {
    const identityQuery = searchIdentityQuery({ data: [] })
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: [
          {
            source: 'binance_futures',
            source_trader_id: 'unrelated-trader',
            handle: 'Unrelated identity',
            avatar_url: null,
            relevance_score: 999999,
          },
        ],
        error: null,
      }),
      from: jest.fn(() => identityQuery),
    }

    const result = await searchTraders(supabase as never, { query: 'needle', limit: 5 })

    expect(result).toEqual([])
    expect(supabase.from).toHaveBeenCalledWith('trader_sources')
    expect(supabase.from).not.toHaveBeenCalledWith('public_ranked_leaderboard')
  })

  it('uses stable identity ordering when text matches tie despite conflicting raw relevance', async () => {
    const publicQuery = publicSearchQuery({
      data: [
        publicRankRow({
          source_trader_id: 'alpha-a',
          rank: 10,
          arena_score: 70,
          roi: 3,
          pnl: 50,
        }),
        publicRankRow({
          source_trader_id: 'alpha-b',
          rank: 2,
          arena_score: 90,
          roi: 30,
          pnl: 500,
        }),
      ],
    })
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: [
          {
            source: 'binance_futures',
            source_trader_id: 'alpha-a',
            handle: 'Alpha One',
            avatar_url: null,
            relevance_score: 1,
          },
          {
            source: 'binance_futures',
            source_trader_id: 'alpha-b',
            handle: 'Alpha Two',
            avatar_url: null,
            relevance_score: 999999,
          },
        ],
        error: null,
      }),
      from: jest.fn(() => publicQuery),
    }

    const result = await searchTraders(supabase as never, { query: 'alpha', limit: 5 })

    expect(result.map((trader) => trader.traderKey)).toEqual(['alpha-a', 'alpha-b'])
  })

  it('finds names containing LIKE wildcards: escapes once for SQL, matches raw text in JS', async () => {
    const publicQuery = publicSearchQuery({
      data: [publicRankRow({ source_trader_id: 'john_doe', rank: 1, arena_score: 80 })],
    })
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: [
          {
            source: 'binance_futures',
            source_trader_id: 'john_doe',
            handle: 'john_doe',
            avatar_url: null,
            relevance_score: 1,
          },
        ],
        error: null,
      }),
      from: jest.fn(() => publicQuery),
    }

    const result = await searchTraders(supabase as never, { query: 'john_doe', limit: 5 })

    expect(supabase.rpc).toHaveBeenCalledWith(
      'search_traders_fuzzy',
      expect.objectContaining({ search_query: 'john\\_doe' })
    )
    expect(result.map((trader) => trader.traderKey)).toEqual(['john_doe'])
  })
})

describe('getLeaderboard public cohort view', () => {
  it('filters the public cohort in SQL before range and does not request an exact count', async () => {
    const leaderboardQuery = chainableQuery({
      data: [
        {
          source_trader_id: 'safe-trader',
          handle: 'Safe Trader',
          source: 'binance_futures',
          source_type: 'futures',
          roi: 12,
          pnl: 1000,
          win_rate: 60,
          max_drawdown: 10,
          arena_score: 90,
          rank: 1,
          computed_at: '2026-08-16T00:00:00.000Z',
          score_completeness: 'full',
          is_outlier: false,
          season_id: '90D',
        },
      ],
    })
    const signal = new AbortController().signal
    const supabase = {
      from: jest.fn(() => leaderboardQuery),
    }

    const result = await getLeaderboard(supabase as never, {
      period: '90D',
      platform: 'binance_futures',
      allowedSources: ['binance_futures'],
      excludeSources: ['okx_web3_solana'],
      limit: 20,
      minScore: 50,
      signal,
    })

    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(leaderboardQuery.select).toHaveBeenCalledWith(
      expect.stringContaining('source_trader_id')
    )
    expect(leaderboardQuery.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot,bingx,bingx_spot)'
    )
    expect(leaderboardQuery.in).toHaveBeenCalledWith('source', ['binance_futures'])
    expect(leaderboardQuery.eq).toHaveBeenCalledWith('source', 'binance_futures')
    expect(leaderboardQuery.gt).toHaveBeenCalledWith('arena_score', 50)
    expect(leaderboardQuery.range).toHaveBeenCalledWith(0, 20)
    expect(leaderboardQuery.abortSignal).toHaveBeenCalledWith(signal)
    expect(result.total).toBeUndefined()
    expect(result.totalCountIsExact).toBe(false)
    expect(result.hasMore).toBe(false)
    expect(result.traders).toHaveLength(1)

    const filterCallOrders = [
      ...leaderboardQuery.eq.mock.invocationCallOrder,
      ...leaderboardQuery.in.mock.invocationCallOrder,
      ...leaderboardQuery.not.mock.invocationCallOrder,
      ...leaderboardQuery.gt.mock.invocationCallOrder,
      ...leaderboardQuery.gte.mock.invocationCallOrder,
    ]
    expect(Math.max(...filterCallOrders)).toBeLessThan(
      leaderboardQuery.range.mock.invocationCallOrder[0]
    )
  })

  it('uses one view-scoped lookahead row for pagination without a count cache', async () => {
    const leaderboardQuery = chainableQuery({
      data: [
        { source: 'binance_futures', source_trader_id: 'one', rank: 1, season_id: '7D' },
        { source: 'binance_futures', source_trader_id: 'two', rank: 2, season_id: '7D' },
        { source: 'binance_futures', source_trader_id: 'three', rank: 3, season_id: '7D' },
      ],
    })
    const supabase = { from: jest.fn(() => leaderboardQuery) }

    const result = await getLeaderboard(supabase as never, {
      period: '7D',
      limit: 2,
    })

    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(leaderboardQuery.range).toHaveBeenCalledWith(0, 2)
    expect(result.traders.map((trader) => trader.traderKey)).toEqual(['one', 'two'])
    expect(result.hasMore).toBe(true)
    expect(result.total).toBeUndefined()
    expect(result.totalCountIsExact).toBe(false)
    expect(leaderboardQuery.maybeSingle).not.toHaveBeenCalled()
  })

  it.each(['okx_web3_solana', 'bitget_bots_futures', 'bitget_bots_spot'])(
    'does not query quarantined platform %s',
    async (platform) => {
      const from = jest.fn()
      const result = await getLeaderboard({ from } as never, { platform })
      expect(result).toEqual({
        traders: [],
        totalCountIsExact: false,
        hasMore: false,
      })
      expect(from).not.toHaveBeenCalled()
    }
  )
})

function traderDetailSupabase(publicRows: unknown[]) {
  const emptyRows = () => detailQuery({ data: [], error: null })
  const queries = new Map<string, Array<ReturnType<typeof detailQuery>>>([
    ['public_ranked_leaderboard', [detailQuery({ data: publicRows, error: null })]],
    [
      'trader_sources',
      [
        detailQuery({
          data: {
            source_trader_id: 'trader-1',
            handle: 'Trader One',
            profile_url: 'https://example.test/trader-1',
            avatar_url: 'https://example.test/avatar.png',
            market_type: 'futures',
          },
          error: null,
        }),
        detailQuery({ data: { created_at: '2026-08-15T00:00:00.000Z' }, error: null }),
      ],
    ],
    ['trader_profiles_v2', [detailQuery({ data: null, error: null })]],
    ['trader_equity_curve', [emptyRows()]],
    ['trader_asset_breakdown', [emptyRows()]],
    ['trader_stats_detail', [emptyRows()]],
    ['trader_portfolio', [emptyRows()]],
    ['trader_position_summary', [detailQuery({ data: null, error: null })]],
  ])
  const from = jest.fn((relation: string) => {
    const queued = queries.get(relation)
    if (!queued || queued.length === 0) {
      throw new Error(`Unexpected relation ${relation}`)
    }
    return queued.shift()!
  })
  return { from }
}

describe('getTraderDetail public profile cohort', () => {
  it('uses the sealed view for every public rank-derived profile metric', async () => {
    const supabase = traderDetailSupabase([publicRankRow()])

    const result = await getTraderDetail(supabase as never, {
      platform: 'binance_futures',
      traderKey: 'trader-1',
    })

    expect(supabase.from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(supabase.from).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(result?.trader).toMatchObject({
      handle: 'Trader One',
      rank: 1,
      roi: 12.5,
      arenaScore: 90,
      tradesCount: 42,
    })
    expect(result?.periods['90D']).toMatchObject({ rank: 1, roi: 12.5, arenaScore: 90 })
  })

  it('does not read retained history, price, PnL, or raw-stat tables for a public profile', async () => {
    const supabase = traderDetailSupabase([publicRankRow()])

    const result = await getTraderDetail(supabase as never, {
      platform: 'binance_futures',
      traderKey: 'trader-1',
      publicProfileHistoryQuarantine: true,
    })

    for (const relation of [
      'trader_equity_curve',
      'trader_asset_breakdown',
      'trader_stats_detail',
      'trader_portfolio',
      'trader_position_summary',
    ]) {
      expect(supabase.from).not.toHaveBeenCalledWith(relation)
    }
    expect(result?.equityCurve).toEqual({ '7D': [], '30D': [], '90D': [] })
    expect(result?.assetBreakdown).toEqual({ '7D': [], '30D': [], '90D': [] })
    expect(result?.stats).toBeNull()
    expect(result?.portfolio).toEqual([])
    expect(result?.positionSummary).toBeNull()
  })

  it('keeps a known profile but nulls ranking fields when its public row is unavailable', async () => {
    const supabase = traderDetailSupabase([])

    const result = await getTraderDetail(supabase as never, {
      platform: 'binance_futures',
      traderKey: 'trader-1',
    })

    expect(result).not.toBeNull()
    expect(result?.trader).toMatchObject({
      handle: 'Trader One',
      rank: null,
      roi: null,
      pnl: null,
      arenaScore: null,
      tradesCount: null,
    })
    expect(result?.periods).toEqual({ '7D': null, '30D': null, '90D': null })
    expect(supabase.from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('keeps a non-rankable source profile while skipping its public ranking query', async () => {
    const supabase = traderDetailSupabase([])

    const result = await getTraderDetail(supabase as never, {
      platform: 'okx_web3_solana',
      traderKey: 'trader-1',
    })

    expect(result?.trader).toMatchObject({ handle: 'Trader One', rank: null, roi: null })
    expect(supabase.from).not.toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(supabase.from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })
})
