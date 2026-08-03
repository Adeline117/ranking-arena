import { renderHook } from '@testing-library/react'
import { useServingTabData } from '../useServingTabData'
import { useTraderCore } from '@/lib/hooks/useTraderCore'
import { useTraderRecords } from '@/lib/hooks/useTraderRecords'
import type { HistoryCompleteness, SourceCapability } from '@/lib/data/serving/types'

jest.mock('@/lib/hooks/useTraderCore', () => ({ useTraderCore: jest.fn() }))
jest.mock('@/lib/hooks/useTraderRecords', () => ({ useTraderRecords: jest.fn() }))

const capability: SourceCapability = {
  timeframes: { '7': 'native', '30': 'native', '90': 'native' },
  inceptionTf: false,
  metrics: [],
  surfaces: {
    positions: true,
    position_history: true,
    orders: false,
    transfers: false,
    copiers: false,
  },
  copierDepth: 'none',
  currency: 'USD',
  isOnchain: false,
  derivedBoardNote: false,
  exchangeName: 'Test Exchange',
}

function coreResult() {
  return { modules: null, isLoading: false }
}

function recordsResult(completeness: HistoryCompleteness | null) {
  return {
    rows: [],
    provenance: null,
    completeness,
    isPendingUpstream: false,
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: jest.fn(),
    error: null,
    refetch: jest.fn(),
  }
}

describe('useServingTabData history completeness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(useTraderCore as jest.Mock).mockReturnValue(coreResult())
  })

  it.each([
    { state: 'partial', reason: 'interactive_preview' },
    { state: 'unknown', reason: 'history_evidence_not_bound' },
    {
      state: 'complete',
      reason: 'verified_terminal_history',
      evidenceState: 'verified',
      scanTerminalState: 'exhausted',
      blockerReasons: [],
    },
    null,
  ] as const)('preserves the position-history page state $state', (completeness) => {
    ;(useTraderRecords as jest.Mock).mockImplementation(({ kind }: { kind: string }) =>
      recordsResult(kind === 'position_history' ? completeness : null)
    )

    const view = renderHook(() =>
      useServingTabData(
        {
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          nickname: 'Trader A',
          avatarSrc: null,
        },
        capability,
        true
      )
    )

    expect(view.result.current.historyCompleteness).toEqual(completeness)
  })

  it('updates the memoized result when evidence weakens', () => {
    let completeness: HistoryCompleteness = {
      state: 'partial',
      reason: 'interactive_preview',
    }
    ;(useTraderRecords as jest.Mock).mockImplementation(({ kind }: { kind: string }) =>
      recordsResult(kind === 'position_history' ? completeness : null)
    )
    const view = renderHook(() =>
      useServingTabData(
        {
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          nickname: 'Trader A',
          avatarSrc: null,
        },
        capability,
        true
      )
    )

    completeness = {
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    }
    view.rerender()

    expect(view.result.current.historyCompleteness).toEqual(completeness)
  })
})
