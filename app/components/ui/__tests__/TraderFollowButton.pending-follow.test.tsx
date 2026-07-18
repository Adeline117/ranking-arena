import { render, screen, waitFor } from '@testing-library/react'

const mockBroadcast = jest.fn()
const mockOn = jest.fn(() => jest.fn())
const mockShowToast = jest.fn()
const mockGetAuthHeadersAsync = jest.fn().mockResolvedValue({
  Authorization: 'Bearer access-token',
})
jest.mock('@/lib/hooks/useBroadcastSync', () => ({
  useFollowSync: () => ({
    broadcast: mockBroadcast,
    on: mockOn,
  }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    getAuthHeadersAsync: mockGetAuthHeadersAsync,
  }),
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

jest.mock('@/lib/hooks/useLoginModal', () => ({
  useLoginModal: {
    getState: () => ({ openLoginModal: jest.fn() }),
  },
}))

jest.mock('@/lib/analytics/track', () => ({
  trackEvent: jest.fn(),
}))

jest.mock('@/lib/utils/haptics', () => ({
  haptic: jest.fn(),
}))

import TraderFollowButton from '../TraderFollowButton'

const originalFetch = global.fetch

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

function queuePendingFollow() {
  sessionStorage.setItem(
    'pendingFollow',
    JSON.stringify({ traderId: 'trader-1', source: 'binance', action: 'follow' })
  )
}

function renderLoggedInButton() {
  return render(<TraderFollowButton traderId="trader-1" source="binance" userId="user-1" />)
}

describe('TraderFollowButton legacy pending-login follow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sessionStorage.clear()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('clears a stale legacy record without executing its mutation', async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ following: false }))
    queuePendingFollow()

    renderLoggedInButton()

    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(mockBroadcast).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('pendingFollow')).toBeNull()
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/follow?traderId=trader-1&source=binance',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(screen.getByRole('button', { name: 'followTrader' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })
})
