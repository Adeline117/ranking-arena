import { fireEvent, render, screen } from '@testing-library/react'

const mockRetrySearch = jest.fn()
const mockSearchParams = new URLSearchParams('q=arena')
const mockUseQueryOptions = jest.fn()
let mockQueryState: Record<string, unknown>

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: Record<string, unknown>) => {
    mockUseQueryOptions(options)
    return mockQueryState
  },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          retry: 'Retry',
          searchErrorTitle: 'Search failed',
          searchTryAgainLater: 'Please try again later',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/lib/hooks/useDebounce', () => ({
  useDebounce: (value: string) => value,
}))

jest.mock('@/lib/features', () => ({
  features: { social: true },
}))

jest.mock('@/lib/services/search-history', () => ({
  getLocalHistory: () => [],
  addToHistory: jest.fn(),
  clearHistory: jest.fn(),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: jest.fn(),
}))

jest.mock('@/app/components/ui/ErrorState', () => ({
  __esModule: true,
  default: ({
    title,
    description,
    retry,
  }: {
    title: string
    description: string
    retry: () => void
  }) => (
    <div role="alert">
      <span>{title}</span>
      <span>{description}</span>
      <button onClick={retry}>Retry</button>
    </div>
  ),
}))

import SearchPageClient from '../SearchPageClient'

describe('SearchPageClient retry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockQueryState = {
      data: undefined,
      error: new Error('Search unavailable'),
      isLoading: false,
      refetch: mockRetrySearch,
    }
  })

  it('offers an explicit retry for a failed main search', () => {
    render(<SearchPageClient />)

    expect(screen.getByRole('alert')).toHaveTextContent('Search failed')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(mockRetrySearch).toHaveBeenCalledTimes(1)
  })

  it('uses the fetcher deadline without multiplying it through automatic retries', () => {
    render(<SearchPageClient />)

    expect(mockUseQueryOptions).toHaveBeenCalledWith(
      expect.objectContaining({ retry: false, queryFn: expect.any(Function) })
    )
    expect(mockUseQueryOptions.mock.calls[0][0]).not.toHaveProperty('placeholderData')
  })

  it('keeps same-query last-good results visible beside a compact retry state', () => {
    mockQueryState = {
      data: {
        query: 'arena',
        results: {
          traders: [
            {
              id: 'binance:alice',
              type: 'trader',
              title: '@alice',
              href: '/trader/alice?platform=binance',
              meta: { platform: 'binance' },
            },
          ],
          posts: [],
          users: [],
          groups: [],
        },
        total: 1,
      },
      error: new Error('Refresh failed'),
      isLoading: false,
      refetch: mockRetrySearch,
    }

    render(<SearchPageClient />)

    expect(screen.getByRole('alert')).toHaveTextContent('Search failed')
    expect(screen.getByText('@alice')).toBeInTheDocument()
  })
})
