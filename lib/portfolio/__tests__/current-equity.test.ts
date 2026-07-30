import { summarizePortfolioCurrentEquity } from '../current-equity'

describe('summarizePortfolioCurrentEquity', () => {
  it('sums exchange-reported equity and pnl across current active generations', () => {
    expect(
      summarizePortfolioCurrentEquity([
        {
          is_active: true,
          current_equity: 100,
          current_pnl: 10,
          current_equity_generation: 3,
        },
        {
          is_active: true,
          current_equity: '50',
          current_pnl: '-5',
          current_equity_generation: '2',
        },
      ])
    ).toEqual({ totalEquity: 150, totalPnl: 5, totalPnlPct: 5 / 1.5 })
  })

  it('does not reuse a projection after its portfolio becomes inactive', () => {
    expect(
      summarizePortfolioCurrentEquity([
        {
          is_active: false,
          current_equity: 1000,
          current_pnl: 200,
          current_equity_generation: 4,
        },
      ])
    ).toEqual({ totalEquity: 0, totalPnl: 0, totalPnlPct: 0 })
  })

  it.each([
    [0, 100, 10],
    [1, null, 10],
    [1, 100, null],
    [1, -1, 10],
    [1, 'not-a-number', 10],
  ])('fails closed on incomplete generation %p equity %p pnl %p', (generation, equity, pnl) => {
    expect(
      summarizePortfolioCurrentEquity([
        {
          is_active: true,
          current_equity: equity,
          current_pnl: pnl,
          current_equity_generation: generation,
        },
      ])
    ).toEqual({ totalEquity: 0, totalPnl: 0, totalPnlPct: 0 })
  })
})
