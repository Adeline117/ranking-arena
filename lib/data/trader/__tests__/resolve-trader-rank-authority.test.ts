jest.mock('@/lib/logger', () => ({
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

import { resolveTrader } from '../queries'

type QueryResponse = {
  data?: unknown
  error?: { message: string } | null
}

function resolutionQuery(response: QueryResponse) {
  const query: Record<string, jest.Mock> = {}
  for (const method of ['select', 'or', 'eq', 'in', 'not']) {
    query[method] = jest.fn(() => query)
  }
  query.limit = jest.fn().mockResolvedValue({
    data: response.data ?? [],
    error: response.error ?? null,
  })
  return query
}

function resolverSupabase({
  sourceRows = [],
  publicRows = [],
  profileRows = [],
}: {
  sourceRows?: unknown[]
  publicRows?: unknown[]
  profileRows?: unknown[]
}) {
  const sourceQuery = resolutionQuery({ data: sourceRows })
  const publicQuery = resolutionQuery({ data: publicRows })
  const profileQuery = resolutionQuery({ data: profileRows })
  const from = jest.fn((relation: string) => {
    if (relation === 'trader_sources') return sourceQuery
    if (relation === 'public_ranked_leaderboard') return publicQuery
    if (relation === 'trader_profiles_v2') return profileQuery
    throw new Error(`Unexpected relation ${relation}`)
  })

  return {
    supabase: { from },
    from,
    sourceQuery,
    publicQuery,
    profileQuery,
  }
}

function publishedRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'legacy-id',
    handle: 'Legacy Trader',
    avatar_url: 'https://example.test/legacy.png',
    season_id: '90D',
    rank: 7,
    arena_score: 88,
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

describe('resolveTrader public identity authority', () => {
  it('fails closed for an ambiguous source identity instead of selecting by raw score', async () => {
    const { supabase, from } = resolverSupabase({
      sourceRows: [
        {
          source: 'binance_futures',
          source_trader_id: 'binance-id',
          handle: 'Shared Handle',
          avatar_url: null,
        },
        {
          source: 'bybit',
          source_trader_id: 'bybit-id',
          handle: 'Shared Handle',
          avatar_url: null,
        },
      ],
    })

    await expect(resolveTrader(supabase as never, { handle: 'Shared Handle' })).resolves.toBeNull()

    expect(from).toHaveBeenCalledWith('trader_sources')
    expect(from).not.toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('fails closed when the source identity query reaches its ambiguity sentinel', async () => {
    const sourceRows = Array.from({ length: 101 }, (_, index) => ({
      source: `source-${index}`,
      source_trader_id: `trader-${index}`,
      handle: 'Very Common Handle',
      avatar_url: null,
    }))
    const { supabase, from, sourceQuery } = resolverSupabase({ sourceRows })

    await expect(
      resolveTrader(supabase as never, { handle: 'Very Common Handle' })
    ).resolves.toBeNull()

    expect(sourceQuery.limit).toHaveBeenCalledWith(101)
    expect(from).not.toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('preserves an explicit platform lookup for a unique source identity', async () => {
    const { supabase, from, sourceQuery } = resolverSupabase({
      sourceRows: [
        {
          source: 'bybit',
          source_trader_id: 'bybit-id',
          handle: 'Shared Handle',
          avatar_url: 'https://example.test/bybit.png',
        },
      ],
    })

    await expect(
      resolveTrader(supabase as never, { handle: 'Shared Handle', platform: 'bybit' })
    ).resolves.toEqual({
      platform: 'bybit',
      traderKey: 'bybit-id',
      handle: 'Shared Handle',
      avatarUrl: 'https://example.test/bybit.png',
    })

    expect(sourceQuery.eq).toHaveBeenCalledWith('source', 'bybit')
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('preserves dots in a unique handle and source trader ID filter', async () => {
    const { supabase, sourceQuery } = resolverSupabase({
      sourceRows: [
        {
          source: 'bybit',
          source_trader_id: 'wallet.alpha',
          handle: 'alpha.trader',
          avatar_url: null,
        },
      ],
    })

    await expect(resolveTrader(supabase as never, { handle: 'alpha.trader' })).resolves.toEqual({
      platform: 'bybit',
      traderKey: 'wallet.alpha',
      handle: 'alpha.trader',
      avatarUrl: null,
    })

    expect(sourceQuery.or).toHaveBeenCalledWith(
      'handle.eq.alpha.trader,source_trader_id.eq.alpha.trader'
    )
  })

  it('preserves underscores and percent signs in an exact identity filter', async () => {
    const { supabase, sourceQuery } = resolverSupabase({
      sourceRows: [
        {
          source: 'bybit',
          source_trader_id: 'crypto_king',
          handle: 'crypto_king',
          avatar_url: null,
        },
      ],
    })

    await expect(resolveTrader(supabase as never, { handle: 'crypto_king' })).resolves.toEqual({
      platform: 'bybit',
      traderKey: 'crypto_king',
      handle: 'crypto_king',
      avatarUrl: null,
    })

    expect(sourceQuery.or).toHaveBeenCalledWith(
      'handle.eq.crypto_king,source_trader_id.eq.crypto_king'
    )
  })

  it('recovers a legacy identity only from a sanitized sealed public row', async () => {
    const { supabase, from, publicQuery } = resolverSupabase({
      publicRows: [publishedRow()],
    })

    await expect(resolveTrader(supabase as never, { handle: 'Legacy Trader' })).resolves.toEqual({
      platform: 'binance_futures',
      traderKey: 'legacy-id',
      handle: 'Legacy Trader',
      avatarUrl: 'https://example.test/legacy.png',
    })

    expect(from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(publicQuery.select).toHaveBeenCalledWith(expect.stringContaining('score_completeness'))
    expect(publicQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('does not use an incomplete published row as an identity authority', async () => {
    const { supabase, from } = resolverSupabase({
      publicRows: [
        publishedRow({
          score_completeness: 'partial',
          arena_score: 99,
          roi: 9999,
          pnl: 999999,
        }),
      ],
    })

    await expect(resolveTrader(supabase as never, { handle: 'Legacy Trader' })).resolves.toBeNull()

    expect(from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('fails closed when the sealed fallback has several matching identities', async () => {
    const { supabase, from } = resolverSupabase({
      publicRows: [
        publishedRow({ source: 'binance_futures', source_trader_id: 'binance-id' }),
        publishedRow({ source: 'bybit', source_trader_id: 'bybit-id' }),
      ],
      profileRows: [
        {
          platform: 'binance_futures',
          trader_key: 'binance-id',
          display_name: 'Legacy Trader',
          avatar_url: null,
        },
      ],
    })

    await expect(resolveTrader(supabase as never, { handle: 'Legacy Trader' })).resolves.toBeNull()

    expect(from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('fails closed when either fallback candidate query reaches its ambiguity sentinel', async () => {
    const publicRows = Array.from({ length: 101 }, (_, index) =>
      publishedRow({ source_trader_id: `published-${index}`, handle: 'Common Legacy Handle' })
    )
    const { supabase, publicQuery, profileQuery } = resolverSupabase({
      publicRows,
      profileRows: Array.from({ length: 101 }, (_, index) => ({
        platform: `profile-${index}`,
        trader_key: `profile-${index}`,
        display_name: 'Common Legacy Handle',
        avatar_url: null,
      })),
    })

    await expect(
      resolveTrader(supabase as never, { handle: 'Common Legacy Handle' })
    ).resolves.toBeNull()

    expect(publicQuery.limit).toHaveBeenCalledWith(101)
    expect(profileQuery.limit).toHaveBeenCalledWith(101)
  })

  it('keeps a platform-explicit pure profile fallback when no sealed ranking exists', async () => {
    const { supabase, publicQuery, profileQuery } = resolverSupabase({
      profileRows: [
        {
          platform: 'okx_futures',
          trader_key: 'profile-id',
          display_name: 'Profile Only',
          avatar_url: 'https://example.test/profile.png',
        },
      ],
    })

    await expect(
      resolveTrader(supabase as never, { handle: 'Profile Only', platform: 'okx_futures' })
    ).resolves.toEqual({
      platform: 'okx_futures',
      traderKey: 'profile-id',
      handle: 'Profile Only',
      avatarUrl: 'https://example.test/profile.png',
    })

    expect(publicQuery.eq).toHaveBeenCalledWith('source', 'okx_futures')
    expect(profileQuery.eq).toHaveBeenCalledWith('platform', 'okx_futures')
  })
})
