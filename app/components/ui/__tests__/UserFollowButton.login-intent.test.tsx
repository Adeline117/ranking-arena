import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      .mockResolvedValueOnce(response({ following: false, followedBy: false }))
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
      .mockResolvedValueOnce(response({ following: false, followedBy: false }))
      .mockResolvedValueOnce(
        response({ following: true, mutual: false, success: true })
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
})
