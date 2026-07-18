import type { ReactElement } from 'react'
import type {
  ExchangeRankings,
  ExchangeRankingsTimeframe,
} from '@/lib/data/serving/exchange-rankings'

const mockGetExchangeRankings = jest.fn()

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

import ExchangeRankingsPage from '../page'

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
    jest.clearAllMocks()
  })

  it('propagates total upstream failure to the retryable route error boundary', async () => {
    mockGetExchangeRankings.mockRejectedValue(new Error('database unavailable'))

    await expect(ExchangeRankingsPage()).rejects.toThrow('Exchange rankings are unavailable')
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
  })
})
