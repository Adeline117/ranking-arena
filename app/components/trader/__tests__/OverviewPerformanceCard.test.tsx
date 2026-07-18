import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import OverviewPerformanceCard from '../OverviewPerformanceCard'
import { usePeriodStore } from '@/lib/stores/periodStore'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('../performance/PeriodSelector', () => ({
  PeriodSelector: ({
    period,
    onPeriodChange,
  }: {
    period: '7D' | '30D' | '90D'
    onPeriodChange: (period: '7D' | '30D' | '90D') => void
  }) => (
    <div>
      {(['7D', '30D', '90D'] as const).map((candidate) => (
        <button
          key={candidate}
          aria-label={`${candidate} period`}
          aria-pressed={period === candidate}
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
jest.mock('../performance/ScoreBreakdownSection', () => ({ ScoreBreakdownSection: () => null }))

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
})
