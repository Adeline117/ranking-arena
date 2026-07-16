import { reconstructRoundTrips, fillStats, type HlFill } from '../fills'

const H = 3_600_000
const T0 = Date.parse('2026-06-01T00:00:00Z')

/** Build a fill. side B=+sz buy, A=−sz sell. startPosition = pre-fill position. */
function f(
  coin: string,
  hoursFromT0: number,
  side: 'B' | 'A',
  sz: number,
  px: number,
  startPosition: number,
  closedPnl = 0,
  fee = 0
): HlFill {
  return {
    coin,
    time: T0 + hoursFromT0 * H,
    side,
    sz: String(sz),
    px: String(px),
    startPosition: String(startPosition),
    closedPnl: String(closedPnl),
    fee: String(fee),
  }
}

describe('reconstructRoundTrips', () => {
  it('rebuilds a simple long round-trip (open → close)', () => {
    const fills = [
      f('BTC', 0, 'B', 1, 100, 0), // open long 1 @ 100 (0 → +1)
      f('BTC', 5, 'A', 1, 110, 1, 10, 0.5), // close (+1 → 0), pnl 10, fee 0.5
    ]
    const trips = reconstructRoundTrips(fills)
    expect(trips).toHaveLength(1)
    const t = trips[0]
    expect(t.side).toBe('long')
    expect(t.entryPrice).toBeCloseTo(100, 6)
    expect(t.exitPrice).toBeCloseTo(110, 6)
    expect(t.realizedPnl).toBeCloseTo(9.5, 6) // closedPnl − fee
    expect((t.closedAtMs - t.openedAtMs) / H).toBeCloseTo(5, 6)
  })

  it('handles partial closes with size-weighted exit price', () => {
    const fills = [
      f('ETH', 0, 'B', 2, 100, 0), // open long 2
      f('ETH', 1, 'A', 1, 105, 2, 5), // partial close (2 → 1)
      f('ETH', 2, 'A', 1, 115, 1, 15), // final close (1 → 0)
    ]
    const trips = reconstructRoundTrips(fills)
    expect(trips).toHaveLength(1)
    expect(trips[0].exitPrice).toBeCloseTo(110, 6) // (105+115)/2, equal sizes
    expect(trips[0].realizedPnl).toBeCloseTo(20, 6)
    expect(trips[0].size).toBeCloseTo(2, 6)
  })

  it('splits a direction flip into two trips (flagged)', () => {
    const fills = [
      f('SOL', 0, 'B', 1, 50, 0), // open long 1
      f('SOL', 3, 'A', 3, 55, 1, 5), // flip: +1 → −2 (close long, open short)
      f('SOL', 6, 'B', 2, 50, -2, 10), // close short (−2 → 0)
    ]
    const trips = reconstructRoundTrips(fills)
    expect(trips).toHaveLength(2)
    const [second, first] = trips // sorted newest-first
    expect(first.side).toBe('long')
    expect(first.fromFlip).toBe(true) // boundary approximated at the flip fill
    expect(second.side).toBe('short')
    expect(second.realizedPnl).toBeCloseTo(10, 6)
  })

  it('skips trips whose open predates the window (no guessed entries)', () => {
    const fills = [
      // startPosition 5 ≠ 0 — this close's open was never seen → not a trip
      f('DOGE', 1, 'A', 5, 0.1, 5, 3),
      // a complete pair after it
      f('DOGE', 2, 'B', 1, 0.1, 0),
      f('DOGE', 4, 'A', 1, 0.12, 1, 2),
    ]
    const trips = reconstructRoundTrips(fills)
    expect(trips).toHaveLength(1)
    expect(trips[0].realizedPnl).toBeCloseTo(2, 6)
  })
})

describe('fillStats', () => {
  it('aggregates winRate / holding / pnlRatio / trips-per-week', () => {
    const fills = [
      f('BTC', 0, 'B', 1, 100, 0),
      f('BTC', 4, 'A', 1, 110, 1, 20), // win, 4h
      f('ETH', 10, 'B', 1, 100, 0),
      f('ETH', 12, 'A', 1, 90, 1, -10), // loss, 2h
    ]
    const s = fillStats(fills, 0, 7)
    expect(s.totalPositions).toBe(2)
    expect(s.winPositions).toBe(1)
    expect(s.winRate).toBe(50)
    expect(s.avgHoldingHours).toBeCloseTo(3, 2)
    expect(s.pnlRatio).toBeCloseTo(2, 2) // avg win 20 / |avg loss| 10
    expect(s.tripsPerWeek).toBeCloseTo(2, 2)
    expect(s.boundaryComplete).toBe(true)
  })

  it('reconstructs before slicing so an earlier open and in-window close is retained', () => {
    const fills = [f('BTC', 0, 'B', 1, 100, 0), f('BTC', 10, 'A', 1, 110, 1, 10)]
    const s = fillStats(fills, T0 + 5 * H, 7)
    expect(s.totalPositions).toBe(1)
    expect(s.trips[0]).toMatchObject({ openedAtMs: T0, closedAtMs: T0 + 10 * H })
    expect(s.boundaryComplete).toBe(true)
  })

  it('diagnoses an in-window close whose open predates the fetched prefix', () => {
    const fills = [
      f('DOGE', 2, 'A', 5, 0.1, 5, 3),
      f('DOGE', 3, 'B', 1, 0.1, 0),
      f('DOGE', 4, 'A', 1, 0.12, 1, 2),
    ]
    const s = fillStats(fills, T0, 7)
    expect(s.totalPositions).toBe(1)
    expect(s.boundaryComplete).toBe(false)
    expect(s.boundarySkippedPositions).toBe(1)
  })

  it('does not poison a shorter window when the unknown boundary closed before it', () => {
    const fills = [
      f('DOGE', 2, 'A', 5, 0.1, 5, 3),
      f('DOGE', 8, 'B', 1, 0.1, 0),
      f('DOGE', 9, 'A', 1, 0.12, 1, 2),
    ]
    const s = fillStats(fills, T0 + 7 * H, 7)
    expect(s.totalPositions).toBe(1)
    expect(s.boundaryComplete).toBe(true)
    expect(s.boundarySkippedPositions).toBe(0)
  })

  it('null-collapses on no fills', () => {
    const s = fillStats([], 0, 30)
    expect(s.totalPositions).toBe(0)
    expect(s.winRate).toBeNull()
    expect(s.avgHoldingHours).toBeNull()
    expect(s.pnlRatio).toBeNull()
    expect(s.boundaryComplete).toBe(true)
  })
})
