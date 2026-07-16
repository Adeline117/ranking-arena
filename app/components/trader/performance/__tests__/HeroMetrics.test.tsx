import React from 'react'
import { render, screen } from '@testing-library/react'
import { HeroMetrics } from '../HeroMetrics'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

describe('HeroMetrics PnL disclosure', () => {
  const disclosure = {
    kind: 'gmx_realized_net_completed_utc_days' as const,
    windowFrom: Date.UTC(2026, 5, 15) / 1000,
    windowTo: Date.UTC(2026, 6, 15) / 1000,
    windowDurationDays: 30 as const,
  }

  it('uses the specialized label, tooltip, and cutoff only with a verified contract', () => {
    render(
      <HeroMetrics roi={12} pnl={345} pnlDisclosure={disclosure} sparklineData={[]} isVisible />
    )

    expect(screen.getByText('gmxRealizedNetPnlLabel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'gmxRealizedNetPnlTooltip' })).toBeInTheDocument()
    expect(screen.getByRole('note', { name: 'gmxRealizedNetPnlSummary' })).toBeInTheDocument()
    expect(screen.queryByText('pnl')).not.toBeInTheDocument()
  })

  it('keeps generic PnL copy when no verified contract is attached', () => {
    render(<HeroMetrics roi={12} pnl={345} sparklineData={[]} isVisible />)

    expect(screen.getByText('pnl')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pnlTooltip' })).toBeInTheDocument()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.queryByText('gmxRealizedNetPnlLabel')).not.toBeInTheDocument()
  })
})
