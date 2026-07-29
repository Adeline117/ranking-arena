const mockReadSealedRankingAuthorityGeneration = jest.fn()

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: (...args: unknown[]) =>
    mockReadSealedRankingAuthorityGeneration(...args),
}))

import { readSealedRankIdentities } from '@/lib/rankings/read-sealed-rank-identities'

type Call = { method: string; args: unknown[] }

function queryClient(result: { data: unknown; error: unknown }) {
  const calls: Call[] = []
  const chain = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => void) => resolve(result)
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

describe('readSealedRankIdentities', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadSealedRankingAuthorityGeneration.mockImplementation(
      async (
        _client,
        season,
        reader: (publication: {
          scoreCohortId: string
          proofs: Array<{ source: string }>
        }) => Promise<unknown>
      ) => ({
        value: await reader({
          scoreCohortId: 'cohort-1',
          proofs: [{ source: 'binance_futures' }],
        }),
        publication: { state: 'sealed' },
        publicationIdentity: 'proof',
        authoritySources: ['binance_futures'],
        season,
      })
    )
  })

  it('binds exact composite identities to one sealed cohort', async () => {
    const row = {
      source: 'binance_futures',
      source_trader_id: 'shared-id',
      handle: 'alice',
      avatar_url: null,
      roi: 1,
      pnl: 2,
      win_rate: 3,
      followers: 4,
      arena_score: 5,
      rank: 6,
    }
    const { client, calls } = queryClient({ data: [row], error: null })

    const result = await readSealedRankIdentities(client as never, '90D', [
      { source: 'binance_futures', sourceTraderId: 'shared-id' },
      { source: 'bybit', sourceTraderId: 'not-in-live-authority' },
      { source: 'okx_web3_solana', sourceTraderId: 'quarantined' },
      { source: 'not_a_source', sourceTraderId: 'private' },
    ])

    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledWith(
      client,
      '90D',
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['source', 'binance_futures'] },
        { method: 'in', args: ['source_trader_id', ['shared-id']] },
        { method: 'eq', args: ['season_id', '90D'] },
        { method: 'filter', args: ['rank_publication_id', 'eq', 'cohort-1'] },
      ])
    )
    expect(calls).not.toContainEqual({ method: 'eq', args: ['source', 'bybit'] })
    expect(result?.value).toEqual([row])
  })

  it('does not invoke service-role proof or rank reads for non-public identities', async () => {
    const { client } = queryClient({ data: [], error: null })

    await expect(
      readSealedRankIdentities(client as never, '90D', [
        { source: 'okx_web3_solana', sourceTraderId: 'quarantined' },
        { source: 'unknown', sourceTraderId: 'private' },
      ])
    ).resolves.toBeNull()

    expect(mockReadSealedRankingAuthorityGeneration).not.toHaveBeenCalled()
    expect(client.from).not.toHaveBeenCalled()
  })

  it('returns an empty sealed enrichment when code-public identities left live authority', async () => {
    const { client } = queryClient({ data: [], error: null })

    const result = await readSealedRankIdentities(client as never, '90D', [
      { source: 'bybit', sourceTraderId: 'retired-live-id' },
    ])

    expect(result?.value).toEqual([])
    expect(mockReadSealedRankingAuthorityGeneration).toHaveBeenCalledTimes(1)
    expect(client.from).not.toHaveBeenCalled()
  })

  it('fails closed on rank query errors and null row sets', async () => {
    const failed = queryClient({ data: null, error: { message: 'database unavailable' } })
    await expect(
      readSealedRankIdentities(failed.client as never, '90D', [
        { source: 'binance_futures', sourceTraderId: 'trader-1' },
      ])
    ).rejects.toThrow('sealed rank identity query failed')

    const missing = queryClient({ data: null, error: null })
    await expect(
      readSealedRankIdentities(missing.client as never, '90D', [
        { source: 'binance_futures', sourceTraderId: 'trader-1' },
      ])
    ).rejects.toThrow('returned no row array')
  })

  it('rejects rows outside the exact requested pair and duplicate identities', async () => {
    const unexpected = queryClient({
      data: [
        {
          source: 'bybit',
          source_trader_id: 'shared-id',
        },
      ],
      error: null,
    })
    await expect(
      readSealedRankIdentities(unexpected.client as never, '90D', [
        { source: 'binance_futures', sourceTraderId: 'shared-id' },
      ])
    ).rejects.toThrow('unrequested identity')

    const duplicate = queryClient({
      data: [
        { source: 'binance_futures', source_trader_id: 'shared-id' },
        { source: 'binance_futures', source_trader_id: 'shared-id' },
      ],
      error: null,
    })
    await expect(
      readSealedRankIdentities(duplicate.client as never, '90D', [
        { source: 'binance_futures', sourceTraderId: 'shared-id' },
      ])
    ).rejects.toThrow('duplicate identity')
  })
})
