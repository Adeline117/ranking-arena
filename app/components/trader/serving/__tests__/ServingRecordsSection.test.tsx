import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import ServingRecordsSection from '../ServingRecordsSection'
import { useCopierAggregate, useTraderRecords } from '@/lib/hooks/useTraderRecords'
import type { RecordKind, SourceCapability } from '@/lib/data/serving/types'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/lib/hooks/useTraderRecords', () => ({
  useTraderRecords: jest.fn(),
  useCopierAggregate: jest.fn(),
}))
jest.mock('../RecordsTable', () => () => null)
jest.mock('../CopierAggregatePanel', () => () => null)
jest.mock('../ModuleDegraded', () => () => null)
jest.mock('@/app/components/common/ProvenanceFooter', () => () => null)

function capability(enabledKinds: RecordKind[]): SourceCapability {
  const enabled = new Set(enabledKinds)
  return {
    timeframes: { '7': 'native', '30': 'native', '90': 'native' },
    inceptionTf: false,
    metrics: [],
    surfaces: {
      positions: enabled.has('positions'),
      position_history: enabled.has('position_history'),
      orders: enabled.has('orders'),
      transfers: enabled.has('transfers'),
      copiers: enabled.has('copiers'),
    },
    copierDepth: 'none',
    currency: 'USD',
    isOnchain: false,
    derivedBoardNote: false,
    exchangeName: 'Test Exchange',
  }
}

describe('ServingRecordsSection selection scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useTraderRecords as jest.Mock).mockReturnValue({
      rows: [],
      provenance: null,
      completeness: null,
      isPendingUpstream: false,
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: jest.fn(),
      error: null,
      refetch: jest.fn(),
    })
    ;(useCopierAggregate as jest.Mock).mockReturnValue({
      aggregate: null,
      isPendingUpstream: false,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    })
  })

  it('resets the active kind for a new subject and fails closed after capability shrinkage', () => {
    const fullCapability = capability(['positions', 'position_history', 'orders'])
    const view = render(
      <ServingRecordsSection
        source="gmx"
        exchangeTraderId="trader-a"
        capability={fullCapability}
        tf={90}
      />
    )

    expect(screen.getByRole('button', { name: 'tabPositionHistory' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'tabPositions' }))
    expect(screen.getByRole('button', { name: 'tabPositions' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    view.rerender(
      <ServingRecordsSection
        source="hyperliquid_perp"
        exchangeTraderId="trader-b"
        capability={fullCapability}
        tf={90}
      />
    )
    expect(screen.getByRole('button', { name: 'tabPositionHistory' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(useTraderRecords).toHaveBeenLastCalledWith({
      source: 'hyperliquid_perp',
      exchangeTraderId: 'trader-b',
      kind: 'position_history',
      tf: 90,
      enabled: true,
    })

    fireEvent.click(screen.getByRole('button', { name: 'tabPositions' }))
    view.rerender(
      <ServingRecordsSection
        source="hyperliquid_perp"
        exchangeTraderId="trader-b"
        capability={capability(['orders'])}
        tf={90}
      />
    )

    expect(screen.queryByRole('button', { name: 'tabPositions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'tabOrders' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(useTraderRecords).toHaveBeenLastCalledWith({
      source: 'hyperliquid_perp',
      exchangeTraderId: 'trader-b',
      kind: 'orders',
      tf: 90,
      enabled: true,
    })
  })

  it.each(['position_history', 'orders', 'transfers'] as const)(
    'discloses a partial %s preview as rank-ineligible',
    (kind) => {
      ;(useTraderRecords as jest.Mock).mockReturnValue({
        rows: [{ symbol: 'BTCUSDT' }],
        provenance: null,
        completeness: {
          state: 'partial',
          reason: 'interactive_preview',
          evidenceState: 'caller_limited',
          scanTerminalState: 'partial',
          blockerReasons: ['caller_limit'],
        },
        isPendingUpstream: false,
        isLoading: false,
        isFetchingNextPage: false,
        hasNextPage: false,
        fetchNextPage: jest.fn(),
        error: null,
        refetch: jest.fn(),
      })

      render(
        <ServingRecordsSection
          source="gmx"
          exchangeTraderId="trader-a"
          capability={capability([kind])}
          tf={90}
        />
      )

      const notice = screen.getByRole('status', {
        name: 'historyCompletenessPartialTitle',
      })
      expect(notice).toHaveAttribute('data-history-completeness', 'partial')
      expect(notice).toHaveAttribute('data-history-evidence', 'caller_limited')
      expect(screen.getByText('historyCompletenessPartialDescription')).toBeInTheDocument()
    }
  )

  it('discloses unknown order-history evidence', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue({
      rows: [{ symbol: 'ETHUSDT' }],
      provenance: null,
      completeness: {
        state: 'unknown',
        reason: 'history_evidence_not_bound',
      },
      isPendingUpstream: false,
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: jest.fn(),
      error: null,
      refetch: jest.fn(),
    })

    render(
      <ServingRecordsSection
        source="gmx"
        exchangeTraderId="trader-a"
        capability={capability(['orders'])}
        tf={90}
      />
    )

    const notice = screen.getByRole('status', {
      name: 'historyCompletenessUnknownTitle',
    })
    expect(notice).toHaveAttribute('data-history-completeness', 'unknown')
    expect(screen.getByText('historyCompletenessUnknownDescription')).toBeInTheDocument()
  })

  it.each([
    ['positions', { state: 'partial', reason: 'interactive_preview' }],
    [
      'orders',
      {
        state: 'complete',
        reason: 'verified_terminal_history',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      },
    ],
  ] as const)('does not show a limitation notice for %s', (kind, completeness) => {
    ;(useTraderRecords as jest.Mock).mockReturnValue({
      rows: [{ symbol: 'BTCUSDT' }],
      provenance: null,
      completeness,
      isPendingUpstream: false,
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: jest.fn(),
      error: null,
      refetch: jest.fn(),
    })

    render(
      <ServingRecordsSection
        source="gmx"
        exchangeTraderId="trader-a"
        capability={capability([kind])}
        tf={90}
      />
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
