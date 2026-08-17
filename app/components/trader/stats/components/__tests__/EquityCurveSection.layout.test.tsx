import { render, screen } from '@testing-library/react'
import { EquityCurveSection } from '../EquityCurveSection'
import { usePeriodStore } from '@/lib/stores/periodStore'

jest.mock('next/dynamic', () => () => () => null)

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('../SimpleLineChart', () => ({
  SimpleLineChart: () => <div data-testid="equity-chart" />,
}))

describe('EquityCurveSection responsive toolbar', () => {
  beforeEach(() => {
    usePeriodStore.setState({ period: '90D' })
  })

  afterEach(() => {
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

  it('keeps a serving chart on its exact selected window when that curve is absent', () => {
    const broaderWindowPoints = [
      { date: '2026-07-01', roi: 1, pnl: 10 },
      { date: '2026-07-02', roi: 2, pnl: 20 },
      { date: '2026-07-03', roi: 3, pnl: 30 },
      { date: '2026-07-04', roi: 4, pnl: 40 },
    ]

    render(
      <EquityCurveSection
        equityCurve={{ '7D': [], '30D': broaderWindowPoints, '90D': broaderWindowPoints }}
        traderHandle="serving-fixture"
        delay={0}
        selectedPeriod="7D"
        strictPeriod
      />
    )

    expect(screen.getByText('noDataForPeriod')).toBeInTheDocument()
    expect(screen.queryByTestId('equity-chart')).not.toBeInTheDocument()
    expect(usePeriodStore.getState().period).toBe('90D')
  })
})
