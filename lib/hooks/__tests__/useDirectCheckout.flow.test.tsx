import { act, renderHook } from '@testing-library/react'

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

let assignedHref: string | null = null
jest.mock('@/lib/utils/redirect', () => ({
  redirectTo: (url: string) => {
    assignedHref = url
  },
}))

import { useDirectCheckout } from '../useDirectCheckout'

const originalFetch = global.fetch

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

describe('useDirectCheckout checkout flow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetValidToken.mockResolvedValue('access-token')
    assignedHref = null
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('creates a session with auth + CSRF headers and redirects to the returned Stripe URL', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ url: 'https://checkout.stripe.com/c/pay/cs_test' }))
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'yearly', trial: true })
    })

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/stripe/create-checkout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          'x-csrf-token': 'csrf-token',
        }),
        body: JSON.stringify({ plan: 'yearly', trial: true }),
      })
    )
    expect(assignedHref).toBe('https://checkout.stripe.com/c/pay/cs_test')
    expect(hook.result.current.error).toBeNull()
  })

  it('never sends a trial flag for lifetime', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ url: 'https://checkout.stripe.com/x' }))
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'lifetime', trial: true } as never)
    })

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)
    expect(body.trial).toBeUndefined()
  })

  it('sends an existing subscriber to membership instead of a second checkout', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ code: 'ALREADY_SUBSCRIBED', error: 'exists' }, 409))
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })

    expect(mockPush).toHaveBeenCalledWith('/user-center?tab=membership')
    expect(hook.result.current.alreadySubscribed).toBe(true)
    expect(assignedHref).toBeNull()
  })

  it('surfaces the server error message and does not redirect', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'Payments are not configured' }, 503))
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })

    expect(hook.result.current.error).toBe('Payments are not configured')
    expect(hook.result.current.isLoading).toBe(false)
    expect(assignedHref).toBeNull()
  })

  it('reports an error when a 2xx response carries no checkout URL', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({}))
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })

    expect(hook.result.current.error).toBe('Checkout failed')
    expect(assignedHref).toBeNull()
  })

  it('reports a network error when the request throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      await hook.result.current.checkout({ plan: 'monthly' })
    })

    expect(hook.result.current.error).toBe('Network error. Please try again.')
    expect(hook.result.current.isLoading).toBe(false)
  })

  it('creates only one session on a rapid double click', async () => {
    let resolveFetch!: (value: unknown) => void
    global.fetch = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    )
    const hook = renderHook(() => useDirectCheckout())

    await act(async () => {
      const first = hook.result.current.checkout({ plan: 'monthly' })
      const second = hook.result.current.checkout({ plan: 'monthly' })
      await Promise.resolve()
      await Promise.resolve()
      resolveFetch(jsonResponse({ url: 'https://checkout.stripe.com/once' }))
      await Promise.all([first, second])
    })

    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})
