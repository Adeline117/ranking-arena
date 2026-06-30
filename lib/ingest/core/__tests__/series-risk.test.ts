import { riskFromCumulativePnl } from '../series-risk'

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

  it('computes a negative MDD from a peak-to-trough dip', () => {
    // equity base 10000; cumPnl peaks at +2000 (12000) then drops to +200 (10200)
    const series = [
      { ts: '2026-06-01T00:00:00Z', value: 0 },
      { ts: '2026-06-02T00:00:00Z', value: 2000 }, // peak 12000
      { ts: '2026-06-03T00:00:00Z', value: 200 }, // trough 10200 → -15%
      { ts: '2026-06-04T00:00:00Z', value: 1000 },
    ]
    const r = riskFromCumulativePnl(series, 10000)
    expect(r.mdd).toBeCloseTo(-15, 1)
    expect(r.samples).toBe(4)
  })

  it('returns -100 MDD when equity is fully wiped out', () => {
    const series = [
      { ts: '2026-06-01T00:00:00Z', value: 0 },
      { ts: '2026-06-02T00:00:00Z', value: -10000 }, // base 10000 → equity 0
    ]
    const r = riskFromCumulativePnl(series, 10000)
    expect(r.mdd).toBe(-100)
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
