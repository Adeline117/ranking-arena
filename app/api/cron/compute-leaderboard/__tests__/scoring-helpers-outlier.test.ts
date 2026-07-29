/**
 * @jest-environment node
 */

import { markOutliers } from '../scoring-helpers'

describe('markOutliers source-aware PnL envelope', () => {
  it('keeps reviewed DEX whale PnL while rejecting the same value elsewhere', () => {
    const rows = [
      { source: 'hyperliquid', roi: 10, pnl: 500_000_000 },
      { source: 'gmx', roi: 10, pnl: 500_000_000 },
      { source: 'dydx', roi: 10, pnl: 500_000_000 },
      { source: 'drift', roi: 10, pnl: 500_000_000 },
      { source: 'jupiter_perps', roi: 10, pnl: 500_000_000 },
      { source: 'binance_futures', roi: 10, pnl: 500_000_000 },
    ]

    expect(markOutliers(rows)).toBe(2)
    expect(rows.slice(0, 4).every((row) => row.is_outlier !== true)).toBe(true)
    expect(rows.slice(4).every((row) => row.is_outlier === true)).toBe(true)
  })
})
