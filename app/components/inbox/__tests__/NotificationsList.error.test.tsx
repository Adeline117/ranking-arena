import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NotificationsList from '../NotificationsList'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'
import { useInboxStore } from '@/lib/stores/inboxStore'

const mockShowToast = jest.fn()
const token = (subject: string) => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: subject })}.signature`
}
const mockAuthState = {
  accessToken: token('user-1'),
  authChecked: true,
  email: 'user-1@example.com',
  isLoggedIn: true,
  loading: false,
  sessionGeneration: 1,
  user: { id: 'user-1', user_metadata: {} },
  userId: 'user-1',
  viewerKey: 'user:user-1',
}

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
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
          failedToLoadRetry: 'Failed to load, please retry',
          noNotifications: 'No notifications',
          retry: 'Retry',
          somethingWentWrong: 'Something went wrong',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

const originalFetch = global.fetch

describe('NotificationsList load failure', () => {
  beforeEach(() => {
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-1')
    mockAuthState.sessionGeneration = scope.sessionGeneration
    useInboxStore.setState({
      ownerScopeKey: null,
      panelOpen: false,
      unreadMessages: 0,
      unreadNotifications: 0,
    })
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('shows a persistent retry state instead of an empty inbox', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'Unavailable' }),
      })
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
