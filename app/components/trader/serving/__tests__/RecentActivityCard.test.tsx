import React from 'react'
import { render, screen } from '@testing-library/react'
import RecentActivityCard from '../RecentActivityCard'
import { useTraderRecords } from '@/lib/hooks/useTraderRecords'
import type { HistoryCompleteness } from '@/lib/data/serving/types'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  getLanguage: () => 'en',
}))
jest.mock('@/lib/hooks/useTraderRecords', () => ({
  useTraderRecords: jest.fn(),
}))
jest.mock('@/app/components/ui/Metric', () => () => null)

function recordsResult(completeness: HistoryCompleteness | null, rows: object[] = []) {
  return {
    rows,
    completeness,
    provenance: null,
    isPendingUpstream: false,
    isLoading: false,
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

      render(<RecentActivityCard source="gmx" exchangeTraderId="trader-a" enabled />)

      expect(screen.getByRole('status', { name: title })).toHaveAttribute(
        'data-history-completeness',
        completeness.state
      )
      expect(screen.getByText(body)).toBeInTheDocument()
      expect(screen.getByText('BTCUSDT')).toBeInTheDocument()
    }
  )

  it('keeps an empty incomplete preview visible without claiming there is no history', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue(
      recordsResult({ state: 'partial', reason: 'interactive_preview' })
    )

    render(<RecentActivityCard source="gmx" exchangeTraderId="trader-a" enabled />)

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

    const view = render(<RecentActivityCard source="gmx" exchangeTraderId="trader-a" enabled />)

    expect(view.container).toBeEmptyDOMElement()
  })
})
