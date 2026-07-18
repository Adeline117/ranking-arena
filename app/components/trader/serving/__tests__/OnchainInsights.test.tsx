import React from 'react'
import { render, screen } from '@testing-library/react'
import OnchainInsights from '../OnchainInsights'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

jest.mock('@/app/components/trader/charts/PnlCalendarHeatmap', () => ({
  PnlCalendarHeatmap: () => <div data-testid="pnl-calendar" />,
}))

describe('OnchainInsights quality disclosure', () => {
  it('labels estimated wallet PnL and states that it is excluded from Arena Score', () => {
    render(
      <OnchainInsights
        currency="USD"
        extras={{
          onchain_total_pnl: 1200,
          onchain_realized_pnl: 900,
          onchain_unrealized_pnl: 300,
          onchain_quality: {
            schema_version: 1,
            methodology: 'wallet-balance-delta-average-cost',
            methodology_version: '1.0.0',
            completeness: 'partial',
            price_quality: 'non_historical_approx',
            score_eligible: false,
            reasons: ['opening_inventory_unknown'],
            realized_partial: false,
            history: { requested_days: 90, scan_complete: null, truncated: null },
          },
        }}
      />
    )

    expect(screen.getByRole('note', { name: 'onchainEstimatedData' })).toBeInTheDocument()
    expect(screen.getByText('onchainEstimatedDataHint')).toBeInTheDocument()
    expect(screen.getByText('estimatedPnl')).toBeInTheDocument()
    expect(screen.getByText('metricTotalPnl')).toBeInTheDocument()
    expect(screen.getByText('metricRealizedPnl')).toBeInTheDocument()
    expect(screen.getByText('metricUnrealizedPnl')).toBeInTheDocument()
  })

  it('does not show an estimate warning for a canonical quality contract', () => {
    render(
      <OnchainInsights
        currency="USD"
        extras={{
          onchain_total_pnl: 1200,
          onchain_quality: {
            schema_version: 1,
            methodology: 'wallet-balance-delta-average-cost',
            methodology_version: '1.0.0',
            completeness: 'complete',
            price_quality: 'historical_execution',
            score_eligible: true,
            reasons: [],
            realized_partial: false,
            history: { requested_days: 90, scan_complete: true, truncated: false },
          },
        }}
      />
    )

    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.queryByText('estimatedPnl')).not.toBeInTheDocument()
  })

  it('labels on-chain dollar buckets as dollars, never percentages', () => {
    render(
      <OnchainInsights
        currency="USD"
        extras={{
          onchain_token_distribution_unit: 'realized_pnl_usd',
          onchain_token_distribution_usd: {
            gt_500: 1,
            p0_500: 2,
            n50_0: 3,
            lt_n50: 4,
          },
        }}
      />
    )

    expect(screen.getByText('>+$500')).toBeInTheDocument()
    expect(screen.getByText('$0~+$500')).toBeInTheDocument()
    expect(screen.getByText('-$50~$0')).toBeInTheDocument()
    expect(screen.getByText('<-$50')).toBeInTheDocument()
    expect(screen.queryByText('>+500%')).not.toBeInTheDocument()
  })

  it('renders reconstructed top-token dollars without a fabricated return rate', () => {
    render(
      <OnchainInsights
        currency="USD"
        extras={{
          onchain_top_earning_tokens_provenance: 'onchain-computed',
          onchain_top_earning_tokens: [{ symbol: 'WIF', realized_pnl: 1234, profit_pct: 999 }],
        }}
      />
    )

    expect(screen.getByText('WIF')).toBeInTheDocument()
    expect(screen.getByText('$1.23K USD')).toBeInTheDocument()
    expect(screen.queryByText('+999.0%')).not.toBeInTheDocument()
  })

  it('shows optional enrichment degradation without requiring insight data', () => {
    render(<OnchainInsights currency="USD" extras={{}} enrichmentState="unavailable" />)

    expect(screen.getByRole('status', { name: 'onchainEstimatedData' })).toHaveTextContent(
      'onchainEstimatedData · serviceTemporarilyUnavailable'
    )
  })
})
