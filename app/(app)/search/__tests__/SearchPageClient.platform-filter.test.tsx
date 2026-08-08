import { render, screen } from '@testing-library/react'
import type { UnifiedSearchResponse } from '@/lib/search/unified-search-client-contract'
import SearchPageClient from '../SearchPageClient'

const mockSearchParams = new URLSearchParams('q=btc&platform=bybit')

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}))

const mockFilteredSearchResponse: UnifiedSearchResponse = {
  query: 'btc',
  total: 0,
  results: {
    traders: [],
    posts: [],
    users: [],
    groups: [],
  },
}

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: mockFilteredSearchResponse,
    error: null,
    isLoading: false,
    refetch: jest.fn(),
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          platform: 'Platform',
          searchResults: 'Search Results',
          searchTabAll: 'All',
          traders: 'Traders',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/lib/hooks/useDebounce', () => ({
  useDebounce: (value: string) => value,
}))

jest.mock('@/lib/features', () => ({
  features: { social: false },
}))

jest.mock('@/lib/services/search-history', () => ({
  getLocalHistory: () => [],
  addToHistory: jest.fn(),
  clearHistory: jest.fn(),
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: jest.fn(),
}))

describe('SearchPageClient platform filter', () => {
  it('keeps the active platform and its explicit clear control visible with no filtered hits', () => {
    render(<SearchPageClient />)

    expect(screen.getByText('Platform:')).toBeVisible()

    const activePlatform = screen.getByRole('link', { name: 'Bybit' })
    expect(activePlatform).toHaveAttribute('aria-current', 'page')
    expect(activePlatform).toHaveAttribute('href', '/search?q=btc&platform=bybit')
    expect(activePlatform).toHaveClass('touch-target-sm')

    const clearPlatform = screen.getByRole('link', { name: 'All' })
    expect(clearPlatform).toHaveAttribute('href', '/search?q=btc')
    expect(clearPlatform).toHaveClass('touch-target-sm')
  })
})
