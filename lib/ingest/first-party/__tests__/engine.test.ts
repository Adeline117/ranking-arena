import { computeFirstParty, maxDrawdownPct, type RealizedEvent } from '../engine'

const DAY = 86_400_000
const NOW = Date.parse('2026-07-09T00:00:00.000Z')

function ev(daysAgo: number, pnl: number, positionLevel = true): RealizedEvent {
  return { ts: NOW - daysAgo * DAY, pnl, positionLevel }
}

describe('maxDrawdownPct', () => {
  it('computes peak-to-trough percentage', () => {
    expect(maxDrawdownPct([100, 120, 90, 110])).toBeCloseTo(25, 5) // 120→90
  })
  it('returns null for <2 points and 0 for monotonic rise', () => {
    expect(maxDrawdownPct([100])).toBeNull()
    expect(maxDrawdownPct([100, 110, 120])).toBe(0)
  })
})

describe('computeFirstParty', () => {
  it('windows realized events into 7/30/90 pnl + exact win rate', () => {
    const r = computeFirstParty({
      nowMs: NOW,
      currency: 'USDT',
      equityNow: 1000,
      balanceNow: 900,
      unrealizedNow: 50,
      events: [ev(1, +100), ev(10, -40), ev(60, +200)],
      netTransfersIn: {},
      netTransfersSinceLast: 0,
      snapshots: [],
    })
    const by = Object.fromEntries(r.stats.map((s) => [s.timeframe, s]))
    expect(by[7].pnl).toBeCloseTo(100)
    expect(by[7].winRate).toBe(100)
    expect(by[30].pnl).toBeCloseTo(60) // +100 −40
    expect(by[30].winRate).toBe(50)
    expect(by[90].pnl).toBeCloseTo(260)
    expect(by[90].winPositions).toBe(2)
    expect(by[90].totalPositions).toBe(3)
    for (const s of r.stats) expect(s.extras.provenance).toBe('first_party')
  })

  it('ROI reconstructed before snapshot coverage, snapshot-based after; MDD honest-NULL early', () => {
    const noHistory = computeFirstParty({
      nowMs: NOW,
      currency: 'USDT',
      equityNow: 1100,
      balanceNow: null,
      unrealizedNow: null,
      events: [ev(2, +100)],
      netTransfersIn: { 7: 0 },
      netTransfersSinceLast: 0,
      snapshots: [],
    })
    const s7 = noHistory.stats.find((s) => s.timeframe === 7)!
    // recon start = 1100 − 100 = 1000 → roi 10%
    expect(s7.roi).toBeCloseTo(10)
    expect(s7.extras.roi_method).toBe('reconstructed')
    expect(s7.mdd).toBeNull() // no snapshot coverage → never faked

    const covered = computeFirstParty({
      nowMs: NOW,
      currency: 'USDT',
      equityNow: 1100,
      balanceNow: null,
      unrealizedNow: null,
      events: [ev(2, +100)],
      netTransfersIn: {},
      netTransfersSinceLast: 0,
      snapshots: [
        { ts: new Date(NOW - 8 * DAY).toISOString(), equity: 1000, net_transfer_cum: 0 },
        { ts: new Date(NOW - 4 * DAY).toISOString(), equity: 1200, net_transfer_cum: 0 },
        { ts: new Date(NOW - 1 * DAY).toISOString(), equity: 1050, net_transfer_cum: 0 },
      ],
    })
    const c7 = covered.stats.find((s) => s.timeframe === 7)!
    expect(c7.extras.roi_method).toBe('snapshot')
    expect(c7.mdd).toBeCloseTo(12.5) // 1200→1050
    expect(c7.extras.mdd_basis).toBe('snapshots')
  })

  it('transfers adjust reconstructed denominator and cum counter (no window double-count)', () => {
    const r = computeFirstParty({
      nowMs: NOW,
      currency: 'USDT',
      equityNow: 2100,
      balanceNow: null,
      unrealizedNow: null,
      events: [ev(3, +100)],
      netTransfersIn: { 7: 1000 }, // deposited 1000 this week
      netTransfersSinceLast: 25,
      snapshots: [
        { ts: new Date(NOW - 30 * DAY).toISOString(), equity: 900, net_transfer_cum: 500 },
      ],
    })
    const s7 = r.stats.find((s) => s.timeframe === 7)!
    // recon start = 2100 − 100 − 1000 = 1000 → roi 10% (deposit not counted as gain)
    expect(s7.roi).toBeCloseTo(10)
    expect(r.snapshot.netTransferCum).toBe(525) // 500 + since-last 25, NOT +1000 window
  })

  it('flags income-event win basis (binance) distinctly from position-level', () => {
    const r = computeFirstParty({
      nowMs: NOW,
      currency: 'USDT',
      equityNow: 500,
      balanceNow: null,
      unrealizedNow: null,
      events: [ev(1, +10, false), ev(2, -5, false)],
      netTransfersIn: {},
      netTransfersSinceLast: null,
      snapshots: [],
    })
    const s7 = r.stats.find((s) => s.timeframe === 7)!
    expect(s7.extras.win_rate_basis).toBe('income_events')
  })
})
