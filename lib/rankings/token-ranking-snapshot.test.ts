const mockTieredGetOrSet = jest.fn()

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))

import {
  POPULAR_TOKEN_PAGE_CONTRACT,
  TOKEN_RANKING_PAGE_CONTRACT,
  TokenRankingReadError,
  getPopularTokenRankingSnapshot,
  getPopularTokenSnapshotCacheKey,
  getTokenTraderRankingSnapshot,
  getTokenTraderSnapshotCacheKey,
  parseTokenRankingGeneration,
  parseTokenRankingPublicationHead,
} from './token-ranking-snapshot'

const PUBLISHED_AT = '2026-07-29T20:00:00.123456+00:00'
const PUBLISHED_AT_EPOCH_MS = Date.parse(PUBLISHED_AT)

function publicationHead(generation = '1', sourceAsOf: string | null = null) {
  return {
    generation_seq: generation,
    published_at: PUBLISHED_AT,
    published_at_epoch_ms: PUBLISHED_AT_EPOCH_MS,
    window_through_date: '2026-07-29',
    source_as_of: sourceAsOf,
    source_through_date: '2026-07-29',
    daily_row_count: '123',
    popular_row_count: '3',
  }
}

function tokenRow(rank = 1) {
  return {
    source: 'hyperliquid',
    source_trader_id: `wallet-${rank}`,
    token_rank: rank,
    token_pnl: '123.45',
    token_trade_count: '9',
    token_win_rate: '55.5',
    token_avg_pnl_pct: null,
  }
}

function publicProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'hyperliquid',
    source_trader_id: 'wallet-1',
    season_id: '90D',
    rank: 42,
    handle: 'Published Alice',
    avatar_url: 'https://example.com/alice.png',
    arena_score: 86,
    roi: 12.5,
    pnl: 456.78,
    win_rate: 61,
    max_drawdown: 18,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function cachedTokenPage(
  generation = '1',
  traderOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    contract: TOKEN_RANKING_PAGE_CONTRACT,
    generation,
    publishedAt: PUBLISHED_AT,
    publishedAtEpochMs: PUBLISHED_AT_EPOCH_MS,
    windowThroughDate: '2026-07-29',
    sourceAsOf: null,
    sourceThroughDate: '2026-07-29',
    dailyRowCount: 123,
    popularRowCount: 3,
    profilePublicationId: 'retired-profile-cache-fence',
    token: 'BTC',
    period: '90D',
    lookbackDays: 90,
    limit: 50,
    offset: 0,
    total: 1,
    traders: [
      {
        source: 'hyperliquid',
        source_trader_id: 'wallet-1',
        handle: 'Stale Alice',
        avatar_url: 'https://example.com/stale.png',
        arena_score: 99,
        roi: 999,
        total_pnl: 999_999,
        token_rank: 1,
        token_pnl: 123.45,
        token_trade_count: 9,
        token_win_rate: 55.5,
        token_avg_pnl_pct: null,
        ...traderOverrides,
      },
    ],
  }
}

function tokenPayload(
  generation = '1',
  options: {
    token?: string
    lookbackDays?: number
    limit?: number
    offset?: number
    total?: number
    traders?: unknown[]
    sourceAsOf?: string | null
  } = {}
) {
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0
  const total = options.total ?? 1
  return {
    contract: TOKEN_RANKING_PAGE_CONTRACT,
    generation,
    published_at: PUBLISHED_AT,
    published_at_epoch_ms: PUBLISHED_AT_EPOCH_MS,
    window_through_date: '2026-07-29',
    source_as_of: options.sourceAsOf ?? null,
    source_through_date: '2026-07-29',
    token: options.token ?? 'BTC',
    lookback_days: options.lookbackDays ?? 90,
    limit,
    offset,
    total,
    traders: options.traders ?? [tokenRow(offset + 1)],
  }
}

