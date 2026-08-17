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

function coreResult(overrides: Record<string, unknown> = {}) {
  return {
    modules: null,
    isPendingUpstream: false,
    isDegraded: false,
    isRefreshing: false,
    isLoading: false,
    refetch: jest.fn(),
    ...overrides,
  }
}

function coreModule(timeframe: 7 | 30 | 90) {
  return {
    timeframe,
    stats: {},
    currency: 'USD',
    series: {},
    extras: {},
    provenance: { source: 'gmx', asOf: '2026-08-16T00:00:00.000Z' },
    cacheState: 'warm',
  }
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
    ;(useTraderRecords as jest.Mock).mockReturnValue(recordsResult(null))
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
  ] as const)('preserves the exact position-history state $state', (completeness) => {
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

  it('updates its memoized verdict when evidence weakens', () => {
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

    completeness = { state: 'unknown', reason: 'history_evidence_not_bound' }
    view.rerender()

    expect(view.result.current.historyCompleteness).toEqual(completeness)
  })

  it('carries an in-progress core refresh to the default three-tab surface', () => {
    ;(useTraderCore as jest.Mock).mockImplementation(() => coreResult({ isPendingUpstream: true }))
    ;(useTraderRecords as jest.Mock).mockImplementation(() => recordsResult(null))

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

    expect(view.result.current.isCorePendingUpstream).toBe(true)
    expect(view.result.current.isCoreStale).toBe(false)
    expect(view.result.current.isCoreUnavailable).toBe(false)
    expect(view.result.current.hasCoreModules).toBe(false)
    expect(view.result.current.coreModuleAvailability).toEqual({
      '7D': false,
      '30D': false,
      '90D': false,
    })
    expect(view.result.current.isColdCoreLoading).toBe(true)
  })

  it('marks a no-module network fetch as cold loading rather than no trader data', () => {
    ;(useTraderCore as jest.Mock).mockReturnValue(coreResult({ isLoading: true }))

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

    expect(view.result.current.isColdCoreLoading).toBe(true)
    expect(view.result.current.isCoreUnavailable).toBe(false)
  })

  it('keeps a retained module visible while another window is collecting', () => {
    ;(useTraderCore as jest.Mock).mockImplementation(({ tf }: { tf: 7 | 30 | 90 }) =>
      tf === 90
        ? coreResult({ modules: coreModule(90), isPendingUpstream: true })
        : coreResult({ isLoading: true })
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

    expect(view.result.current.isCorePendingUpstream).toBe(true)
    expect(view.result.current.hasCoreModules).toBe(true)
    expect(view.result.current.coreModuleAvailability).toEqual({
      '7D': false,
      '30D': false,
      '90D': true,
    })
    expect(view.result.current.isColdCoreLoading).toBe(false)
  })

  it('shows simultaneous collection and stale disclosure, then retries only failed timeframes', async () => {
    const retry7 = jest.fn().mockResolvedValue(undefined)
    const retry30 = jest.fn().mockResolvedValue(undefined)
    const retry90 = jest.fn().mockResolvedValue(undefined)
    ;(useTraderCore as jest.Mock).mockImplementation(({ tf }: { tf: 7 | 30 | 90 }) => {
      if (tf === 7) {
        return coreResult({ modules: coreModule(7), isPendingUpstream: true, refetch: retry7 })
      }
      if (tf === 30) {
        return coreResult({ modules: coreModule(30), isDegraded: true, refetch: retry30 })
      }
      return coreResult({ modules: coreModule(90), refetch: retry90 })
    })
    ;(useTraderRecords as jest.Mock).mockImplementation(() => recordsResult(null))

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

    expect(view.result.current.isCorePendingUpstream).toBe(true)
    expect(view.result.current.isCoreStale).toBe(true)
    expect(view.result.current.isCoreUnavailable).toBe(false)
    await view.result.current.refetchDegradedCore()
    expect(retry7).not.toHaveBeenCalled()
    expect(retry30).toHaveBeenCalledTimes(1)
    expect(retry90).not.toHaveBeenCalled()
  })

  it('marks a cold-start failure unavailable instead of calling absent data stale', async () => {
    const retry7 = jest.fn().mockResolvedValue(undefined)
    const retry30 = jest.fn().mockResolvedValue(undefined)
    const retry90 = jest.fn().mockResolvedValue(undefined)
    ;(useTraderCore as jest.Mock).mockImplementation(({ tf }: { tf: 7 | 30 | 90 }) => {
      if (tf === 7) return coreResult({ isDegraded: true, refetch: retry7 })
      if (tf === 30) return coreResult({ refetch: retry30 })
      return coreResult({ refetch: retry90 })
    })
    ;(useTraderRecords as jest.Mock).mockImplementation(() => recordsResult(null))

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

    expect(view.result.current.isCoreStale).toBe(false)
    expect(view.result.current.isCoreUnavailable).toBe(true)
    expect(view.result.current.isColdCoreLoading).toBe(false)
    await view.result.current.refetchDegradedCore()
    expect(retry7).toHaveBeenCalledTimes(1)
    expect(retry30).not.toHaveBeenCalled()
    expect(retry90).not.toHaveBeenCalled()
  })

  it('does not treat an all-absent capability as a cold loading state', () => {
    ;(useTraderCore as jest.Mock).mockReturnValue(
      coreResult({ isLoading: true, isPendingUpstream: true })
    )
    const allAbsent: SourceCapability = {
      ...capability,
      timeframes: { '7': 'absent', '30': 'absent', '90': 'absent' },
    }

    const view = renderHook(() =>
      useServingTabData(
        {
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          nickname: 'Trader A',
          avatarSrc: null,
        },
        allAbsent,
        true
      )
    )

    expect(view.result.current.isCorePendingUpstream).toBe(false)
    expect(view.result.current.isCoreUnavailable).toBe(false)
    expect(view.result.current.isColdCoreLoading).toBe(false)
  })

  it('never requests or retains source-declared absent timeframes', async () => {
    const retry7 = jest.fn().mockResolvedValue(undefined)
    const retry30 = jest.fn().mockResolvedValue(undefined)
    const retry90 = jest.fn().mockResolvedValue(undefined)
    ;(useTraderCore as jest.Mock).mockImplementation(({ tf }: { tf: 7 | 30 | 90 }) => {
      if (tf === 7) {
        return coreResult({
          modules: {
            ...coreModule(7),
            stats: { unsupported_7d_metric: 1 },
            extras: { unsupported_7d_extra: 'cached-before-withdrawal' },
          },
          isDegraded: true,
          isPendingUpstream: true,
          refetch: retry7,
        })
      }
      if (tf === 30) return coreResult({ modules: coreModule(30), refetch: retry30 })
      return coreResult({
        modules: {
          ...coreModule(90),
          stats: { unsupported_90d_metric: 1 },
        },
        isDegraded: true,
        isPendingUpstream: true,
        refetch: retry90,
      })
    })
    ;(useTraderRecords as jest.Mock).mockImplementation(() => recordsResult(null))
    const thirtyDayOnly: SourceCapability = {
      ...capability,
      timeframes: { '7': 'absent', '30': 'native', '90': 'absent' },
    }

    const view = renderHook(() =>
      useServingTabData(
        {
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          nickname: 'Trader A',
          avatarSrc: null,
        },
        thirtyDayOnly,
        true
      )
    )

    expect(useTraderCore).toHaveBeenNthCalledWith(1, {
      source: 'gmx',
      exchangeTraderId: 'trader-a',
      tf: 7,
      enabled: false,
    })
    expect(useTraderCore).toHaveBeenNthCalledWith(2, {
      source: 'gmx',
      exchangeTraderId: 'trader-a',
      tf: 30,
      enabled: true,
    })
    expect(useTraderCore).toHaveBeenNthCalledWith(3, {
      source: 'gmx',
      exchangeTraderId: 'trader-a',
      tf: 90,
      enabled: false,
    })
    expect(view.result.current.metaExtras).not.toHaveProperty('unsupported_7d_extra')
    expect(view.result.current.gridStats).not.toHaveProperty('unsupported_7d_metric')
    expect(view.result.current.gridStats).not.toHaveProperty('unsupported_90d_metric')
    expect(view.result.current.isCorePendingUpstream).toBe(false)
    expect(view.result.current.isCoreStale).toBe(false)
    expect(view.result.current.isCoreUnavailable).toBe(false)

    await view.result.current.refetchDegradedCore()
    expect(retry7).not.toHaveBeenCalled()
    expect(retry30).not.toHaveBeenCalled()
    expect(retry90).not.toHaveBeenCalled()
  })
})
