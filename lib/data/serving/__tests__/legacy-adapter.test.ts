import {
  positionsToPortfolio,
  historyToPositionHistory,
  servingToTraderProfile,
  servingStatsToPerformance,
  servingSeriesToEquityCurve,
  servingToAssetBreakdown,
  servingToStats,
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

  it('surfaces advanced metrics when present, NULL-collapses when absent', () => {
    const perf = servingStatsToPerformance({
      tf90: {
        roi: 30,
        pnl: 300,
        win_rate: 70,
        mdd: 15,
        win_positions: 51,
        total_positions: 139,
        sharpe: null, // binance omits → must stay undefined, not 0
      },
    })
    expect(perf.winning_positions).toBe(51)
    expect(perf.total_positions).toBe(139)
    expect(perf.sharpe_ratio).toBeUndefined() // null collapses, no misleading 0
    expect(perf.sortino_ratio).toBeUndefined()
  })

  it('NULL-collapses missing timeframes (only 90d present)', () => {
    const perf = servingStatsToPerformance({ tf90: { roi: 30, pnl: 300, win_rate: 70, mdd: 15 } })
    expect(perf.roi_90d).toBe(30)
    expect(perf.roi_7d).toBeUndefined()
    expect(perf.roi_30d).toBeUndefined()
  })

  it('merges roi+pnl series into per-TF EquityCurveData by day', () => {
    const ec = servingSeriesToEquityCurve({
      tf90: {
        roi: [
          { ts: '2026-06-01T00:00:00Z', value: 5 },
          { ts: '2026-06-02T00:00:00Z', value: 8 },
        ],
        pnl: [{ ts: '2026-06-02T00:00:00Z', value: 120 }],
      },
    })
    expect(ec['90D']).toEqual([
      { date: '2026-06-01', roi: 5, pnl: 0 },
      { date: '2026-06-02', roi: 8, pnl: 120 },
    ])
    expect(ec['7D']).toEqual([]) // missing TF collapses to empty
  })

  it('maps trading_preferences → per-TF AssetBreakdownData', () => {
    const ab = servingToAssetBreakdown({
      tf90: {
        trading_preferences: {
          assets: [
            { asset: 'BTC', volume: 60 },
            { asset: 'ETH', volume: 40 },
          ],
        },
      },
    })
    expect(ab['90D']).toEqual([
      { symbol: 'BTC', weightPct: 60 },
      { symbol: 'ETH', weightPct: 40 },
    ])
    expect(ab['7D']).toEqual([])
  })

  it('maps serving stats+extras → legacy TraderStats', () => {
    const s = servingToStats(
      { win_positions: 70, total_positions: 100, sharpe: 2.1, mdd: 12, volume: 5000 },
      { avg_profit: 30, avg_loss: -10, trades_per_week: 15 }
    )
    expect(s.trading).toMatchObject({
      totalTrades12M: 100,
      avgProfit: 30,
      avgLoss: -10,
      profitableTradesPct: 70,
    })
    expect(s.additionalStats).toMatchObject({
      tradesPerWeek: 15,
      sharpeRatio: 2.1,
      maxDrawdown: 12,
      volume90d: 5000,
    })
  })
})
