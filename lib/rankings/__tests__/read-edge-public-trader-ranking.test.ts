/**
 * @jest-environment node
 */

import {
  readEdgePublicTraderRanking,
  type EdgePublicTraderRankingConfig,
} from '@/lib/rankings/read-edge-public-trader-ranking'
import {
  SealedRankingGenerationChangedError,
  SealedRankingSourceOutsideAuthorityError,
} from '@/lib/rankings/read-sealed-ranking-generation'

const SUPABASE_URL = 'https://example.supabase.co'
const KEY = 'service-role-key'
const COHORT_ID = '123e4567-e89b-42d3-a456-426614174000'
const SEASONS = ['90D', '30D', '7D'] as const

interface RestRequest {
  readonly table: string
  readonly params: URLSearchParams
}

interface FetchHarnessOptions {
  readonly sources: readonly string[]
  readonly rest: (request: RestRequest) => unknown
  readonly mutateClosingProof?: boolean
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fetchHarness(options: FetchHarnessOptions) {
  const proofCalls = new Map<string, number>()
  const requests: Array<{ url: URL; body: unknown }> = []
  const now = Date.now()
  const sourceAsOf = new Date(now - 60_000).toISOString()
  const recordedAt = new Date(now - 30_000).toISOString()
  const fetchImpl = jest.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, body })

    if (url.pathname.endsWith('/arena_freshness_expected_sources')) {
      return json(
        SEASONS.flatMap((season) =>
          options.sources.map((source) => ({
            season_id: season,
            registry_slug: `${source}_registry`,
            filter_source: source,
            exchange_name: source,
          }))
        )
      )
    }
    if (url.pathname.endsWith('/arena_leaderboard_publication_proofs')) {
      const args = body as { p_season_id: string; p_sources: string[] }
      const call = (proofCalls.get(args.p_season_id) ?? 0) + 1
      proofCalls.set(args.p_season_id, call)
      const mutation = options.mutateClosingProof && call === 2 ? 1 : 0
      return json(
        args.p_sources.map((source, index) => ({
          season_id: args.p_season_id,
          source,
          source_as_of: sourceAsOf,
          recorded_at: recordedAt,
          score_cohort_id: COHORT_ID,
          rank_mutation_seq: 9 + mutation,
          current_mutation_seq: 9 + mutation,
          published_rank_count: 2,
          published_identity_sha256: String.fromCharCode(97 + index + mutation).repeat(64),
          is_sealed: true,
        }))
      )
    }

    const table = url.pathname.split('/').at(-1) ?? ''
    return json(options.rest({ table, params: url.searchParams }))
  })

  const config: EdgePublicTraderRankingConfig = {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: KEY,
    fetchImpl,
  }
  return { config, fetchImpl, requests }
}

function directoryRow(source: string, sourceTraderId: string, handle = 'shared') {
  return {
    source,
    source_trader_id: sourceTraderId,
    handle,
    avatar_url: `https://images.example/${sourceTraderId}.png`,
  }
}

function rankRow(
  source: string,
  sourceTraderId: string,
  season: (typeof SEASONS)[number],
  score: number,
  rank: number,
  handle = 'shared'
) {
  return {
    ...directoryRow(source, sourceTraderId, handle),
    season_id: season,
    rank_publication_id: COHORT_ID,
    roi: 24.5,
    pnl: 500,
    win_rate: 61,
    max_drawdown: 8,
    arena_score: score,
    rank,
  }
}

function filterValue(params: URLSearchParams, key: string): string | null {
  return params.get(key)?.replace(/^eq\./, '') ?? null
}

