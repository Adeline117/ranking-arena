import { parseVisibleLeaderboardSources } from '../visible-leaderboard-sources'

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
})
