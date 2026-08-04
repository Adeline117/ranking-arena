import { render, screen } from '@testing-library/react'
import SearchDropdown from '../SearchDropdown'

const mockUseSearchData = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn() }),
}))

jest.mock('../useSearchData', () => ({
  useSearchData: (...args: unknown[]) => mockUseSearchData(...args),
}))

jest.mock('../SearchResultGroup', () => ({
  SearchResultGroup: () => null,
}))

jest.mock('../SearchSuggestions', () => ({
  SearchHistory: () => null,
  TrendingSearches: () => null,
  HotPosts: () => null,
}))

jest.mock('../SearchEmptyState', () => ({
  SearchEmptyState: () => null,
  SearchSkeleton: () => null,
}))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))
jest.mock('@/lib/features', () => ({ features: { social: true } }))

describe('SearchDropdown translation state', () => {
  const searchState = () => ({
    language: 'ja',
    t: (key: string) => key,
    searchHistory: [],
    hotPosts: [],
    trendingSearches: [],
    trendingLoading: false,
    loading: false,
    searchData: null,
    searching: false,
    isOffline: false,
    selectedIndex: -1,
    setSelectedIndex: jest.fn(),
    translatedTitles: {},
    translating: true,
    flatResults: [],
    saveToHistory: jest.fn(),
    handleDeleteHistory: jest.fn(),
    handleClearAllHistory: jest.fn(),
  })

  it('exposes reachable translation busy truth and 44px suggestion/result links', () => {
    mockUseSearchData.mockReturnValue(searchState())

    const { rerender } = render(<SearchDropdown open query="" onClose={jest.fn()} />)

    expect(screen.getByRole('listbox', { name: 'Search results' })).toHaveAttribute(
      'aria-busy',
      'true'
    )

    mockUseSearchData.mockReturnValue({
      ...searchState(),
      translating: false,
      searchData: {
        query: 'bt',
        total: 1,
        suggestions: ['btc'],
        results: { traders: [], posts: [], users: [], groups: [] },
      },
    })
    rerender(<SearchDropdown open query="bt" onClose={jest.fn()} />)

    const suggestion = screen.getByRole('link', { name: 'btc' })
    expect(suggestion).toHaveStyle({ minWidth: '44px', minHeight: '44px' })
    const viewAll = screen.getByRole('link', { name: /viewAllSearchResults/ })
    expect(viewAll).toHaveStyle({ minHeight: '44px' })
  })
})
