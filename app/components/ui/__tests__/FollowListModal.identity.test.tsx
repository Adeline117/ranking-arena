import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '11111111-1111-4111-8111-111111111112'
const TARGET_ALICE = '22222222-2222-4222-8222-222222222222'
const TARGET_CAROL = '22222222-2222-4222-8222-222222222223'
const USER_BOB = '33333333-3333-4333-8333-333333333333'
const USER_DAVE = '33333333-3333-4333-8333-333333333334'
const NOW = '2026-08-03T12:00:00.000Z'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: string
}

function signedIn(userId: string, generation: number): MockAuth {
  return {
    accessToken: `token-${userId}`,
    authChecked: true,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth: MockAuth = signedIn(VIEWER_A, 1)
const mockShowToast = jest.fn()
const mockPush = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))
jest.mock('@/app/components/ui/ModalOverlay', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}))
jest.mock('@/app/components/ui/Avatar', () => ({
  __esModule: true,
  default: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`} />,
}))
jest.mock('@/app/components/ui/UserFollowButton', () => ({
  __esModule: true,
  default: ({ targetUserId, currentUserId }: { targetUserId: string; currentUserId: string }) => (
    <button type="button" aria-label={`follow-${targetUserId}`} data-current-user={currentUserId} />
  ),
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn() },
}))

import FollowListModal from '../FollowListModal'

type FetchResponse = {
  status: number
  json: () => Promise<unknown>
}

const fetchMock = jest.fn<Promise<FetchResponse>, Parameters<typeof fetch>>()

function response(status: number, body: unknown): FetchResponse {
  return { status, json: async () => body }
}

function user(id: string, handle: string, followedAt = NOW): Record<string, unknown> {
  return {
    id,
    handle,
    bio: null,
    avatar_url: null,
    followed_at: followedAt,
    is_following: false,
  }
}

function page(
  options: {
    viewerId?: string | null
    targetUserId?: string
    targetHandle?: string
    list?: 'followers' | 'following'
    users?: Record<string, unknown>[]
    hidden?: boolean
    hasMore?: boolean
    nextCursor?: string | null
    extra?: Record<string, unknown>
  } = {}
) {
  const hidden = options.hidden ?? false
  return {
    success: true,
    data: {
      viewer_id: options.viewerId === undefined ? VIEWER_A : options.viewerId,
      target_user_id: options.targetUserId ?? TARGET_ALICE,
      target_handle: options.targetHandle ?? 'Alice',
      list: options.list ?? 'followers',
      hidden,
      users: options.users ?? (hidden ? [] : [user(USER_BOB, 'bob')]),
      pagination: {
        limit: 50,
        has_more: options.hasMore ?? false,
        next_cursor: options.nextCursor ?? null,
      },
    },
    meta: { timestamp: NOW },
    ...options.extra,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function renderModal(overrides: Partial<React.ComponentProps<typeof FollowListModal>> = {}) {
  const props: React.ComponentProps<typeof FollowListModal> = {
    isOpen: true,
    onClose: jest.fn(),
    type: 'followers',
    handle: 'alice',
    currentUserId: VIEWER_B,
    ...overrides,
  }
  return { ...render(<FollowListModal {...props} />), props }
}

describe('FollowListModal exact read and identity isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuth = signedIn(VIEWER_A, 1)
    globalThis.fetch = fetchMock as typeof fetch
  })

  it('uses the canonical auth viewer and token instead of the legacy viewer prop', async () => {
    fetchMock.mockResolvedValueOnce(response(200, page()))
    renderModal({ currentUserId: VIEWER_B })

    expect(await screen.findByText('bob')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/users/alice/follow?list=followers',
      expect.objectContaining({
        headers: { Authorization: `Bearer token-${VIEWER_A}` },
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      })
    )
    expect(screen.getByRole('button', { name: `follow-${USER_BOB}` })).toHaveAttribute(
      'data-current-user',
      VIEWER_A
    )
  })

  it('does not disguise a malformed 200 as an empty list and retries explicitly', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, page({ extra: { debug: true } })))
      .mockResolvedValueOnce(response(200, page()))
    renderModal()

    expect(await screen.findByRole('alert')).toHaveTextContent('loadFailed')
    expect(screen.queryByText('noFollowersYet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(await screen.findByText('bob')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not turn a timed-out response into an empty list when fetch resolves after abort', async () => {
    jest.useFakeTimers()
    try {
      const latePage = deferred<FetchResponse>()
      fetchMock.mockImplementationOnce(() => latePage.promise)
      renderModal()

      await act(async () => {
        jest.advanceTimersByTime(15_000)
        await Promise.resolve()
      })
      await act(async () => {
        latePage.resolve(response(200, page()))
        await latePage.promise
        await Promise.resolve()
      })

      expect(screen.getByRole('alert')).toHaveTextContent('loadFailed')
      expect(screen.queryByText('noFollowersYet')).not.toBeInTheDocument()
      expect(screen.queryByText('bob')).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it('retains a same-resource last-good page when load-more fails, then retries it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(
          200,
          page({ hasMore: true, nextCursor: 'cursor_A', users: [user(USER_BOB, 'bob')] })
        )
      )
      .mockResolvedValueOnce(response(200, { success: true }))
      .mockResolvedValueOnce(
        response(200, page({ users: [user(USER_DAVE, 'dave', '2026-08-03T11:00:00.000Z')] }))
      )
    renderModal()

    expect(await screen.findByText('bob')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'loadMore' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('loadMoreFailed')
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.queryByText('noFollowersYet')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    expect(await screen.findByText('dave')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/users/alice/follow?list=followers&cursor=cursor_A'
    )
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      '/api/users/alice/follow?list=followers&cursor=cursor_A'
    )
  })

  it('single-flights repeated load-more activation', async () => {
    const nextPage = deferred<FetchResponse>()
    fetchMock
      .mockResolvedValueOnce(response(200, page({ hasMore: true, nextCursor: 'cursor_A' })))
      .mockImplementationOnce(() => nextPage.promise)
    renderModal()

    const loadMore = await screen.findByRole('button', { name: 'loadMore' })
    fireEvent.click(loadMore)
    fireEvent.click(loadMore)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      nextPage.resolve(
        response(200, page({ users: [user(USER_DAVE, 'dave', '2026-08-03T11:00:00.000Z')] }))
      )
      await nextPage.promise
    })
    expect(await screen.findByText('dave')).toBeInTheDocument()
  })

  it('drops an old viewer response after the authenticated account changes', async () => {
    const oldPage = deferred<FetchResponse>()
    fetchMock
      .mockImplementationOnce(() => oldPage.promise)
      .mockResolvedValueOnce(
        response(200, page({ viewerId: VIEWER_B, users: [user(USER_DAVE, 'dave')] }))
      )
    const view = renderModal()

    mockAuth = signedIn(VIEWER_B, 2)
    view.rerender(<FollowListModal {...view.props} />)
    expect(await screen.findByText('dave')).toBeInTheDocument()

    await act(async () => {
      oldPage.resolve(response(200, page({ viewerId: VIEWER_A, users: [user(USER_BOB, 'bob')] })))
      await oldPage.promise
    })
    expect(screen.queryByText('bob')).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalledWith('loadFailed', 'error')
  })

  it('drops an old handle/list response after the resource changes', async () => {
    const oldPage = deferred<FetchResponse>()
    fetchMock
      .mockImplementationOnce(() => oldPage.promise)
      .mockResolvedValueOnce(
        response(
          200,
          page({
            targetUserId: TARGET_CAROL,
            targetHandle: 'carol',
            list: 'following',
            users: [user(USER_DAVE, 'dave')],
          })
        )
      )
    const onClose = jest.fn()
    const view = renderModal({ onClose })

    const nextProps = { ...view.props, handle: 'carol', type: 'following' as const }
    view.rerender(<FollowListModal {...nextProps} />)
    expect(await screen.findByText('dave')).toBeInTheDocument()

    await act(async () => {
      oldPage.resolve(response(200, page({ users: [user(USER_BOB, 'bob')] })))
      await oldPage.promise
    })
    expect(screen.queryByText('bob')).not.toBeInTheDocument()
  })

  it('invalidates a pending response synchronously when closed', async () => {
    const pendingPage = deferred<FetchResponse>()
    fetchMock.mockImplementationOnce(() => pendingPage.promise)
    const onClose = jest.fn()
    renderModal({ onClose })

    fireEvent.click(screen.getByRole('button', { name: 'close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => {
      pendingPage.resolve(response(200, page()))
      await pendingPage.promise
    })
    expect(screen.queryByText('bob')).not.toBeInTheDocument()
    expect(mockShowToast).not.toHaveBeenCalled()
  })

  it('renders hidden state only from an exact hidden acknowledgement', async () => {
    mockAuth = {
      accessToken: null,
      authChecked: true,
      sessionGeneration: 1,
      userId: null,
      viewerKey: 'anon',
    }
    fetchMock.mockResolvedValueOnce(response(200, page({ viewerId: null, hidden: true })))
    renderModal()

    expect(await screen.findByText('userHiddenList')).toBeInTheDocument()
    expect(screen.queryByText('noFollowersYet')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({})
  })

  it('uses a semantic profile button for keyboard navigation', async () => {
    fetchMock.mockResolvedValueOnce(response(200, page()))
    const onClose = jest.fn()
    renderModal({ onClose })

    const profileButton = await screen.findByRole('button', { name: '@bob' })
    profileButton.focus()
    fireEvent.keyDown(profileButton, { key: 'Enter' })
    fireEvent.click(profileButton)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith('/u/bob')
  })

  it('waits for canonical auth resolution before issuing the request', async () => {
    mockAuth = {
      accessToken: null,
      authChecked: false,
      sessionGeneration: 0,
      userId: null,
      viewerKey: 'pending',
    }
    fetchMock.mockResolvedValueOnce(response(200, page()))
    const view = renderModal()
    expect(fetchMock).not.toHaveBeenCalled()

    mockAuth = signedIn(VIEWER_A, 1)
    view.rerender(<FollowListModal {...view.props} />)
    expect(await screen.findByText('bob')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
