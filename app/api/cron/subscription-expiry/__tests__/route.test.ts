/**
 * @jest-environment node
 */

jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_target, key) {
        return process.env[String(key)]
      },
    }
  ),
}))

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockStripeRetrieve = jest.fn()
const mockSendRateLimitedAlert = jest.fn()
const mockSendNotification = jest.fn()
const mockSupabaseClient = { from: mockFrom, rpc: mockRpc }

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}))

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

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_jobName: string, handler: Function) => async (request: unknown) => {
    const secret = process.env.CRON_SECRET
    const authHeader = (
      request as { headers: { get: (key: string) => string | null } }
    ).headers.get('authorization')
    const { NextResponse } = require('next/server')
    if (!secret || authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    try {
      const result = await handler(request, {
        plog: {
          success: jest.fn(),
          error: jest.fn(),
          timeout: jest.fn(),
          partialSuccess: jest.fn(),
          id: 1,
        },
        supabase: mockSupabaseClient,
      })
      return NextResponse.json({ ok: true, ...result })
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      )
    }
  },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: (...args: unknown[]) => mockSendRateLimitedAlert(...args),
  sendAlert: jest.fn().mockResolvedValue({ sent: false, channels: [] }),
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/subscription-expiry', { headers })
}

function chainable(result: { data?: unknown; error?: unknown; count?: number | null }) {
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

function queueDatabaseResults(
  ...results: Array<{ data?: unknown; error?: unknown; count?: number | null }>
) {
  const queue = [...results]
  mockFrom.mockImplementation(() => {
    const result = queue.shift()
    if (!result) throw new Error('Unexpected database query')
    return chainable(result)
  })
}

function projectionPage(processedCount = 0, authorityCount = 0) {
  return {
    status: 'reconciled',
    processed_count: processedCount,
    authority_count: authorityCount,
    next_cursor: null,
    has_more: false,
  }
}

describe('GET /api/cron/subscription-expiry', () => {
  const cronSecret = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = cronSecret
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockImplementation(() => chainable({ data: [], error: null, count: 0 }))
    mockRpc.mockResolvedValue({ data: projectionPage(), error: null })
    mockSendRateLimitedAlert.mockResolvedValue({ sent: false, rateLimited: false, channels: [] })
    mockSendNotification.mockResolvedValue(undefined)
  })

  it('returns 401 when CRON_SECRET is missing', async () => {
    const response = await GET(createCronRequest())
    expect(response.status).toBe(401)
  })

  it('returns 401 when the secret does not match', async () => {
    const response = await GET(createCronRequest('wrong'))
    expect(response.status).toBe(401)
  })

  it('reconciles zero due projections without touching Stripe', async () => {
    const response = await GET(createCronRequest(cronSecret))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      count: 0,
      expiringReminders: 0,
      downgraded: 0,
      repaired: 0,
      projectionReconciled: 0,
      errors: [],
    })
    expect(mockStripeRetrieve).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith('reconcile_due_pro_entitlement_projections_atomic', {
      p_limit: 500,
      p_after_user_id: null,
    })
  })

  it('reports the number of projections repaired by the atomic ledger writer', async () => {
    mockRpc.mockResolvedValueOnce({ data: projectionPage(4, 3), error: null })

    const response = await GET(createCronRequest(cronSecret))
    const body = await response.json()

    expect(body).toMatchObject({ count: 4, projectionReconciled: 4 })
  })

  it('sends a reminder only after Stripe confirms the exact active expiring product', async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60
    queueDatabaseResults(
      {
        data: [
          {
            user_id: 'user1',
            stripe_subscription_id: 'sub_1',
            stripe_customer_id: 'cus_1',
            current_period_end: new Date(periodEnd * 1000).toISOString(),
            plan: 'monthly',
            cancel_at_period_end: true,
          },
        ],
        error: null,
      },
      { data: [], error: null }
    )
    mockStripeRetrieve.mockResolvedValue({
      id: 'sub_1',
      status: 'active',
      customer: 'cus_1',
      cancel_at_period_end: true,
      items: {
        data: [{ current_period_end: periodEnd, price: { id: 'price_monthly' } }],
      },
    })

    const response = await GET(createCronRequest(cronSecret))
    const body = await response.json()

    expect(body.expiringReminders).toBe(1)
    expect(mockSendNotification).toHaveBeenCalledWith(
      mockSupabaseClient,
      expect.objectContaining({
        user_id: 'user1',
        type: 'subscription_expiring',
        reference_id: 'sub_expiring_user1',
      }),
      'subscription-expiry'
    )
  })

  it('preserves access and records an error when Stripe reminder verification fails', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            user_id: 'user1',
            stripe_subscription_id: 'sub_1',
            stripe_customer_id: 'cus_1',
            current_period_end: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            plan: 'monthly',
            cancel_at_period_end: true,
          },
        ],
        error: null,
      },
      { data: [], error: null }
    )
    mockStripeRetrieve.mockRejectedValue(new Error('Stripe unavailable'))

    const response = await GET(createCronRequest(cronSecret))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ downgraded: 0, projectionReconciled: 0 })
    expect(body.errors).toEqual(['Stripe expiry-reminder verification failed for user1'])
    expect(mockSendRateLimitedAlert).toHaveBeenCalled()
  })

  it('returns 500 when the database query throws', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('Connection lost')
    })

    const response = await GET(createCronRequest(cronSecret))
    expect(response.status).toBe(500)
  })

  it('returns 500 and alerts when atomic projection reconciliation fails', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'projection ledger unavailable' },
    })

    const response = await GET(createCronRequest(cronSecret))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('projection ledger unavailable')
    expect(mockSendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({ title: '订阅过期投影修复失败' }),
      'subscription-expiry:projection-authority'
    )
  })
})
