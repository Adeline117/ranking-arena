/**
 * Cron: subscription-expiry route tests
 * Tests auth, expiry checks, downgrade logic, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock @/lib/env so env.CRON_SECRET reads process.env.CRON_SECRET at call time
jest.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get(_t, key) {
        if (key === 'CRON_SECRET') return process.env.CRON_SECRET
        return process.env[String(key)]
      },
    }
  ),
}))

const mockFrom = jest.fn()
const mockSupabaseClient = { from: mockFrom }
const mockStripeRetrieve = jest.fn()
const mockStripeList = jest.fn()
const mockUpdateUserSubscription = jest.fn()
const mockCheckNFTMembership = jest.fn()

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    subscriptions: { retrieve: mockStripeRetrieve, list: mockStripeList },
  }),
  STRIPE_PRICE_IDS: {
    monthly: 'price_monthly',
    yearly: 'price_yearly',
    lifetime: 'price_lifetime',
  },
  STRIPE_API_PRICE_IDS: { starter: 'price_api_starter', pro: 'price_api_pro' },
}))

jest.mock('@/app/api/stripe/webhook/handlers/subscription', () => ({
  updateUserSubscription: (...args: unknown[]) => mockUpdateUserSubscription(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  apiLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  dataLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  },
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

jest.mock('@/lib/web3/nft', () => ({
  checkNFTMembership: (...args: unknown[]) => mockCheckNFTMembership(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    dbError: jest.fn(),
    apiError: jest.fn(),
  },
}))

// Mock withCron to pass through (auth handled by test's CRON_SECRET setup)
jest.mock('@/lib/api/with-cron', () => ({
  withCron: (jobName: string, handler: Function) => async (request: unknown) => {
    const secret = process.env.CRON_SECRET
    const authHeader = (request as { headers: { get: (k: string) => string | null } }).headers.get(
      'authorization'
    )
    if (!secret || authHeader !== `Bearer ${secret}`) {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const { getSupabaseAdmin } = require('@/lib/supabase/server')
    try {
      const result = await handler(request, {
        plog: {
          success: jest.fn(),
          error: jest.fn(),
          timeout: jest.fn(),
          partialSuccess: jest.fn(),
          id: 1,
        },
        supabase: getSupabaseAdmin(),
      })
      const { NextResponse } = require('next/server')
      return NextResponse.json({ ok: true, ...result })
    } catch (err: unknown) {
      const { NextResponse } = require('next/server')
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500 }
      )
    }
  },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendRateLimitedAlert: jest
    .fn()
    .mockResolvedValue({ sent: false, rateLimited: false, channels: [] }),
  sendAlert: jest.fn().mockResolvedValue({ sent: false, channels: [] }),
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn().mockResolvedValue({
      id: 1,
      success: jest.fn().mockResolvedValue(undefined),
      error: jest.fn().mockResolvedValue(undefined),
      timeout: jest.fn().mockResolvedValue(undefined),
    }),
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCronRequest(secret?: string): NextRequest {
  const headers = new Headers()
  if (secret) headers.set('authorization', `Bearer ${secret}`)
  return new NextRequest('http://localhost:3000/api/cron/subscription-expiry', { headers })
}

/** Build chainable mock */
function chainable(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const handler = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
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

function stripeSubscription(status: 'active' | 'canceled') {
  return {
    id: 'sub_1',
    status,
    customer: 'cus_1',
    start_date: 1_700_000_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_monthly' } }] },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/subscription-expiry', () => {
  const CRON_SECRET = 'test-secret'

  beforeAll(() => {
    process.env.CRON_SECRET = CRON_SECRET
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdateUserSubscription.mockResolvedValue(undefined)
    mockCheckNFTMembership.mockResolvedValue(false)
  })

  // ---- Auth ----------------------------------------------------------------

  it('returns 401 when CRON_SECRET is missing', async () => {
    const res = await GET(createCronRequest())
    expect(res.status).toBe(401)
  })

  it('returns 401 when secret does not match', async () => {
    const res = await GET(createCronRequest('wrong'))
    expect(res.status).toBe(401)
  })

  // ---- Successful execution with no expiring subscriptions -----------------

  it('runs successfully with no expiring subscriptions', async () => {
    mockFrom.mockImplementation(() => chainable({ data: [], error: null, count: 0 }))

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.expiringReminders).toBe(0)
    expect(body.downgraded).toBe(0)
  })

  // ---- Downgrade expired subscriptions -------------------------------------

  it('downgrades expired subscriptions', async () => {
    const expiredSubs = [
      {
        user_id: 'user1',
        stripe_subscription_id: 'sub_1',
        stripe_customer_id: 'cus_1',
        plan: 'monthly',
      },
    ]
    const ended = stripeSubscription('canceled')
    queueDatabaseResults(
      { data: [], error: null },
      { data: expiredSubs, error: null },
      {
        data: [{ id: 'user1', pro_plan: 'monthly', wallet_address: null }],
        error: null,
      },
      { data: [], error: null }
    )
    mockStripeList.mockResolvedValue({ data: [ended] })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.downgraded).toBe(1)
    expect(mockUpdateUserSubscription).toHaveBeenCalledWith('user1', ended, 'monthly')
  })

  it('repairs a stale local expiry when Stripe still says active', async () => {
    const expiredSubs = [
      {
        user_id: 'user1',
        stripe_subscription_id: 'sub_1',
        stripe_customer_id: 'cus_1',
        plan: 'monthly',
      },
    ]
    const active = stripeSubscription('active')
    queueDatabaseResults(
      { data: [], error: null },
      { data: expiredSubs, error: null },
      {
        data: [{ id: 'user1', pro_plan: 'monthly', wallet_address: null }],
        error: null,
      },
      { data: [], error: null }
    )
    mockStripeList.mockResolvedValue({ data: [active] })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(body).toMatchObject({ downgraded: 0, repaired: 1 })
    expect(mockUpdateUserSubscription).toHaveBeenCalledWith('user1', active, 'monthly')
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when database throws', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('Connection lost')
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
  })

  it('preserves access when Stripe expiration verification fails', async () => {
    queueDatabaseResults(
      { data: [], error: null },
      {
        data: [
          {
            user_id: 'user1',
            stripe_subscription_id: 'sub_1',
            stripe_customer_id: 'cus_1',
            plan: 'monthly',
          },
        ],
        error: null,
      },
      {
        data: [{ id: 'user1', pro_plan: 'monthly', wallet_address: null }],
        error: null,
      },
      { data: [], error: null }
    )
    mockStripeList.mockRejectedValue(new Error('Stripe unavailable'))

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.downgraded).toBe(0)
    expect(body.errors).toHaveLength(1)
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('does not treat an NFT badge as fallback authority for an ended Stripe subscription', async () => {
    const ended = stripeSubscription('canceled')
    queueDatabaseResults(
      { data: [], error: null },
      {
        data: [
          {
            user_id: 'user1',
            stripe_subscription_id: 'sub_1',
            stripe_customer_id: 'cus_1',
            plan: 'monthly',
          },
        ],
        error: null,
      },
      {
        data: [{ id: 'user1', pro_plan: 'monthly', wallet_address: '0x123' }],
        error: null,
      }
    )
    mockStripeList.mockResolvedValue({ data: [ended] })
    mockCheckNFTMembership.mockResolvedValue(true)

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(body.downgraded).toBe(1)
    expect(mockUpdateUserSubscription).toHaveBeenCalledWith('user1', ended, 'monthly')
    expect(mockCheckNFTMembership).not.toHaveBeenCalled()
  })
})
