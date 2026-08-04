import type { ReactElement } from 'react'
import type {
  ExchangeRankings,
  ExchangeRankingsTimeframe,
} from '@/lib/data/serving/exchange-rankings'

const mockGetExchangeRankings = jest.fn()

jest.mock('next/cache', () => ({
  unstable_cache: jest.fn((loader: (...args: unknown[]) => unknown) => loader),
}))

jest.mock('@/lib/supabase/read-replica', () => ({
  getReadReplica: () => ({ rpc: jest.fn() }),
}))

jest.mock('@/lib/data/serving/exchange-rankings', () => ({
  getExchangeRankings: (...args: unknown[]) => mockGetExchangeRankings(...args),
}))

jest.mock('../ExchangeRankingsClient', () => ({
  __esModule: true,
  default: () => null,
}))

import ExchangeRankingsPage, { dynamic, EXCHANGE_RANKINGS_SSR_TIMEOUT_MS } from '../page'

type ExchangePageProps = {
  byTimeframe: Record<ExchangeRankingsTimeframe, ExchangeRankings | null>
  failedTimeframes: ExchangeRankingsTimeframe[]
}

function rankings(timeframe: ExchangeRankingsTimeframe): ExchangeRankings {
  return {
    nonLegacyCount: 5,
    timeframe,
    rows: [],
  }
}

describe('exchange rankings SSR failure state', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    mockGetExchangeRankings.mockReset()
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('renders total upstream failure as localized retryable client state', async () => {
    mockGetExchangeRankings.mockRejectedValue(new Error('database unavailable'))

    const element = (await ExchangeRankingsPage()) as ReactElement<ExchangePageProps>
    expect(element.props.failedTimeframes).toEqual([7, 30, 90])
    expect(element.props.byTimeframe).toEqual({ 7: null, 30: null, 90: null })
    expect(consoleError).toHaveBeenCalledTimes(3)
  })

  it('bounds a never-settling timeframe so the inherited route skeleton cannot remain forever', async () => {
    jest.useFakeTimers()
    try {
      mockGetExchangeRankings.mockImplementation(
        (_client: unknown, timeframe: ExchangeRankingsTimeframe) =>
          timeframe === 90 ? new Promise(() => undefined) : Promise.resolve(rankings(timeframe))
      )

      const page = ExchangeRankingsPage()
      await jest.advanceTimersByTimeAsync(EXCHANGE_RANKINGS_SSR_TIMEOUT_MS)

      const element = (await page) as ReactElement<ExchangePageProps>
      expect(element.props.failedTimeframes).toEqual([90])
      expect(element.props.byTimeframe[90]).toBeNull()
      expect(element.props.byTimeframe[7]).toEqual(rankings(7))
      expect(element.props.byTimeframe[30]).toEqual(rankings(30))
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not let a response that settles after its deadline mutate the rendered result', async () => {
    jest.useFakeTimers()
    try {
      let resolveLate: ((value: ExchangeRankings) => void) | undefined
      mockGetExchangeRankings.mockImplementation(
        (_client: unknown, timeframe: ExchangeRankingsTimeframe) =>
          timeframe === 90
            ? new Promise<ExchangeRankings>((resolve) => {
                resolveLate = resolve
              })
            : Promise.resolve(rankings(timeframe))
      )

      const page = ExchangeRankingsPage()
      await jest.advanceTimersByTimeAsync(EXCHANGE_RANKINGS_SSR_TIMEOUT_MS)
      const element = (await page) as ReactElement<ExchangePageProps>
      expect(element.props.byTimeframe[90]).toBeNull()

      resolveLate?.(rankings(90))
      await Promise.resolve()

      expect(element.props.byTimeframe[90]).toBeNull()
      expect(element.props.failedTimeframes).toEqual([90])
    } finally {
      jest.useRealTimers()
    }
  })

  it('is request-rendered so transient RPC failures cannot fail the production build', () => {
    const { unstable_cache } = jest.requireMock('next/cache') as {
      unstable_cache: jest.Mock
    }

    expect(dynamic).toBe('force-dynamic')
    expect(unstable_cache).toHaveBeenCalledWith(
      expect.any(Function),
      ['rankings-exchange-rankings-v1'],
      { revalidate: 1800, tags: ['rankings', 'exchange-rankings'] }
    )
  })

  it('preserves successful timeframes when one timeframe fails', async () => {
    mockGetExchangeRankings.mockImplementation(
      (_client: unknown, timeframe: ExchangeRankingsTimeframe) =>
        timeframe === 30
          ? Promise.reject(new Error('30D unavailable'))
          : Promise.resolve(rankings(timeframe))
    )

    const element = (await ExchangeRankingsPage()) as ReactElement<ExchangePageProps>
    expect(element.props.failedTimeframes).toEqual([30])
    expect(element.props.byTimeframe[7]).toEqual(rankings(7))
    expect(element.props.byTimeframe[30]).toBeNull()
    expect(element.props.byTimeframe[90]).toEqual(rankings(90))
    expect(mockGetExchangeRankings.mock.calls.map((call) => call[1])).toEqual([7, 30, 90])
  })
})
