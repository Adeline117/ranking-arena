import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { profileTraderTarget, queueProfileActionLogin } from '@/lib/auth/profile-action-login'

const mockPush = jest.fn()
const mockShowToast = jest.fn()
const mockAddToWatchlist = jest.fn()
const mockRemoveFromWatchlist = jest.fn()
let mockIsLoggedIn = false
let mockUserId: string | null = null
let mockWatched = false
let mockViewerKey = 'anon'
let mockSessionGeneration = 1

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    isLoggedIn: mockIsLoggedIn,
    userId: mockUserId,
    viewerKey: mockViewerKey,
    sessionGeneration: mockSessionGeneration,
    loading: false,
    authChecked: true,
  }),
}))

jest.mock('@/lib/hooks/useWatchlist', () => ({
  isWatchlistViewerChangedError: (error: unknown) =>
    error instanceof Error && error.name === 'WatchlistViewerChangedError',
  useWatchlist: () => ({
    isWatched: () => mockWatched,
    addToWatchlist: mockAddToWatchlist,
    removeFromWatchlist: mockRemoveFromWatchlist,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  }),
}))

jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

jest.mock('@/lib/analytics/track', () => ({ trackEvent: jest.fn() }))

import WatchlistToggleButton from '../WatchlistToggleButton'

function renderButton() {
  return render(
    <WatchlistToggleButton
      source="binance"
      sourceTraderID="trader-1"
      handle="alice"
      loginReturnPath="/trader/alice?platform=binance"
    />
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('WatchlistToggleButton login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsLoggedIn = false
    mockUserId = null
    mockWatched = false
    mockViewerKey = 'anon'
    mockSessionGeneration = 1
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/trader/alice?platform=binance&tab=portfolio')
  })

  it('preserves the exact trader route for an anonymous watch action', () => {
    renderButton()

    fireEvent.click(screen.getByRole('button', { name: 'addToWatchlist' }))

    expect(mockPush).toHaveBeenCalledWith(
      '/login?returnUrl=%2Ftrader%2Falice%3Fplatform%3Dbinance%26tab%3Dportfolio%26resumeAction%3Dwatch-trader'
    )
  })

  it('re-authenticates a 401 and retains the desired watch state', async () => {
    mockIsLoggedIn = true
    mockUserId = 'viewer-1'
    mockAddToWatchlist.mockRejectedValue(new Error('watchlist add: 401'))
    renderButton()

    fireEvent.click(screen.getByRole('button', { name: 'addToWatchlist' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Ftrader%2Falice%3Fplatform%3Dbinance%26tab%3Dportfolio%26resumeAction%3Dwatch-trader'
      )
    )
    expect(mockShowToast).toHaveBeenCalledWith('loginExpiredPleaseRelogin', 'error')
  })

  it('retains an expired removal as an unwatch intent', async () => {
    mockIsLoggedIn = true
    mockUserId = 'viewer-1'
    mockWatched = true
    mockRemoveFromWatchlist.mockRejectedValue(new Error('watchlist remove: 401'))
    renderButton()

    fireEvent.click(screen.getByRole('button', { name: 'removeFromWatchlist' }))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Ftrader%2Falice%3Fplatform%3Dbinance%26tab%3Dportfolio%26resumeAction%3Dunwatch-trader'
      )
    )
  })

  it('resumes a matching same-tab watch once after login', async () => {
    const href = queueProfileActionLogin({
      action: 'watch-trader',
      target: profileTraderTarget('binance', 'trader-1'),
      fallbackPath: '/trader/alice?platform=binance',
    })
    window.history.replaceState(
      {},
      '',
      new URL(href, 'https://arena.invalid').searchParams.get('returnUrl')!
    )
    mockIsLoggedIn = true
    mockUserId = 'viewer-1'
    mockAddToWatchlist.mockResolvedValue(undefined)

    renderButton()

    await waitFor(() =>
      expect(mockAddToWatchlist).toHaveBeenCalledWith('binance', 'trader-1', 'alice')
    )
    expect(mockAddToWatchlist).toHaveBeenCalledTimes(1)
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/trader/alice?platform=binance&tab=portfolio'
    )
  })

  it('lets B act while A is pending and never publishes A completion under B', async () => {
    const userA = deferred<void>()
    const userB = deferred<void>()
    mockIsLoggedIn = true
    mockUserId = 'user-a'
    mockViewerKey = 'user:user-a'
    mockAddToWatchlist.mockReturnValueOnce(userA.promise).mockReturnValueOnce(userB.promise)
    const view = renderButton()

    fireEvent.click(screen.getByRole('button', { name: 'addToWatchlist' }))
    expect(mockAddToWatchlist).toHaveBeenCalledTimes(1)

    mockUserId = 'user-b'
    mockViewerKey = 'user:user-b'
    mockSessionGeneration = 2
    view.rerender(
      <WatchlistToggleButton
        source="binance"
        sourceTraderID="trader-1"
        handle="alice"
        loginReturnPath="/trader/alice?platform=binance"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'addToWatchlist' }))
    expect(mockAddToWatchlist).toHaveBeenCalledTimes(2)

    await act(async () => userA.resolve())
    expect(mockShowToast).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'addToWatchlist' })).toHaveAttribute(
      'aria-busy',
      'true'
    )

    await act(async () => userB.resolve())
    expect(mockShowToast).toHaveBeenCalledTimes(1)
    expect(mockShowToast).toHaveBeenCalledWith('addedToWatchlist', 'success')
  })
})
