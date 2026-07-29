import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { profileUserTarget, queueProfileActionLogin } from '@/lib/auth/profile-action-login'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockBroadcast = jest.fn()
const mockOn = jest.fn(() => jest.fn())
const mockGetAuthHeadersAsync = jest.fn().mockResolvedValue({
  Authorization: 'Bearer access-token',
})

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
  useAuthSession: () => ({ getAuthHeadersAsync: mockGetAuthHeadersAsync }),
}))

jest.mock('@/lib/hooks/useBroadcastSync', () => ({
  useUserFollowSync: () => ({ broadcast: mockBroadcast, on: mockOn }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'X-CSRF-Token': 'csrf-token' }),
}))

jest.mock('@/lib/utils/haptics', () => ({ haptic: jest.fn() }))

import UserFollowButton from '../UserFollowButton'

const originalFetch = global.fetch

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

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
  })

  afterAll(() => {
    global.fetch = originalFetch
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
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ following: false, followedBy: false, mutual: false }))
      .mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401)) as typeof fetch

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
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ following: false, followedBy: false, mutual: false }))
      .mockResolvedValueOnce(
        response({ following: true, followedBy: false, mutual: false, success: true })
      ) as typeof fetch

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
    expect(global.fetch).toHaveBeenCalledTimes(2)
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
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ error: 'unavailable' }, 500))
      .mockResolvedValueOnce(
        response({ following: false, followedBy: false, mutual: false, success: true })
      ) as typeof fetch

    render(
      <UserFollowButton
        targetUserId="target-user"
        currentUserId="viewer-user"
        loginReturnPath="/u/alice"
      />
    )

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2))
    expect(global.fetch).toHaveBeenLastCalledWith(
      '/api/users/follow',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ followingId: 'target-user', action: 'unfollow' }),
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
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('does not apply a late status response to a replacement profile target', async () => {
    const firstStatus = deferred<Response>()
    global.fetch = jest
      .fn()
      .mockReturnValueOnce(firstStatus.promise)
      .mockResolvedValueOnce(
        response({ following: true, followedBy: false, mutual: false })
      ) as typeof fetch

    const view = render(<UserFollowButton targetUserId="target-a" currentUserId="viewer-user" />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

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
    const oldMutation = deferred<Response>()
    global.fetch = jest.fn((url: string, options?: RequestInit) => {
      if (url === '/api/users/follow' && options?.method === 'POST') {
        return oldMutation.promise
      }
      return Promise.resolve(response({ following: false, followedBy: false, mutual: false }))
    }) as typeof fetch

    const view = render(<UserFollowButton targetUserId="target-a" currentUserId="viewer-user" />)
    fireEvent.click(await screen.findByRole('button', { name: 'followUser' }))
    await waitFor(() =>
      expect(
        (global.fetch as jest.Mock).mock.calls.some(
          (call) => call[0] === '/api/users/follow' && call[1]?.method === 'POST'
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
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ following: false, followedBy: false, mutual: false }))
      .mockResolvedValueOnce(
        response({
          success: true,
          following: 'yes',
          followedBy: false,
          mutual: false,
        })
      ) as typeof fetch

    render(<UserFollowButton targetUserId="target-user" currentUserId="viewer-user" />)
    fireEvent.click(await screen.findByRole('button', { name: 'followUser' }))

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('operationFailedRetry', 'error'))
    expect(screen.getByRole('button', { name: 'followUser' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(mockBroadcast).not.toHaveBeenCalled()
  })
})
