import React from 'react'
import { render, screen } from '@testing-library/react'
import RecentActivityCard from '../RecentActivityCard'
import { useTraderRecords } from '@/lib/hooks/useTraderRecords'
import type { HistoryCompleteness } from '@/lib/data/serving/types'

jest.mock('@/lib/hooks/useTraderRecords', () => ({ useTraderRecords: jest.fn() }))
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  getLanguage: () => 'en',
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/ui/Metric', () => ({
  __esModule: true,
  default: ({ display }: { display?: string }) =>
    display ? <output data-testid="recent-activity-pnl">{display}</output> : null,
}))

const props = {
  source: 'gmx',
  exchangeTraderId: 'trader-a',
  enabled: true,
}

function recordsResult(completeness: HistoryCompleteness | null, rows: object[] = []) {
  return {
    rows,
    completeness,
    provenance: null,
    isPendingUpstream: false,
    isLoading: false,
    isInitialError: false,
    isFetchNextPageError: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: jest.fn(),
    error: null,
    refetch: jest.fn(),
  }
}

describe('RecentActivityCard history disclosure', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    [
      'partial',
      {
        state: 'partial',
        reason: 'interactive_preview',
        evidenceState: 'caller_limited',
        scanTerminalState: 'partial',
        blockerReasons: ['caller_limit'],
      } satisfies HistoryCompleteness,
      'historyCompletenessPartialTitle',
      'historyCompletenessPartialDescription',
    ],
    [
      'unknown',
      {
        state: 'unknown',
        reason: 'history_evidence_not_bound',
      } satisfies HistoryCompleteness,
      'historyCompletenessUnknownTitle',
      'historyCompletenessUnknownDescription',
    ],
  ])(
    'shows the %s order-history warning above captured rows',
    (_state, completeness, title, body) => {
      ;(useTraderRecords as jest.Mock).mockReturnValue(
        recordsResult(completeness, [
          { ts: '2026-08-03T12:00:00.000Z', symbol: 'BTCUSDT', side: 'buy' },
        ])
      )

      render(<RecentActivityCard {...props} />)

      expect(screen.getByRole('status', { name: title })).toHaveAttribute(
        'data-history-completeness',
        completeness.state
      )
      expect(screen.getByText(body)).toBeInTheDocument()
      expect(screen.getByText('BTCUSDT')).toBeInTheDocument()
    }
  )

  it('fails closed for legacy rows without completeness metadata', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue(
      recordsResult(null, [{ symbol: 'BTC', side: 'buy' }])
    )

    render(<RecentActivityCard {...props} />)

    expect(screen.getByRole('status', { name: 'historyCompletenessUnknownTitle' })).toHaveAttribute(
      'data-history-completeness',
      'unknown'
    )
    expect(screen.getByText('recentActivityViewAll')).toBeInTheDocument()
  })

  it('keeps an empty incomplete preview visible without claiming there is no history', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue(
      recordsResult({ state: 'partial', reason: 'interactive_preview' })
    )

    render(<RecentActivityCard {...props} />)

    expect(
      screen.getByRole('status', { name: 'historyCompletenessPartialTitle' })
    ).toBeInTheDocument()
    expect(screen.getByText('historyPreviewEmptyTitle')).toBeInTheDocument()
    expect(screen.getByText('historyPreviewEmptyDescription')).toBeInTheDocument()
    expect(screen.queryByText('recentActivityViewAll')).not.toBeInTheDocument()
  })

  it.each([
    ['missing', null],
    [
      'complete',
      {
        state: 'complete',
        reason: 'verified_terminal_history',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      } satisfies HistoryCompleteness,
    ],
  ])('preserves null-collapse for an empty %s trust result', (_label, completeness) => {
    ;(useTraderRecords as jest.Mock).mockReturnValue(recordsResult(completeness))

    const view = render(<RecentActivityCard {...props} />)

    expect(view.container).toBeEmptyDOMElement()
  })

  it('suppresses the warning only for complete non-empty history', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue(
      recordsResult(
        {
          state: 'complete',
          reason: 'verified_terminal_history',
          evidenceState: 'verified',
          scanTerminalState: 'exhausted',
          blockerReasons: [],
        },
        [{ symbol: 'BTC', side: 'buy' }]
      )
    )

    render(<RecentActivityCard {...props} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('recentActivityViewAll')).toBeInTheDocument()
  })

  it('keeps realized PnL bound to each order row currency', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue(
      recordsResult(
        {
          state: 'complete',
          reason: 'verified_terminal_history',
          evidenceState: 'verified',
          scanTerminalState: 'exhausted',
          blockerReasons: [],
        },
        [
          {
            ts: '2026-08-03T12:00:00.000Z',
            symbol: 'BTCUSDC',
            side: 'buy',
            realized_pnl: 12.5,
            currency: 'USDC',
          },
        ]
      )
    )

    render(<RecentActivityCard {...props} />)

    expect(screen.getByTestId('recent-activity-pnl')).toHaveTextContent('+$12.50 USDC')
  })

  it('hides realized PnL whose source row has no exact currency', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue(
      recordsResult(
        {
          state: 'complete',
          reason: 'verified_terminal_history',
          evidenceState: 'verified',
          scanTerminalState: 'exhausted',
          blockerReasons: [],
        },
        [
          {
            ts: '2026-08-03T12:00:00.000Z',
            symbol: 'BTC',
            side: 'buy',
            realized_pnl: 12.5,
          },
        ]
      )
    )

    render(<RecentActivityCard {...props} />)

    expect(screen.queryByTestId('recent-activity-pnl')).not.toBeInTheDocument()
  })
})
