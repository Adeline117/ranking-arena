import { render, screen } from '@testing-library/react'
import {
  createMarketSpotSnapshot,
  fetchCoinGeckoSpot,
} from '@/lib/market/market-spot-client-contract'

jest.mock('next/cache', () => ({
  unstable_cache: (work: () => unknown) => work,
}))

jest.mock('@/lib/market/market-spot-client-contract', () => {
  const actual = jest.requireActual('@/lib/market/market-spot-client-contract')
  return { ...actual, fetchCoinGeckoSpot: jest.fn() }
})

jest.mock('../MarketPageClient', () => ({
  __esModule: true,
  default: ({ initialSpotSnapshot, initialError }: any) => (
    <div
      data-testid="market-client-props"
      data-count={String(initialSpotSnapshot?.coins.length ?? 0)}
      data-error={String(initialError)}
    />
  ),
}))

import { MarketPageWithSeed } from '../page'

const mockedFetchCoinGeckoSpot = jest.mocked(fetchCoinGeckoSpot)

describe('market server seed truth', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('passes a verified snapshot and its provider receipt to the client', async () => {
    const snapshot = createMarketSpotSnapshot({
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
      collectedAt: '2026-08-03T12:00:00.000Z',
    })
    mockedFetchCoinGeckoSpot.mockResolvedValue(snapshot)

    render(await MarketPageWithSeed())

    expect(screen.getByTestId('market-client-props')).toHaveAttribute('data-count', '1')
    expect(screen.getByTestId('market-client-props')).toHaveAttribute('data-error', 'false')
  })

  it('passes an explicit initial failure instead of caching or labeling an empty success', async () => {
    mockedFetchCoinGeckoSpot.mockRejectedValue(new Error('deadline'))

    render(await MarketPageWithSeed())

    expect(screen.getByTestId('market-client-props')).toHaveAttribute('data-count', '0')
    expect(screen.getByTestId('market-client-props')).toHaveAttribute('data-error', 'true')
  })
})
