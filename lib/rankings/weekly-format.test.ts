import {
  formatWeeklyMoney,
  formatWeeklyRange,
  formatWeeklyRoi,
  formatWeeklyWinRate,
  weeklyTraderHref,
} from './weekly-format'

describe('weekly ranking display formatting', () => {
  it('uses deterministic number formatting instead of the host locale', () => {
    expect(formatWeeklyRoi(9396.99)).toBe('+9,396.99%')
    expect(formatWeeklyRoi(12_345)).toBe('+12.3K%')
    expect(formatWeeklyWinRate(60.52)).toBe('60.5%')
    expect(formatWeeklyWinRate(null)).toBe('—')
    expect(formatWeeklyMoney(12_345, 'USDT')).toBe('+12.3K USDT')
  })

  it('keeps the UTC week boundary stable across equivalent offsets', () => {
    expect(formatWeeklyRange('2026-07-16T00:30:00Z', 'en')).toBe('Jul 10 – Jul 16')
    expect(formatWeeklyRange('2026-07-15T17:30:00-07:00', 'en')).toBe('Jul 10 – Jul 16')
  })

  it('uses an explicit locale for every supported app language', () => {
    expect(formatWeeklyRange('2026-07-16T00:30:00Z', 'zh')).toBe('7月10日 – 7月16日')
    expect(formatWeeklyRange('2026-07-16T00:30:00Z', 'ja')).toBe('7月10日 – 7月16日')
    expect(formatWeeklyRange('2026-07-16T00:30:00Z', 'ko')).toBe('7월 10일 – 7월 16일')
  })

  it('rejects a missing or invalid snapshot timestamp', () => {
    expect(formatWeeklyRange(null, 'en')).toBeNull()
    expect(formatWeeklyRange('not-a-date', 'en')).toBeNull()
  })

  it('keeps the complete exchange-account identity in weekly trader links', () => {
    expect(weeklyTraderHref('shared/id', 'bybit futures')).toBe(
      '/trader/shared%2Fid?platform=bybit%20futures'
    )
    expect(weeklyTraderHref('shared-id', 'binance_futures')).not.toBe(
      weeklyTraderHref('shared-id', 'bybit_futures')
    )
  })
})
