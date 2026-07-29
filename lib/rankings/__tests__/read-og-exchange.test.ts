const mockReadSealedRankingGeneration = jest.fn()

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

import { readOgExchangeRanking } from '@/lib/rankings/read-og-exchange'

type Call = { method: string; args: unknown[] }

function queryClient(result: { data: unknown; error: unknown }) {
  const calls: Call[] = []
  const chain = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: typeof result) => void) => resolve(result)
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(property), args })
          return chain
        }
      },
    }
  )
  return {
    client: {
      from: jest.fn(() => chain),
      rpc: jest.fn(),
    },
    calls,
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
          scoreCohortId: 'cohort-1',
          proofs: [{ source: 'binance_futures', published_rank_count: 42 }],
        }),
        publication: { state: 'sealed' },
        publicationIdentity: 'proof',
      })
    )
  })

  it('binds the top three and exact total to one source publication', async () => {
    const { client, calls } = queryClient({
      data: [
        {
          source: 'binance_futures',
          handle: 'alice',
          avatar_url: null,
          roi: 12,
          arena_score: 88,
        },
      ],
      error: null,
    })

    await expect(readOgExchangeRanking(client as never, 'binance_futures')).resolves.toEqual({
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
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      client,
      { season: '90D', sources: ['binance_futures'] },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['source', 'binance_futures'] },
        { method: 'eq', args: ['season_id', '90D'] },
        { method: 'filter', args: ['rank_publication_id', 'eq', 'cohort-1'] },
        { method: 'limit', args: [3] },
      ])
    )
  })

  it.each(['okx_web3_solana', 'bitget_bots_futures', 'bitget_bots_spot', 'unknown'])(
    'rejects non-public source %s before proof or row access',
    async (source) => {
      const { client } = queryClient({ data: [], error: null })

      await expect(readOgExchangeRanking(client as never, source)).rejects.toThrow(
        'not a canonical public ranking source'
      )
      expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
      expect(client.from).not.toHaveBeenCalled()
    }
  )

  it('fails closed on query errors, null rows, and cross-source rows', async () => {
    const failed = queryClient({ data: null, error: { message: 'database unavailable' } })
    await expect(readOgExchangeRanking(failed.client as never, 'binance_futures')).rejects.toThrow(
      'database unavailable'
    )

    const missing = queryClient({ data: null, error: null })
    await expect(readOgExchangeRanking(missing.client as never, 'binance_futures')).rejects.toThrow(
      'null payload'
    )

    const crossed = queryClient({
      data: [
        {
          source: 'bybit',
          handle: 'other',
          avatar_url: null,
          roi: 1,
          arena_score: 2,
        },
      ],
      error: null,
    })
    await expect(readOgExchangeRanking(crossed.client as never, 'binance_futures')).rejects.toThrow(
      'outside its authority'
    )
  })
})