function popularPayload(generation = '1', limit = 2) {
  return {
    contract: POPULAR_TOKEN_PAGE_CONTRACT,
    generation,
    published_at: PUBLISHED_AT,
    published_at_epoch_ms: PUBLISHED_AT_EPOCH_MS,
    window_through_date: '2026-07-29',
    source_as_of: null,
    source_through_date: '2026-07-29',
    lookback_days: 90,
    limit,
    total: 3,
    tokens: [
      { token: 'BTC', trade_count: '100', trader_count: '20', total_pnl: '500.5' },
      { token: 'ETH', trade_count: '90', trader_count: '18', total_pnl: '-20' },
    ].slice(0, limit),
  }
}

type RpcResult = { data: unknown; error: unknown }

function makeSupabase(options: {
  heads?: RpcResult[]
  tokenPages?: RpcResult[]
  popularPages?: RpcResult[]
  profiles?: RpcResult
}) {
  const rpcAbortSignal = jest.fn()
  const queues: Record<string, RpcResult[]> = {
    get_token_ranking_publication_head: [...(options.heads ?? [])],
    get_token_trader_rankings_v2: [...(options.tokenPages ?? [])],
    get_popular_tokens_v2: [...(options.popularPages ?? [])],
  }
  const rpc = jest.fn((name: string) => {
    const result = queues[name]?.shift()
    if (!result) throw new Error(`Unexpected RPC ${name}`)
    const promise = Promise.resolve(result) as Promise<RpcResult> & {
      abortSignal: (signal: AbortSignal) => Promise<RpcResult>
    }
    promise.abortSignal = (signal) => {
      rpcAbortSignal(name, signal)
      return promise
    }
    return promise
  })

  const profileResult = options.profiles ?? { data: [], error: null }
  const query: Record<string, jest.Mock | unknown> = {}
  query.select = jest.fn(() => query)
  query.eq = jest.fn(() => query)
  query.in = jest.fn(() => query)
  const profileAbortSignal = jest.fn(() => query)
  query.abortSignal = profileAbortSignal
  query.then = (resolve: (value: RpcResult) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(profileResult).then(resolve, reject)
  const from = jest.fn(() => query)
  return {
    client: { rpc, from } as never,
    rpc,
    from,
    query,
    rpcAbortSignal,
    profileAbortSignal,
  }
}

function expectReadError(error: unknown, kind: TokenRankingReadError['kind']) {
  expect(error).toBeInstanceOf(TokenRankingReadError)
  expect((error as TokenRankingReadError).kind).toBe(kind)
}

describe('token ranking publication parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredGetOrSet.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) =>
      fetcher()
    )
  })

  test('rejects generation zero instead of presenting an empty board', () => {
    expect(() =>
      parseTokenRankingPublicationHead([
        {
          ...publicationHead('0'),
          published_at: null,
          published_at_epoch_ms: null,
          window_through_date: null,
          source_as_of: null,
        },
      ])
    ).toThrow(expect.objectContaining({ kind: 'not_published' }))
  })

  test.each(['0', '01', '-1', '9007199254740001', '1.5', ''])('rejects generation %p', (value) => {
    expect(() => parseTokenRankingGeneration(value)).toThrow(
      expect.objectContaining({ kind: 'invalid_input' })
    )
  })

  test('requires one exact publication-head row with a truthful epoch', () => {
    expect(() =>
      parseTokenRankingPublicationHead([
        { ...publicationHead(), published_at_epoch_ms: PUBLISHED_AT_EPOCH_MS + 1 },
      ])
    ).toThrow(expect.objectContaining({ kind: 'contract' }))
    expect(() => parseTokenRankingPublicationHead([])).toThrow(
      expect.objectContaining({ kind: 'contract' })
    )
  })
})

