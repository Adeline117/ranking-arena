import { countPublicRankedTradersBySource } from '../public-ranked-source-counts'
import { fakePublicRankedCountClient } from '../testing/public-ranked-count-client'

type Client = Parameters<typeof countPublicRankedTradersBySource>[0]

describe('countPublicRankedTradersBySource', () => {
  it('counts a board larger than one PostgREST page without reading a row', async () => {
    const fake = fakePublicRankedCountClient({
      served: ['binance_futures', 'bybit', 'okx_futures'],
      nonIdleBySource: { binance_futures: 2_600, bybit: 1_500, okx_futures: 0 },
    })

    const counts = await countPublicRankedTradersBySource(fake.client as unknown as Client, '90D')

    expect(counts?.total).toBe(4_100)
    // A served source with only idle rows is absent, not a zero.
    expect(Array.from(counts?.bySource.entries() ?? [])).toEqual([
      ['binance_futures', 2_600],
      ['bybit', 1_500],
    ])
    expect(fake.rpcCalls).toEqual([['arena_visible_sources', { p_season_id: '90D' }]])
    expect(new Set(fake.relations)).toEqual(new Set(['public_ranked_leaderboard']))
    for (const select of fake.selects) {
      expect(select).toEqual(['source_trader_id', { count: 'exact', head: true }])
    }
    for (const filter of fake.filters) {
      expect(filter).toEqual(
        expect.objectContaining({ season_id: '90D', idle_window: false, 'not:rank:is': null })
      )
    }
  })

  it('is unknown when the per-source counts do not add up to the season total', async () => {
    // A row from a source the served list does not name.
    const fake = fakePublicRankedCountClient({
      served: ['binance_futures'],
      nonIdleBySource: { binance_futures: 10 },
      total: 11,
    })

    await expect(
      countPublicRankedTradersBySource(fake.client as unknown as Client, '90D')
    ).resolves.toBeNull()
  })

  it.each([
    ['the served-source read', { rpcError: true }],
    ['the season count', { failCountFor: ['total'] }],
    ['one source count', { failCountFor: ['bybit'] }],
  ])('is unknown when %s fails', async (_label, failure) => {
    const fake = fakePublicRankedCountClient({
      served: ['binance_futures', 'bybit'],
      nonIdleBySource: { binance_futures: 3, bybit: 2 },
      ...failure,
    })

    await expect(
      countPublicRankedTradersBySource(fake.client as unknown as Client, '90D')
    ).resolves.toBeNull()
  })
})
