import { computeWalletPnl, type OnchainSwap } from '../pnl-accounting'

const t = (n: number) => `2026-06-${String(n).padStart(2, '0')}T00:00:00Z`
function swap(
  token: string,
  day: number,
  side: 'buy' | 'sell',
  tokenAmount: number,
  usdValue: number
): OnchainSwap {
  return { token, ts: t(day), side, tokenAmount, usdValue }
}

describe('computeWalletPnl', () => {
  it('realizes profit on a full round-trip (avg cost)', () => {
    // Buy 100 TOK for $100 (cost $1/tok), sell all 100 for $150 → +$50.
    const r = computeWalletPnl([swap('TOK', 1, 'buy', 100, 100), swap('TOK', 2, 'sell', 100, 150)])
    expect(r.realizedPnlUsd).toBeCloseTo(50, 6)
    expect(r.closedPositions).toBe(1)
    expect(r.winningPositions).toBe(1)
    expect(r.winRate).toBe(100)
    expect(r.txsBuy).toBe(1)
    expect(r.txsSell).toBe(1)
    expect(r.tokensTraded).toBe(1)
  })

  it('averages cost across multiple buys before a sell', () => {
    // Buy 100@$1 then 100@$3 → avg $2/tok over 200. Sell 100 for $250 → cost 100×$2=$200 → +$50.
    const r = computeWalletPnl([
      swap('TOK', 1, 'buy', 100, 100),
      swap('TOK', 2, 'buy', 100, 300),
      swap('TOK', 3, 'sell', 100, 250),
    ])
    expect(r.realizedPnlUsd).toBeCloseTo(50, 6)
    const tok = r.perToken[0]
    expect(tok.holding).toBeCloseTo(100, 6) // 100 left open
    expect(tok.costBasisUsd).toBeCloseTo(200, 6) // remaining basis
    expect(r.closedPositions).toBe(0) // still holding → not closed
  })

  it('counts a loss as a closed non-winning position', () => {
    const r = computeWalletPnl([swap('X', 1, 'buy', 10, 100), swap('X', 2, 'sell', 10, 60)])
    expect(r.realizedPnlUsd).toBeCloseTo(-40, 6)
    expect(r.closedPositions).toBe(1)
    expect(r.winningPositions).toBe(0)
    expect(r.winRate).toBe(0)
  })

  it('win rate across multiple tokens (2 wins / 1 loss = 66.67%)', () => {
    const r = computeWalletPnl([
      swap('A', 1, 'buy', 10, 100),
      swap('A', 2, 'sell', 10, 120), // +20 win
      swap('B', 1, 'buy', 10, 100),
      swap('B', 2, 'sell', 10, 130), // +30 win
      swap('C', 1, 'buy', 10, 100),
      swap('C', 2, 'sell', 10, 50), // -50 loss
    ])
    expect(r.closedPositions).toBe(3)
    expect(r.winningPositions).toBe(2)
    expect(r.winRate).toBeCloseTo(66.67, 2)
    expect(r.realizedPnlUsd).toBeCloseTo(0, 6) // 20+30-50
  })

  it('re-entering a token after closing counts two separate closed positions', () => {
    const r = computeWalletPnl([
      swap('R', 1, 'buy', 10, 100),
      swap('R', 2, 'sell', 10, 150), // close cycle 1: +50 win
      swap('R', 3, 'buy', 10, 100),
      swap('R', 4, 'sell', 10, 80), // close cycle 2: -20 loss
    ])
    expect(r.closedPositions).toBe(2)
    expect(r.winningPositions).toBe(1)
    expect(r.winRate).toBe(50)
    expect(r.realizedPnlUsd).toBeCloseTo(30, 6)
  })

  it('handles overselling (sell more than held) without negative basis', () => {
    // Sell 20 when only 10 held: cost basis capped at what was held.
    const r = computeWalletPnl([swap('D', 1, 'buy', 10, 100), swap('D', 2, 'sell', 20, 300)])
    expect(r.realizedPnlUsd).toBeCloseTo(200, 6) // proceeds 300 − cost 100
    expect(r.perToken[0].holding).toBe(0)
    expect(r.perToken[0].costBasisUsd).toBe(0)
  })

  it('aggregates volumes + sorts perToken by realized desc', () => {
    const r = computeWalletPnl([
      swap('LOW', 1, 'buy', 10, 100),
      swap('LOW', 2, 'sell', 10, 90), // -10
      swap('HI', 1, 'buy', 10, 100),
      swap('HI', 2, 'sell', 10, 300), // +200
    ])
    expect(r.buyVolumeUsd).toBeCloseTo(200, 6)
    expect(r.sellVolumeUsd).toBeCloseTo(390, 6)
    expect(r.totalVolumeUsd).toBeCloseTo(590, 6)
    expect(r.perToken[0].token).toBe('HI') // highest realized first
  })

  it('skips malformed swaps and sorts by ts', () => {
    const r = computeWalletPnl([
      swap('Z', 3, 'sell', 10, 150),
      { token: '', ts: t(1), side: 'buy', tokenAmount: 5, usdValue: 5 }, // bad token
      { token: 'Z', ts: t(2), side: 'buy', tokenAmount: NaN, usdValue: 100 }, // bad amount
      swap('Z', 1, 'buy', 10, 100),
    ])
    // Only the two valid Z swaps count, sorted → buy@day1 then sell@day3.
    expect(r.realizedPnlUsd).toBeCloseTo(50, 6)
    expect(r.tokensTraded).toBe(1)
  })

  it('empty / all-invalid input → zeroed stats, null win rate', () => {
    const r = computeWalletPnl([])
    expect(r.realizedPnlUsd).toBe(0)
    expect(r.closedPositions).toBe(0)
    expect(r.winRate).toBeNull()
    expect(r.perToken).toHaveLength(0)
  })
})

describe('dailyRealized (chain-derived pnl_daily raw material)', () => {
  it('accumulates per-day realized deltas on sells only, sorted by day', () => {
    const r = computeWalletPnl([
      { token: 'A', ts: '2026-07-01T10:00:00Z', side: 'buy', tokenAmount: 10, usdValue: 100 },
      { token: 'A', ts: '2026-07-02T10:00:00Z', side: 'sell', tokenAmount: 5, usdValue: 80 }, // +30
      { token: 'A', ts: '2026-07-02T12:00:00Z', side: 'sell', tokenAmount: 5, usdValue: 40 }, // -10
      { token: 'A', ts: '2026-07-05T09:00:00Z', side: 'buy', tokenAmount: 2, usdValue: 20 },
      { token: 'A', ts: '2026-07-06T09:00:00Z', side: 'sell', tokenAmount: 2, usdValue: 15 }, // -5
    ])
    expect(r.dailyRealized).toEqual([
      { ts: '2026-07-02', value: 20 },
      { ts: '2026-07-06', value: -5 },
    ])
    expect(r.realizedPnlUsd).toBe(15)
  })

  it('is empty when there are no sells', () => {
    const r = computeWalletPnl([
      { token: 'A', ts: '2026-07-01T10:00:00Z', side: 'buy', tokenAmount: 1, usdValue: 10 },
    ])
    expect(r.dailyRealized).toEqual([])
  })
})
