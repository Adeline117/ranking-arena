import { render, screen } from '@testing-library/react'
import StatsPage from '../StatsPage'

const mockEquityCurveSection = jest.fn(() => <div data-testid="equity-curve-section" />)
const mockPnlCalendarHeatmap = jest.fn(({ days }: { data: unknown; days: number }) => (
  <output data-testid="pnl-calendar">{days}</output>
))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/ui/ProGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pro-gate">{children}</div>
  ),
}))
jest.mock('../components/TradingSection', () => ({ TradingSection: () => null }))
jest.mock('../components/EquityCurveSection', () => ({
  EquityCurveSection: (props: Record<string, unknown>) => mockEquityCurveSection(props),
}))
jest.mock('../components/BreakdownSection', () => ({ BreakdownSection: () => null }))
jest.mock('../../charts/PnlCalendarHeatmap', () => ({
  PnlCalendarHeatmap: (props: { data: unknown; days: number }) => mockPnlCalendarHeatmap(props),
}))

describe('StatsPage history completeness', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    ['partial', 'interactive_preview', 'historyCompletenessPartialTitle'],
    ['unknown', 'history_evidence_not_bound', 'historyCompletenessUnknownTitle'],
  ] as const)(
    'keeps the %s disclosure visible outside the Pro gate',
    async (state, reason, title) => {
      render(
        <StatsPage
          stats={undefined}
          traderHandle="trader-a"
          positionHistory={[]}
          historyCompleteness={{ state, reason }}
          isPro={false}
        />
      )

      const notice = await screen.findByRole('status', { name: title })
      expect(screen.getByTestId('pro-gate')).not.toContainElement(notice)
    }
  )

  it.each([
    null,
    {
      state: 'complete' as const,
      reason: 'verified_terminal_history' as const,
      evidenceState: 'verified' as const,
      scanTerminalState: 'exhausted' as const,
      blockerReasons: [],
    },
  ])('does not label trusted or legacy history as incomplete', async (historyCompleteness) => {
    render(
      <StatsPage
        stats={undefined}
        traderHandle="trader-a"
        positionHistory={[]}
        historyCompleteness={historyCompleteness}
        isPro={false}
      />
    )

    await screen.findByTestId('pro-gate')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('binds the serving heatmap and main curve to the exact resolved period', async () => {
    const sevenDayCurve = [
      { date: '2026-07-01', roi: 1, pnl: 10 },
      { date: '2026-07-02', roi: 2, pnl: 20 },
      { date: '2026-07-03', roi: 3, pnl: 30 },
      { date: '2026-07-04', roi: 4, pnl: 40 },
    ]
    const ninetyDayCurve = [
      { date: '2026-04-01', roi: 10, pnl: 100 },
      { date: '2026-04-02', roi: 20, pnl: 200 },
      { date: '2026-04-03', roi: 30, pnl: 300 },
      { date: '2026-04-04', roi: 40, pnl: 400 },
    ]

    render(
      <StatsPage
        stats={undefined}
        traderHandle="trader-a"
        equityCurve={{ '7D': sevenDayCurve, '30D': [], '90D': ninetyDayCurve }}
        selectedPeriod="7D"
        strictPeriod
      />
    )

    expect(await screen.findByTestId('pnl-calendar')).toHaveTextContent('7')
    expect(mockPnlCalendarHeatmap).toHaveBeenCalledWith({ data: sevenDayCurve, days: 7 })
    expect(mockEquityCurveSection).toHaveBeenCalledWith(
      expect.objectContaining({ selectedPeriod: '7D', strictPeriod: true })
    )
  })

  it('hides a serving heatmap rather than substituting 90D when the selected curve is absent', async () => {
    const ninetyDayCurve = [
      { date: '2026-04-01', roi: 10, pnl: 100 },
      { date: '2026-04-02', roi: 20, pnl: 200 },
      { date: '2026-04-03', roi: 30, pnl: 300 },
      { date: '2026-04-04', roi: 40, pnl: 400 },
    ]

    render(
      <StatsPage
        stats={undefined}
        traderHandle="trader-a"
        equityCurve={{ '7D': [], '30D': [], '90D': ninetyDayCurve }}
        selectedPeriod="7D"
        strictPeriod
      />
    )

    await screen.findByTestId('equity-curve-section')
    expect(screen.queryByTestId('pnl-calendar')).not.toBeInTheDocument()
    expect(mockPnlCalendarHeatmap).not.toHaveBeenCalled()
  })

  it('keeps the legacy 90D heatmap behavior when strict serving mode is off', async () => {
    const ninetyDayCurve = [
      { date: '2026-04-01', roi: 10, pnl: 100 },
      { date: '2026-04-02', roi: 20, pnl: 200 },
      { date: '2026-04-03', roi: 30, pnl: 300 },
      { date: '2026-04-04', roi: 40, pnl: 400 },
    ]

    render(
      <StatsPage
        stats={undefined}
        traderHandle="trader-a"
        equityCurve={{ '7D': [], '30D': [], '90D': ninetyDayCurve }}
      />
    )

    expect(await screen.findByTestId('pnl-calendar')).toHaveTextContent('90')
    expect(mockPnlCalendarHeatmap).toHaveBeenCalledWith({ data: ninetyDayCurve, days: 90 })
  })
})
