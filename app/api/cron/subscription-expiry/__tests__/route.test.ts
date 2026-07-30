/**
 * @jest-environment node
 */

jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'CRON_SECRET') return process.env.CRON_SECRET
        return process.env[String(key)]
      },
    }
  ),
}))

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockSupabaseClient = { from: mockFrom, rpc: mockRpc }
const mockStripeRetrieve = jest.fn()
const mockSendRateLimitedAlert = jest.fn()
const mockDeliverNotification = jest.fn()
const mockClassifyActiveProSubscription = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: () => ({ subscriptions: { retrieve: mockStripeRetrieve } }),
  STRIPE_PRICE_IDS: {
    monthly: 'price_monthly',
    yearly: 'price_yearly',
    lifetime: 'price_lifetime',
  },
  STRIPE_API_PRICE_IDS: { starter: 'price_api_starter', pro: 'price_api_pro' },
}))

jest.mock('@/lib/stripe/reconciliation', () => ({
  classifyActiveProSubscription: (...args: unknown[]) => mockClassifyActiveProSubscription(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_jobName: string, handler: Function) => async (request: NextRequest) => {
    const secret = process.env.CRON_SECRET
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    try {
      const result = await handler(request, { supabase: mockSupabaseClient })
      return Response.json({ ok: true, ...result })
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      )
    }
  },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendRateLimitedAlert(...args),
}))

jest.mock('@/lib/data/notifications', () => ({
  deliverNotification: (...args: unknown[]) => mockDeliverNotification(...args),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost/api/cron/subscription-expiry', {
    headers,
  })
}

function chainable(result: { data: unknown; error: unknown }) {
  const handler = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (value: unknown) => void) => resolve(result)
          }
          return jest.fn().mockImplementation(handler)
        },
      }
    )
  return handler()
}

describe('GET /api/cron/subscription-expiry', () => {
  const cronSecret = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = cronSecret
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReturnValue(chainable({ data: [], error: null }))
    mockRpc.mockResolvedValue({
      data: {
        status: 'reconciled',
        processed_count: 4,
        authority_count: 2,
        next_cursor: '11111111-1111-4111-8111-111111111111',
        has_more: false,
      },
      error: null,
    })
    mockSendRateLimitedAlert.mockResolvedValue({
      sent: false,
      rateLimited: false,
      channels: [],
    })
    mockDeliverNotification.mockResolvedValue({
      outcome: 'CREATED',
      notificationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-07-29T12:00:00Z',
      created: true,
      deduplicated: false,
      skippedSelf: false,
    })
    mockClassifyActiveProSubscription.mockReturnValue({ kind: 'active', plan: 'monthly' })
  })

  it('rejects missing cron authority', async () => {
    await expect(GET(createCronRequest())).resolves.toMatchObject({ status: 401 })
  })

  it('reconciles expiry through the atomic projection and group authority', async () => {
    const response = await GET(createCronRequest(cronSecret))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      projectionReconciled: 4,
      downgraded: 0,
      repaired: 0,
    })
    expect(mockRpc).toHaveBeenCalledWith('reconcile_due_pro_entitlement_projections_atomic', {
      p_limit: 500,
      p_after_user_id: null,
    })
    expect(mockFrom.mock.calls.map(([table]) => table)).not.toContain('group_members')
  })

  it('fails closed and alerts when atomic projection authority is unavailable', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'projection database unavailable' },
    })

    const response = await GET(createCronRequest(cronSecret))

    expect(response.status).toBe(500)
    expect(mockSendRateLimitedAlert).toHaveBeenCalled()
  })

  it('waits for an atomically deduplicated expiry reminder without a preflight table race', async () => {
    const now = Date.now()
    const periodEnd = Math.floor((now + 5 * 24 * 60 * 60 * 1000) / 1000)
    mockFrom.mockImplementation((table: string) =>
      chainable({
        data:
          table === 'subscriptions'
            ? [
                {
                  user_id: '11111111-1111-4111-8111-111111111111',
                  stripe_subscription_id: 'sub_expiring',
                  stripe_customer_id: 'cus_exact',
                  current_period_end: new Date(periodEnd * 1000).toISOString(),
                  plan: 'monthly',
                  cancel_at_period_end: true,
                },
              ]
            : [],
        error: null,
      })
    )
    mockStripeRetrieve.mockResolvedValue({
      customer: 'cus_exact',
      cancel_at_period_end: true,
      items: { data: [{ current_period_end: periodEnd }] },
    })

    const response = await GET(createCronRequest(cronSecret))
    const responseBody = await response.json()

    expect(response.status).toBe(200)
    expect(responseBody.expiringReminders).toBe(1)
    expect(mockDeliverNotification).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        user_id: '11111111-1111-4111-8111-111111111111',
        type: 'subscription_expiring',
        reference_id: 'sub_expiring_11111111-1111-4111-8111-111111111111',
      }),
      { deduplicate: true, dedupWindowSeconds: 259200 }
    )
    expect(mockFrom.mock.calls.map(([table]) => table)).not.toContain('notifications')
  })

  it('does not count an atomic replay as a newly sent reminder', async () => {
    const now = Date.now()
    const periodEnd = Math.floor((now + 5 * 24 * 60 * 60 * 1000) / 1000)
    mockFrom.mockReturnValue(
      chainable({
        data: [
          {
            user_id: '11111111-1111-4111-8111-111111111111',
            stripe_subscription_id: 'sub_expiring',
            stripe_customer_id: 'cus_exact',
            current_period_end: new Date(periodEnd * 1000).toISOString(),
            plan: 'monthly',
            cancel_at_period_end: true,
          },
        ],
        error: null,
      })
    )
    mockStripeRetrieve.mockResolvedValue({
      customer: 'cus_exact',
      cancel_at_period_end: true,
      items: { data: [{ current_period_end: periodEnd }] },
    })
    mockDeliverNotification.mockResolvedValue({
      outcome: 'DEDUPLICATED',
      notificationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-07-29T12:00:00Z',
      created: false,
      deduplicated: true,
      skippedSelf: false,
    })

    const response = await GET(createCronRequest(cronSecret))
    const responseBody = await response.json()

    expect(response.status).toBe(200)
    expect(responseBody.expiringReminders).toBe(0)
  })

  it('surfaces a reminder delivery failure without skipping entitlement reconciliation', async () => {
    const now = Date.now()
    const periodEnd = Math.floor((now + 5 * 24 * 60 * 60 * 1000) / 1000)
    mockFrom.mockReturnValue(
      chainable({
        data: [
          {
            user_id: '11111111-1111-4111-8111-111111111111',
            stripe_subscription_id: 'sub_expiring',
            stripe_customer_id: 'cus_exact',
            current_period_end: new Date(periodEnd * 1000).toISOString(),
            plan: 'monthly',
            cancel_at_period_end: true,
          },
        ],
        error: null,
      })
    )
    mockStripeRetrieve.mockResolvedValue({
      customer: 'cus_exact',
      cancel_at_period_end: true,
      items: { data: [{ current_period_end: periodEnd }] },
    })
    mockDeliverNotification.mockRejectedValue(new Error('notification database unavailable'))

    const response = await GET(createCronRequest(cronSecret))
    const responseBody = await response.json()

    expect(response.status).toBe(200)
    expect(responseBody.expiringReminders).toBe(0)
    expect(responseBody.projectionReconciled).toBe(4)
    expect(responseBody.errors).toEqual([
      expect.stringContaining('notification database unavailable'),
    ])
    expect(mockSendRateLimitedAlert).toHaveBeenCalled()
  })
})
