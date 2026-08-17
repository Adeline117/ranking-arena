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
          noGainers: 'No gainers',
          noLosers: 'No losers',
          gainersTop5: 'Top gainers',
          losersTop5: 'Top losers',
          fundFlow: 'Exchange volume',
          dataUnavailable: 'Unavailable',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

const mockedUseQuery = jest.mocked(useQuery)
const refetchMarket = jest.fn()

type QueryState = {
  data?: unknown
  dataUpdatedAt?: number
  isLoading: boolean
  isError: boolean
  refetch: jest.Mock
}

function mockMarket(market: QueryState) {
  mockedUseQuery.mockImplementation(() => market as ReturnType<typeof useQuery>)
}

describe('CoreCards terminal load states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('keeps Fund Flow unavailable while market failures retain retry', () => {
    mockMarket({
      isLoading: false,
      isError: true,
      refetch: refetchMarket,
    })

    const view = render(<CoreCards />)

    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable')
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()

    const retries = screen.getAllByRole('button', { name: 'Retry' })
    fireEvent.click(retries[0])
    expect(refetchMarket).toHaveBeenCalledTimes(1)
    expect(mockedUseQuery).toHaveBeenCalledTimes(1)
    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['market-core'], retry: false })
    )
  })

  it('renders genuine successful empties as empty copy, not errors or loading', () => {
    mockMarket({
      data: { rows: [] },
      dataUpdatedAt: 1,
      isLoading: false,
      isError: false,
      refetch: refetchMarket,
    })

    const view = render(<CoreCards />)

    expect(screen.getByText('No gainers')).toBeInTheDocument()
    expect(screen.getByText('No losers')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()
    expect(mockedUseQuery).toHaveBeenCalledTimes(1)
  })

  it('limits skeletons to pending requests and disables automatic retry loops', () => {
    mockMarket({
      isLoading: true,
      isError: false,
      refetch: refetchMarket,
    })

    const view = render(<CoreCards />)

    expect(view.container.querySelectorAll('.skeleton')).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable')
    expect(mockedUseQuery).toHaveBeenCalledTimes(1)
    expect(mockedUseQuery).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['market-core'], retry: false })
    )
  })
})
