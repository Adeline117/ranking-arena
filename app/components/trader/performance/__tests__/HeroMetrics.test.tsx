import React from 'react'
import { render, screen } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
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
  const roiDisclosure = {
    kind: 'gmx_realized_net_on_window_max_capital' as const,
    windowFrom: Date.UTC(2026, 5, 15) / 1000,
    windowTo: Date.UTC(2026, 6, 15) / 1000,
    windowDurationDays: 30 as const,
  }

  it('uses the specialized label, tooltip, and cutoff only with a verified contract', () => {
    render(
      <HeroMetrics
        roi={12}
        roiDisclosure={roiDisclosure}
        pnl={345}
        pnlDisclosure={disclosure}
        sparklineData={[]}
      />
    )

    expect(screen.getByText('gmxMaxCapitalRoiLabel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'gmxMaxCapitalRoiTooltip' })).toBeInTheDocument()
    expect(screen.getByText('gmxRealizedNetPnlLabel')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'gmxRealizedNetPnlTooltip' })).toBeInTheDocument()
    expect(screen.getByRole('note', { name: 'gmxRealizedNetPnlSummary' })).toBeInTheDocument()
    expect(screen.queryByText('pnl')).not.toBeInTheDocument()
  })

  it('keeps generic PnL copy when no verified contract is attached', () => {
    render(<HeroMetrics roi={12} pnl={345} sparklineData={[]} />)

    expect(screen.getByText('pnl')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pnlTooltip' })).toBeInTheDocument()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.queryByText('gmxRealizedNetPnlLabel')).not.toBeInTheDocument()
    expect(screen.getByText('roi')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'roiTooltip' })).toBeInTheDocument()
  })

  it('does not infer the ROI formula from the PnL contract alone', () => {
    render(<HeroMetrics roi={12} pnl={345} pnlDisclosure={disclosure} sparklineData={[]} />)

    expect(screen.getByText('roi')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'roiTooltip' })).toBeInTheDocument()
    expect(screen.queryByText('gmxMaxCapitalRoiLabel')).not.toBeInTheDocument()
  })

  it('renders ROI and PnL at first paint without an opacity-gated reveal', () => {
    const markup = renderToStaticMarkup(<HeroMetrics roi={12} pnl={345} sparklineData={[]} />)
    const roiMetricStyle = markup.match(/class="hero-metric-value" style="([^"]*)"/)?.[1]
    const pnlMetricStyle = markup.match(
      /<div style="([^"]*)"><span[^>]*>\+\$345\.00<\/span><\/div>/
    )?.[1]

    expect(markup).toContain('roi')
    expect(markup).toContain('pnl')
    expect(roiMetricStyle).toBeDefined()
    expect(roiMetricStyle).not.toContain('opacity')
    expect(roiMetricStyle).not.toContain('transition')
    expect(pnlMetricStyle).toBeDefined()
    expect(pnlMetricStyle).not.toContain('opacity')
    expect(pnlMetricStyle).not.toContain('transition')
  })

  it('renders serving PnL with its exact source unit', () => {
    render(<HeroMetrics roi={12} pnl={345} pnlCurrency="USDT" sparklineData={[]} />)

    expect(screen.getByText('+$345.00 USDT')).toBeInTheDocument()
    expect(screen.queryByText('+$345.00')).not.toBeInTheDocument()
  })

  it('does not invent a dollar unit when serving PnL is unbound', () => {
    render(<HeroMetrics roi={12} pnl={345} pnlCurrency={null} sparklineData={[]} />)

    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/\$345/)).not.toBeInTheDocument()
  })
})
