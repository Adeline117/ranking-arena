import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import OverviewPerformanceCard from '../OverviewPerformanceCard'
import { usePeriodStore } from '@/lib/stores/periodStore'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('../performance/PeriodSelector', () => ({
  PeriodSelector: ({
    period,
    onPeriodChange,
    availability,
  }: {
    period: '7D' | '30D' | '90D'
    onPeriodChange: (period: '7D' | '30D' | '90D') => void
    availability?: Partial<Record<'7D' | '30D' | '90D', 'native' | 'derived' | 'absent'>>
  }) => (
    <div>
      {(['7D', '30D', '90D'] as const).map((candidate) => (
        <button
          key={candidate}
          aria-label={`${candidate} period`}
          aria-pressed={period === candidate}
          disabled={availability?.[candidate] === 'absent'}
          onClick={() => onPeriodChange(candidate)}
        >
          {candidate}
        </button>
      ))}
    </div>
  ),
}))

jest.mock('../performance/HeroMetrics', () => ({
  HeroMetrics: ({
    pnl,
    pnlDisclosure,
  }: {
    pnl?: number
    pnlDisclosure?: { windowDurationDays: number }
  }) => (
    <output data-testid="period-pnl" data-window={pnlDisclosure?.windowDurationDays}>
      {pnl}
    </output>
  ),
}))
jest.mock('../performance/MetricBadgesGrid', () => ({ MetricBadgesGrid: () => null }))
jest.mock('../performance/ScoreBreakdownSection', () => ({
  ScoreBreakdownSection: ({
    periodProfitabilityScore,
    periodRiskControlScore,
    scoreConfidence,
  }: {
    periodProfitabilityScore?: number
    periodRiskControlScore?: number
    scoreConfidence?: string | null
  }) => (
    <output
      data-testid="period-scores"
      data-profitability={
        periodProfitabilityScore == null ? 'unknown' : String(periodProfitabilityScore)
      }
      data-risk={periodRiskControlScore == null ? 'unknown' : String(periodRiskControlScore)}
      data-confidence={scoreConfidence ?? 'unknown'}
    />
  ),
}))

describe('OverviewPerformanceCard period switching', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    usePeriodStore.setState({ period: '90D' })
  })

  afterEach(() => {
    cleanup()
    jest.clearAllTimers()
    jest.useRealTimers()
    usePeriodStore.setState({ period: '90D' })
  })

  const performance = {
    pnl: 900,
    pnl_30d: 300,
    pnl_7d: 70,
    pnlDisclosures: {
      '30D': {
        kind: 'gmx_realized_net_completed_utc_days' as const,
        windowFrom: 1,
        windowTo: 2,
        windowDurationDays: 30 as const,
      },
      '90D': {
        kind: 'gmx_realized_net_completed_utc_days' as const,
        windowFrom: 1,
        windowTo: 2,
        windowDurationDays: 90 as const,
      },
    },
  }

  it('honors the latest click in a rapid 90D to 30D to 90D sequence', () => {
    render(<OverviewPerformanceCard performance={performance} />)

    fireEvent.click(screen.getByRole('button', { name: '30D period' }))
    fireEvent.click(screen.getByRole('button', { name: '90D period' }))

    act(() => jest.advanceTimersByTime(200))

    expect(usePeriodStore.getState().period).toBe('90D')
    expect(screen.getByRole('button', { name: '90D period' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('period-pnl')).toHaveTextContent('900')
    expect(screen.getByTestId('period-pnl')).toHaveAttribute('data-window', '90')
  })

  it('clears pending animation timers when the card unmounts', () => {
    const view = render(<OverviewPerformanceCard performance={performance} />)
    fireEvent.click(screen.getByRole('button', { name: '30D period' }))
    expect(jest.getTimerCount()).toBeGreaterThan(0)

    view.unmount()

    expect(jest.getTimerCount()).toBe(0)
  })

  it('keeps the performance card readable in SSR markup before hydration', () => {
    const markup = renderToStaticMarkup(<OverviewPerformanceCard performance={performance} />)

    expect(markup).toContain('period-pnl')
    expect(markup).not.toContain('opacity:0')
  })

  it('shows the dormant notice only for the selected all-zero activity period', () => {
    render(
      <OverviewPerformanceCard
        performance={{
          roi_90d: 2.46,
          pnl: 19.34,
          win_rate: 32,
          total_positions: 26,
          roi_30d: 0,
          pnl_30d: 0,
          win_rate_30d: undefined,
          total_positions_30d: 0,
        }}
      />
    )

    expect(screen.queryByText('traderDormantForPeriod')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '30D period' }))

    expect(screen.getByText('traderDormantForPeriod')).toBeInTheDocument()
  })

  it('keeps the selected period scores instead of leaking 90D dimensions', () => {
    render(
      <OverviewPerformanceCard
        performance={{
          profitability_score: 88,
          risk_control_score: 77,
          return_score_30d: 0,
          pnl_score_30d: 12,
          score_confidence: 'full',
          score_confidence_30d: 'partial',
        }}
      />
    )

    expect(screen.getByTestId('period-scores')).toHaveAttribute('data-profitability', '88')
    expect(screen.getByTestId('period-scores')).toHaveAttribute('data-risk', '77')
    expect(screen.getByTestId('period-scores')).toHaveAttribute('data-confidence', 'full')

    fireEvent.click(screen.getByRole('button', { name: '30D period' }))

    expect(screen.getByTestId('period-scores')).toHaveAttribute('data-profitability', '0')
    expect(screen.getByTestId('period-scores')).toHaveAttribute('data-risk', '12')
    expect(screen.getByTestId('period-scores')).toHaveAttribute('data-confidence', 'partial')
  })

  it('does not mask an invalid canonical 90D dimension with a legacy score', () => {
    render(
      <OverviewPerformanceCard
        performance={{
          profitability_score: 100.01,
          return_score: 50,
          risk_control_score: Number.NaN,
          pnl_score: 40,
        }}
      />
    )

    expect(screen.getByTestId('period-scores')).toHaveAttribute('data-profitability', 'unknown')
    expect(screen.getByTestId('period-scores')).toHaveAttribute('data-risk', 'unknown')
  })

  it('falls back an unsupported retained or deep-linked period to the best serving timeframe', () => {
    usePeriodStore.setState({ period: '7D' })

    render(
      <OverviewPerformanceCard
        performance={{ pnl: 900, pnl_30d: 300, pnl_7d: 70 }}
        availability={{ '7D': 'absent', '30D': 'native', '90D': 'absent' }}
      />
    )

    expect(usePeriodStore.getState().period).toBe('30D')
    expect(screen.getByRole('button', { name: '30D period' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: '7D period' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '90D period' })).toBeDisabled()
    expect(screen.getByTestId('period-pnl')).toHaveTextContent('300')
  })

  it('replaces the metric grid with a clear unavailable state when no core period is provided', () => {
    render(
      <OverviewPerformanceCard
        performance={{ pnl: 900 }}
        availability={{ '7D': 'absent', '30D': 'absent', '90D': 'absent' }}
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('tfNotProvided')
    expect(screen.queryByTestId('period-pnl')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '7D period' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '30D period' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '90D period' })).toBeDisabled()
  })
})
