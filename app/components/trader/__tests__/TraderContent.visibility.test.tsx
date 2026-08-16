import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import OverviewPerformanceCard from '../OverviewPerformanceCard'
import PortfolioTable from '../PortfolioTable'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('../performance/PeriodSelector', () => ({
  PeriodSelector: () => <div>period-selector</div>,
}))

describe('trader core content server visibility', () => {
  it('does not hide the real performance metrics before hydration', () => {
    const markup = renderToStaticMarkup(
      <OverviewPerformanceCard
        performance={{
          roi_90d: 12,
          pnl: 34,
          sharpe_ratio: 1.2,
          max_drawdown: 8,
          win_rate: 60,
          winning_positions: 6,
          total_positions: 10,
          arena_score_90d: 75,
          profitability_score: 80,
          risk_control_score: 70,
        }}
      />
    )

    expect(markup).toContain('hero-metric-value')
    expect(markup).toContain('metric-badges-grid')
    expect(markup).toContain('score-breakdown-layout')
    expect(markup).not.toMatch(/opacity:\s*0(?:;|\")/)
    expect(markup).not.toContain('translateY(4px)')
    expect(markup).not.toContain('translateY(10px)')
    expect(markup).not.toContain('translateY(20px)')
  })

  it('does not hide a populated portfolio before hydration', () => {
    const markup = renderToStaticMarkup(
      <PortfolioTable
        items={[
          {
            market: 'BTC',
            direction: 'long',
            invested: 50,
            pnl: 3.2,
            value: 100,
            price: 50_000,
          },
        ]}
      />
    )

    expect(markup).toContain('BTC')
    expect(markup).not.toMatch(/opacity:\s*0(?:;|\")/)
    expect(markup).not.toContain('translateY(20px)')
  })
})
