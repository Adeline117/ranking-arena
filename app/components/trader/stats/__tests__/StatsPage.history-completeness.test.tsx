import { render, screen } from '@testing-library/react'
import StatsPage from '../StatsPage'

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
jest.mock('../components/EquityCurveSection', () => ({ EquityCurveSection: () => null }))
jest.mock('../components/BreakdownSection', () => ({ BreakdownSection: () => null }))

describe('StatsPage history completeness', () => {
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
})
