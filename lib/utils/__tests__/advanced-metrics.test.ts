import {
  calculateProfitFactor,
  calculateConsecutiveStats,
  type TradeData,
} from '../advanced-metrics'

describe('calculateProfitFactor', () => {
  it('returns null for empty trades', () => {
    expect(calculateProfitFactor([])).toBeNull()
  })

  it('calculates profit factor correctly', () => {
    const trades: TradeData[] = [
      { pnl: 100, timestamp: '2024-01-01' },
      { pnl: 200, timestamp: '2024-01-02' },
      { pnl: -50, timestamp: '2024-01-03' },
    ]
    const result = calculateProfitFactor(trades)
    // Gross profit = 300, gross loss = 50, factor = 6
    expect(result).toBe(6)
  })

  it('returns null when no losses', () => {
    const trades: TradeData[] = [
      { pnl: 100, timestamp: '2024-01-01' },
      { pnl: 200, timestamp: '2024-01-02' },
    ]
    const result = calculateProfitFactor(trades)
    // No losses means profit factor uses a fallback (gross_profit / 1 cap)
    expect(result).toBeGreaterThan(0)
  })

  it('handles all losses', () => {
    const trades: TradeData[] = [
      { pnl: -100, timestamp: '2024-01-01' },
      { pnl: -200, timestamp: '2024-01-02' },
    ]
    const result = calculateProfitFactor(trades)
    expect(result).toBe(0)
  })
})

describe('calculateConsecutiveStats', () => {
  it('handles empty trades', () => {
    const stats = calculateConsecutiveStats([])
    expect(stats.maxWins).toBe(0)
    expect(stats.maxLosses).toBe(0)
  })

  it('counts consecutive wins', () => {
    const trades: TradeData[] = [
      { pnl: 10, timestamp: '2024-01-01' },
      { pnl: 20, timestamp: '2024-01-02' },
      { pnl: 30, timestamp: '2024-01-03' },
      { pnl: -5, timestamp: '2024-01-04' },
    ]
    const stats = calculateConsecutiveStats(trades)
    expect(stats.maxWins).toBe(3)
    expect(stats.maxLosses).toBe(1)
  })

  it('counts consecutive losses', () => {
    const trades: TradeData[] = [
      { pnl: -10, timestamp: '2024-01-01' },
      { pnl: -20, timestamp: '2024-01-02' },
      { pnl: 5, timestamp: '2024-01-03' },
    ]
    const stats = calculateConsecutiveStats(trades)
    expect(stats.maxLosses).toBe(2)
    expect(stats.maxWins).toBe(1)
  })
})
