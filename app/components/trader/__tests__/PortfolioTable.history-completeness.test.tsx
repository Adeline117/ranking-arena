import { fireEvent, render, screen } from '@testing-library/react'
import PortfolioTable from '../PortfolioTable'
import type { PortfolioItem, PositionHistoryItem } from '@/lib/data/trader-types'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/ui/ProGate', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pro-gate">{children}</div>
  ),
}))
jest.mock('next/dynamic', () => () => () => null)
jest.mock('../PortfolioCurrentView', () => () => <div>current-view</div>)
jest.mock('../PositionHistoryView', () => () => <div>history-view</div>)

const position: PortfolioItem = {
  market: 'BTCUSDT',
  direction: 'long',
  invested: 100,
  pnl: 10,
  value: 110,
  price: 100,
}

const history: PositionHistoryItem = {
  symbol: 'BTCUSDT',
  direction: 'long',
  entryPrice: 100,
  exitPrice: 110,
  pnlPct: 10,
  openTime: '2026-07-01T00:00:00.000Z',
  closeTime: '2026-07-02T00:00:00.000Z',
}

describe('PortfolioTable history completeness', () => {
  it('shows unknown only after the user opens history and keeps it outside ProGate', () => {
    render(
      <PortfolioTable
        items={[position]}
        history={[history]}
        historyCompleteness={{
          state: 'unknown',
          reason: 'history_evidence_not_bound',
        }}
        isPro={false}
      />
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'positionHistory' }))

    const notice = screen.getByRole('status', { name: 'historyCompletenessUnknownTitle' })
    expect(screen.getByTestId('pro-gate')).not.toContainElement(notice)
    expect(screen.getByText('history-view')).toBeInTheDocument()
  })

  it('discloses an empty partial result instead of implying a verified empty history', () => {
    render(
      <PortfolioTable
        items={[]}
        history={[]}
        historyCompleteness={{ state: 'partial', reason: 'interactive_preview' }}
      />
    )

    expect(screen.getByRole('status', { name: 'historyCompletenessPartialTitle' })).toHaveAttribute(
      'data-history-completeness',
      'partial'
    )
    expect(screen.getByText('noPositionHistoryDesc')).toBeInTheDocument()
  })

  it.each([
    null,
    {
      state: 'complete' as const,
      reason: 'verified_terminal_history' as const,
      evidenceState: 'verified' as const,
      scanTerminalState: 'exhausted' as const,
      blockerReasons: [],
    },
  ])('does not label trusted or legacy history as incomplete', (historyCompleteness) => {
    render(
      <PortfolioTable
        items={[position]}
        history={[history]}
        historyCompleteness={historyCompleteness}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'positionHistory' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
