import { aggregateLatestDailyPortfolioSnapshots } from '../snapshot-series'

describe('aggregateLatestDailyPortfolioSnapshots', () => {
  it('keeps only the newest snapshot for each portfolio/day before aggregating', () => {
    const series = aggregateLatestDailyPortfolioSnapshots([
      {
        portfolio_id: 'binance',
        total_equity: 100,
        total_pnl: 10,
        snapshot_at: '2026-07-10T08:00:00Z',
      },
      {
        portfolio_id: 'binance',
        total_equity: 120,
        total_pnl: 12,
        snapshot_at: '2026-07-10T12:00:00Z',
      },
      { portfolio_id: 'okx', total_equity: 80, total_pnl: -4, snapshot_at: '2026-07-10T10:00:00Z' },
    ])

    expect(series).toEqual([
      {
        total_equity: 200,
        total_pnl: 8,
        total_pnl_pct: 4,
        snapshot_at: '2026-07-10T12:00:00Z',
      },
    ])
  })

  it('keeps daily history separate and chronologically ordered', () => {
    const series = aggregateLatestDailyPortfolioSnapshots([
      {
        portfolio_id: 'binance',
        total_equity: 120,
        total_pnl: 12,
        snapshot_at: '2026-07-11T12:00:00Z',
      },
      {
        portfolio_id: 'binance',
        total_equity: 100,
        total_pnl: 10,
        snapshot_at: '2026-07-10T12:00:00Z',
      },
    ])

    expect(series.map((s) => s.total_equity)).toEqual([100, 120])
  })
})
