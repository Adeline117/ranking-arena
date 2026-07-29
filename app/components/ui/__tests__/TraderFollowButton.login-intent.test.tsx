import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { profileTraderTarget, queueProfileActionLogin } from '@/lib/auth/profile-action-login'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockBroadcast = jest.fn()
const mockOn = jest.fn(() => jest.fn())
const mockAuthedFetch = jest.fn()
const VIEWER_A = '11111111-1111-4111-8111-111111111111'
const VIEWER_B = '22222222-2222-4222-8222-222222222222'

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

jest.mock('@/lib/hooks/useBroadcastSync', () => ({
  useFollowSync: () => ({ broadcast: mockBroadcast, on: mockOn }),
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

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))
jest.mock('@/lib/utils/haptics', () => ({ haptic: jest.fn() }))

import TraderFollowButton from '../TraderFollowButton'

function response(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
  }
}

describe('TraderFollowButton login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/trader/alice?platform=binance&tab=stats')
    mockAuth = signedIn(VIEWER_A, 'access-token-a', 1)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('preserves the exact trader route for an anonymous follow', () => {
    render(
      <TraderFollowButton
        traderId="trader-1"
        source="binance"
        userId={null}
        loginReturnPath="/trader/alice?platform=binance"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'follow' }))

    expect(mockPush).toHaveBeenCalledWith(
      '/login?returnUrl=%2Ftrader%2Falice%3Fplatform%3Dbinance%26tab%3Dstats%26resumeAction%3Dfollow-trader'
    )
  })

  it('rolls back and re-authenticates an expired follow request', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(response({ success: true, data: { following: false } }))
      .mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401))

    render(
      <TraderFollowButton
        traderId="trader-1"
        source="binance"
        userId={VIEWER_A}
        loginReturnPath="/trader/alice?platform=binance"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'followTrader' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Ftrader%2Falice%3Fplatform%3Dbinance%26tab%3Dstats%26resumeAction%3Dfollow-trader'
      )
    )
    expect(mockShowToast).toHaveBeenCalledWith('loginExpiredPleaseRelogin', 'error')
    expect(screen.getByRole('button', { name: 'followTrader' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('retains an expired unfollow as an unfollow intent', async () => {
    mockAuthedFetch
      .mockResolvedValueOnce(response({ success: true, data: { following: true } }))
      .mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401))

    render(
      <TraderFollowButton
        traderId="trader-1"
        source="binance"
        userId={VIEWER_A}
        initialFollowing
        loginReturnPath="/trader/alice?platform=binance"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'unfollowTrader' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Ftrader%2Falice%3Fplatform%3Dbinance%26tab%3Dstats%26resumeAction%3Dunfollow-trader'
      )
    )
    expect(screen.getByRole('button', { name: 'unfollowTrader' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('resumes an exact pending trader follow without a competing status read', async () => {
    const href = queueProfileActionLogin({
      action: 'follow-trader',
      target: profileTraderTarget('binance', 'trader-1'),
      fallbackPath: '/trader/alice?platform=binance',
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    mockAuthedFetch.mockResolvedValue(response({ data: { following: true }, success: true }))

    render(
      <TraderFollowButton
        traderId="trader-1"
        source="binance"
        userId={VIEWER_A}
        loginReturnPath="/trader/alice?platform=binance"
      />
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'unfollowTrader' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/trader/alice?platform=binance&tab=stats'
    )
  })

  it('releases a resumed follow when the request exceeds its timeout', async () => {
    jest.useFakeTimers()
    const href = queueProfileActionLogin({
      action: 'follow-trader',
      target: profileTraderTarget('binance', 'trader-1'),
      fallbackPath: '/trader/alice?platform=binance',
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    mockAuthedFetch.mockImplementation(() => new Promise(() => {}))

    render(
      <TraderFollowButton
        traderId="trader-1"
        source="binance"
        userId={VIEWER_A}
        loginReturnPath="/trader/alice?platform=binance"
      />
    )

    await act(async () => {
      await Promise.resolve()
      jest.advanceTimersByTime(8_000)
      await Promise.resolve()
    })

    expect(mockShowToast).toHaveBeenCalledWith('timeoutRetry', 'warning')
    expect(screen.getByRole('button', { name: 'followTrader' })).toHaveAttribute(
      'aria-busy',
      'false'
    )
  })

  it('never replays an old trader follow as a newly selected account', async () => {
    let resolveMutation:
      | ((value: { data: Record<string, unknown>; ok: boolean; status: number }) => void)
      | undefined
    mockAuthedFetch.mockImplementation((_url: string, method: string) => {
      if (method === 'POST') {
        return new Promise((resolve) => {
          resolveMutation = resolve
        })
      }
      return Promise.resolve(response({ data: { following: false }, success: true }))
    })

    const { rerender } = render(
      <TraderFollowButton traderId="trader-1" source="binance" userId={VIEWER_A} />
    )
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'followTrader' }))

    await waitFor(() =>
      expect(mockAuthedFetch).toHaveBeenCalledWith(
        '/api/follow',
        'POST',
        'access-token-a',
        { action: 'follow', source: 'binance', traderId: 'trader-1' },
        15_000,
        expect.objectContaining({
          expectedSessionGeneration: 1,
          expectedUserId: VIEWER_A,
          signal: expect.any(AbortSignal),
        })
      )
    )

    mockAuth = signedIn(VIEWER_B, 'access-token-b', 2)
    rerender(<TraderFollowButton traderId="trader-1" source="binance" userId={VIEWER_B} />)
    resolveMutation?.({
      data: { data: { following: true }, success: true },
      ok: true,
      status: 200,
    })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'followTrader' })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
    )
    expect(mockBroadcast).not.toHaveBeenCalled()
    expect(mockShowToast).not.toHaveBeenCalledWith('followSuccess', 'success')
    expect(mockAuthedFetch.mock.calls.filter((call) => call[1] === 'POST')).toHaveLength(1)
  })
})
