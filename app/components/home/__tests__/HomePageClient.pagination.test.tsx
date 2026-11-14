import { act, render } from '@testing-library/react'
import type { ComponentProps } from 'react'

let latestRankingProps: Record<string, unknown> | undefined
let mockActiveTimeRange = '90D'
const mockChangeTimeRange = jest.fn()

jest.mock('../RankingSection', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    latestRankingProps = props
    return <div data-testid="ranking-section" data-loading={String(props.loading)} />
  },
}))
jest.mock('../../ui/PullToRefresh', () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}))
jest.mock('../hooks', () => ({
  useTraderData: () => ({
    traders: [
      {
        id: 'server-default',
        handle: 'server-default',
        roi: 1,
        followers: 0,
        source: 'bybit',
        arena_score: 50,
        rank: 1,
      },
    ],
    loading: false,
    error: null,
    activeTimeRange: mockActiveTimeRange,
    changeTimeRange: mockChangeTimeRange,
    lastUpdated: null,
    availableSources: [],
    refresh: jest.fn(),
    deferredFetchFailed: false,
    retryDeferredFetch: jest.fn(),
    isChangingTimeRange: false,
    totalCount: null,
    totalCountIsExact: false,
    hasMore: false,
    categoryCounts: { all: null, futures: null, spot: null, onchain: null },
    categoryCountsAreExact: false,
    fetchPage: jest.fn(),
    lastRefreshFailed: false,
    staleDataWarning: false,
    isStale: false,
  }),
}))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ isLoggedIn: false }),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}))

import HomePageClient from '../HomePageClient'

type ClientProps = ComponentProps<typeof HomePageClient>

function renderClient(props: ClientProps = {}) {
  return render(<HomePageClient {...props} />)
}

describe('HomePageClient direct cohort safety', () => {
  beforeEach(() => {
    latestRankingProps = undefined
    mockActiveTimeRange = '90D'
    mockChangeTimeRange.mockClear()
    window.localStorage.clear()
    document.body.innerHTML = '<div id="ssr-home-content-shell"></div>'
  })

  it('ignores a legacy persisted exchange: the clean homepage shows its SSR rows', () => {
    window.localStorage.setItem('ranking-exchange', 'binance-futures')
    renderClient()

    // The picker that wrote this key no longer exists, so honouring it would
    // scope the board invisibly. SSR all-exchange rows stay on screen.
    expect(latestRankingProps).toEqual(
      expect.objectContaining({
        requiresInitialCohortFetch: false,
        loading: false,
        traders: [expect.objectContaining({ id: 'server-default' })],
      })
    )
  })

  it('does not apply a persisted exchange to a range/page deep link', () => {
    window.history.replaceState(null, '', '/?range=30D&page=3')
    window.localStorage.setItem('ranking-exchange', 'binance-futures')
    renderClient()

    // `/ ?range=30D&page=3` already names the SSR all-source cohort. It must
    // not be hidden while a local browser preference fetches a different one.
    expect(latestRankingProps).toEqual(
      expect.objectContaining({
        requiresInitialCohortFetch: false,
        loading: false,
        traders: [expect.objectContaining({ id: 'server-default' })],
      })
    )
  })

  it('keeps a failed direct cohort retryable and reveals rows only after retry success', () => {
    renderClient({ initialClientCohortPending: true })
    const initialProps = latestRankingProps!
    expect(initialProps.traders).toEqual([])
    expect(initialProps.loading).toBe(true)

    act(() => {
      ;(initialProps.onInitialCohortSettled as (succeeded: boolean) => void)(false)
    })
    const failedProps = latestRankingProps!
    expect(failedProps.error).toBe('failedToLoadRankings')
    expect(failedProps.traders).toEqual([])

    act(() => {
      ;(failedProps.onRetry as () => void)()
    })
    const retryProps = latestRankingProps!
    expect(retryProps.loading).toBe(true)
    expect(retryProps.initialCohortAttempt).toBe(1)

    act(() => {
      ;(retryProps.onInitialCohortSettled as (succeeded: boolean) => void)(true)
    })
    expect(latestRankingProps).toEqual(
      expect.objectContaining({
        loading: false,
        traders: [expect.objectContaining({ id: 'server-default' })],
      })
    )
    expect(document.getElementById('ssr-home-content-shell')).toHaveStyle({ display: 'none' })
  })

  it('does not rewrite range/page URL until the new range cohort has committed', async () => {
    window.history.replaceState(null, '', '/?page=3')
    const { rerender } = renderClient()

    act(() => {
      ;(latestRankingProps?.onTimeRangeChange as (range: '30D') => void)('30D')
    })
    expect(mockChangeTimeRange).toHaveBeenCalledWith('30D')
    expect(new URLSearchParams(window.location.search).get('page')).toBe('3')
    expect(new URLSearchParams(window.location.search).get('range')).toBeNull()

    mockActiveTimeRange = '30D'
    rerender(<HomePageClient />)
    await act(async () => {
      await Promise.resolve()
    })
    const params = new URLSearchParams(window.location.search)
    expect(params.get('range')).toBe('30D')
    expect(params.get('page')).toBeNull()
  })

  it('forwards a click back to the visible range so the hook can cancel the pending request', () => {
    renderClient()
    act(() => {
      ;(latestRankingProps?.onTimeRangeChange as (range: '30D') => void)('30D')
      ;(latestRankingProps?.onTimeRangeChange as (range: '90D') => void)('90D')
    })
    expect(mockChangeTimeRange).toHaveBeenNthCalledWith(1, '30D')
    expect(mockChangeTimeRange).toHaveBeenNthCalledWith(2, '90D')
  })
})
