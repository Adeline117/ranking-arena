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
  flashNewsLastUpdated: 'Last updated: ',
  dataStaleWarning: 'Data may be delayed',
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

describe('FlashNewsPageClient last-updated time', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    intersectionCallbacks = []
    window.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof window.IntersectionObserver
  })

  it('shows the newest item time, not the fetch time, and flags old news as delayed', async () => {
    const realNow = Date.now
    Date.now = () => Date.parse('2026-11-11T12:00:00.000Z')
    try {
      mockedApiFetch.mockResolvedValueOnce({
        success: true,
        data: {
          news: [
            item('one', 'Old item'),
            { ...item('two', 'Newer item'), published_at: '2026-08-01T09:00:00.000Z' },
          ],
          pagination: pagination(1, false),
        },
      })
      render(<FlashNewsPageClient />)
      const label = await screen.findByTestId('flash-news-latest')
      expect(label.querySelector('time')).toHaveAttribute('dateTime', '2026-08-01T09:00:00.000Z')
      expect(label).toHaveTextContent('Data may be delayed')
    } finally {
      Date.now = realNow
    }
  })

  it('shows no last-updated time when the feed is empty', async () => {
    mockedApiFetch.mockResolvedValueOnce({
      success: true,
      data: { news: [], pagination: pagination(1, false) },
    })
    render(<FlashNewsPageClient />)
    expect(await screen.findByText('No news yet')).toBeInTheDocument()
    expect(screen.queryByTestId('flash-news-latest')).not.toBeInTheDocument()
  })
})
