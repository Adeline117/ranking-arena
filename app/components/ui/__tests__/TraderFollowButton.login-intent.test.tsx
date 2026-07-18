import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { profileTraderTarget, queueProfileActionLogin } from '@/lib/auth/profile-action-login'

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

jest.mock('@/lib/hooks/useBroadcastSync', () => ({
  useFollowSync: () => ({ broadcast: mockBroadcast, on: mockOn }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ getAuthHeadersAsync: mockGetAuthHeadersAsync }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/lib/api/client', () => ({
  getCsrfHeaders: () => ({ 'X-CSRF-Token': 'csrf-token' }),
}))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))
jest.mock('@/lib/utils/haptics', () => ({ haptic: jest.fn() }))

import TraderFollowButton from '../TraderFollowButton'

const originalFetch = global.fetch

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

describe('TraderFollowButton login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/trader/alice?platform=binance&tab=stats')
  })

  afterAll(() => {
    global.fetch = originalFetch
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
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ following: false }))
      .mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401)) as typeof fetch

    render(
      <TraderFollowButton
        traderId="trader-1"
        source="binance"
        userId="viewer-1"
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
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ following: true }))
      .mockResolvedValueOnce(response({ error: 'Unauthorized' }, 401)) as typeof fetch

    render(
      <TraderFollowButton
        traderId="trader-1"
        source="binance"
        userId="viewer-1"
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
    global.fetch = jest
      .fn()
      .mockResolvedValue(response({ data: { following: true, success: true } })) as typeof fetch

    render(
      <TraderFollowButton
        traderId="trader-1"
        source="binance"
        userId="viewer-1"
        loginReturnPath="/trader/alice?platform=binance"
      />
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'unfollowTrader' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )
    expect(global.fetch).toHaveBeenCalledTimes(1)
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
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as typeof fetch

    render(
      <TraderFollowButton
        traderId="trader-1"
        source="binance"
        userId="viewer-1"
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
    jest.useRealTimers()
  })
})
