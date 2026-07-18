/** @jest-environment node */

const mockAssertProPriceReady = jest.fn()
const mockAssertApiPriceReady = jest.fn()
const mockWebhookList = jest.fn()
const mockSendAlert = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()

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
    const result = await handler(request, { supabase: { from: mockFrom, rpc: mockRpc } })
    return Response.json({ ok: true, ...result })
  },
}))

import { NextRequest } from 'next/server'
import { GET, REQUIRED_WEBHOOK_EVENTS, STRIPE_PAID_READINESS_KEYS } from '../route'

const readyEntitlementAuthority = {
  status: 'ready',
  open_manual_reviews: 0,
  unfinished_effects: 0,
  completed_effects_without_external_ref: 0,
  paid_unbound_payments: 0,
  unresolved_refund_tombstones: 0,
  reservation_anomalies: 0,
  projection_drift: 0,
  authority_drift: 0,
}

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
    mockRpc.mockResolvedValue({ data: readyEntitlementAuthority, error: null })
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
      entitlementReadiness: readyEntitlementAuthority,
    })
    expect(Object.keys(body.entitlementReadiness).sort()).toEqual(
      [...STRIPE_PAID_READINESS_KEYS].sort()
    )
    expect(mockRpc).toHaveBeenCalledWith('stripe_paid_launch_readiness_v2')
    expect(body.warnings).toHaveLength(2)
    expect(mockSendAlert).not.toHaveBeenCalled()
  })

  it('fails closed when an unresolved Charge refund tombstone blocks authority', async () => {
    mockRpc.mockResolvedValue({
      data: {
        ...readyEntitlementAuthority,
        status: 'blocked',
        unresolved_refund_tombstones: 1,
      },
      error: null,
    })

    const response = await GET(new NextRequest('http://localhost/api/cron/stripe-readiness'))
    const body = await response.json()

    expect(body.healthy).toBe(false)
    expect(body.paidLaunchReady).toBe(false)
    expect(body.failures).toContain(
      'Stripe entitlement authority is blocked: unresolved_refund_tombstones=1'
    )
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
  })

  it('rejects a readiness payload that omits the tombstone authority key', async () => {
    const { unresolved_refund_tombstones: _omitted, ...incompleteReadiness } =
      readyEntitlementAuthority
    mockRpc.mockResolvedValue({ data: incompleteReadiness, error: null })

    const response = await GET(new NextRequest('http://localhost/api/cron/stripe-readiness'))
    const body = await response.json()

    expect(body.healthy).toBe(false)
    expect(body.failures).toContain('Stripe entitlement authority readiness contract is invalid')
  })

  it('fails closed when the database authority readiness query fails', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'readiness unavailable' },
    })

    const response = await GET(new NextRequest('http://localhost/api/cron/stripe-readiness'))
    const body = await response.json()

    expect(body.healthy).toBe(false)
    expect(body.entitlementReadiness).toBeNull()
    expect(body.failures).toContain('Stripe entitlement authority readiness query failed')
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
