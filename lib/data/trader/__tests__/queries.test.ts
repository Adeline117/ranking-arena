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

const mockReadSealedRankingGeneration = jest.fn()
const mockReadSealedRankingAuthorityGeneration = jest.fn()
const mockReadSealedRankIdentities = jest.fn()
const mockReadPublicationAuthority = jest.fn()

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
}))

jest.mock('@/lib/rankings/read-publication-authority', () => ({
  readLeaderboardPublicationAuthority: (...args: unknown[]) =>
    mockReadPublicationAuthority(...args),
}))

jest.mock('@/lib/rankings/read-sealed-rank-identities', () => ({
  readSealedRankIdentities: (...args: unknown[]) => mockReadSealedRankIdentities(...args),
}))

import { getLeaderboard, resolveTrader, safeQuery, searchTraders, withTimeout } from '../queries'

function chainableQuery() {
  const query: Record<string, jest.Mock> = {}
  for (const method of [
    'select',
    'eq',
    'filter',
    'in',
    'not',
    'or',
    'gt',
    'gte',
    'order',
    'range',
  ]) {
    query[method] = jest.fn(() => query)
  }
  query.abortSignal = jest.fn().mockResolvedValue({ data: [], error: null })
  query.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null })
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

describe('getLeaderboard source exclusion', () => {
  it('applies an exclusion before the finite DB page even with a platform filter', async () => {
    const leaderboardQuery = chainableQuery()
    const countQuery = chainableQuery()
    const signal = new AbortController().signal
    const supabase = {
      from: jest.fn((table: string) =>
        table === 'leaderboard_ranks' ? leaderboardQuery : countQuery
      ),
    }

    await getLeaderboard(supabase as never, {
      period: '90D',
      platform: 'binance_futures',
      excludeSources: ['okx_web3_solana'],
      limit: 20,
      signal,
    })

    expect(leaderboardQuery.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
    )
    expect(leaderboardQuery.eq).toHaveBeenCalledWith('source', 'binance_futures')
    expect(leaderboardQuery.order.mock.calls).toEqual([
      ['rank', { ascending: true, nullsFirst: false }],
      ['source_trader_id', { ascending: true }],
    ])
    expect(leaderboardQuery.range).toHaveBeenCalledWith(0, 19)
    expect(leaderboardQuery.abortSignal).toHaveBeenCalledWith(signal)
    expect(countQuery.abortSignal).toHaveBeenCalledWith(signal)
    expect(leaderboardQuery.not.mock.invocationCallOrder[0]).toBeLessThan(
      leaderboardQuery.range.mock.invocationCallOrder[0]
    )
  })

  it.each(['okx_web3_solana', 'bitget_bots_futures', 'bitget_bots_spot'])(
    'does not query quarantined platform %s',
    async (platform) => {
      const from = jest.fn()
      const result = await getLeaderboard({ from } as never, { platform })
      expect(result).toEqual({ traders: [], total: 0 })
      expect(from).not.toHaveBeenCalled()
    }
  )

  it('lets sealed cohort proof govern freshness and never reads a generic count cache', async () => {
    const leaderboardQuery = chainableQuery()
    leaderboardQuery.abortSignal.mockResolvedValue({
      data: [
        {
          source: 'binance_futures',
          source_trader_id: 'sealed-a',
          season_id: '90D',
          rank: 11,
        },
        {
          source: 'hyperliquid',
          source_trader_id: 'sealed-b',
          season_id: '90D',
          rank: 12,
        },
      ],
      error: null,
    })
    const from = jest.fn((table: string) => {
      if (table !== 'leaderboard_ranks') {
        throw new Error(`unexpected table: ${table}`)
      }
      return leaderboardQuery
    })
    const signal = new AbortController().signal

    const result = await getLeaderboard({ from } as never, {
      period: '90D',
      scoreCohortId: '11111111-1111-4111-8111-111111111111',
      allowedSources: ['binance_futures', 'hyperliquid'],
      offset: 10,
      limit: 2,
      signal,
    })

    expect(leaderboardQuery.filter).toHaveBeenCalledWith(
      'rank_publication_id',
      'eq',
      '11111111-1111-4111-8111-111111111111'
    )
    expect(leaderboardQuery.gte).not.toHaveBeenCalled()
    expect(leaderboardQuery.order.mock.calls).toEqual([
      ['rank', { ascending: true, nullsFirst: false }],
      ['source', { ascending: true }],
      ['source_trader_id', { ascending: true }],
    ])
    expect(leaderboardQuery.order.mock.invocationCallOrder[2]).toBeLessThan(
      leaderboardQuery.range.mock.invocationCallOrder[0]
    )
    expect(from).not.toHaveBeenCalledWith('leaderboard_count_cache')
    expect(result.traders).toHaveLength(2)
    expect(result.total).toBe(13)
  })
})

