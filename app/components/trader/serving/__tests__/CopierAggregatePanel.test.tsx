import React from 'react'
import { render, screen } from '@testing-library/react'
import CopierAggregatePanel from '../CopierAggregatePanel'
import type { CopierAggregate } from '@/lib/data/serving/types'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/app/components/common/RecordProvenanceFooter', () => () => null)

function aggregate(overrides: Partial<CopierAggregate> = {}): CopierAggregate {
  return {
    copierCount: 12,
    copierCountMax: 20,
    totalCopierPnl: null,
    pnlDistribution: [],
    depth: 'full',
    receiptBound: true,
    provenance: {
      source: 'gmx',
      sourceAsOf: null,
      observedAt: '2026-08-03T12:00:00.000Z',
      publishedAt: null,
    },
    ...overrides,
  }
}

describe('CopierAggregatePanel history completeness', () => {
  it('fails closed for a legacy aggregate without completeness metadata', () => {
    render(<CopierAggregatePanel aggregate={aggregate()} />)

    expect(screen.getByRole('status', { name: 'historyCompletenessUnknownTitle' })).toHaveAttribute(
      'data-history-completeness',
      'unknown'
    )
  })

  it('renders an explicit partial-history disclosure', () => {
    render(
      <CopierAggregatePanel
        aggregate={aggregate({
          completeness: { state: 'partial', reason: 'interactive_preview' },
        })}
      />
    )

    expect(screen.getByRole('status', { name: 'historyCompletenessPartialTitle' })).toHaveAttribute(
      'data-history-completeness',
      'partial'
    )
  })

  it('suppresses the limitation notice only for verified complete history', () => {
    render(
      <CopierAggregatePanel
        aggregate={aggregate({
          completeness: {
            state: 'complete',
            reason: 'verified_copier_snapshot',
            evidenceState: 'verified',
            scanTerminalState: 'exhausted',
            blockerReasons: [],
          },
        })}
      />
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('describes receipt-bound figures as a verified capture, not a live roster', () => {
    render(
      <CopierAggregatePanel
        aggregate={aggregate({
          completeness: {
            state: 'complete',
            reason: 'verified_copier_snapshot',
            evidenceState: 'verified',
            scanTerminalState: 'exhausted',
            blockerReasons: [],
          },
        })}
      />
    )

    expect(screen.getByText('copierVerifiedCaptureNotice')).toBeInTheDocument()
    expect(screen.queryByText('copierAggregateNotice')).not.toBeInTheDocument()
  })

  it('does not describe an unbound N/A response as a verified capture', () => {
    render(
      <CopierAggregatePanel
        aggregate={aggregate({
          depth: 'none',
          receiptBound: false,
          completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
        })}
      />
    )

    expect(screen.getByText('copierAggregateNotice')).toBeInTheDocument()
    expect(screen.queryByText('copierVerifiedCaptureNotice')).not.toBeInTheDocument()
  })
})
