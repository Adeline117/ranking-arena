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
          markAllAsRead: 'Mark all as read',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

const originalFetch = global.fetch

function notification(id: string) {
  return {
    id,
    user_id: 'user-1',
    type: 'like',
    title: `title ${id}`,
    message: `message ${id}`,
    read: false,
    link: null,
    created_at: new Date().toISOString(),
  }
}

describe('NotificationsList read state survives cache re-derivation', () => {
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

  it('does not resurrect unread items or the badge after mark-all-read and a remount', async () => {
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return { ok: true, status: 200, json: async () => ({ success: true }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          notifications: [notification('n1'), notification('n2')],
          unread_count: 2,
        }),
      }
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <NotificationsList variant="page" />
      </QueryClientProvider>
    )

    const first = render(tree())
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true)
    )
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument()
    )
    first.unmount()

    // Remount within staleTime: the list and badge are re-derived from cache.
    render(tree())
    await screen.findByText('title n1')
    expect(useInboxStore.getState().unreadNotifications).toBe(0)
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'PUT')).toHaveLength(1)
  })
})
