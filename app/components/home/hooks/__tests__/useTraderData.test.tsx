/**
 * useTraderData — time range switch behavior.
 *
 * Guards the Wave-1 perceived-performance contract: switching 7D/30D/90D must
 * never blank the table. currentTraders stays non-empty through the debounce
 * window AND the in-flight fetch; only LOAD_SUCCESS replaces rows.
 */

import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { useTraderData, TIME_RANGE_DEBOUNCE_MS } from '../useTraderData'
import type { Trader } from '../../../ranking/RankingTable'

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

// Stable identities — fetchPage depends on `broadcast`; a fresh fn per render
// would change fetchPage's identity every render and loop the fetch effect.
const stableBroadcast = jest.fn()
const stableOn = jest.fn(() => () => {})
jest.mock('@/lib/hooks/useBroadcastSync', () => ({
  useTraderDataSync: () => ({ broadcast: stableBroadcast, on: stableOn }),
}))

const initialTrader = {
  id: 'trader-90d',
  handle: 'Alice',
  roi: 12.3,
  pnl: 1000,
  win_rate: 60,
  max_drawdown: 5,
  trades_count: 10,
  followers: 1,
  source: 'bybit',
  avatar_url: null,
  arena_score: 80,
  rank: 1,
} as unknown as Trader

function mockFetchResolving(traders: Array<Record<string, unknown>>) {
  let resolve!: () => void
  const gate = new Promise<void>((r) => {
    resolve = r
  })
  global.fetch = jest.fn(async () => {
    await gate
    return {
      ok: true,
      json: async () => ({
        traders,
        lastUpdated: '2026-06-12T00:00:00Z',
        availableSources: ['bybit'],
        totalCount: traders.length,
      }),
    } as Response
  }) as jest.Mock
  return { resolveFetch: resolve }
}

describe('useTraderData time range switch', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.runOnlyPendingTimers()
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('keeps currentTraders non-empty through debounce and in-flight fetch', async () => {
    const { resolveFetch } = mockFetchResolving([
      { id: 'trader-30d', source: 'bybit', rank: 1, roi: 9.9 },
    ])

    const { result } = renderHook(() =>
      useTraderData({
        autoRefreshInterval: 0,
        initialTraders: [initialTrader],
        initialLastUpdated: '2026-06-11T00:00:00Z',
        initialTotalCount: 1,
      })
    )

    expect(result.current.traders).toHaveLength(1)
    expect(result.current.loading).toBe(false)

    act(() => {
      result.current.changeTimeRange('30D')
    })

    // Debounce window: switch flagged, rows untouched, fetch not yet dispatched.
    expect(result.current.isChangingTimeRange).toBe(true)
    expect(result.current.traders).toHaveLength(1)
    expect(result.current.activeTimeRange).toBe('90D')
    expect(global.fetch).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(TIME_RANGE_DEBOUNCE_MS - 1)
    })
    expect(result.current.activeTimeRange).toBe('90D')

    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(result.current.activeTimeRange).toBe('30D')
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('timeRange=30D'),
      expect.anything()
    )

    // Fetch in flight: old rows must still be on screen.
    expect(result.current.traders).toHaveLength(1)
    expect(result.current.traders[0].id).toBe('trader-90d')

    await act(async () => {
      resolveFetch()
      await Promise.resolve()
    })

    expect(result.current.traders).toHaveLength(1)
    expect(result.current.traders[0].id).toBe('trader-30d')
    expect(result.current.isChangingTimeRange).toBe(false)
    expect(result.current.loading).toBe(false)
  })

  it('rapid tab flicking settles on the last range with a single fetch', async () => {
    const { resolveFetch } = mockFetchResolving([
      { id: 'trader-7d', source: 'bybit', rank: 1, roi: 1.1 },
    ])

    const { result } = renderHook(() =>
      useTraderData({
        autoRefreshInterval: 0,
        initialTraders: [initialTrader],
        initialTotalCount: 1,
      })
    )

    act(() => {
      result.current.changeTimeRange('30D')
    })
    act(() => {
      jest.advanceTimersByTime(TIME_RANGE_DEBOUNCE_MS / 2)
      result.current.changeTimeRange('7D')
    })
    act(() => {
      jest.advanceTimersByTime(TIME_RANGE_DEBOUNCE_MS)
    })

    expect(result.current.activeTimeRange).toBe('7D')
    const calls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('timeRange=7D')

    await act(async () => {
      resolveFetch()
      await Promise.resolve()
    })
    expect(result.current.traders[0].id).toBe('trader-7d')
  })
})
