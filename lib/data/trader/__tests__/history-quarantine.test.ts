import {
  LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
  quarantineLegacyFullPositions,
  quarantineLegacyPositionHistory,
  quarantineLegacyTraderTimeseries,
} from '../history-quarantine'

describe('legacy history response quarantine', () => {
  it('clones and clears every legacy profile-history surface with explicit unknown evidence', () => {
    const cached = {
      profile: { handle: 'cached' },
      performance: { roi_90d: 9, avg_profit: 42, largest_loss: -5 },
      equityCurve: { '90D': [{ date: '2026-08-17', roi: 9, pnl: 42 }] },
      assetBreakdown: { '90D': [{ symbol: 'BTC', weightPct: 100 }] },
      stats: { trading: { avgProfit: 42 } },
      portfolio: [{ market: 'BTCUSDT', price: 100, pnl: 42 }],
      positionHistory: [{ symbol: 'BTCUSDT', pnlUsd: 42 }],
      positionSummary: { totalUnrealizedPnl: 42 },
      historyCompleteness: { state: 'complete' },
    }

    const sanitized = quarantineLegacyPositionHistory(cached)

    expect(sanitized).not.toBe(cached)
    expect(sanitized).toEqual({
      profile: cached.profile,
      performance: {
        roi_90d: 9,
        avg_profit: null,
        largest_loss: null,
        winning_positions: null,
        total_positions: null,
        winning_positions_7d: null,
        winning_positions_30d: null,
        total_positions_7d: null,
        total_positions_30d: null,
        avg_holding_time_hours: null,
        largest_win: null,
        avg_loss: null,
      },
      equityCurve: undefined,
      assetBreakdown: undefined,
      stats: null,
      portfolio: [],
      positionHistory: [],
      positionSummary: null,
      historyCompleteness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
    })
    expect(cached.equityCurve['90D']).toHaveLength(1)
    expect(cached.portfolio).toHaveLength(1)
    expect(cached.positionHistory).toHaveLength(1)
  })

  it('clears the historical full-route positions alias', () => {
    expect(
      quarantineLegacyFullPositions({
        portfolio: [{ market: 'ETHUSDT', price: 100, pnl: 42 }],
        positions: [{ symbol: 'ETHUSDT' }],
        equityCurve: [{ date: '2026-08-17', roi: 9, pnl: 42 }],
        assetBreakdown: [{ symbol: 'ETH', weightPct: 100 }],
        stats: { raw: 42 },
      })
    ).toEqual({
      portfolio: [],
      positions: [],
      equityCurve: [],
      assetBreakdown: [],
      stats: null,
      historyCompleteness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
    })
  })

  it('nulls the deprecated timeseries transport without making a zero baseline', () => {
    const payload = quarantineLegacyTraderTimeseries({
      timeseries: {
        equity_curve: [{ date: '2026-08-17', roi: 9, pnl: 42 }],
        daily_pnl: [{ date: '2026-08-17', pnl: 42 }],
        asset_breakdown: [{ symbol: 'BTC', weight_pct: 100 }],
      },
    })

    expect(payload).toEqual({
      timeseries: { equity_curve: null, daily_pnl: null, asset_breakdown: null },
      history_completeness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
    })
  })

  it.each([null, undefined, 'cached', 7, []])('leaves non-record payload %p unchanged', (value) => {
    expect(quarantineLegacyPositionHistory(value)).toBe(value)
    expect(quarantineLegacyFullPositions(value)).toBe(value)
    expect(quarantineLegacyTraderTimeseries(value)).toBe(value)
  })
})
