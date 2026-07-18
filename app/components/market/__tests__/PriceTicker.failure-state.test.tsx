import { fireEvent, render, screen } from '@testing-library/react'
import { useQuery } from '@tanstack/react-query'
import PriceTicker from '../PriceTicker'

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
}))

const mockTranslations: Record<string, string> = {
  marketDataError: 'Market data failed to load',
  retry: 'Retry',
  noDataGeneric: 'No data available',
}
const mockTranslate = (key: string) => mockTranslations[key] ?? key

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: mockTranslate }),
}))

const mockedUseQuery = jest.mocked(useQuery)
const refetch = jest.fn()

describe('PriceTicker terminal load states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('shows a compact retryable error after the bounded request fails', () => {
    mockedUseQuery.mockReturnValue({
      data: [],
      error: new Error('unavailable'),
      isLoading: false,
      refetch,
    } as unknown as ReturnType<typeof useQuery>)

    const view = render(<PriceTicker />)

    expect(screen.getByRole('alert')).toHaveTextContent('Market data failed to load')
    expect(view.container.querySelector('.skeleton')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('renders a successful empty response as empty data rather than an error or blank strip', () => {
    mockedUseQuery.mockReturnValue({
      data: [],
      error: null,
      isLoading: false,
      refetch,
    } as unknown as ReturnType<typeof useQuery>)

    render(<PriceTicker />)

    expect(screen.getByRole('status')).toHaveTextContent('No data available')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not chain automatic retries behind the loading skeleton', () => {
    mockedUseQuery.mockReturnValue({
      data: [],
      error: null,
      isLoading: true,
      refetch,
    } as unknown as ReturnType<typeof useQuery>)

    const view = render(<PriceTicker />)

    expect(view.container.querySelector('.skeleton')).toBeInTheDocument()
    expect(mockedUseQuery).toHaveBeenCalledWith(expect.objectContaining({ retry: false }))
  })
})