describe('readEdgePublicTraderRanking', () => {
  it('binds a source-scoped metric read to the sealed publication cohort', async () => {
    const harness = fetchHarness({
      sources: ['binance_futures'],
      rest: ({ table, params }) => {
        const handle = filterValue(params, 'handle')
        if (table === 'trader_sources') {
          return handle === 'alice' ? [directoryRow('binance_futures', 'alice-id', 'alice')] : []
        }
        const season = filterValue(params, 'season_id')
        return handle === 'alice'
          ? [rankRow('binance_futures', 'alice-id', season as '90D', 88, 7, 'alice')]
          : []
      },
    })

    await expect(
      readEdgePublicTraderRanking(harness.config, {
        handle: 'alice',
        source: 'binance_futures',
      })
    ).resolves.toEqual({
      handle: 'alice',
      avatarUrl: 'https://images.example/alice-id.png',
      source: 'binance_futures',
      sourceTraderId: 'alice-id',
      season: '90D',
      rank: 7,
      arenaScore: 88,
      roi: 24.5,
      pnl: 500,
      winRate: 61,
      maxDrawdown: 8,
    })

    const rankRequests = harness.requests.filter(({ url }) =>
      url.pathname.endsWith('/leaderboard_ranks')
    )
    expect(rankRequests).toHaveLength(2)
    for (const { url } of rankRequests) {
      expect(url.searchParams.get('source')).toBe('eq.binance_futures')
      expect(url.searchParams.get('season_id')).toBe('eq.90D')
      expect(url.searchParams.get('rank_publication_id')).toBe(`eq.${COHORT_ID}`)
    }
    expect(
      harness.requests.filter(({ url }) =>
        url.pathname.endsWith('/arena_freshness_expected_sources')
      )
    ).toHaveLength(2)
    expect(
      harness.requests.filter(({ url }) =>
        url.pathname.endsWith('/arena_leaderboard_publication_proofs')
      )
    ).toHaveLength(2)
  })

  it('uses a sealed score to resolve same-handle exchange ambiguity', async () => {
    const harness = fetchHarness({
      sources: ['binance_futures', 'bybit'],
      rest: ({ table, params }) => {
        if (filterValue(params, 'handle') !== 'shared') return []
        if (table === 'trader_sources') {
          return [directoryRow('binance_futures', 'binance-id'), directoryRow('bybit', 'bybit-id')]
        }
        return [
          rankRow('binance_futures', 'binance-id', '90D', 80, 3),
          rankRow('bybit', 'bybit-id', '90D', 91, 8),
          rankRow('retired_exchange', 'retired-id', '90D', 99, 1),
          {
            ...rankRow('binance_futures', 'malformed-id', '90D', 92, 2),
            arena_score: '92',
          },
        ]
      },
    })

    await expect(
      readEdgePublicTraderRanking(harness.config, { handle: 'shared' })
    ).resolves.toMatchObject({
      source: 'bybit',
      sourceTraderId: 'bybit-id',
      arenaScore: 91,
      rank: 8,
    })

    const sourceFilters = harness.requests
      .filter(({ url }) => /\/(?:trader_sources|leaderboard_ranks)$/.test(url.pathname))
      .map(({ url }) => url.searchParams.get('source'))
    expect(sourceFilters).toEqual([
      'in.(binance_futures,bybit)',
      'in.(binance_futures,bybit)',
      'in.(binance_futures,bybit)',
      'in.(binance_futures,bybit)',
    ])
  })

  it('cascades to a separately sealed 30D generation without reusing a 90D cohort', async () => {
    const harness = fetchHarness({
      sources: ['binance_futures'],
      rest: ({ table, params }) => {
        const handle = filterValue(params, 'handle')
        if (table === 'trader_sources') {
          return handle === 'alice' ? [directoryRow('binance_futures', 'alice-id', 'alice')] : []
        }
        const season = filterValue(params, 'season_id')
        return handle === 'alice' && season === '30D'
          ? [rankRow('binance_futures', 'alice-id', '30D', 78, 12, 'alice')]
          : []
      },
    })

    await expect(
      readEdgePublicTraderRanking(harness.config, { handle: 'alice' })
    ).resolves.toMatchObject({
      season: '30D',
      rank: 12,
      arenaScore: 78,
    })

    const proofBodies = harness.requests
      .filter(({ url }) => url.pathname.endsWith('/arena_leaderboard_publication_proofs'))
      .map(({ body }) => body)
    expect(proofBodies).toEqual([
      { p_season_id: '90D', p_sources: ['binance_futures'] },
      { p_season_id: '90D', p_sources: ['binance_futures'] },
      { p_season_id: '30D', p_sources: ['binance_futures'] },
      { p_season_id: '30D', p_sources: ['binance_futures'] },
    ])
  })

  it('rejects a generation cutover after the metric REST read', async () => {
    const harness = fetchHarness({
      sources: ['binance_futures'],
      mutateClosingProof: true,
      rest: ({ table, params }) => {
        if (filterValue(params, 'handle') !== 'alice') return []
        return table === 'trader_sources'
          ? [directoryRow('binance_futures', 'alice-id', 'alice')]
          : [rankRow('binance_futures', 'alice-id', '90D', 88, 7, 'alice')]
      },
    })

    await expect(
      readEdgePublicTraderRanking(harness.config, { handle: 'alice' })
    ).rejects.toBeInstanceOf(SealedRankingGenerationChangedError)
  })

  it('rejects a code-known source outside the live authority before any table read', async () => {
    const harness = fetchHarness({
      sources: ['binance_futures'],
      rest: () => {
        throw new Error('table read must not run')
      },
    })

    await expect(
      readEdgePublicTraderRanking(harness.config, {
        handle: 'alice',
        source: 'bybit',
      })
    ).rejects.toBeInstanceOf(SealedRankingSourceOutsideAuthorityError)
    expect(
      harness.requests.some(({ url }) =>
        /\/(?:trader_sources|leaderboard_ranks)$/.test(url.pathname)
      )
    ).toBe(false)
  })

  it.each(['', ' alice', 'alice ', `alice\u0000evil`, 'a'.repeat(201)])(
    'rejects an invalid handle before dispatch: %p',
    async (handle) => {
      const harness = fetchHarness({ sources: ['binance_futures'], rest: () => [] })
      await expect(readEdgePublicTraderRanking(harness.config, { handle })).rejects.toBeInstanceOf(
        TypeError
      )
      expect(harness.fetchImpl).not.toHaveBeenCalled()
    }
  )
})
