jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private body: unknown
    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
    async json() {
      return this.body
    }
  }
  class MockNextRequest {
    private body: unknown
    constructor(_url: string, init?: { body?: string }) {
      this.body = init?.body ? JSON.parse(init.body) : null
    }
    async json() {
      return this.body
    }
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockCreatePortalSession = jest.fn()
const mockProfile = jest.fn()
const mockSubscription = jest.fn()

jest.mock('@/lib/stripe', () => ({
  createPortalSession: (...args: unknown[]) => mockCreatePortalSession(...args),
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => (table === 'user_profiles' ? mockProfile() : mockSubscription()),
        }),
      }),
    }),
  }),
}))
jest.mock('@/lib/auth/extract-user', () => ({
  extractUserFromRequest: jest.fn().mockResolvedValue({ user: { id: 'user-1' }, error: null }),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {} },
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/lib/env', () => ({
  env: { STRIPE_SECRET_KEY: 'sk_test', NEXT_PUBLIC_APP_URL: 'https://app.test' },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/stripe/portal', {
    body: JSON.stringify(body),
  } as never)
}

const RETURN_URL = 'https://app.test/user-center?tab=membership'

describe('POST /api/stripe/portal', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockProfile.mockResolvedValue({ data: { stripe_customer_id: 'cus_1' }, error: null })
    mockSubscription.mockResolvedValue({
      data: { stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1' },
      error: null,
    })
    mockCreatePortalSession.mockResolvedValue({ url: 'https://billing.stripe.test/s' })
  })

  it('opens the portal home when no flow is requested', async () => {
    const res = await POST(request({ returnUrl: RETURN_URL }))
    expect(res.status).toBe(200)
    expect(mockCreatePortalSession).toHaveBeenCalledWith('cus_1', RETURN_URL, undefined)
  })

  it('deep-links the payment method flow', async () => {
    await POST(request({ returnUrl: RETURN_URL, flow_data: { type: 'payment_method_update' } }))
    expect(mockCreatePortalSession).toHaveBeenCalledWith('cus_1', RETURN_URL, {
      type: 'payment_method_update',
    })
  })

  it.each([
    ['subscription_update', { subscription_update: { subscription: 'sub_1' } }],
    ['subscription_cancel', { subscription_cancel: { subscription: 'sub_1' } }],
  ])('deep-links %s with the user’s own subscription', async (type, extra) => {
    await POST(request({ returnUrl: RETURN_URL, flow_data: { type } }))
    expect(mockCreatePortalSession).toHaveBeenCalledWith('cus_1', RETURN_URL, { type, ...extra })
  })

  it('ignores unknown flow types', async () => {
    await POST(request({ returnUrl: RETURN_URL, flow_data: { type: 'anything_else' } }))
    expect(mockCreatePortalSession).toHaveBeenCalledWith('cus_1', RETURN_URL, undefined)
  })

  it('does not deep-link a subscription that belongs to another customer', async () => {
    mockSubscription.mockResolvedValue({
      data: { stripe_subscription_id: 'sub_x', stripe_customer_id: 'cus_other' },
      error: null,
    })
    await POST(request({ returnUrl: RETURN_URL, flow_data: { type: 'subscription_cancel' } }))
    expect(mockCreatePortalSession).toHaveBeenCalledWith('cus_1', RETURN_URL, undefined)
  })

  it('falls back to the portal home when Stripe rejects the flow', async () => {
    mockCreatePortalSession
      .mockRejectedValueOnce(new Error('subscription_update is not enabled'))
      .mockResolvedValueOnce({ url: 'https://billing.stripe.test/home' })
    const res = await POST(
      request({ returnUrl: RETURN_URL, flow_data: { type: 'subscription_update' } })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.test/home' })
    expect(mockCreatePortalSession).toHaveBeenLastCalledWith('cus_1', RETURN_URL)
  })

  it('returns 500 instead of a pricing redirect when the profile lookup fails', async () => {
    mockProfile.mockResolvedValue({ data: null, error: { message: 'db down' } })
    const res = await POST(request({ returnUrl: RETURN_URL }))
    expect(res.status).toBe(500)
    expect(mockCreatePortalSession).not.toHaveBeenCalled()
  })

  it('redirects to pricing only when the user truly has no customer', async () => {
    mockProfile.mockResolvedValue({ data: { stripe_customer_id: null }, error: null })
    const res = await POST(request({ returnUrl: RETURN_URL }))
    expect(await res.json()).toEqual({ redirect: '/pricing' })
  })

  it('drops an off-origin return URL', async () => {
    await POST(request({ returnUrl: 'https://evil.test/x' }))
    expect(mockCreatePortalSession).toHaveBeenCalledWith(
      'cus_1',
      'https://app.test/settings',
      undefined
    )
  })
})
