import { fireEvent, render, screen } from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import GlobalMarketBar from '../GlobalMarketBar'

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
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

const mockedUseQuery = jest.mocked(useQuery)
const refetch = jest.fn()

describe('GlobalMarketBar terminal load states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows a retryable error after the request fails instead of keeping a skeleton', () => {
    mockedUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    } as unknown as ReturnType<typeof useQuery>)

    const view = render(<GlobalMarketBar />)

    expect(screen.getByRole('alert')).toHaveTextContent('Market data failed to load')
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('keeps a successful aggregate-free response distinct from loading and failure', () => {
    mockedUseQuery.mockReturnValue({
      data: {
        btcPrice: 100_000,
        btcChange24h: 1,
        ethPrice: 3_000,
        ethChange24h: 1,
        totalMarketCap: 0,
        totalVolume24h: 0,
        btcDominance: 0,
        ethGasGwei: null,
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
      isLoading: false,
      isError: false,
      refetch,
    } as unknown as ReturnType<typeof useQuery>)

    const view = render(<GlobalMarketBar />)

    expect(screen.getByRole('status')).toHaveTextContent('No data available')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
  })

  it('disables automatic retries so the bounded request can reach a visible terminal state', () => {
    mockedUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch,
    } as unknown as ReturnType<typeof useQuery>)

    render(<GlobalMarketBar />)

    expect(screen.getByTestId('market-overview-loading')).toBeInTheDocument()
    expect(mockedUseQuery).toHaveBeenCalledWith(expect.objectContaining({ retry: false }))
  })
})
