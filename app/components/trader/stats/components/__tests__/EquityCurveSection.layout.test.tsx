import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EquityCurveSection } from '../EquityCurveSection'
import { getBestChartType } from '../ChartControls'
import { usePeriodStore } from '@/lib/stores/periodStore'

jest.mock('next/dynamic', () => () => () => null)

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('../SimpleLineChart', () => ({
  SimpleLineChart: ({
    data,
    dataKey,
    period,
  }: {
    data: Array<{ date: string; roi: number; pnl: number }>
    dataKey: 'roi' | 'pnl'
    period: string
  }) => (
    <div
      data-testid="equity-chart"
      data-points={data.length}
      data-key={dataKey}
      data-period={period}
    />
  ),
}))

describe('EquityCurveSection responsive toolbar', () => {
  beforeEach(() => {
    usePeriodStore.setState({ period: '90D' })
  })

  it('wraps controls and right-aligns chart actions when the row is narrow', () => {
    const points = [
      { date: '2026-07-01', roi: 1, pnl: 10 },
      { date: '2026-07-02', roi: 2, pnl: 20 },
      { date: '2026-07-03', roi: 3, pnl: 30 },
      { date: '2026-07-04', roi: 4, pnl: 40 },
    ]

    render(
      <EquityCurveSection
        equityCurve={{ '7D': points, '30D': points, '90D': points }}
        traderHandle="mobile-fixture"
        delay={0}
      />
    )

    const fullscreen = screen.getByRole('button', { name: 'traderFullscreen' })
    const actions = fullscreen.parentElement
    const toolbar = actions?.parentElement

    expect(actions).toHaveClass('equity-curve-actions')
    expect(actions).toHaveStyle({ marginLeft: 'auto', maxWidth: '100%' })
    expect(toolbar).toHaveClass('equity-curve-toolbar')
    expect(toolbar).toHaveStyle({ flexWrap: 'wrap', gap: '8px' })
  })

  it('renders the best non-empty period in server markup before hydration', () => {
    const points = [
      { date: '2026-07-01', roi: 1, pnl: 10 },
      { date: '2026-07-02', roi: 2, pnl: 20 },
      { date: '2026-07-03', roi: 3, pnl: 30 },
      { date: '2026-07-04', roi: 4, pnl: 40 },
    ]

    const markup = renderToStaticMarkup(
      <EquityCurveSection
        equityCurve={{ '7D': [], '30D': points, '90D': [] }}
        traderHandle="no-js-fixture"
        delay={0}
      />
    )

    expect(markup).toContain('data-testid="equity-chart"')
    expect(markup).toContain('data-points="4"')
    expect(markup).toContain('data-period="30D"')
    expect(markup).not.toContain('noDataForPeriod')
  })

  it('chooses PnL when the only non-empty period has no ROI movement', () => {
    const pnlOnly = [
      { date: '2026-07-01', roi: 0, pnl: 10 },
      { date: '2026-07-02', roi: 0, pnl: 20 },
      { date: '2026-07-03', roi: 0, pnl: 30 },
      { date: '2026-07-04', roi: 0, pnl: 40 },
    ]

    expect(getBestChartType({ '7D': [], '30D': pnlOnly, '90D': [] })).toBe('pnl')
  })
})
