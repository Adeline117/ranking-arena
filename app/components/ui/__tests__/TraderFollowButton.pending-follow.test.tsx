import { render, screen, waitFor } from '@testing-library/react'

const mockBroadcast = jest.fn()
const mockOn = jest.fn(() => jest.fn())
const mockShowToast = jest.fn()
const mockGetAuthHeadersAsync = jest.fn().mockResolvedValue({
  Authorization: 'Bearer access-token',
})
const mockOnFollowChange = jest.fn()
const mockTrackEvent = jest.fn()

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
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
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
  return render(
    <TraderFollowButton
      traderId="trader-1"
      source="binance"
      userId="user-1"
      onFollowChange={mockOnFollowChange}
    />
  )
}

describe('TraderFollowButton pending-login follow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sessionStorage.clear()
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it('stays unfollowed and shows the API error when the resumed follow fails', async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ error: 'Follow unavailable' }, 500))
    queuePendingFollow()

    renderLoggedInButton()

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Follow unavailable', 'error'))

    expect(screen.getByRole('button', { name: 'followTrader' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(mockOnFollowChange).not.toHaveBeenCalledWith(true)
    expect(mockBroadcast).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('pendingFollow')).toBeNull()
  })

  it('shows Following only after the resumed follow is confirmed by the server', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(response({ data: { following: true, success: true } }))
    queuePendingFollow()

    renderLoggedInButton()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'unfollowTrader' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )

    expect(mockOnFollowChange).toHaveBeenCalledWith(true)
    expect(mockShowToast).toHaveBeenCalledWith('followSuccess', 'success')
    expect(mockBroadcast).toHaveBeenCalledWith('FOLLOW_CHANGED', {
      traderId: 'trader-1',
      source: 'binance',
      following: true,
      userId: 'user-1',
    })
  })
})
