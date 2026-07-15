import { getTokenTraderRankingCacheKey, mergeTokenRankingsWithProfiles } from './token-traders'

describe('getTokenTraderRankingCacheKey', () => {
  test('uses the aggregate-backed cache namespace', () => {
    expect(getTokenTraderRankingCacheKey('BTC', '90D', 25, 0)).toBe(
      'rankings:by-token:v2:BTC:90D:25:0'
    )
  })
})

describe('mergeTokenRankingsWithProfiles', () => {
  test('preserves aggregate rank data and enriches matching trader profiles', () => {
    const result = mergeTokenRankingsWithProfiles(
      [
        {
          source: 'hyperliquid',
          source_trader_id: 'trader-1',
          token_pnl: '1234.56',
          token_trade_count: '42',
          token_win_rate: '61.9',
          token_avg_pnl_pct: null,
          total_count: '126',
        },
      ],
      [
        {
          source: 'hyperliquid',
          source_trader_id: 'trader-1',
          handle: 'Alice',
          avatar_url: 'https://example.com/alice.png',
          arena_score: 0,
          roi: 18.2,
          pnl: 9999,
        },
      ]
    )

    expect(result.total).toBe(126)
    expect(result.traders).toEqual([
      {
        source: 'hyperliquid',
        source_trader_id: 'trader-1',
        handle: 'Alice',
        avatar_url: 'https://example.com/alice.png',
        arena_score: 0,
        roi: 18.2,
        total_pnl: 9999,
        token_pnl: 1234.56,
        token_trade_count: 42,
        token_win_rate: 61.9,
        token_avg_pnl_pct: null,
      },
    ])
  })

  test('keeps a usable row when no leaderboard profile exists', () => {
    const result = mergeTokenRankingsWithProfiles(
      [
        {
          source: 'bybit',
          source_trader_id: 'trader-2',
          token_pnl: -10,
          token_trade_count: 2,
          token_win_rate: 0,
          token_avg_pnl_pct: -1.5,
          total_count: 1,
        },
      ],
      []
    )

    expect(result.traders[0]).toMatchObject({
      handle: null,
      arena_score: null,
      total_pnl: 0,
      token_win_rate: 0,
    })
  })
})
