import {
  riskFromCumulativePnl,
  ratiosFromCumulativePnl,
  riskFromEquitySeries,
  deriveMissingRatios,
} from '../series-risk'

/** Build a cumulative-PnL series from per-day deltas. */
function cum(deltas: number[]): Array<{ ts: string; value: number }> {
  let acc = 0
  return deltas.map((d, i) => {
    acc += d
    return { ts: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`, value: acc }
  })
}

describe('riskFromCumulativePnl', () => {
  it('returns all-null on missing/short series or bad base', () => {
    expect(riskFromCumulativePnl(null, 1000)).toEqual({
      mdd: null,
      sharpe: null,
      sortino: null,
      samples: 0,
    })
    expect(riskFromCumulativePnl([{ ts: 'a', value: 1 }], 1000).samples).toBe(0)
    // base must be positive
    expect(riskFromCumulativePnl(cum([1, 2, 3]), 0).mdd).toBeNull()
    expect(riskFromCumulativePnl(cum([1, 2, 3]), -5).mdd).toBeNull()
  })

  it('computes a positive-magnitude MDD from a peak-to-trough dip', () => {
    // equity base 10000; cumPnl peaks at +2000 (12000) then drops to +200 (10200)
    const series = [
      { ts: '2026-06-01T00:00:00Z', value: 0 },
      { ts: '2026-06-02T00:00:00Z', value: 2000 }, // peak 12000
      { ts: '2026-06-03T00:00:00Z', value: 200 }, // trough 10200 → 15% drawdown
      { ts: '2026-06-04T00:00:00Z', value: 1000 },
    ]
    const r = riskFromCumulativePnl(series, 10000)
    expect(r.mdd).toBeCloseTo(15, 1)
    expect(r.samples).toBe(4)
  })

  it('returns 100 MDD when equity is fully wiped out', () => {
    const series = [
      { ts: '2026-06-01T00:00:00Z', value: 0 },
      { ts: '2026-06-02T00:00:00Z', value: -10000 }, // base 10000 → equity 0
    ]
    const r = riskFromCumulativePnl(series, 10000)
    expect(r.mdd).toBe(100)
    expect(r.sharpe).toBeNull()
  })

  it('needs >=7 daily samples for Sharpe/Sortino', () => {
    const r6 = riskFromCumulativePnl(cum([10, 10, 10, 10, 10, 10]), 10000)
    expect(r6.sharpe).toBeNull()
    expect(r6.sortino).toBeNull()
    // 7 return-deltas → 8 points
    const r8 = riskFromCumulativePnl(cum([10, -5, 12, -3, 8, -2, 15, -4]), 10000)
    expect(typeof r8.sharpe).toBe('number')
    expect(typeof r8.sortino).toBe('number')
  })

  it('caps Sortino at +10 when there are no down days', () => {
    const r = riskFromCumulativePnl(cum([5, 5, 5, 5, 5, 5, 5, 5]), 10000)
    expect(r.sortino).toBe(10)
    // monotonic up curve → no drawdown
    expect(r.mdd).toBe(0)
  })

  it('returns null Sharpe for a flat (zero-variance) curve', () => {
    const flat = Array.from({ length: 8 }, (_, i) => ({
      ts: `2026-06-0${i + 1}T00:00:00Z`,
      value: 0,
    }))
    expect(riskFromCumulativePnl(flat, 10000).sharpe).toBeNull()
  })

  it('sorts unsorted input defensively', () => {
    const a = riskFromCumulativePnl(cum([10, -5, 12, -3, 8, -2, 15, -4]), 10000)
    const shuffled = cum([10, -5, 12, -3, 8, -2, 15, -4]).slice().reverse()
    const b = riskFromCumulativePnl(shuffled, 10000)
    expect(b.mdd).toBeCloseTo(a.mdd as number, 5)
    expect(b.sharpe).toBeCloseTo(a.sharpe as number, 5)
  })
})

describe('ratiosFromCumulativePnl (base-free, for DEX without capital base)', () => {
  it('needs >=7 deltas and returns no MDD field', () => {
    const deltas = [10, -5, 12, -3, 8, -2, 15, -4]
    const r = ratiosFromCumulativePnl(cum(deltas))
    expect(typeof r.sharpe).toBe('number')
    expect(typeof r.sortino).toBe('number')
    expect(r.samples).toBe(deltas.length - 1) // N-1 return-deltas (the gate count)
    expect((r as Record<string, unknown>).mdd).toBeUndefined()
    expect(ratiosFromCumulativePnl(cum([1, 2, 3])).sharpe).toBeNull()
  })

  it('base cancels: Sharpe matches the base-aware version when capital is huge (≈constant equity)', () => {
    // With a very large base relative to PnL, equity is ~constant so the
    // base-aware return-ratio Sharpe converges to the base-free delta Sharpe.
    const deltas = [10, -5, 12, -3, 8, -2, 15, -4, 6, -7]
    const free = ratiosFromCumulativePnl(cum(deltas))
    const aware = riskFromCumulativePnl(cum(deltas), 1e9)
    expect(free.sharpe).toBeCloseTo(aware.sharpe as number, 2)
    expect(free.sortino).toBeCloseTo(aware.sortino as number, 2)
  })
})

describe('deriveMissingRatios (CEX self-derivation from stored series)', () => {
  const series = (metric: string, deltas: number[], timeframe = 30) => ({
    timeframe,
    metric,
    points: cum(deltas),
  })

  it('fills sharpe/sortino on a null-sharpe stat from a matching pnl series', () => {
    const stats = [{ timeframe: 30, sharpe: null, mdd: 42, extras: {} as Record<string, unknown> }]
    deriveMissingRatios(stats, [series('pnl', [10, -5, 12, -3, 8, -2, 15, -4])])
    expect(typeof stats[0].sharpe).toBe('number')
    expect(stats[0].extras.sharpe_derivation).toBe('series-derived')
    expect(typeof stats[0].extras.sortino).toBe('number')
    expect(stats[0].mdd).toBe(42) // exchange mdd left untouched
  })

  it('NEVER overrides an exchange-reported sharpe', () => {
    const stats = [{ timeframe: 30, sharpe: 1.5, mdd: null, extras: {} as Record<string, unknown> }]
    deriveMissingRatios(stats, [series('pnl', [10, -5, 12, -3, 8, -2, 15, -4])])
    expect(stats[0].sharpe).toBe(1.5)
    expect(stats[0].extras.sharpe_derivation).toBeUndefined()
  })

  it('prefers pnl but falls back to a roi series', () => {
    const stats = [{ timeframe: 7, sharpe: null, mdd: null, extras: {} as Record<string, unknown> }]
    deriveMissingRatios(stats, [series('roi', [2, -1, 3, -1, 2, -1, 4, -2], 7)])
    expect(typeof stats[0].sharpe).toBe('number')
    expect(stats[0].extras.sharpe_derivation).toBe('series-derived')
  })

  it('stays NULL when the series is too short (no dishonest fill)', () => {
    const stats = [
      { timeframe: 30, sharpe: null, mdd: null, extras: {} as Record<string, unknown> },
    ]
    deriveMissingRatios(stats, [series('pnl', [10, -5, 12])])
    expect(stats[0].sharpe).toBeNull()
    expect(stats[0].extras.sharpe_derivation).toBeUndefined()
  })

  it('ignores _daily metrics (uncertain per-period semantics)', () => {
    const stats = [
      { timeframe: 30, sharpe: null, mdd: null, extras: {} as Record<string, unknown> },
    ]
    deriveMissingRatios(stats, [series('pnl_daily', [10, -5, 12, -3, 8, -2, 15, -4])])
    expect(stats[0].sharpe).toBeNull()
  })
})

describe('riskFromEquitySeries (direct equity curve, e.g. Hyperliquid)', () => {
  it('computes true peak-to-trough MDD on the actual equity samples', () => {
    const equity = [
      { ts: '2026-06-01T00:00:00Z', value: 10000 },
      { ts: '2026-06-02T00:00:00Z', value: 12000 }, // peak
      { ts: '2026-06-03T00:00:00Z', value: 9000 }, // trough → 25% drawdown
      { ts: '2026-06-04T00:00:00Z', value: 11000 },
    ]
    const r = riskFromEquitySeries(equity)
    expect(r.mdd).toBeCloseTo(25, 1)
    expect(r.samples).toBe(4)
  })

  it('drops non-positive equity samples and returns all-null when too few remain', () => {
    expect(riskFromEquitySeries(null).mdd).toBeNull()
    expect(
      riskFromEquitySeries([
        { ts: 'a', value: -1 },
        { ts: 'b', value: 5000 },
      ]).mdd
    ).toBeNull()
  })
})
