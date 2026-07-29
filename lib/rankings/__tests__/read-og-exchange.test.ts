/**
 * @jest-environment node
 */

const mockReadSealedRankingGeneration = jest.fn()

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

import { readOgExchangeRanking } from '@/lib/rankings/read-og-exchange'

const SUPABASE_URL = 'https://example.supabase.co'
const KEY = 'service-role-key'
const COHORT_ID = '11111111-1111-4111-8111-111111111111'

function response(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

function rankingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'binance_futures',
    source_trader_id: 'alice-source-id',
    handle: 'alice',
    avatar_url: null,
    roi: 12,
    arena_score: 88,
    rank: 1,
    season_id: '90D',
    rank_publication_id: COHORT_ID,
    is_outlier: false,
    ...overrides,
  }
}

function config(fetchImpl: typeof fetch) {
  return {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: KEY,
    fetchImpl,
  }
}

describe('readOgExchangeRanking', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _client,
        _input,
        reader: (publication: {
          scoreCohortId: string
          proofs: Array<{ source: string; published_rank_count: number }>
        }) => Promise<unknown>
      ) => ({
        value: await reader({
          scoreCohortId: COHORT_ID,
          proofs: [{ source: 'binance_futures', published_rank_count: 42 }],
        }),
        publication: { state: 'sealed' },
        publicationIdentity: 'proof',
      })
    )
  })

  it('binds the Edge REST top three and exact total to one source publication', async () => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(response([rankingRow()]))

    const result = await readOgExchangeRanking(config(fetchImpl), 'binance_futures')

    expect(result).toEqual({
      traders: [
        {
          handle: 'alice',
          avatar_url: null,
          roi: 12,
          arena_score: 88,
          rank: 1,
        },
      ],
      total: 42,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.traders)).toBe(true)
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ rpc: expect.any(Function) }),
      { season: '90D', sources: ['binance_futures'] },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [input, init] = fetchImpl.mock.calls[0]
    const requestUrl = new URL(String(input))
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(
      `${SUPABASE_URL}/rest/v1/leaderboard_ranks`
    )
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      source: 'eq.binance_futures',
      season_id: 'eq.90D',
      rank_publication_id: `eq.${COHORT_ID}`,
      arena_score: 'gt.0',
      rank: 'not.is.null',
      or: '(is_outlier.is.null,is_outlier.eq.false)',
      order: 'rank.asc.nullslast',
      limit: '3',
    })
    expect(init).toEqual({
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
      },
      signal: expect.any(AbortSignal),
    })
  })

  it.each(['okx_web3_solana', 'bitget_bots_futures', 'bitget_bots_spot', 'unknown'])(
    'rejects non-public source %s before proof or row access',
    async (source) => {
      const fetchImpl = jest.fn<typeof fetch>()

      await expect(readOgExchangeRanking(config(fetchImpl), source)).rejects.toThrow(
        'not a canonical public ranking source'
      )
      expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  )

  it('fails closed on HTTP errors and ambiguous payloads', async () => {
    const failedFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(response({ message: 'database unavailable' }, 503))
    await expect(readOgExchangeRanking(config(failedFetch), 'binance_futures')).rejects.toThrow(
      'status 503'
    )

    const missingFetch = jest.fn<typeof fetch>().mockResolvedValue(response(null))
    await expect(readOgExchangeRanking(config(missingFetch), 'binance_futures')).rejects.toThrow(
      'invalid payload'
    )

    const oversizedFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(response([rankingRow(), rankingRow(), rankingRow(), rankingRow()]))
    await expect(readOgExchangeRanking(config(oversizedFetch), 'binance_futures')).rejects.toThrow(
      'invalid payload'
    )
  })

  it.each([
    [rankingRow({ source: 'bybit' }), 'escaped its sealed publication'],
    [rankingRow({ season_id: '30D' }), 'escaped its sealed publication'],
    [rankingRow({ rank_publication_id: 'wrong-cohort' }), 'escaped its sealed publication'],
    [rankingRow({ arena_score: 'not-a-number' }), 'invalid arena_score'],
    [rankingRow({ arena_score: 101 }), 'escaped its sealed publication'],
    [rankingRow({ rank: 0 }), 'escaped its sealed publication'],
    [rankingRow({ source_trader_id: '' }), 'escaped its sealed publication'],
  ])('rejects a malformed or unbound row %#', async (row, message) => {
    const fetchImpl = jest.fn<typeof fetch>().mockResolvedValue(response([row]))

    await expect(readOgExchangeRanking(config(fetchImpl), 'binance_futures')).rejects.toThrow(
      message
    )
  })

  it('rejects duplicate source identities and proof-count overflow', async () => {
    const duplicateFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(response([rankingRow(), rankingRow({ rank: 2 })]))
    await expect(readOgExchangeRanking(config(duplicateFetch), 'binance_futures')).rejects.toThrow(
      'escaped its sealed publication'
    )

    mockReadSealedRankingGeneration.mockImplementationOnce(
      async (
        _client,
        _input,
        reader: (publication: {
          scoreCohortId: string
          proofs: Array<{ source: string; published_rank_count: number }>
        }) => Promise<unknown>
      ) => ({
        value: await reader({
          scoreCohortId: COHORT_ID,
          proofs: [{ source: 'binance_futures', published_rank_count: 1 }],
        }),
      })
    )
    const overflowFetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        response([
          rankingRow(),
          rankingRow({ source_trader_id: 'bob-source-id', handle: 'bob', rank: 2 }),
        ])
      )
    await expect(readOgExchangeRanking(config(overflowFetch), 'binance_futures')).rejects.toThrow(
      'does not authorize the returned rows'
    )
  })

  it('validates Edge transport configuration before the generation read', async () => {
    await expect(
      readOgExchangeRanking(
        { supabaseUrl: 'file:///tmp/database', serviceRoleKey: KEY },
        'binance_futures'
      )
    ).rejects.toThrow('must use HTTP or HTTPS')
    await expect(
      readOgExchangeRanking(
        { supabaseUrl: SUPABASE_URL, serviceRoleKey: ' key-with-whitespace' },
        'binance_futures'
      )
    ).rejects.toThrow('service key is invalid')
    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
  })
})
