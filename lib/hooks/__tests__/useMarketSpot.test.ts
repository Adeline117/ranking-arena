import { useQuery } from '@tanstack/react-query'
import { useMarketSpotData, type SpotCoin } from '../useMarketSpot'

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
}))

const mockedUseQuery = jest.mocked(useQuery)

const seed: SpotCoin[] = [
  {
    id: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    image: '',
    price: 100_000,
    change24h: 1,
    high24h: 101_000,
    low24h: 99_000,
    volume24h: 1_000_000,
    marketCap: 2_000_000,
    rank: 1,
  },
]

describe('useMarketSpotData initial snapshot time', () => {
  beforeEach(() => {
    mockedUseQuery.mockReset()
    mockedUseQuery.mockReturnValue({} as ReturnType<typeof useQuery>)
  })

  it('passes the stable timestamp captured with the SSR payload', () => {
    useMarketSpotData(seed, 1_752_777_500_000)

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        initialData: seed,
        initialDataUpdatedAt: 1_752_777_500_000,
      })
    )
  })

  it('marks a seed with unknown collection time stale instead of using render time', () => {
    useMarketSpotData(seed)

    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        initialData: seed,
        initialDataUpdatedAt: 0,
      })
    )
  })
})
