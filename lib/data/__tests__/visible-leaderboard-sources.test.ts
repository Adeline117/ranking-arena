import {
  parseVisibleLeaderboardSources,
  summarizePublicVisibleLeaderboardSources,
} from '../visible-leaderboard-sources'

function row(filterSource: string, traderCount: number) {
  return {
    registry_slug: filterSource,
    filter_source: filterSource,
    exchange_slug: filterSource,
    exchange_name: filterSource,
    product_type: 'futures',
    trader_count: traderCount,
    cache_updated_at: '2026-07-16T07:00:00.000Z',
  }
}

describe('parseVisibleLeaderboardSources', () => {
  it('rejects non-array and incomplete RPC payloads', () => {
    expect(() => parseVisibleLeaderboardSources(null)).toThrow(/non-array/)
    expect(() => parseVisibleLeaderboardSources([{}])).toThrow(/trader_count/)
  })

  it('keeps registry and filter source identities distinct', () => {
    expect(
      parseVisibleLeaderboardSources([
        {
          registry_slug: 'gate_futures',
          filter_source: 'gateio',
          exchange_slug: 'gate',
          exchange_name: 'Gate',
          product_type: 'futures',
          trader_count: 533,
          cache_updated_at: '2026-07-16T07:00:00.000Z',
        },
      ])[0]
    ).toMatchObject({ registrySlug: 'gate_futures', filterSource: 'gateio' })
  })

  it('summarizes only public source boards from one visibility generation', () => {
    expect(
      summarizePublicVisibleLeaderboardSources([
        row('bybit', 576),
        row('binance_futures', 800),
        row('bitget_bots_futures', 90),
        row('okx_web3_solana', 10),
      ])
    ).toMatchObject({
      sourceBoardCount: 2,
      rankedTraderCount: 1376,
      sourceBoards: [
        { filterSource: 'binance_futures' },
        { filterSource: 'bybit' },
      ],
    })
  })

  it('fails closed when registry rows alias the same public filter source', () => {
    expect(() =>
      summarizePublicVisibleLeaderboardSources([
        row('bybit', 576),
        { ...row('bybit', 576), registry_slug: 'bybit_copytrade_v2' },
      ])
    ).toThrow(/duplicate filter_source bybit/)
  })
})
