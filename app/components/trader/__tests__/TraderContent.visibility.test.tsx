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

jest.mock('../performance/HeroMetrics', () => ({
  HeroMetrics: () => <div>hero-metrics</div>,
}))

jest.mock('../performance/MetricBadgesGrid', () => ({ MetricBadgesGrid: () => null }))
jest.mock('../performance/ScoreBreakdownSection', () => ({ ScoreBreakdownSection: () => null }))

describe('trader core content server visibility', () => {
  it('does not hide the performance card before hydration', () => {
    const markup = renderToStaticMarkup(
      <OverviewPerformanceCard performance={{ roi_90d: 12, pnl: 34 }} />
    )

    expect(markup).toContain('hero-metrics')
    expect(markup).not.toMatch(/opacity:\s*0(?:;|\")/)
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
