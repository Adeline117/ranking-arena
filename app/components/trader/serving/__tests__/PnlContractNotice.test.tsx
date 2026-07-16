import React from 'react'
import { render, screen } from '@testing-library/react'
import PnlContractNotice from '../PnlContractNotice'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

describe('PnlContractNotice', () => {
  it('renders the verified GMX basis and an accessible UTC cutoff', () => {
    const windowTo = Date.UTC(2026, 6, 15) / 1000
    const cutoffIso = new Date(windowTo * 1000).toISOString()

    render(
      <PnlContractNotice
        disclosure={{
          kind: 'gmx_realized_net_completed_utc_days',
          windowFrom: windowTo - 90 * 86_400,
          windowTo,
          windowDurationDays: 90,
        }}
      />
    )

    expect(screen.getByRole('note', { name: 'gmxRealizedNetPnlSummary' })).toBeInTheDocument()
    expect(screen.getByText('gmxRealizedNetPnlSummary')).toBeInTheDocument()
    expect(screen.getByText(/gmxCompletedWindowEnded/)).toBeInTheDocument()
    expect(screen.getByRole('time')).toHaveAttribute('dateTime', cutoffIso)
    expect(screen.getByRole('time')).toHaveTextContent('UTC')
  })
})
