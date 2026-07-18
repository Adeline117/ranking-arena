import { act, renderHook } from '@testing-library/react'
import type { PricingCheckoutIntent } from '@/lib/premium/pricing-login-intent'

const mockPush = jest.fn()
const mockGetValidToken = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
  },
}))

jest.mock('@/lib/api/csrf', () => ({
  getCsrfHeaders: () => ({ 'x-csrf-token': 'csrf-token' }),
}))

import { useDirectCheckout } from '../useDirectCheckout'

const originalFetch = global.fetch

describe('useDirectCheckout login intent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it.each<[label: string, intent: PricingCheckoutIntent, expectedHref: string]>([
    [
      'monthly Pro',
      { plan: 'monthly' },
      '/login?returnUrl=%2Fpricing%3Fplan%3Dpro%26billing%3Dmonthly',
    ],
    [
      'yearly trial',
      { plan: 'yearly', trial: true },
      '/login?returnUrl=%2Fpricing%3Fplan%3Dtrial%26billing%3Dyearly',
    ],
    [
      'lifetime from the monthly view',
      { plan: 'lifetime', billing: 'monthly' },
      '/login?returnUrl=%2Fpricing%3Fplan%3Dlifetime%26billing%3Dmonthly',
    ],
  ])('preserves %s when no canonical token is available', async (_label, intent, expectedHref) => {
    mockGetValidToken.mockResolvedValue(null)
    global.fetch = jest.fn()
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout(intent)
    })

    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockPush).toHaveBeenCalledWith(expectedHref)
  })

  it('preserves trial and billing after the checkout API rejects an expired token', async () => {
    mockGetValidToken.mockResolvedValue('expired-access-token')
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    })
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'yearly', trial: true })
    })

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/stripe/create-checkout',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          plan: 'yearly',
          promotionCode: undefined,
          trial: true,
        }),
      })
    )
    expect(mockPush).toHaveBeenCalledWith(
      '/login?returnUrl=%2Fpricing%3Fplan%3Dtrial%26billing%3Dyearly'
    )
  })
})
