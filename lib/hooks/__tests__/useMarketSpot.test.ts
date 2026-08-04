import { useQuery } from '@tanstack/react-query'
import { useMarketSpotData } from '../useMarketSpot'
import { createMarketSpotSnapshot } from '@/lib/market/market-spot-client-contract'

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
}))

const mockedUseQuery = jest.mocked(useQuery)

const seed = createMarketSpotSnapshot({
  coins: [
    {
      id: 'bitcoin',
      symbol: 'BTC',
      name: 'Bitcoin',
      image: null,
      price: 100_000,
      change1h: null,
      change24h: 1,
      change7d: null,
      high24h: 101_000,
      low24h: 99_000,
      volume24h: 1_000_000,
      marketCap: 2_000_000,
      rank: 1,
    },
  ],
  source: 'coingecko',
  providerLimit: 100,
  collectedAt: '2025-07-17T16:25:00.000Z',
})

describe('useMarketSpotData initial snapshot time', () => {
  beforeEach(() => {
    mockedUseQuery.mockReset()
    mockedUseQuery.mockReturnValue({} as ReturnType<typeof useQuery>)
  })

  it('passes the stable timestamp captured with the SSR payload', () => {
    useMarketSpotData(seed)

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        initialData: seed,
        initialDataUpdatedAt: Date.parse(seed.collectedAt),
      })
    )
  })

  it('does not invent an initial timestamp when no verified seed exists', () => {
    useMarketSpotData()

    const options = mockedUseQuery.mock.calls[0][0]
    expect(options).not.toHaveProperty('initialData')
    expect(options).not.toHaveProperty('initialDataUpdatedAt')
  })

  it('ends a failed request after the bounded fetch so the page can offer manual retry', () => {
    useMarketSpotData()

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['market-spot'],
        queryFn: expect.any(Function),
        retry: false,
      })
    )
  })
})
