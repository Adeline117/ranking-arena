import { mergeTokenRankingsWithProfiles } from './token-traders'

type AggregateRows = Parameters<typeof mergeTokenRankingsWithProfiles>[0]

describe('token trader ranking authority mapping', () => {
  it('preserves token_rank and keeps unavailable profile metrics unknown', () => {
    const rows = [
      {
        source: 'hyperliquid',
        source_trader_id: 'wallet-1',
        token_rank: '51',
        token_pnl: '123.45',
        token_trade_count: '9',
        token_win_rate: 'not-a-number',
        token_avg_pnl_pct: 'Infinity',
        total_count: '80',
      },
    ] as unknown as AggregateRows

    const result = mergeTokenRankingsWithProfiles(rows, [])

    expect(result.total).toBe(80)
    expect(result.traders).toEqual([
      expect.objectContaining({
        source: 'hyperliquid',
        source_trader_id: 'wallet-1',
        token_rank: 51,
        token_pnl: 123.45,
        token_trade_count: 9,
        token_win_rate: null,
        token_avg_pnl_pct: null,
        total_pnl: null,
      }),
    ])
  })

  it('fails the whole page when the authoritative rank or token-PnL basis is invalid', () => {
    const rows = [
      {
        source: 'binance_futures',
        source_trader_id: 'missing-rank',
        token_rank: null,
        token_pnl: 100,
        token_trade_count: 5,
        token_win_rate: 50,
        token_avg_pnl_pct: 1,
        total_count: 2,
      },
      {
        source: 'bybit',
        source_trader_id: 'invalid-pnl',
        token_rank: 1,
        token_pnl: Number.NaN,
        token_trade_count: 5,
        token_win_rate: 50,
        token_avg_pnl_pct: 1,
        total_count: 2,
      },
    ] as unknown as AggregateRows

    expect(() => mergeTokenRankingsWithProfiles(rows, [])).toThrow(
      'Token ranking response violated its authority contract'
    )
  })

  it('fails the whole page on duplicate, missing, or inconsistent rank authority', () => {
    const rows = [
      {
        source: 'hyperliquid',
        source_trader_id: 'wallet-1',
        token_rank: 51,
        token_pnl: 100,
        token_trade_count: 5,
        token_win_rate: 50,
        token_avg_pnl_pct: 1,
        total_count: 80,
      },
      {
        source: 'bybit',
        source_trader_id: 'trader-2',
        token_rank: 53,
        token_pnl: 90,
        token_trade_count: 4,
        token_win_rate: 50,
        token_avg_pnl_pct: 1,
        total_count: 80,
      },
    ] as unknown as AggregateRows

    expect(() => mergeTokenRankingsWithProfiles(rows, [])).toThrow(
      'Token ranking response violated its ordering contract'
    )
  })
})
