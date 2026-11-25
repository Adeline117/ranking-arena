import {
  hasLeaderboardFilters,
  leaderboardFilterQuery,
  listsIdleRows,
} from '../leaderboard-filters'

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

describe('idle-window rows', () => {
  it('asks for them only when the filter state says so', () => {
    expect(leaderboardFilterQuery({}, null)).toBeNull()
    expect(leaderboardFilterQuery({ show_idle: false }, null)).toBeNull()
    expect(leaderboardFilterQuery({ show_idle: true }, null)).toBe('idle=1')
  })

  it('counts as a cohort of its own, so the request stays out of the shared cache', () => {
    expect(hasLeaderboardFilters({ includeIdle: true })).toBe(true)
    expect(hasLeaderboardFilters({})).toBe(false)
  })
})

describe('listsIdleRows (idle rows only on the plain board)', () => {
  it('lists them for the default order with no other filter', () => {
    expect(listsIdleRows({ includeIdle: true }, 'arena_score', 'desc')).toBe(true)
  })

  it('does not list them unless asked', () => {
    expect(listsIdleRows({}, 'arena_score', 'desc')).toBe(false)
    expect(listsIdleRows(null, 'arena_score', 'desc')).toBe(false)
  })

  it.each([
    ['roi', 'desc'],
    ['pnl', 'desc'],
    ['arena_score', 'asc'],
  ] as const)(
    'does not list them when sorted by %s %s — they would leave the tail',
    (sortBy, order) => {
      expect(listsIdleRows({ includeIdle: true }, sortBy, order)).toBe(false)
    }
  )

  it('does not list them together with any other filter or preset', () => {
    expect(listsIdleRows({ includeIdle: true, minScore: 10 }, 'arena_score', 'desc')).toBe(false)
    expect(listsIdleRows({ includeIdle: true, sources: ['bybit'] }, 'arena_score', 'desc')).toBe(
      false
    )
    expect(listsIdleRows({ includeIdle: true, preset: 'low_risk' }, 'arena_score', 'desc')).toBe(
      false
    )
  })
})