describe('resolveTrader sealed candidate ranking', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadPublicationAuthority.mockResolvedValue(['binance_futures', 'hyperliquid'])
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _supabase: unknown,
        _input: unknown,
        reader: (publication: { scoreCohortId: string }) => Promise<unknown>
      ) => {
        const publication = {
          state: 'sealed' as const,
          season: '90D' as const,
          scoreCohortId: '11111111-1111-4111-8111-111111111111',
          proofs: [],
        }
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
    mockReadSealedRankingAuthorityGeneration.mockImplementation(
      async (
        _supabase: unknown,
        season: '7D' | '30D' | '90D',
        reader: (publication: {
          scoreCohortId: string
          proofs: Array<{ source: string }>
        }) => Promise<unknown>
      ) => {
        const publication = {
          state: 'sealed' as const,
          season,
          scoreCohortId: '11111111-1111-4111-8111-111111111111',
          proofs: [{ source: 'binance_futures' }, { source: 'hyperliquid' }],
        }
        return {
          value: await reader(publication),
          publication,
          publicationIdentity: JSON.stringify(publication),
        }
      }
    )
  })

  it('uses an exact source+trader pair from the sealed cohort to break handle ties', async () => {
    const candidateQuery: Record<string, jest.Mock> = {}
    for (const method of ['select', 'or', 'eq', 'in', 'order']) {
      candidateQuery[method] = jest.fn(() => candidateQuery)
    }
    candidateQuery.limit = jest.fn().mockResolvedValue({
      data: [
        {
          source: 'hyperliquid',
          source_trader_id: 'id-b',
          handle: 'shared',
          avatar_url: null,
        },
        {
          source: 'binance_futures',
          source_trader_id: 'id-a',
          handle: 'shared',
          avatar_url: null,
        },
      ],
      error: null,
    })

    const rankQuery: Record<string, jest.Mock> = {}
    for (const method of ['select', 'in', 'eq', 'filter', 'not', 'order']) {
      rankQuery[method] = jest.fn(() => rankQuery)
    }
    rankQuery.limit = jest.fn().mockResolvedValue({
      data: [
        // Cartesian false positive: this exact source+ID pair is not a candidate.
        { source: 'binance_futures', source_trader_id: 'id-b', arena_score: 99 },
        { source: 'binance_futures', source_trader_id: 'id-a', arena_score: 80 },
        { source: 'hyperliquid', source_trader_id: 'id-b', arena_score: 70 },
      ],
      error: null,
    })

    const supabase = {
      from: jest.fn((table: string) => {
        if (table === 'trader_sources') return candidateQuery
        if (table === 'leaderboard_ranks') return rankQuery
        throw new Error(`unexpected table: ${table}`)
      }),
    }

    const result = await resolveTrader(supabase as never, { handle: 'shared' })

    expect(mockReadPublicationAuthority).toHaveBeenCalledWith(supabase, '90D', {
      timeoutMs: expect.any(Number),
    })
    expect(candidateQuery.in).toHaveBeenCalledWith('source', ['binance_futures', 'hyperliquid'])
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      supabase,
      { season: '90D', sources: ['binance_futures', 'hyperliquid'] },
      expect.any(Function)
    )
    expect(rankQuery.filter).toHaveBeenCalledWith(
      'rank_publication_id',
      'eq',
      '11111111-1111-4111-8111-111111111111'
    )
    expect(result).toEqual({
      platform: 'binance_futures',
      traderKey: 'id-a',
      handle: 'shared',
      avatarUrl: null,
    })
  })

  it('rejects a code-known platform that is outside the live publication authority', async () => {
    mockReadPublicationAuthority.mockResolvedValue(['hyperliquid'])
    const from = jest.fn()
    const supabase = { from }

    await expect(
      resolveTrader(supabase as never, {
        handle: 'shared',
        platform: 'binance_futures',
      })
    ).resolves.toBeNull()
    expect(from).not.toHaveBeenCalled()
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'database error',
      result: { data: null, error: { message: 'directory unavailable' } },
      expected: 'trader identity lookup failed: directory unavailable',
    },
    {
      name: 'ambiguous null',
      result: { data: null, error: null },
      expected: 'trader identity lookup returned an ambiguous null result',
    },
  ])('fails closed on trader_sources $name', async ({ result, expected }) => {
    const candidateQuery: Record<string, jest.Mock> = {}
    for (const method of ['select', 'or', 'eq', 'in', 'order']) {
      candidateQuery[method] = jest.fn(() => candidateQuery)
    }
    candidateQuery.limit = jest.fn().mockResolvedValue(result)
    const from = jest.fn((table: string) => {
      if (table === 'trader_sources') return candidateQuery
      throw new Error(`unexpected fallback table: ${table}`)
    })

    await expect(resolveTrader({ from } as never, { handle: 'shared' })).rejects.toThrow(expected)
    expect(from).toHaveBeenCalledTimes(1)
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
  })

  it('fails closed on profile authority error instead of falling through to leaderboard', async () => {
    const candidateQuery: Record<string, jest.Mock> = {}
    for (const method of ['select', 'or', 'eq', 'in', 'order']) {
      candidateQuery[method] = jest.fn(() => candidateQuery)
    }
    candidateQuery.limit = jest.fn().mockResolvedValue({ data: [], error: null })

    const profileQuery: Record<string, jest.Mock> = {}
    for (const method of ['select', 'or', 'eq', 'in', 'order', 'limit']) {
      profileQuery[method] = jest.fn(() => profileQuery)
    }
    profileQuery.maybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'profile authority unavailable' },
    })
    const from = jest.fn((table: string) => {
      if (table === 'trader_sources') return candidateQuery
      if (table === 'trader_profiles_v2') return profileQuery
      throw new Error(`unexpected fallback table: ${table}`)
    })

    await expect(resolveTrader({ from } as never, { handle: 'shared' })).rejects.toThrow(
      'trader profile lookup failed: profile authority unavailable'
    )
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
  })

  it('continues to sealed fallback only after an explicit successful empty profile result', async () => {
    const candidateQuery: Record<string, jest.Mock> = {}
    for (const method of ['select', 'or', 'eq', 'in', 'order']) {
      candidateQuery[method] = jest.fn(() => candidateQuery)
    }
    candidateQuery.limit = jest.fn().mockResolvedValue({ data: [], error: null })

    const profileQuery: Record<string, jest.Mock> = {}
    for (const method of ['select', 'or', 'eq', 'in', 'order', 'limit']) {
      profileQuery[method] = jest.fn(() => profileQuery)
    }
    profileQuery.maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null })
    const from = jest.fn((table: string) => {
      if (table === 'trader_sources') return candidateQuery
      if (table === 'trader_profiles_v2') return profileQuery
      throw new Error(`unexpected table before proof authorization: ${table}`)
    })
    mockReadSealedRankingAuthorityGeneration.mockRejectedValue(new Error('sealed fallback reached'))

    await expect(resolveTrader({ from } as never, { handle: 'shared' })).rejects.toThrow(
      'sealed fallback reached'
    )
    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledTimes(1)
  })

  it('does not choose an arbitrary same-handle candidate when sealed ranking proof fails', async () => {
    const candidateQuery: Record<string, jest.Mock> = {}
    for (const method of ['select', 'or', 'eq', 'in', 'order']) {
      candidateQuery[method] = jest.fn(() => candidateQuery)
    }
    candidateQuery.limit = jest.fn().mockResolvedValue({
      data: [
        {
          source: 'binance_futures',
          source_trader_id: 'id-a',
          handle: 'shared',
          avatar_url: null,
        },
        {
          source: 'hyperliquid',
          source_trader_id: 'id-b',
          handle: 'shared',
          avatar_url: null,
        },
      ],
      error: null,
    })
    mockReadSealedRankingGeneration.mockRejectedValue(new Error('publication proof unavailable'))

    await expect(
      resolveTrader({ from: jest.fn(() => candidateQuery) } as never, { handle: 'shared' })
    ).rejects.toThrow('publication proof unavailable')
  })
})

