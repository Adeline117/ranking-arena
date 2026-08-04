import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import ServingRecordsSection, { RECORD_COLUMNS } from '../ServingRecordsSection'
import RecordsTable from '../RecordsTable'
import { useCopierAggregate, useTraderRecords } from '@/lib/hooks/useTraderRecords'
import type { RecordKind, SourceCapability } from '@/lib/data/serving/types'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))
jest.mock('@/lib/hooks/useTraderRecords', () => ({
  useTraderRecords: jest.fn(),
  useCopierAggregate: jest.fn(),
}))
jest.mock('../RecordsTable', () => jest.fn(() => null))
jest.mock('../CopierAggregatePanel', () => () => null)
jest.mock('../ModuleDegraded', () => () => null)
jest.mock('@/app/components/common/RecordProvenanceFooter', () => () => null)

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
      isInitialError: false,
      isFetchNextPageError: false,
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

  it('renders transfer amounts as asset quantities, never settlement-currency money', () => {
    expect(RECORD_COLUMNS.transfers).toContainEqual({
      key: 'amount',
      i18nKey: 'colAmount',
      format: 'asset_quantity',
      align: 'right',
    })
    expect(RECORD_COLUMNS.transfers).not.toContainEqual(
      expect.objectContaining({ key: 'amount', format: 'money' })
    )
    expect(RECORD_COLUMNS.transfers).not.toContainEqual(expect.objectContaining({ key: 'asset' }))
  })

  it('preserves loaded rows and wires an inline retry for a next-page failure', () => {
    const fetchNextPage = jest.fn().mockResolvedValue(undefined)
    ;(useTraderRecords as jest.Mock).mockReturnValue({
      rows: [{ symbol: 'BTCUSDT' }],
      provenance: null,
      completeness: null,
      isPendingUpstream: false,
      isLoading: false,
      isInitialError: false,
      isFetchNextPageError: true,
      isFetchingNextPage: false,
      hasNextPage: true,
      fetchNextPage,
      error: new Error('later page failed'),
      refetch: jest.fn(),
    })

    render(
      <ServingRecordsSection
        source="gmx"
        exchangeTraderId="trader-a"
        capability={capability(['positions'])}
        tf={90}
      />
    )

    expect(RecordsTable).toHaveBeenCalled()
    const props = (RecordsTable as jest.Mock).mock.calls.at(-1)?.[0]
    expect(props).toEqual(
      expect.objectContaining({
        rows: [{ symbol: 'BTCUSDT' }],
        hasLoadMoreError: true,
        hasNextPage: true,
      })
    )
    props.onLoadMore()
    expect(fetchNextPage).toHaveBeenCalledTimes(1)
  })

  it('uses module degradation only when the first page has no recoverable data', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue({
      rows: [],
      provenance: null,
      completeness: null,
      isPendingUpstream: false,
      isLoading: false,
      isInitialError: true,
      isFetchNextPageError: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: jest.fn(),
      error: new Error('first page failed'),
      refetch: jest.fn(),
    })

    render(
      <ServingRecordsSection
        source="gmx"
        exchangeTraderId="trader-a"
        capability={capability(['positions'])}
        tf={90}
      />
    )

    expect(RecordsTable).not.toHaveBeenCalled()
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

  it.each([
    {
      state: 'partial' as const,
      reason: 'interactive_preview' as const,
      title: 'historyCompletenessPartialTitle',
      description: 'historyCompletenessPartialDescription',
    },
    {
      state: 'unknown' as const,
      reason: 'history_evidence_not_bound' as const,
      title: 'historyCompletenessUnknownTitle',
      description: 'historyCompletenessUnknownDescription',
    },
  ])('discloses $state position-history trust state', (completeness) => {
    ;(useTraderRecords as jest.Mock).mockReturnValue({
      rows: [{ symbol: 'BTCUSDT' }],
      provenance: null,
      completeness: { state: completeness.state, reason: completeness.reason },
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
        capability={capability(['position_history'])}
        tf={90}
      />
    )

    const notice = screen.getByRole('status', { name: completeness.title })
    expect(notice).toHaveAttribute('data-history-completeness', completeness.state)
    expect(screen.getByText(completeness.description)).toBeInTheDocument()
  })

  it.each(['orders', 'transfers'] as const)(
    'fails closed with an unknown-history notice on the %s tab',
    (kind) => {
      ;(useTraderRecords as jest.Mock).mockReturnValue({
        rows: [{ id: `${kind}-1` }],
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

      render(
        <ServingRecordsSection
          source="gmx"
          exchangeTraderId="trader-a"
          capability={capability([kind])}
          tf={90}
        />
      )

      expect(
        screen.getByRole('status', { name: 'historyCompletenessUnknownTitle' })
      ).toHaveAttribute('data-history-completeness', 'unknown')
    }
  )

  it('suppresses the limitation notice for complete history and non-history tabs', () => {
    ;(useTraderRecords as jest.Mock).mockReturnValue({
      rows: [],
      provenance: null,
      completeness: {
        state: 'complete',
        reason: 'verified_terminal_history',
        evidenceState: 'verified',
        scanTerminalState: 'exhausted',
        blockerReasons: [],
      },
      isPendingUpstream: false,
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      fetchNextPage: jest.fn(),
      error: null,
      refetch: jest.fn(),
    })

    const view = render(
      <ServingRecordsSection
        source="gmx"
        exchangeTraderId="trader-a"
        capability={capability(['position_history'])}
        tf={90}
      />
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    ;(useTraderRecords as jest.Mock).mockReturnValue({
      ...(useTraderRecords as jest.Mock).mock.results.at(-1)?.value,
      completeness: { state: 'partial', reason: 'interactive_preview' },
    })
    view.rerender(
      <ServingRecordsSection
        source="gmx"
        exchangeTraderId="trader-a"
        capability={capability(['positions'])}
        tf={90}
      />
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
