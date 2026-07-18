import { fireEvent, render, screen } from '@testing-library/react'
import type { UnifiedSearchResponse } from '@/app/api/search/route'
import SearchPageClient from '../SearchPageClient'

const mockSearchParams = new URLSearchParams('q=arena')

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}))

const mockSearchResponse: UnifiedSearchResponse = {
  query: 'arena',
  total: 4,
  results: {
    traders: [
      {
        id: 'binance_futures:trader-1',
        type: 'trader',
        title: '@arena-trader',
        href: '/trader/trader-1?platform=binance_futures',
        meta: { platform: 'binance_futures', arena_score: 88 },
      },
    ],
    posts: [
      {
        id: 'post-1',
        type: 'post',
        title: 'Arena post',
        href: '/post/post-1',
      },
    ],
    users: [
      {
        id: 'user-uuid',
        type: 'user',
        title: '@Arena',
        subtitle: '@Arena',
        href: '/u/Arena',
        avatar: null,
      },
    ],
    groups: [
      {
        id: 'group-1',
        type: 'group',
        title: 'Arena group',
        href: '/groups/group-1',
      },
    ],
  },
}

jest.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: mockSearchResponse,
    error: null,
    isLoading: false,
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (
        ({
          searchResults: 'Search Results',
          searchTabAll: 'All',
          searchTabPeople: 'People',
          searchTabPosts: 'Posts',
          traders: 'Traders',
          groups: 'Groups',
          members: 'members',
          searchPostsSection: 'Posts',
          searchPostBy: 'by',
          searchNoSectionResults: 'No {type} found',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ email: null }),
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

jest.mock('@/app/components/ui/Avatar', () => ({
  __esModule: true,
  default: ({ name }: { name: string }) => <span data-testid="person-avatar">{name}</span>,
}))

describe('SearchPageClient People results', () => {
  afterEach(() => {
    mockSearchParams.delete('tab')
  })

  it('renders People in All with a public-profile link and distinct user styling', () => {
    const { container } = render(<SearchPageClient />)

    expect(screen.getByRole('link', { name: 'People (1)' })).toHaveAttribute(
      'href',
      '/search?q=arena&tab=people'
    )
    expect(screen.getByRole('link', { name: /^@\s*Arena$/i })).toHaveAttribute('href', '/u/Arena')
    expect(screen.getByTestId('person-avatar')).toHaveTextContent('Arena')

    const sectionHeadings = Array.from(container.querySelectorAll('section')).map((section) =>
      section.textContent?.trim()
    )
    expect(sectionHeadings[0]).toContain('Traders')
    expect(sectionHeadings[1]).toContain('Posts')
    expect(sectionHeadings[2]).toContain('People')
    expect(sectionHeadings[3]).toContain('Groups')
  })

  it('includes the People row in arrow-key focus order', () => {
    const { container } = render(<SearchPageClient />)
    const resultsGrid = container.querySelector('section')?.parentElement
    expect(resultsGrid).not.toBeNull()

    fireEvent.keyDown(resultsGrid!, { key: 'ArrowDown' })
    fireEvent.keyDown(resultsGrid!, { key: 'ArrowDown' })
    fireEvent.keyDown(resultsGrid!, { key: 'ArrowDown' })

    expect(document.activeElement).toBe(container.querySelector('a[href="/u/Arena"]'))
  })

  it('isolates personal profiles on the dedicated People tab', () => {
    mockSearchParams.set('tab', 'people')
    const { container } = render(<SearchPageClient />)

    expect(screen.getByRole('link', { name: 'People (1)' })).toHaveAttribute('aria-current', 'page')
    expect(container.querySelector('a[href="/u/Arena"]')).toBeInTheDocument()
    expect(
      container.querySelector('a[href="/trader/trader-1?platform=binance_futures"]')
    ).not.toBeInTheDocument()
  })
})
