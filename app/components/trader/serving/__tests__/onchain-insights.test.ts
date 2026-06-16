import { shapeTokenDistribution, shapeTopTokens, shapePnlCalendar } from '../onchain-insights'

describe('onchain-insights shapers', () => {
  it('orders token distribution best→worst and tags positivity', () => {
    const out = shapeTokenDistribution({
      token_distribution: { gt_500: 1, p0_500: 9, n50_0: 10, lt_n50: 3 },
    })
    expect(out).toEqual([
      { key: 'gt_500', positive: true, count: 1 },
      { key: 'p0_500', positive: true, count: 9 },
      { key: 'n50_0', positive: false, count: 10 },
      { key: 'lt_n50', positive: false, count: 3 },
    ])
  })

  it('NULL-collapses token distribution when absent or all-zero', () => {
    expect(shapeTokenDistribution({})).toBeNull()
    expect(
      shapeTokenDistribution({ token_distribution: { gt_500: 0, p0_500: 0, n50_0: 0, lt_n50: 0 } })
    ).toBeNull()
  })

  it('shapes top tokens and drops entries without a symbol', () => {
    const out = shapeTopTokens({
      top_earning_tokens: [
        {
          symbol: 'BILL',
          address: '0xabc',
          logo: '/x.png',
          profit_pct: 141.3,
          realized_pnl: 79357,
        },
        { address: '0xdef' }, // no symbol → dropped
      ],
    })
    expect(out).toHaveLength(1)
    expect(out![0]).toMatchObject({ symbol: 'BILL', profitPct: 141.3, realizedPnl: 79357 })
  })

  it('converts daily PnL calendar to a cumulative series for the heatmap', () => {
    const out = shapePnlCalendar({
      pnl_calendar: [
        { date: '2026-03-29', pnl: -100 },
        { date: '2026-03-30', pnl: 50 },
        { date: '2026-03-31', pnl: 200 },
        { date: '2026-04-01', pnl: 10 },
      ],
    })
    // cumulative: -100, -50, 150, 160 — the heatmap re-derives the daily deltas
    expect(out).toEqual([
      { date: '2026-03-29', roi: 0, pnl: -100 },
      { date: '2026-03-30', roi: 0, pnl: -50 },
      { date: '2026-03-31', roi: 0, pnl: 150 },
      { date: '2026-04-01', roi: 0, pnl: 160 },
    ])
  })

  it('NULL-collapses calendar when too short to render', () => {
    expect(shapePnlCalendar({ pnl_calendar: [{ date: '2026-01-01', pnl: 5 }] })).toBeNull()
    expect(shapePnlCalendar({})).toBeNull()
  })
})
