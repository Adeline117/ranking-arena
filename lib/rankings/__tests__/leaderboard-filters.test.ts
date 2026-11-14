import { hasLeaderboardFilters, leaderboardFilterQuery } from '../leaderboard-filters'

describe('leaderboardFilterQuery — canonical /api/traders filter params', () => {
  it('returns null when nothing narrows the cohort', () => {
    expect(leaderboardFilterQuery({}, null)).toBeNull()
    expect(leaderboardFilterQuery({ exchange: [], category: [] }, 'all')).toBeNull()
    expect(hasLeaderboardFilters({})).toBe(false)
  })

  it('is order-independent: one filter state always gives one string', () => {
    const a = leaderboardFilterQuery(
      { min_win_rate: 55, exchange: ['bybit', 'binance_futures'], category: ['web3', 'futures'] },
      'low_risk'
    )
    const b = leaderboardFilterQuery(
      {
        category: ['futures', 'onchain'],
        exchange: ['binance_futures', 'bybit'],
        min_win_rate: 55,
      },
      'low_risk'
    )
    expect(a).toBe('fcat=futures%2Cweb3&fex=binance_futures%2Cbybit&min_wr=55&preset=low_risk')
    expect(b).toBe(a)
  })

  it('clamps typed values to the API bounds and writes plain decimals', () => {
    const q = new URLSearchParams(
      leaderboardFilterQuery(
        { drawdown_max: 250, min_score: -3, roi_min: 1e9, min_pnl: 0.00000001 },
        null
      ) ?? ''
    )
    expect(q.get('dd_max')).toBe('100')
    expect(q.get('min_score')).toBe('0')
    expect(q.get('roi_min')).toBe('50000')
    expect(q.get('min_pnl')).toBe('0')
  })

  it('drops exchanges the resolver rejects and ignores invalid grade / preset', () => {
    expect(
      leaderboardFilterQuery({ exchange: ['gone', 'bybit'], grade: 'Z' }, 'bogus', (s) =>
        s === 'bybit' ? s : null
      )
    ).toBe('fex=bybit')
  })
})
