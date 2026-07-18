import { fireEvent, render, screen } from '@testing-library/react'
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
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

const mockedUseQuery = jest.mocked(useQuery)
const refetchMarket = jest.fn()
const refetchExchanges = jest.fn()

type QueryState = {
  data?: unknown
  dataUpdatedAt?: number
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

  it('renders genuine successful empties as empty copy, not errors or loading', () => {
    mockLanes(
      {
        data: { rows: [] },
        dataUpdatedAt: 1,
        isLoading: false,
        isError: false,
        refetch: refetchMarket,
      },
      {
        data: [],
        isLoading: false,
        isError: false,
        refetch: refetchExchanges,
      }
    )

    const view = render(<CoreCards />)

    expect(screen.getByText('No gainers')).toBeInTheDocument()
    expect(screen.getByText('No losers')).toBeInTheDocument()
    expect(screen.getByText('No data available')).toBeInTheDocument()
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
})
