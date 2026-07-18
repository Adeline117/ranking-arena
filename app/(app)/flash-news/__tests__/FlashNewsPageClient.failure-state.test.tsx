import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { apiFetch } from '@/lib/utils/api-fetch'
import FlashNewsPageClient from '../FlashNewsPageClient'

const showToast = jest.fn()
const mockTranslations: Record<string, string> = {
  flashNewsFetchFailed: 'Failed to load news',
  loadFailedRetryShort: 'Failed to load, please retry',
  retry: 'Retry',
  flashNewsNoNews: 'No news yet',
  flashNewsNoNewsDesc: 'News will appear here as they come in',
  flashNewsCenter: 'Flash News',
  flashNewsDesc: 'Live market updates',
  search: 'Search',
  newsFlash_imp_breaking: 'Breaking',
  today: 'Today',
  yesterday: 'Yesterday',
  latest: 'latest',
  flashNewsNewItems: '{count} new',
  flashNewsTotal: '{count} total',
  loading: 'Loading',
}
const mockTranslate = (key: string) => mockTranslations[key] ?? key

jest.mock('@/lib/utils/api-fetch', () => ({
  apiFetch: jest.fn(),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: mockTranslate,
  }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    isLoggedIn: false,
    accessToken: null,
  }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({}),
}))

jest.mock('../components/CategoryFilter', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('../components/NewsTimelineSkeleton', () => ({
  __esModule: true,
  default: () => <div data-testid="news-loading">Loading news</div>,
}))

jest.mock('../components/NewsCard', () => ({
  __esModule: true,
  default: ({ item }: { item: { title: string } }) => <article>{item.title}</article>,
}))

const mockedApiFetch = jest.mocked(apiFetch)

const pagination = (page: number, hasNext: boolean) => ({
  page,
  limit: 20,
  total: hasNext ? 2 : page === 1 ? 0 : 2,
  totalPages: hasNext ? 2 : page,
  hasNext,
  hasPrev: page > 1,
})

const item = (id: string, title: string) => ({
  id,
  title,
  source: 'Arena',
  category: 'market' as const,
  importance: 'normal' as const,
  tags: [],
  published_at: '2026-07-18T12:00:00.000Z',
  created_at: '2026-07-18T12:00:00.000Z',
})

let intersectionCallbacks: IntersectionObserverCallback[] = []

class MockIntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds = []

  constructor(callback: IntersectionObserverCallback) {
    intersectionCallbacks.push(callback)
  }

  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

describe('FlashNewsPageClient failure states', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    intersectionCallbacks = []
    window.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof window.IntersectionObserver
  })

  it('replaces a failed first-load skeleton with a visible retry and preserves genuine empty', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({
      success: true,
      data: { news: [], pagination: pagination(1, false) },
    })

    render(<FlashNewsPageClient />)

    expect(screen.getByTestId('news-loading')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load news')
    expect(screen.queryByTestId('news-loading')).not.toBeInTheDocument()
    expect(screen.queryByText('No news yet')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('No news yet')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockedApiFetch).toHaveBeenCalledTimes(2)
  })

  it('retries the exact failed next page without dropping the rendered timeline or skipping ahead', async () => {
    mockedApiFetch
      .mockResolvedValueOnce({
        success: true,
        data: { news: [item('one', 'First item')], pagination: pagination(1, true) },
      })
      .mockRejectedValueOnce(new Error('page 2 unavailable'))
      .mockResolvedValueOnce({
        success: true,
        data: { news: [item('two', 'Second item')], pagination: pagination(2, false) },
      })

    render(<FlashNewsPageClient />)

    expect(await screen.findByText('First item')).toBeInTheDocument()
    await waitFor(() => expect(intersectionCallbacks.length).toBeGreaterThan(0))

    await act(async () => {
      intersectionCallbacks.at(-1)?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load news')
    expect(screen.getByText('First item')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Second item')).toBeInTheDocument()
    expect(screen.getByText('First item')).toBeInTheDocument()
    expect(mockedApiFetch).toHaveBeenCalledTimes(3)
    expect(String(mockedApiFetch.mock.calls[1][0])).toContain('page=2')
    expect(String(mockedApiFetch.mock.calls[2][0])).toContain('page=2')
  })
})
