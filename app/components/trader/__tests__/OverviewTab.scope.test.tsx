import React from 'react'
import { render, screen } from '@testing-library/react'
import type { OverviewTabProps } from '../tabs/OverviewTab'

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function DynamicModule() {
      return <div data-testid="dynamic-module" />
    },
}))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock('@/lib/features', () => ({ features: { social: false } }))
jest.mock('@/app/components/utils/ErrorBoundary', () => ({
  SectionErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/app/components/trader/OverviewPerformanceCard', () => ({
  __esModule: true,
  default: () => <div data-testid="primary-performance" />,
}))
jest.mock('@/app/components/base', () => ({
  Box: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  Text: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
}))

import { deriveDailyRoiPointChanges, OverviewTab } from '../tabs/OverviewTab'

const linkedAccounts: OverviewTabProps['linkedAccounts'] = [
  {
    id: 'bybit:primary',
    platform: 'bybit',
    traderKey: 'primary',
    handle: 'Primary',
    label: null,
    isPrimary: true,
    roi: 10,
    pnl: null,
    arenaScore: null,
    winRate: 55,
    maxDrawdown: 10,
    rank: null,
  },
  {
    id: 'okx:secondary',
    platform: 'okx',
    traderKey: 'secondary',
    handle: 'Secondary',
    label: null,
    isPrimary: false,
    roi: 20,
    pnl: null,
    arenaScore: null,
    winRate: 60,
    maxDrawdown: 8,
    rank: null,
  },
]

const baseProps: OverviewTabProps = {
  data: {
    handle: 'Primary',
    source: 'bybit',
    source_trader_id: 'primary',
    roi: 99,
    pnl: 999,
    arena_score: 88,
  },
  traderProfile: { id: 'primary', handle: 'Primary', source: 'bybit' },
  traderPerformance: { roi_90d: 99, pnl: 999, arena_score: 88 },
  traderEquityCurve: {
    '90D': [
      { date: '2026-01-01', roi: 0, pnl: 0 },
      { date: '2026-01-02', roi: 1, pnl: 1 },
      { date: '2026-01-03', roi: 2, pnl: 2 },
    ],
    '30D': [],
    '7D': [],
  },
  traderSimilar: [],
  positionSummary: null,
  selectedPeriod: '90D',
  hasMultipleAccounts: true,
  activeAccount: 'all',
  aggregatedData: { combinedPnl: null, bestRoi: null, weightedScore: null },
  linkedAccounts,
  suppressAccountContent: true,
  accountContentStatus: 'unavailable',
  currentUserId: null,
  isVerifiedClaimOwner: false,
  isVerifiedTrader: false,
  verifiedTraderProfile: null,
  claimedUser: null,
}

describe('OverviewTab account scope', () => {
  it('derives cumulative ROI changes as percentage-point deltas', () => {
    expect(
      deriveDailyRoiPointChanges([
        { date: '2026-07-27', roi: 10 },
        { date: '2026-07-28', roi: 11 },
        { date: '2026-07-29', roi: 9.5 },
      ])
    ).toEqual([
      { date: '2026-07-28', returnPct: 1 },
      { date: '2026-07-29', returnPct: -1.5 },
    ])
  })

  it('shows linked evidence but never primary performance or charts in All accounts scope', () => {
    render(<OverviewTab {...baseProps} />)

    expect(screen.queryByTestId('primary-performance')).not.toBeInTheDocument()
    expect(screen.queryByText('noChartDataAvailable')).not.toBeInTheDocument()
    expect(screen.queryByText('traderAccountDataUnavailable')).not.toBeInTheDocument()
    expect(screen.getByTestId('dynamic-module')).toBeInTheDocument()
  })

  it('shows a neutral checking state and no account module while selection is unresolved', () => {
    render(
      <OverviewTab
        {...baseProps}
        hasMultipleAccounts={false}
        activeAccount="okx:secondary"
        aggregatedData={null}
        accountContentStatus="checking"
      />
    )

    expect(screen.getByRole('status')).toHaveTextContent('traderAccountDataChecking')
    expect(screen.queryByTestId('primary-performance')).not.toBeInTheDocument()
    expect(screen.queryByTestId('dynamic-module')).not.toBeInTheDocument()
  })

  it('renders account modules only after the caller marks the exact detail safe', () => {
    render(
      <OverviewTab
        {...baseProps}
        hasMultipleAccounts={false}
        activeAccount="okx:secondary"
        aggregatedData={null}
        suppressAccountContent={false}
      />
    )

    expect(screen.getByTestId('primary-performance')).toBeInTheDocument()
  })
})
