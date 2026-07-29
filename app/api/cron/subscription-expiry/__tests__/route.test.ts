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
  sendNotification: jest.fn().mockResolvedValue(undefined),
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
})
