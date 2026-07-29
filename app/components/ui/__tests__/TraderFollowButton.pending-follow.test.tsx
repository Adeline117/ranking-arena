import { render, screen, waitFor } from '@testing-library/react'

const mockBroadcast = jest.fn()
const mockOn = jest.fn(() => jest.fn())
const mockShowToast = jest.fn()
const mockAuthedFetch = jest.fn()
const USER_ID = '11111111-1111-4111-8111-111111111111'
const mockAuth = {
  accessToken: 'access-token',
  authChecked: true,
  email: null,
  loading: false,
  sessionGeneration: 1,
  userId: USER_ID,
  viewerKey: `user:${USER_ID}` as const,
}
jest.mock('@/lib/hooks/useBroadcastSync', () => ({
  useFollowSync: () => ({
    broadcast: mockBroadcast,
    on: mockOn,
  }),
}))

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockAuth,
}))

jest.mock('@/app/(app)/settings/hooks/settings-viewer-scope', () => ({
  captureSettingsViewer: () => ({
    accessToken: mockAuth.accessToken,
    email: null,
    sessionGeneration: mockAuth.sessionGeneration,
    userId: mockAuth.userId,
    viewerKey: mockAuth.viewerKey,
  }),
  isSettingsViewerCurrent: (viewer: {
    sessionGeneration: number
    userId: string
    viewerKey: string
  }) =>
    viewer.userId === mockAuth.userId &&
    viewer.viewerKey === mockAuth.viewerKey &&
    viewer.sessionGeneration === mockAuth.sessionGeneration,
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

function response(data: unknown, status = 200) {
  return {
    data,
    ok: status >= 200 && status < 300,
    status,
  }
}

function queuePendingFollow() {
  sessionStorage.setItem(
    'pendingFollow',
    JSON.stringify({ traderId: 'trader-1', source: 'binance', action: 'follow' })
  )
}

function renderLoggedInButton() {
  return render(<TraderFollowButton traderId="trader-1" source="binance" userId={USER_ID} />)
}

describe('TraderFollowButton legacy pending-login follow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sessionStorage.clear()
  })

  it('clears a stale legacy record without executing its mutation', async () => {
    mockAuthedFetch.mockResolvedValue(response({ data: { following: false }, success: true }))
    queuePendingFollow()

    renderLoggedInButton()

    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalled())
    expect(mockBroadcast).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('pendingFollow')).toBeNull()
    expect(mockAuthedFetch).toHaveBeenCalledTimes(1)
    expect(mockAuthedFetch).toHaveBeenCalledWith(
      '/api/follow?traderId=trader-1&source=binance',
      'GET',
      'access-token',
      undefined,
      15_000,
      expect.objectContaining({
        expectedSessionGeneration: 1,
        expectedUserId: USER_ID,
        signal: expect.any(AbortSignal),
      })
    )
    expect(screen.getByRole('button', { name: 'followTrader' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })
})
