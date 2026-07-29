import {
  isRankEligiblePnl,
  isRankEligibleRoi,
  normalizeRankDrawdown,
  normalizeRankProfitFactor,
  normalizeRankSharpe,
  normalizeRankTradesCount,
  normalizeRankWinRate,
} from '../metric-eligibility'

describe('ranking metric eligibility', () => {
  it('preserves finite zero/loss ROI while rejecting runtime-invalid and clamp values', () => {
    expect(isRankEligibleRoi(0, '90D')).toBe(true)
    expect(isRankEligibleRoi(-10.5, '90D')).toBe(true)
    expect(isRankEligibleRoi(2_000, '7D')).toBe(true)
    expect(isRankEligibleRoi(2_000.01, '7D')).toBe(false)
    expect(isRankEligibleRoi(10_000, '90D')).toBe(false)
    expect(isRankEligibleRoi(-10_000, '90D')).toBe(false)
    expect(isRankEligibleRoi(Number.NaN, '90D')).toBe(false)
    expect(isRankEligibleRoi(Number.POSITIVE_INFINITY, '90D')).toBe(false)
    expect(isRankEligibleRoi('10', '90D')).toBe(false)
  })

  it('applies source-aware PnL bounds before cohort construction', () => {
    expect(isRankEligiblePnl(0, 'binance_futures')).toBe(true)
    expect(isRankEligiblePnl(-10_000_000, 'binance_futures')).toBe(true)
    expect(isRankEligiblePnl(100_000_000, 'binance_futures')).toBe(true)
    expect(isRankEligiblePnl(100_000_001, 'binance_futures')).toBe(false)
    expect(isRankEligiblePnl(500_000_000, 'hyperliquid')).toBe(true)
    expect(isRankEligiblePnl(500_000_000, 'gmx')).toBe(true)
    expect(isRankEligiblePnl(500_000_000, 'dydx')).toBe(true)
    expect(isRankEligiblePnl(500_000_000, 'drift')).toBe(true)
    expect(isRankEligiblePnl(500_000_000, 'jupiter_perps')).toBe(false)
    expect(isRankEligiblePnl(1_000_000_001, 'hyperliquid')).toBe(false)
  })

  it('never coerces invalid risk metrics into complete ranking evidence', () => {
    expect(normalizeRankWinRate(0)).toBe(0)
    expect(normalizeRankWinRate(0.6)).toBe(0.6)
    expect(normalizeRankWinRate(60)).toBe(60)
    expect(normalizeRankWinRate('60')).toBeNull()
    expect(normalizeRankWinRate(Number.POSITIVE_INFINITY)).toBeNull()
    expect(normalizeRankWinRate(-1)).toBeNull()
    expect(normalizeRankWinRate(101)).toBeNull()
    expect(normalizeRankDrawdown(0)).toBe(0)
    expect(normalizeRankDrawdown(99.9)).toBe(99.9)
    expect(normalizeRankDrawdown(100)).toBeNull()
    expect(normalizeRankDrawdown(-1)).toBeNull()
    expect(normalizeRankDrawdown('10')).toBeNull()
    expect(normalizeRankDrawdown(Number.NaN)).toBeNull()
    expect(normalizeRankDrawdown(Number.POSITIVE_INFINITY)).toBeNull()
    expect(normalizeRankDrawdown(Number.NEGATIVE_INFINITY)).toBeNull()
  })

  it('keeps optional percentile inputs finite and inside their source contracts', () => {
    expect(normalizeRankSharpe(-20)).toBe(-20)
    expect(normalizeRankSharpe(20)).toBe(20)
    expect(normalizeRankSharpe(20.01)).toBeNull()
    expect(normalizeRankSharpe(Number.NaN)).toBeNull()
    expect(normalizeRankProfitFactor(0)).toBe(0)
    expect(normalizeRankProfitFactor(10)).toBe(10)
    expect(normalizeRankProfitFactor(-0.01)).toBeNull()
    expect(normalizeRankProfitFactor(Number.POSITIVE_INFINITY)).toBeNull()
    expect(normalizeRankTradesCount(0)).toBe(0)
    expect(normalizeRankTradesCount(10)).toBe(10)
    expect(normalizeRankTradesCount(1.5)).toBeNull()
    expect(normalizeRankTradesCount(Number.POSITIVE_INFINITY)).toBeNull()
  })
})
