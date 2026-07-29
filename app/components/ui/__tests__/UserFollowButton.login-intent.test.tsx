import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { profileUserTarget, queueProfileActionLogin } from '@/lib/auth/profile-action-login'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockBroadcast = jest.fn()
const mockOn = jest.fn(() => jest.fn())
const mockAuthedFetch = jest.fn()
const VIEWER_A = 'viewer-user'
const VIEWER_B = 'viewer-b'

type MockAuth = {
  accessToken: string | null
  authChecked: boolean
  email: string | null
  loading: boolean
  sessionGeneration: number
  userId: string | null
  viewerKey: 'anon' | `user:${string}`
}

function signedIn(userId: string, token: string, generation: number): MockAuth {
  return {
    accessToken: token,
    authChecked: true,
    email: null,
    loading: false,
    sessionGeneration: generation,
    userId,
    viewerKey: `user:${userId}`,
  }
}

let mockAuth: MockAuth = signedIn(VIEWER_A, 'access-token-a', 1)

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: (auth: MockAuth) => {
    if (
      auth.loading ||
      !auth.authChecked ||
      !auth.userId ||
      !auth.accessToken ||
      auth.viewerKey !== `user:${auth.userId}`
    ) {
      return null
    }
    return {
      accessToken: auth.accessToken,
      email: auth.email,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
      viewerKey: auth.viewerKey,
    }
  },
  isSettingsViewerCurrent: (
    viewer: { sessionGeneration: number; userId: string; viewerKey: string },
    auth: MockAuth
  ) =>
    auth.authChecked &&
    !auth.loading &&
    auth.userId === viewer.userId &&
    auth.viewerKey === viewer.viewerKey &&
    auth.sessionGeneration === viewer.sessionGeneration,
}))

