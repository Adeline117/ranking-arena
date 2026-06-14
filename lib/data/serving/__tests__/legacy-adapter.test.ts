import {
  positionsToPortfolio,
  historyToPositionHistory,
  servingToTraderProfile,
  servingStatsToPerformance,
} from '../legacy-adapter'

describe('serving → legacy adapter', () => {
  it('maps positions records to PortfolioItem (value = mark × size, direction normalized)', () => {
    const [item] = positionsToPortfolio([
      { symbol: 'BTCUSDT', side: 'SELL', size: 2, mark_price: 100, unrealized_pnl: -5, margin: 40 },
    ])
    expect(item).toEqual({
      market: 'BTCUSDT',
      direction: 'short',
      invested: 40,
      pnl: -5,
      value: 200,
      price: 100,
    })
  })

  it('maps position_history records, deriving pnlPct from notional when absent', () => {
    const [h] = historyToPositionHistory([
      {
        symbol: 'ETHUSDT',
        side: 'long',
        entry_price: 100,
        exit_price: 110,
        size: 10,
        realized_pnl: 100, // notional 100×10=1000 → 10%
        opened_at: '2026-06-01T00:00:00Z',
        closed_at: '2026-06-02T00:00:00Z',
      },
    ])
    expect(h.symbol).toBe('ETHUSDT')
    expect(h.direction).toBe('long')
    expect(h.entryPrice).toBe(100)
    expect(h.exitPrice).toBe(110)
    expect(h.pnlPct).toBeCloseTo(10, 5)
    expect(h.openTime).toBe('2026-06-01T00:00:00Z')
  })

  it('prefers an explicit realized_pnl_pct over the derived value', () => {
    const [h] = historyToPositionHistory([
      { symbol: 'X', side: 'short', entry_price: 1, exit_price: 1, size: 1, realized_pnl_pct: 42 },
    ])
    expect(h.pnlPct).toBe(42)
    expect(h.direction).toBe('short')
  })

  it('maps first-screen identity to TraderProfile', () => {
    const p = servingToTraderProfile({
      exchangeTraderId: 'abc123',
      nickname: 'Whale',
      avatarMirrorUrl: 'https://x/a.png',
      source: 'binance_futures',
      copierCount: 200,
    })
    expect(p.handle).toBe('abc123')
    expect(p.id).toBe('abc123')
    expect(p.display_name).toBe('Whale')
    expect(p.copiers).toBe(200)
    expect(p.source).toBe('binance_futures')
  })

  it('merges per-timeframe serving stats into TraderPerformance slots', () => {
    const perf = servingStatsToPerformance({
      tf7: { roi: 5, pnl: 50, win_rate: 60, mdd: 3 },
      tf30: { roi: 12, pnl: 120, win_rate: 65, mdd: 8 },
      tf90: { roi: 30, pnl: 300, win_rate: 70, mdd: 15 },
    })
    expect(perf.roi_7d).toBe(5)
    expect(perf.roi_30d).toBe(12)
    expect(perf.roi_90d).toBe(30)
    expect(perf.pnl).toBe(300) // 90d → primary
    expect(perf.win_rate).toBe(70)
    expect(perf.max_drawdown).toBe(15)
  })

  it('NULL-collapses missing timeframes (only 90d present)', () => {
    const perf = servingStatsToPerformance({ tf90: { roi: 30, pnl: 300, win_rate: 70, mdd: 15 } })
    expect(perf.roi_90d).toBe(30)
    expect(perf.roi_7d).toBeUndefined()
    expect(perf.roi_30d).toBeUndefined()
  })
})
