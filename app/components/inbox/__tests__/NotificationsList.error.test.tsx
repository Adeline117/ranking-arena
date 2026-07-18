import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NotificationsList from '../NotificationsList'

const mockShowToast = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ accessToken: 'access-token' }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          all: 'All',
          failedToLoadRetryShort: 'Failed to load, please retry',
          noNotifications: 'No notifications',
          retry: 'Retry',
          somethingWentWrong: 'Something went wrong',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

const originalFetch = global.fetch

describe('NotificationsList load failure', () => {
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('shows a persistent retry state instead of an empty inbox', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ notifications: [], unread_count: 0 }),
      })
    global.fetch = fetchMock as unknown as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <NotificationsList variant="page" />
      </QueryClientProvider>
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load, please retry')
    expect(screen.queryByText('No notifications')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No notifications')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