jest.mock('@/lib/hooks/useBroadcastSync', () => ({
  useUserFollowSync: () => ({ broadcast: mockBroadcast, on: mockOn }),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/lib/utils/haptics', () => ({ haptic: jest.fn() }))

import UserFollowButton from '../UserFollowButton'

function response(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
  }
}

type MockFetchResult = ReturnType<typeof response>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('UserFollowButton login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/u/alice?tab=portfolio')
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
  })

  it('sends an anonymous follow through login with the exact profile route', () => {
    render(
      <UserFollowButton
        targetUserId="target-user"
        currentUserId={null}
        loginReturnPath="/u/alice"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'follow' }))

    expect(mockPush).toHaveBeenCalledWith(
      '/login?returnUrl=%2Fu%2Falice%3Ftab%3Dportfolio%26resumeAction%3Dfollow-user'
    )
  })

  it('re-authenticates a 401 without losing the intended follow', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(response({ following: false, followedBy: false, mutual: false }))
      .mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401))

    render(
      <UserFollowButton
        targetUserId="target-user"
        currentUserId="viewer-user"
        loginReturnPath="/u/alice"
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'followUser' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Fu%2Falice%3Ftab%3Dportfolio%26resumeAction%3Dfollow-user'
      )
    )
    expect(mockShowToast).toHaveBeenCalledWith('loginExpiredPleaseRelogin', 'error')
    expect(screen.getByRole('button', { name: 'followUser' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('resumes a matching same-tab follow once after login', async () => {
    const href = queueProfileActionLogin({
      action: 'follow-user',
      target: profileUserTarget('target-user'),
      fallbackPath: '/u/alice',
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    mockAuthedFetch
      .mockResolvedValueOnce(response({ following: false, followedBy: false, mutual: false }))
      .mockResolvedValueOnce(
        response({ following: true, followedBy: false, mutual: false, success: true })
      )

    render(
      <UserFollowButton
        targetUserId="target-user"
        currentUserId="viewer-user"
        loginReturnPath="/u/alice"
      />
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'unfollowUser' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )
    expect(`${window.location.pathname}${window.location.search}`).toBe('/u/alice?tab=portfolio')
    expect(mockAuthedFetch).toHaveBeenCalledTimes(2)
  })

  it('executes an explicit unfollow even when the initial status read fails', async () => {
    const href = queueProfileActionLogin({
      action: 'unfollow-user',
      target: profileUserTarget('target-user'),
      fallbackPath: '/u/alice',
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    mockAuthedFetch
      .mockResolvedValueOnce(response({ error: 'unavailable' }, 500))
      .mockResolvedValueOnce(
        response({ following: false, followedBy: false, mutual: false, success: true })
      )

    render(
      <UserFollowButton
        targetUserId="target-user"
        currentUserId="viewer-user"
        loginReturnPath="/u/alice"
      />
    )

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(2))
    expect(mockAuthedFetch).toHaveBeenLastCalledWith(
      '/api/users/follow',
      'POST',
      'access-token-a',
      { followingId: 'target-user', action: 'unfollow' },
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('consumes an anonymous follow intent without following the target account itself', async () => {
    const href = queueProfileActionLogin({
      action: 'follow-user',
      target: profileUserTarget('target-user'),
      fallbackPath: '/u/alice',
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    mockAuth = signedIn('target-user', 'target-token', 2)

    render(
      <UserFollowButton
        targetUserId="target-user"
        currentUserId="target-user"
        loginReturnPath="/u/alice"
      />
    )

    await waitFor(() =>
      expect(`${window.location.pathname}${window.location.search}`).toBe('/u/alice?tab=portfolio')
    )
    expect(window.sessionStorage).toHaveLength(0)
    expect(mockAuthedFetch).not.toHaveBeenCalled()
  })

  it('does not apply a late status response to a replacement profile target', async () => {
    const firstStatus = deferred<MockFetchResult>()
    mockAuthedFetch
      .mockReturnValueOnce(firstStatus.promise)
      .mockResolvedValueOnce(response({ following: true, followedBy: false, mutual: false }))

    const view = render(<UserFollowButton targetUserId="target-a" currentUserId="viewer-user" />)
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    view.rerender(<UserFollowButton targetUserId="target-b" currentUserId="viewer-user" />)
    expect(await screen.findByRole('button', { name: 'unfollowUser' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await act(async () => {
      firstStatus.resolve(response({ following: false, followedBy: false, mutual: false }))
      await firstStatus.promise
    })

    expect(screen.getByRole('button', { name: 'unfollowUser' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('does not apply an old mutation after the viewer moves to another target', async () => {
    const oldMutation = deferred<MockFetchResult>()
    mockAuthedFetch.mockImplementation((url: string, method: string) => {
      if (url === '/api/users/follow' && method === 'POST') {
        return oldMutation.promise
      }
      return Promise.resolve(response({ following: false, followedBy: false, mutual: false }))
    })

    const view = render(<UserFollowButton targetUserId="target-a" currentUserId="viewer-user" />)
    fireEvent.click(await screen.findByRole('button', { name: 'followUser' }))
    await waitFor(() =>
      expect(
        mockAuthedFetch.mock.calls.some(
          (call) => call[0] === '/api/users/follow' && call[1] === 'POST'
        )
      ).toBe(true)
    )

    view.rerender(<UserFollowButton targetUserId="target-b" currentUserId="viewer-user" />)
    expect(await screen.findByRole('button', { name: 'followUser' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    await act(async () => {
      oldMutation.resolve(
        response({
          success: true,
          following: true,
          followedBy: false,
          mutual: false,
        })
      )
      await oldMutation.promise
    })

    expect(screen.getByRole('button', { name: 'followUser' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(mockBroadcast).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalledWith('followSuccess', 'success')
  })

  it('rolls back an optimistic follow when the success acknowledgement is malformed', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(response({ following: false, followedBy: false, mutual: false }))
      .mockResolvedValueOnce(
        response({
          success: true,
          following: 'yes',
          followedBy: false,
          mutual: false,
        })
      )

    render(<UserFollowButton targetUserId="target-user" currentUserId="viewer-user" />)
    fireEvent.click(await screen.findByRole('button', { name: 'followUser' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('operationFailedRetry', 'error'))
    expect(screen.getByRole('button', { name: 'followUser' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(mockBroadcast).not.toHaveBeenCalled()
  })

  it('does not apply an old mutation after the signed-in viewer changes', async () => {
    const oldMutation = deferred<MockFetchResult>()
    mockAuthedFetch.mockImplementation((url: string, method: string) => {
      if (url === '/api/users/follow' && method === 'POST') {
        return oldMutation.promise
      }
      return Promise.resolve(response({ following: false, followedBy: false, mutual: false }))
    })

    const view = render(<UserFollowButton targetUserId="target-a" currentUserId={VIEWER_A} />)
    fireEvent.click(await screen.findByRole('button', { name: 'followUser' }))
    await waitFor(() =>
      expect(
        mockAuthedFetch.mock.calls.some(
          (call) => call[0] === '/api/users/follow' && call[1] === 'POST'
        )
      ).toBe(true)
    )
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/users/follow',
      'POST',
      'access-token-a',
      { followingId: 'target-a', action: 'follow' },
      15_000,
      expect.objectContaining({
        expectedUserId: VIEWER_A,
        expectedSessionGeneration: 1,
        signal: expect.any(AbortSignal),
      })
    )

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    view.rerender(<UserFollowButton targetUserId="target-b" currentUserId={VIEWER_B} />)
    expect(await screen.findByRole('button', { name: 'followUser' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    await act(async () => {
      oldMutation.resolve(
        response({
          success: true,
          following: true,
          followedBy: false,
          mutual: false,
        })
      )
      await oldMutation.promise
    })

    expect(screen.getByRole('button', { name: 'followUser' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(mockAuthedFetch.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(1)
    expect(mockBroadcast).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalledWith('followSuccess', 'success')
  })

  it('loads the relationship after a pending auth session becomes canonical', async () => {
    mockAuth = {
      accessToken: null,
      authChecked: false,
      email: null,
      loading: true,
      sessionGeneration: 0,
      userId: null,
      viewerKey: 'anon',
    }
    mockAuthedFetch.mockResolvedValue(
      response({ following: true, followedBy: false, mutual: false })
    )

    const view = render(<UserFollowButton targetUserId="target-user" currentUserId={VIEWER_A} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'followUser' })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    )
    expect(mockAuthedFetch).not.toHaveBeenCalled()

    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
    view.rerender(<UserFollowButton targetUserId="target-user" currentUserId={VIEWER_A} />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'unfollowUser' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/users/follow?followingId=target-user',
      'GET',
      'access-token-a',
      undefined,
      15_000,
      expect.objectContaining({
        expectedSessionGeneration: 1,
        expectedUserId: VIEWER_A,
        signal: expect.any(AbortSignal),
      })
    )
  })
})