describe('searchTraders public ranking policy', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadSealedRankIdentities.mockImplementation(
      async (
        _supabase: unknown,
        _season: string,
        identities: Array<{ source: string; sourceTraderId: string }>
      ) => ({
        value: identities.map((identity, index) => ({
          source: identity.source,
          source_trader_id: identity.sourceTraderId,
          handle: 'same-trader',
          avatar_url: null,
          roi: 20,
          pnl: 100,
          win_rate: 55,
          followers: 10,
          arena_score: 80 - index,
          rank: index + 1,
        })),
      })
    )
  })

  it.each(['okx_web3_solana', 'bitget_bots_futures', 'bitget_bots_spot'])(
    'does not query quarantined platform %s',
    async (platform) => {
      const supabase = { rpc: jest.fn(), from: jest.fn() }

      await expect(
        searchTraders(supabase as never, { query: 'trader', platform })
      ).resolves.toEqual([])
      expect(supabase.rpc).not.toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalled()
    }
  )

  it('removes quarantined ranked results returned by the fuzzy RPC', async () => {
    const supabase = {
      rpc: jest.fn().mockResolvedValue({
        data: [
          {
            source_trader_id: 'public-id',
            handle: 'same-trader',
            source: 'binance_futures',
            avatar_url: null,
            relevance_score: 10_000,
            arena_score: 80,
            roi: 20,
            pnl: 100,
            rank: 1,
          },
          {
            source_trader_id: 'quarantined-id',
            handle: 'same-trader',
            source: 'okx_web3_solana',
            avatar_url: null,
            relevance_score: 20_000,
            arena_score: 99,
            roi: 40,
            pnl: 200,
            rank: 1,
          },
        ],
        error: null,
      }),
    }

    const result = await searchTraders(supabase as never, { query: 'same-trader' })

    expect(mockReadSealedRankIdentities).toHaveBeenCalledWith(supabase, '90D', [
      { source: 'binance_futures', sourceTraderId: 'public-id' },
    ])
    expect(result.map(({ platform }) => platform)).toEqual(['binance_futures'])
  })

  it('filters fallback identities before requesting their sealed ranks', async () => {
    const sourceQuery: Record<string, jest.Mock> = {}
    for (const method of ['select', 'or', 'eq']) {
      sourceQuery[method] = jest.fn(() => sourceQuery)
    }
    sourceQuery.limit = jest.fn().mockResolvedValue({
      data: [
        {
          source_trader_id: 'public-id',
          handle: 'same-trader',
          source: 'binance_futures',
          avatar_url: null,
        },
        {
          source_trader_id: 'quarantined-id',
          handle: 'same-trader',
          source: 'bitget_bots_futures',
          avatar_url: null,
        },
      ],
      error: null,
    })

    const supabase = {
      rpc: jest.fn().mockResolvedValue({ data: null, error: { message: 'unavailable' } }),
      from: jest.fn((table: string) => {
        if (table !== 'trader_sources') throw new Error(`unexpected table: ${table}`)
        return sourceQuery
      }),
    }

    const result = await searchTraders(supabase as never, { query: 'same-trader' })

    expect(mockReadSealedRankIdentities).toHaveBeenCalledWith(supabase, '90D', [
      { source: 'binance_futures', sourceTraderId: 'public-id' },
    ])
    expect(result.map(({ platform }) => platform)).toEqual(['binance_futures'])
  })
})
