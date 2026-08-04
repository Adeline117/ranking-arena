import { fireEvent, render, screen, within } from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import CoreCards from '../CoreCards'

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          marketDataError: 'Market data failed to load',
          loadFailedRetryShort: 'Failed to load, please retry',
          retry: 'Retry',
          noDataGeneric: 'No data available',
          noGainers: 'No gainers',
          noLosers: 'No losers',
          gainersTop5: 'Top gainers',
          losersTop5: 'Top losers',
          fundFlow: 'Exchange volume',
          dataLoadIncomplete: 'Data load incomplete',
          dataStaleWarning: 'Data may be stale',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

const mockedUseQuery = jest.mocked(useQuery)
const refetchMarket = jest.fn()
const refetchExchanges = jest.fn()
const exchangeItem = {
  id: 'binance',
  name: 'Binance',
  year_established: 2017,
  country: null,
  image: '',
  trust_score: 10,
  trust_score_rank: 1,
  trade_volume_24h_btc: 100_000,
}

type QueryState = {
  data?: unknown
  dataUpdatedAt?: number
  error?: unknown
  isLoading: boolean
  isError: boolean
  refetch: jest.Mock
}

function mockLanes(market: QueryState, exchanges: QueryState) {
  mockedUseQuery.mockImplementation(
    (options: { queryKey?: readonly unknown[] }) =>
      (options.queryKey?.[0] === 'market-core' ? market : exchanges) as ReturnType<typeof useQuery>
  )
}

describe('CoreCards terminal load states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows retryable failures for each failed lane instead of permanent card skeletons', () => {
    mockLanes(
      {
        isLoading: false,
        isError: true,
        refetch: refetchMarket,
      },
      {
        isLoading: false,
        isError: true,
        refetch: refetchExchanges,
      }
    )

    const view = render(<CoreCards />)

    expect(screen.getAllByRole('alert')).toHaveLength(3)
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()

    const retries = screen.getAllByRole('button', { name: 'Retry' })
    fireEvent.click(retries[0])
    fireEvent.click(retries[2])
    expect(refetchMarket).toHaveBeenCalledTimes(1)
    expect(refetchExchanges).toHaveBeenCalledTimes(1)
  })

  it('renders a genuine no-loser result without turning it into a lane failure', () => {
    mockLanes(
      {
        data: {
          rows: [{ symbol: 'BTC-USD', price: '100,000', changePct: '+1.00%', direction: 'up' }],
          partial: false,
          stale: false,
        },
        isLoading: false,
        isError: false,
        refetch: refetchMarket,
      },
      {
        data: { items: [exchangeItem], partial: false },
        isLoading: false,
        isError: false,
        refetch: refetchExchanges,
      }
    )

    const view = render(<CoreCards />)

    expect(screen.getByText('No losers')).toBeInTheDocument()
    expect(screen.getByText('BTC')).toBeInTheDocument()
    expect(screen.getByText('Binance')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
  })

  it('limits skeletons to pending requests and disables automatic retry loops', () => {
    mockLanes(
      {
        isLoading: true,
        isError: false,
        refetch: refetchMarket,
      },
      {
        isLoading: true,
        isError: false,
        refetch: refetchExchanges,
      }
    )

    const view = render(<CoreCards />)

    expect(view.container.querySelectorAll('.skeleton')).toHaveLength(3)
    expect(mockedUseQuery).toHaveBeenNthCalledWith(1, expect.objectContaining({ retry: false }))
    expect(mockedUseQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({ retry: false }))
  })

  it('keeps real partial rows visible with an explicit retryable coverage warning', () => {
    mockLanes(
      {
        data: {
          rows: [{ symbol: 'BTC-USD', price: '100,000', changePct: '+1.00%', direction: 'up' }],
          source: 'coingecko',
          cached: false,
          stale: false,
          partial: true,
          collectedAt: '2026-08-03T12:00:00.000Z',
        },
        isLoading: false,
        isError: false,
        refetch: refetchMarket,
      },
      {
        data: { items: [exchangeItem], partial: false },
        isLoading: false,
        isError: false,
        refetch: refetchExchanges,
      }
    )

    render(<CoreCards />)

    expect(screen.getByText('BTC')).toBeInTheDocument()
    const warning = screen.getByTestId('market-core-degraded')
    expect(warning).toHaveTextContent('Data load incomplete')
    const retry = within(warning).getByRole('button', { name: 'Retry' })
    expect(retry).toHaveStyle({ minWidth: '44px', minHeight: '44px' })
    fireEvent.click(retry)
    expect(refetchMarket).toHaveBeenCalledTimes(1)
  })

  it('keeps same-query last-good rows visible and reports a failed refresh', () => {
    mockLanes(
      {
        data: {
          rows: [{ symbol: 'BTC-USD', price: '100,000', changePct: '+1.00%', direction: 'up' }],
          partial: false,
          stale: false,
          collectedAt: '2026-08-03T12:00:00.000Z',
        },
        error: new Error('offline'),
        isLoading: false,
        isError: true,
        refetch: refetchMarket,
      },
      {
        data: { items: [exchangeItem], partial: false },
        isLoading: false,
        isError: false,
        refetch: refetchExchanges,
      }
    )

    render(<CoreCards />)

    expect(screen.getByText('BTC')).toBeInTheDocument()
    expect(screen.getByTestId('market-core-degraded')).toHaveTextContent('Data may be stale')
  })

  it('keeps last-good exchange rows visible with an explicit failed-refresh warning', () => {
    mockLanes(
      {
        data: {
          rows: [{ symbol: 'BTC-USD', price: '100,000', changePct: '+1.00%', direction: 'up' }],
          partial: false,
          stale: false,
        },
        isLoading: false,
        isError: false,
        refetch: refetchMarket,
      },
      {
        data: { items: [exchangeItem], partial: false },
        error: new Error('offline'),
        isLoading: false,
        isError: true,
        refetch: refetchExchanges,
      }
    )

    render(<CoreCards />)

    expect(screen.getByText('Binance')).toBeInTheDocument()
    const warning = screen.getByRole('button', { name: 'Data may be stale' })
    expect(warning).toHaveStyle({ minHeight: '44px' })
    fireEvent.click(warning)
    expect(refetchExchanges).toHaveBeenCalledTimes(1)
  })
})
