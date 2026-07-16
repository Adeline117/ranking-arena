import React from 'react'
import { render, screen } from '@testing-library/react'
import MetricGrid from '../MetricGrid'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

describe('MetricGrid label overrides', () => {
  it('uses registry labels by default', () => {
    render(<MetricGrid stats={{ pnl: 120 }} capabilityMetrics={['pnl']} currency="USD" />)

    expect(screen.getByText('metricPnl')).toBeInTheDocument()
    expect(screen.queryByText('gmxRealizedNetPnlLabel')).not.toBeInTheDocument()
  })

  it('overrides only the explicitly targeted metric', () => {
    render(
      <MetricGrid
        stats={{ roi: 12, pnl: 120, total_pnl: 500 }}
        capabilityMetrics={['roi', 'pnl', 'total_pnl']}
        currency="USD"
        metricLabelKeys={{ pnl: 'gmxRealizedNetPnlLabel' }}
        metricTooltipKeys={{ pnl: 'gmxRealizedNetPnlTooltip' }}
      />
    )

    expect(screen.getByText('gmxRealizedNetPnlLabel')).toBeInTheDocument()
    expect(screen.getByText('metricRoi')).toBeInTheDocument()
    expect(screen.getByText('metricTotalPnl')).toBeInTheDocument()
    expect(screen.queryByText('metricPnl')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'gmxRealizedNetPnlTooltip' })).toBeInTheDocument()
  })
})
