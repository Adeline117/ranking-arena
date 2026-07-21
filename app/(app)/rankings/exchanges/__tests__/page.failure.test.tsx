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

import ExchangeRankingsPage, { dynamic } from '../page'

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
  beforeEach(() => {
    mockGetExchangeRankings.mockReset()
  })

  it('propagates total upstream failure to the retryable route error boundary', async () => {
    mockGetExchangeRankings.mockRejectedValue(new Error('database unavailable'))

    await expect(ExchangeRankingsPage()).rejects.toThrow('Exchange rankings are unavailable')
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
