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
        body: expect.any(String),
      })
    )
    const requestBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body as string
    ) as Record<string, unknown>
    expect(requestBody).toEqual(
      expect.objectContaining({
        plan: 'yearly',
        trial: true,
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
      })
    )
    expect(mockPush).toHaveBeenCalledWith(
      '/login?returnUrl=%2Fpricing%3Fplan%3Dtrial%26billing%3Dyearly'
    )
  })

  it('reuses one durable recurring operation across technical retries', async () => {
    mockGetValidToken.mockResolvedValue('valid-access-token')
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Temporarily unavailable' }),
    })
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })
    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })

    const bodies = (global.fetch as jest.Mock).mock.calls.map(([, init]) =>
      JSON.parse(init.body as string)
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[0].operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(bodies[1].operationId).toBe(bodies[0].operationId)
  })

  it('does not reuse a recurring operation after the authenticated principal changes', async () => {
    const jwt = (subject: string) =>
      `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature`
    mockGetValidToken
      .mockResolvedValueOnce(jwt('11111111-1111-4111-8111-111111111111'))
      .mockResolvedValueOnce(jwt('22222222-2222-4222-8222-222222222222'))
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Temporarily unavailable' }),
    })
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })
    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })

    const bodies = (global.fetch as jest.Mock).mock.calls.map(([, init]) =>
      JSON.parse(init.body as string)
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[1].operationId).not.toBe(bodies[0].operationId)
  })
})
