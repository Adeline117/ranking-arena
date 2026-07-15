/** @jest-environment node */

const mockAssertProPriceReady = jest.fn()
const mockAssertApiPriceReady = jest.fn()
const mockWebhookList = jest.fn()
const mockSendAlert = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/stripe', () => ({
  assertProPriceReady: (...args: unknown[]) => mockAssertProPriceReady(...args),
  assertApiPriceReady: (...args: unknown[]) => mockAssertApiPriceReady(...args),
  getStripe: () => ({ webhookEndpoints: { list: mockWebhookList } }),
  STRIPE_PRICE_IDS: {
    monthly: 'price_monthly',
    yearly: 'price_yearly',
    lifetime: 'price_lifetime',
  },
  STRIPE_API_PRICE_IDS: { starter: 'price_api_starter', pro: 'price_api_pro' },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendAlert(...args),
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    const result = await handler(request, { supabase: { from: mockFrom } })
    return Response.json({ ok: true, ...result })
  },
}))

import { NextRequest } from 'next/server'
import { GET, REQUIRED_WEBHOOK_EVENTS } from '../route'

function chainable(result: { count: number | null; error: null | { message: string } }) {
  const handler = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(result)
          return jest.fn().mockImplementation(handler)
        },
      }
    )
  return handler()
}

function queueEventHealth(failed = 0, stale = 0) {
  const results = [
    { count: failed, error: null },
    { count: stale, error: null },
  ]
  mockFrom.mockImplementation(() => chainable(results.shift()!))
}

describe('GET /api/cron/stripe-readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_test_example'
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_example'
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_example'
    delete process.env.NEXT_PUBLIC_PRO_FREE_PROMO
    mockAssertProPriceReady.mockResolvedValue(undefined)
    mockAssertApiPriceReady.mockResolvedValue(undefined)
    mockSendAlert.mockResolvedValue({ sent: false, rateLimited: false, channels: [] })
    mockWebhookList.mockResolvedValue({
      data: [
        {
          url: 'https://www.arenafi.org/api/stripe/webhook',
          status: 'enabled',
          enabled_events: [...REQUIRED_WEBHOOK_EVENTS],
        },
      ],
    })
    queueEventHealth()
  })

  it('reports a healthy sandbox while keeping the paid-launch owner gate closed', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cron/stripe-readiness'))
    const body = await response.json()

    expect(body).toMatchObject({
      healthy: true,
      paidLaunchReady: false,
      mode: 'test',
      promoEnabled: true,
    })
    expect(body.warnings).toHaveLength(2)
    expect(mockSendAlert).not.toHaveBeenCalled()
  })

  it('fails closed and alerts when the webhook event contract drifts', async () => {
    mockWebhookList.mockResolvedValue({
      data: [
        {
          url: 'https://www.arenafi.org/api/stripe/webhook',
          status: 'enabled',
          enabled_events: ['checkout.session.completed'],
        },
      ],
    })

    const response = await GET(new NextRequest('http://localhost/api/cron/stripe-readiness'))
    const body = await response.json()

    expect(body.healthy).toBe(false)
    expect(body.failures).toContain('Enabled Stripe webhook endpoint or event contract has drifted')
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
  })

  it('alerts when retryable webhook events remain failed', async () => {
    queueEventHealth(2, 0)

    const response = await GET(new NextRequest('http://localhost/api/cron/stripe-readiness'))
    const body = await response.json()

    expect(body.failures).toContain('2 Stripe webhook event(s) are failed')
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
  })

  it('requires live keys before the production paywall can be enabled', async () => {
    process.env.NEXT_PUBLIC_PRO_FREE_PROMO = 'false'

    const response = await GET(new NextRequest('http://localhost/api/cron/stripe-readiness'))
    const body = await response.json()

    expect(body.failures).toContain('Production paywall is enabled without live Stripe keys')
    expect(body.paidLaunchReady).toBe(false)
  })
})
