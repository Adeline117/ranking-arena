import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ActivityFeed from '../ActivityFeed'

const mockFetch = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    isLoggedIn: false,
    authChecked: true,
    getAuthHeadersAsync: jest.fn(),
  }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          activityFeedEmpty: 'No activity events yet.',
          activityFeedLive: 'Live',
          activityFeedTitle: 'Activity feed',
          loadFailed: 'Failed to load',
          tryAgain: 'Try again',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}))

jest.mock('../ActivityFeedItem', () => ({
  __esModule: true,
  default: () => <div>activity</div>,
  activityTypeLabel: (type: string) => type,
}))

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

function renderFeed() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ActivityFeed
        initialActivities={[]}
        initialHasMore={false}
        initialNextCursor={null}
        initialStatus="error"
      />
    </QueryClientProvider>
  )
}

describe('ActivityFeed failure state', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch
  })

  it('does not turn a failed SSR seed into an empty success and retries the query', async () => {
    mockFetch.mockResolvedValueOnce(response({ error: 'unavailable' }, 503))
    mockFetch.mockResolvedValueOnce(
      response({
        data: {
          activities: [],
          pagination: { hasMore: false, nextCursor: null },
        },
      })
    )

    renderFeed()

    expect((await screen.findAllByText('Failed to load')).length).toBeGreaterThan(0)
    expect(screen.queryByText('No activity events yet.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No activity events yet.')).toBeInTheDocument()
    expect(screen.queryAllByText('Failed to load')).toHaveLength(0)
  })
})
