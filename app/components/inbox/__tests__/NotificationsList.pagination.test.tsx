import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import NotificationsList from '../NotificationsList'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'
import { useInboxStore } from '@/lib/stores/inboxStore'

const VIEWER_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const FOLLOW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const token = (subject: string) => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ sub: subject })}.signature`
}

const mockAuthState = {
  accessToken: token(VIEWER_ID),
  authChecked: true,
  email: 'viewer@example.com',
  isLoggedIn: true,
  loading: false,
  sessionGeneration: 1,
  user: { id: VIEWER_ID, user_metadata: {} },
  userId: VIEWER_ID,
  viewerKey: `user:${VIEWER_ID}`,
}

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuthState,
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: jest.fn() }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      (
        ({
          all: 'All',
          failedToLoadRetryShort: 'Failed to load, please retry',
          loadMore: 'Load more',
          loading: 'Loading',
          markAllAsRead: 'Mark all as read',
          noNotifications: 'No notifications',
          noNotificationsForFilter: 'No notifications in this category',
          notifications: 'Notifications',
          notifText_new_follower_msg: '{handle} followed you',
          notifText_new_follower_msg_generic: 'Someone followed you',
          notifText_new_follower_title: 'New follower',
          notifType_comment: 'Comments',
          notifType_follow: 'Follows',
          notifType_like: 'Likes',
          notifType_mention: 'Mentions',
          retry: 'Retry',
          somethingWentWrong: 'Something went wrong',
        }) as Record<string, string>
      )[key] || key,
  }),
}))

const originalFetch = global.fetch

function notification(overrides: Record<string, unknown> = {}) {
  return {
    actor_avatar_url: null,
    actor_handle: null,
    actor_id: null,
    created_at: '2026-07-29T12:00:00Z',
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    link: null,
    message: 'System body',
    read: false,
    reference_id: null,
    title: 'Recent system notice',
    type: 'system',
    user_id: VIEWER_ID,
    ...overrides,
  }
}

function response(
  notifications: Record<string, unknown>[],
  nextCursor: { before: string; before_id: string } | null = null,
  unreadCount = notifications.filter((item) => item.read !== true).length
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      notifications,
      next_cursor: nextCursor,
      unread_count: unreadCount,
    }),
  } as Response
}

function renderList(variant: 'page' | 'panel' = 'page') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationsList variant={variant} />
    </QueryClientProvider>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('NotificationsList server-filtered keyset pages', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, VIEWER_ID)
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

  it('requests the selected type before pagination instead of filtering the loaded all page', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('filter=follow')) {
        return response(
          [
            notification({
              actor_handle: 'alice',
              actor_id: ACTOR_ID,
              created_at: '2026-07-20T10:00:00Z',
              id: FOLLOW_ID,
              message: 'old follow',
              title: 'stored follow title',
              type: 'new_follower',
            }),
          ],
          null,
          2
        )
      }
      return response([notification()], null, 2)
    })
    global.fetch = fetchMock as unknown as typeof fetch
    renderList()

    expect(await screen.findByText('Recent system notice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Follows' }))

    expect(await screen.findByText('New follower')).toBeInTheDocument()
    expect(screen.getByText('alice followed you')).toBeInTheDocument()
    expect(screen.queryByText('Recent system notice')).not.toBeInTheDocument()
    expect(screen.queryByText('No notifications in this category')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('filter=follow'))).toBe(true)
  })

  it('uses the server-issued composite cursor for the next page', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => {
      const createdAt = `2026-07-29T12:${(59 - index).toString().padStart(2, '0')}:00Z`
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${(100000000000 + index).toString()}`
      return notification({ created_at: createdAt, id, title: `Notice ${index + 1}` })
    })
    const last = firstPage.at(-1)!
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        response(firstPage, {
          before: last.created_at as string,
          before_id: last.id as string,
        })
      )
      .mockResolvedValueOnce(
        response([
          notification({
            created_at: '2026-07-29T12:39:00Z',
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-999999999999',
            title: 'Oldest loaded notice',
          }),
        ])
      )
    global.fetch = fetchMock as unknown as typeof fetch
    renderList()

    expect(await screen.findByText('Notice 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Oldest loaded notice')).toBeInTheDocument()
    const secondUrl = String(fetchMock.mock.calls[1]?.[0])
    expect(secondUrl).toContain(`cursor=${encodeURIComponent(last.created_at as string)}`)
    expect(secondUrl).toContain(`cursorId=${last.id as string}`)
  })

  it('treats malformed success data as an error rather than a genuine empty list', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        notifications: [],
        next_cursor: null,
        unread_count: 0,
        legacy: true,
      }),
    }) as unknown as typeof fetch
    renderList()

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load, please retry')
    expect(screen.queryByText('No notifications')).not.toBeInTheDocument()
  })

  it('exposes the compact panel disclosure as a real accessible button', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(response([notification()])) as unknown as typeof fetch
    renderList('panel')

    expect(await screen.findByText('Recent system notice')).toBeInTheDocument()
    const disclosure = screen.getByRole('button', { name: /Notifications/ })
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(disclosure)

    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Recent system notice')).not.toBeInTheDocument()
  })

  it('does not overlap one-item and mark-all mutations for the same viewer', async () => {
    const firstMutation = deferred<Response>()
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return response(
          [
            notification({ title: 'First unread notice' }),
            notification({
              created_at: '2026-07-29T11:59:00Z',
              id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              title: 'Second unread notice',
            }),
          ],
          null,
          2
        )
      }

      if (fetchMock.mock.calls.filter(([, request]) => request?.method === 'PUT').length === 1) {
        return firstMutation.promise
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      } as Response
    })
    global.fetch = fetchMock as unknown as typeof fetch
    renderList()

    fireEvent.click(await screen.findByText('First unread notice'))
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'PUT')).toHaveLength(
        1
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }))
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'PUT')).toHaveLength(1)

    await act(async () => {
      firstMutation.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      } as Response)
      await firstMutation.promise
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, request]) => request?.method === 'PUT')).toHaveLength(
        2
      )
    )
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ mark_all: true })
  })
})
