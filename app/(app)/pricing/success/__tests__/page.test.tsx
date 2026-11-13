/**
 * Payment success page — the only user-visible confirmation that a paid
 * checkout turned into Pro. Covers: bare access, verify-session success,
 * webhook-race fallback (verify fails, polling finds Pro), and the honest
 * "unconfirmed" state when Pro never appears.
 */
import { render, screen, waitFor, act } from '@testing-library/react'

const mockReplace = jest.fn()
let mockSearch = new URLSearchParams('session_id=cs_test_1')
const mockShowToast = jest.fn()
const mockRefreshPremium = jest.fn().mockResolvedValue(undefined)
const mockGetAuthSession = jest.fn()
const mockRefreshAuthToken = jest.fn().mockResolvedValue(undefined)
const mockTrackEvent = jest.fn()
const mockSubMaybeSingle = jest.fn()
const mockProfileMaybeSingle = jest.fn()

jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearch,
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ language: 'en', t: (k: string) => k }),
}))
jest.mock('@/app/components/ui/Toast', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))
jest.mock('@/lib/premium/hooks', () => ({
  usePremium: () => ({ refresh: mockRefreshPremium }),
}))
jest.mock('@/app/components/home/hooks/useSubscription', () => ({
  clearSubscriptionCache: jest.fn(),
}))
jest.mock('@/lib/api/client', () => ({ getCsrfHeaders: () => ({}) }))
jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/analytics/track', () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}))
jest.mock('@/lib/auth', () => ({
  getAuthSession: () => mockGetAuthSession(),
  refreshAuthToken: () => mockRefreshAuthToken(),
}))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({
    authChecked: true,
    viewerKey: 'user-1',
    sessionGeneration: 1,
    userId: 'user-1',
    email: 'buyer@example.test',
  }),
}))
jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        maybeSingle: () =>
          table === 'subscriptions' ? mockSubMaybeSingle() : mockProfileMaybeSingle(),
      }
      return chain
    },
  },
}))

import PaymentSuccessPage from '../page'

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const fetchMock = jest.fn()

describe('PaymentSuccessPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearch = new URLSearchParams('session_id=cs_test_1')
    mockGetAuthSession.mockResolvedValue({ userId: 'user-1', accessToken: 'tok' })
    mockSubMaybeSingle.mockResolvedValue({ data: null })
    mockProfileMaybeSingle.mockResolvedValue({ data: null })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('sends bare visits (no session_id) back to pricing without claiming success', async () => {
    mockSearch = new URLSearchParams('')
    render(<PaymentSuccessPage />)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/pricing'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByText('paymentSuccess')).toBeNull()
  })

  it('shows success after verify-session confirms the checkout', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }))
    render(<PaymentSuccessPage />)

    expect(await screen.findByText('paymentSuccess')).toBeTruthy()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/stripe/verify-session')
    expect(JSON.parse(init.body)).toEqual({ sessionId: 'cs_test_1' })
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(mockRefreshPremium).toHaveBeenCalled()
    expect(mockShowToast).toHaveBeenCalledWith('membershipActivated', 'success')
    expect(mockTrackEvent).toHaveBeenCalledWith('pro_subscribe', { source: 'verify_api' })
  })

  describe('when verify-session fails', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    async function flushPolling() {
      for (let i = 0; i < 6; i++) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(2_000)
        })
      }
    }

    it('falls back to polling and shows success once the webhook granted Pro', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === '/api/stripe/verify-session'
          ? jsonResponse(500, { error: 'Unknown payment configuration' })
          : jsonResponse(200, { subscription: { tier: 'pro' } })
      )
      render(<PaymentSuccessPage />)
      await flushPolling()

      expect(screen.getByText('paymentSuccess')).toBeTruthy()
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/subscription',
        expect.objectContaining({ headers: { Authorization: 'Bearer tok' } })
      )
    })

    it('admits the payment is unconfirmed when Pro never appears', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === '/api/stripe/verify-session'
          ? jsonResponse(500, { error: 'boom' })
          : jsonResponse(200, { subscription: { tier: 'free' } })
      )
      render(<PaymentSuccessPage />)
      await flushPolling()

      expect(screen.getByText('paymentStatusUnconfirmed')).toBeTruthy()
      expect(screen.queryByText('paymentSuccess')).toBeNull()
      expect(mockShowToast).not.toHaveBeenCalledWith('membershipActivated', 'success')
    })
  })
})