describe('generation-coordinated token trader reads', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredGetOrSet.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) =>
      fetcher()
    )
  })

  test('returns a strictly parsed G1 page and namespaces its shared cache key', async () => {
    const { client, rpc, query } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [{ data: tokenPayload('1'), error: null }],
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'btc',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(result).toEqual(
      expect.objectContaining({
        contract: TOKEN_RANKING_PAGE_CONTRACT,
        generation: '1',
        sourceAsOf: null,
        profilePublicationId: null,
        total: 1,
        token: 'BTC',
        traders: [expect.objectContaining({ token_rank: 1, token_pnl: 123.45 })],
      })
    )
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'get_token_ranking_publication_head',
      'get_token_trader_rankings_v2',
    ])
    expect(query.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(mockTieredGetOrSet).toHaveBeenCalledWith(
      getTokenTraderSnapshotCacheKey('1', 'BTC', '90D', 50, 0),
      expect.any(Function),
      'cold',
      expect.arrayContaining(['token-ranking-generation:1']),
      expect.objectContaining({ skipMemory: true })
    )
  })

  test('overlays generic profile metrics only from the sealed exact public cohort', async () => {
    const { client, from, query } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [{ data: tokenPayload('1'), error: null }],
      profiles: { data: [publicProfile()], error: null },
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(from).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(from).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(query.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(query.in).toHaveBeenCalledWith('source', ['hyperliquid'])
    expect(query.in).toHaveBeenCalledWith('source_trader_id', ['wallet-1'])
    expect(result.traders).toEqual([
      expect.objectContaining({
        source: 'hyperliquid',
        source_trader_id: 'wallet-1',
        handle: 'Published Alice',
        avatar_url: 'https://example.com/alice.png',
        arena_score: 86,
        roi: 12.5,
        total_pnl: 456.78,
        token_rank: 1,
        token_pnl: 123.45,
      }),
    ])
  })

  test('does not attach a same-id public profile from a different source', async () => {
    const sharedIdRows = [
      { ...tokenRow(1), source: 'hyperliquid', source_trader_id: 'shared-id' },
      { ...tokenRow(2), source: 'bybit', source_trader_id: 'shared-id' },
    ]
    const { client } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [
        {
          data: tokenPayload('1', { total: 2, traders: sharedIdRows }),
          error: null,
        },
      ],
      profiles: {
        data: [
          publicProfile({
            source: 'bybit',
            source_trader_id: 'shared-id',
            handle: 'Bybit profile',
            arena_score: 77,
          }),
        ],
        error: null,
      },
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(result.traders).toEqual([
      expect.objectContaining({
        source: 'hyperliquid',
        source_trader_id: 'shared-id',
        token_rank: 1,
        token_pnl: 123.45,
        handle: null,
        arena_score: null,
        roi: null,
        total_pnl: null,
      }),
      expect.objectContaining({
        source: 'bybit',
        source_trader_id: 'shared-id',
        token_rank: 2,
        token_pnl: 123.45,
        handle: 'Bybit profile',
        arena_score: 77,
        roi: 12.5,
        total_pnl: 456.78,
      }),
    ])
  })

  test('replaces stale cached generic metrics with a live public profile overlay', async () => {
    mockTieredGetOrSet.mockResolvedValue(cachedTokenPage())
    const { client, rpc } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      profiles: {
        data: [
          publicProfile({
            handle: 'Live Alice',
            avatar_url: 'https://example.com/live.png',
            arena_score: 71,
            roi: 7.25,
            pnl: 1234,
          }),
        ],
        error: null,
      },
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['get_token_ranking_publication_head'])
    expect(result.profilePublicationId).toBeNull()
    expect(result.traders).toEqual([
      expect.objectContaining({
        token_rank: 1,
        token_pnl: 123.45,
        handle: 'Live Alice',
        avatar_url: 'https://example.com/live.png',
        arena_score: 71,
        roi: 7.25,
        total_pnl: 1234,
      }),
    ])
  })

  test('drops stale cached generic metrics when the current public cohort is unavailable', async () => {
    mockTieredGetOrSet.mockResolvedValue(
      cachedTokenPage('1', {
        handle: { stale: true },
        avatar_url: 42,
        arena_score: 'not-a-number',
        roi: 'not-a-number',
        total_pnl: 'not-a-number',
      })
    )
    const { client, rpc } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      profiles: { data: null, error: { code: 'PGRST003', message: 'unavailable' } },
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['get_token_ranking_publication_head'])
    expect(result.traders).toEqual([
      expect.objectContaining({
        token_rank: 1,
        token_pnl: 123.45,
        handle: null,
        avatar_url: null,
        arena_score: null,
        roi: null,
        total_pnl: null,
      }),
    ])
  })

  test('preserves the authoritative total on an empty out-of-range page', async () => {
    const { client, from } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [
        {
          data: tokenPayload('1', { offset: 50, total: 12, traders: [] }),
          error: null,
        },
      ],
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 50,
    })

    expect(result).toEqual(expect.objectContaining({ total: 12, traders: [] }))
    expect(from).not.toHaveBeenCalled()
  })

  test('does not use a token-cache fence as a generic profile publication fence', async () => {
    mockTieredGetOrSet.mockImplementation(
      async (
        _key: string,
        fetcher: (writeFence: { key: string; token: string }) => Promise<unknown>
      ) => fetcher({ key: 'public-rankings:write-fence:v1', token: 'profile-fence-7' })
    )
    const { client } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [{ data: tokenPayload('1'), error: null }],
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(result.profilePublicationId).toBeNull()
  })

  test('rereads the head once after an unbound conflict and succeeds on G2', async () => {
    const { client, rpc } = makeSupabase({
      heads: [
        { data: [publicationHead('1')], error: null },
        { data: [publicationHead('2')], error: null },
      ],
      tokenPages: [
        {
          data: null,
          error: { code: '40001', message: 'generation changed', details: '2' },
        },
        { data: tokenPayload('2'), error: null },
      ],
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(result.generation).toBe('2')
    expect(rpc).toHaveBeenCalledTimes(4)
    expect(mockTieredGetOrSet.mock.calls.map(([key]) => key)).toEqual([
      getTokenTraderSnapshotCacheKey('1', 'BTC', '90D', 50, 0),
      getTokenTraderSnapshotCacheKey('2', 'BTC', '90D', 50, 0),
    ])
  })

  test('fails busy after two unbound generation conflicts', async () => {
    const { client } = makeSupabase({
      heads: [
        { data: [publicationHead('1')], error: null },
        { data: [publicationHead('2')], error: null },
      ],
      tokenPages: [
        { data: null, error: { code: '40001', details: '2' } },
        { data: null, error: { code: '40001', details: '3' } },
      ],
    })

    await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    }).catch((error) => expectReadError(error, 'publication_busy'))
  })

  test('rejects a stale explicit generation before cache or page RPC access', async () => {
    const { client, rpc } = makeSupabase({
      heads: [{ data: [publicationHead('2')], error: null }],
    })

    await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
      generation: '1',
    }).catch((error) => {
      expectReadError(error, 'generation_changed')
      expect((error as TokenRankingReadError).currentGeneration).toBe('2')
    })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(mockTieredGetOrSet).not.toHaveBeenCalled()
  })

  test('does not auto-upgrade an explicit generation after a page conflict', async () => {
    const { client, rpc } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [{ data: null, error: { code: '40001', details: '2' } }],
    })

    await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
      generation: '1',
    }).catch((error) => {
      expectReadError(error, 'generation_changed')
      expect((error as TokenRankingReadError).currentGeneration).toBe('2')
    })

    expect(rpc).toHaveBeenCalledTimes(2)
    expect(mockTieredGetOrSet).toHaveBeenCalledTimes(1)
  })

  test('fails closed on a malformed v2 contract rather than caching an empty board', async () => {
    const { client } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [
        { data: { ...tokenPayload('1'), contract: 'token-ranking-page@0' }, error: null },
      ],
    })

    await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    }).catch((error) => expectReadError(error, 'contract'))
  })

  test('keeps token authority while a live public profile lookup is unavailable', async () => {
    const { client } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [{ data: tokenPayload('1'), error: null }],
      profiles: { data: null, error: { code: 'PGRST003', message: 'unavailable' } },
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(result.traders).toEqual([
      expect.objectContaining({
        token_rank: 1,
        token_pnl: 123.45,
        handle: null,
        avatar_url: null,
        arena_score: null,
        roi: null,
        total_pnl: null,
      }),
    ])
  })

  test('keeps malformed profile proof out of the response without withholding token facts', async () => {
    let cacheCommitReached = false
    mockTieredGetOrSet.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) => {
      const value = await fetcher()
      cacheCommitReached = true
      return value
    })
    const { client } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [{ data: tokenPayload('1'), error: null }],
      profiles: {
        data: [publicProfile({ handle: { unsafe: true } })],
        error: null,
      },
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(cacheCommitReached).toBe(true)
    expect(result.traders[0]).toEqual(
      expect.objectContaining({
        token_rank: 1,
        token_pnl: 123.45,
        handle: null,
        arena_score: null,
        roi: null,
        total_pnl: null,
      })
    )
  })

  test('withholds generic fields when the public row fails completeness sanitization', async () => {
    const { client } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [{ data: tokenPayload('1'), error: null }],
      profiles: {
        data: [publicProfile({ metrics_estimated: true })],
        error: null,
      },
    })

    const result = await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    })

    expect(result.traders).toEqual([
      expect.objectContaining({
        token_rank: 1,
        token_pnl: 123.45,
        handle: null,
        avatar_url: null,
        arena_score: null,
        roi: null,
        total_pnl: null,
      }),
    ])
  })

  test('binds one caller deadline to head, v2, and profile enrichment', async () => {
    const controller = new AbortController()
    const { client, rpcAbortSignal, profileAbortSignal } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
      tokenPages: [{ data: tokenPayload('1'), error: null }],
    })

    await getTokenTraderRankingSnapshot(
      client,
      { token: 'BTC', period: '90D', limit: 50, offset: 0 },
      { signal: controller.signal }
    )

    expect(rpcAbortSignal.mock.calls).toEqual([
      ['get_token_ranking_publication_head', controller.signal],
      ['get_token_trader_rankings_v2', controller.signal],
    ])
    expect(profileAbortSignal).toHaveBeenCalledWith(controller.signal)
  })

  test('maps an already-expired shared deadline to the timeout database code', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client } = makeSupabase({
      heads: [{ data: [publicationHead('1')], error: null }],
    })

    await getTokenTraderRankingSnapshot(
      client,
      { token: 'BTC', period: '90D', limit: 50, offset: 0 },
      { signal: controller.signal }
    ).catch((error) => {
      expectReadError(error, 'database')
      expect((error as TokenRankingReadError).databaseCode).toBe('57014')
    })
  })

  test('never serves a cached G1 payload after the directly read head is G2', async () => {
    const stale = {
      contract: TOKEN_RANKING_PAGE_CONTRACT,
      generation: '1',
      publishedAt: PUBLISHED_AT,
      publishedAtEpochMs: PUBLISHED_AT_EPOCH_MS,
      windowThroughDate: '2026-07-29',
      sourceAsOf: null,
      sourceThroughDate: '2026-07-29',
      dailyRowCount: 123,
      popularRowCount: 3,
      profilePublicationId: null,
      token: 'BTC',
      period: '90D',
      lookbackDays: 90,
      limit: 50,
      offset: 0,
      total: 0,
      traders: [],
    }
    mockTieredGetOrSet.mockResolvedValue(stale)
    const { client } = makeSupabase({
      heads: [{ data: [publicationHead('2')], error: null }],
    })

    await getTokenTraderRankingSnapshot(client, {
      token: 'BTC',
      period: '90D',
      limit: 50,
      offset: 0,
    }).catch((error) => expectReadError(error, 'contract'))
  })
})

describe('generation-coordinated popular token reads', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredGetOrSet.mockImplementation(async (_key: string, fetcher: () => Promise<unknown>) =>
      fetcher()
    )
  })

  test('returns authoritative total and generation metadata from v2', async () => {
    const { client } = makeSupabase({
      heads: [{ data: [publicationHead('7')], error: null }],
      popularPages: [{ data: popularPayload('7', 2), error: null }],
    })

    const result = await getPopularTokenRankingSnapshot(client, { limit: 2 })

    expect(result).toEqual(
      expect.objectContaining({
        contract: POPULAR_TOKEN_PAGE_CONTRACT,
        generation: '7',
        sourceAsOf: null,
        total: 3,
        tokens: [
          { token: 'BTC', trade_count: 100, trader_count: 20, total_pnl: 500.5 },
          { token: 'ETH', trade_count: 90, trader_count: 18, total_pnl: -20 },
        ],
      })
    )
    expect(mockTieredGetOrSet).toHaveBeenCalledWith(
      getPopularTokenSnapshotCacheKey('7', 2),
      expect.any(Function),
      'cold',
      expect.arrayContaining(['token-ranking-generation:7']),
      expect.objectContaining({ skipMemory: true })
    )
  })
})
