import React from 'react'
import { render, screen } from '@testing-library/react'
import { RecentActivityCard } from '../RecentActivityCard'
import { useTraderRecords } from '@/lib/hooks/useTraderRecords'

jest.mock('@/lib/hooks/useTraderRecords', () => ({ useTraderRecords: jest.fn() }))
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  getLanguage: () => 'en',
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/ui/Metric', () => () => null)

const props = {
  source: 'gmx',
  exchangeTraderId: 'trader-a',
  enabled: true,
}

function recordsResult(completeness: unknown) {
  return {
    rows: [{ symbol: 'BTC', side: 'buy' }],
    completeness,
  }
}

describe('RecentActivityCard history completeness', () => {
  beforeEach(() => jest.clearAllMocks())

  it('fails closed for legacy order data without completeness metadata', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue(recordsResult(null))

    render(<RecentActivityCard {...props} />)

    expect(screen.getByRole('status', { name: 'historyCompletenessUnknownTitle' })).toHaveAttribute(
      'data-history-completeness',
      'unknown'
    )
    expect(screen.getByText('recentActivityViewAll')).toBeInTheDocument()
  })

  it('renders partial history and suppresses the notice only for complete history', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue(
      recordsResult({ state: 'partial', reason: 'interactive_preview' })
    )
    const view = render(<RecentActivityCard {...props} />)
    expect(screen.getByRole('status', { name: 'historyCompletenessPartialTitle' })).toHaveAttribute(
      'data-history-completeness',
      'partial'
    )
    ;(useTraderRecords as jest.Mock).mockReturnValue(
      recordsResult({
        state: 'complete',
        reason: 'verified_terminal_history',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      })
    )
    view.unmount()
    render(<RecentActivityCard {...props} />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
