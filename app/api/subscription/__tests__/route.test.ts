/** @jest-environment node */

const mockFrom = jest.fn()
const mockGetCanonicalSubscriptionTier = jest.fn()
let mockSubscriptionResult: { data: Record<string, unknown> | null; error: unknown }
let mockFollowsResult: { count: unknown; error: unknown }

const USER_ID = '11111111-1111-4111-8111-111111111111'

function subscriptionQuery() {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn(async () => mockSubscriptionResult),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.in.mockReturnValue(query)
  query.order.mockReturnValue(query)
  query.limit.mockReturnValue(query)
  return query
}

function followsQuery() {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    then: jest.fn(
      (
        resolve: (value: typeof mockFollowsResult) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(mockFollowsResult).then(resolve, reject)
    ),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function validSubscription(overrides: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID,
    tier: 'pro',
    status: 'active',
    plan: 'monthly',
    created_at: '2026-07-01T00:00:00.000Z',
    current_period_start: '2026-07-01T00:00:00.000Z',
    current_period_end: '2026-08-01T00:00:00.000Z',
    cancel_at_period_end: false,
    stripe_subscription_id: 'sub_exact123',
    api_calls_today: 4,
    comparison_reports_this_month: 2,
    exports_this_month: 1,
    ...overrides,
  }
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) =>
    async (): Promise<unknown> =>
      handler({
        user: { id: USER_ID },
        supabase: { from: (...args: unknown[]) => mockFrom(...args) },
      }),
}))
jest.mock('@/lib/premium/server-entitlement', () => ({
  getCanonicalSubscriptionTier: (...args: unknown[]) => mockGetCanonicalSubscriptionTier(...args),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
}))

import { GET } from '../route'

describe('GET /api/subscription exact entitlement read', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSubscriptionResult = { data: validSubscription(), error: null }
    mockFollowsResult = { count: 3, error: null }
    mockGetCanonicalSubscriptionTier.mockResolvedValue('pro')
    mockFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') return subscriptionQuery()
      if (table === 'trader_follows') return followsQuery()
      throw new Error(`Unexpected table: ${table}`)
    })
  })

  it('returns a strictly verified active subscription and exact usage', async () => {
    const response = (await GET({} as never)) as Response
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Set-Cookie')).toContain('arena_tier=pro')
    expect(body.subscription).toMatchObject({
      userId: USER_ID,
      tier: 'pro',
      status: 'active',
      plan: 'monthly',
      paymentMethod: 'stripe',
      usage: {
        apiCallsToday: 4,
        comparisonReportsThisMonth: 2,
        exportsThisMonth: 1,
        currentFollows: 3,
      },
    })
  })

  it('returns Free only after both the empty row and canonical authority agree', async () => {
    mockSubscriptionResult = { data: null, error: null }
    mockGetCanonicalSubscriptionTier.mockResolvedValue('free')

    const response = (await GET({} as never)) as Response
    const body = await response.json()

    expect(body.subscription.tier).toBe('free')
    expect(response.headers.get('Set-Cookie')).toContain('arena_tier=free')
  })

  it('preserves lifetime or admin Pro when canonical authority has no active row', async () => {
    mockSubscriptionResult = { data: null, error: null }

    const response = (await GET({} as never)) as Response
    const body = await response.json()

    expect(body.subscription).toMatchObject({
      userId: USER_ID,
      tier: 'pro',
      status: 'active',
      autoRenew: false,
    })
    expect(body.subscription).not.toHaveProperty('paymentMethod')
    expect(response.headers.get('Set-Cookie')).toContain('arena_tier=pro')
  })

  it.each([
    [
      'subscription query errors',
      () => {
        mockSubscriptionResult = { data: null, error: { message: 'offline' } }
      },
    ],
    [
      'follow count errors',
      () => {
        mockFollowsResult = { count: null, error: { message: 'offline' } }
      },
    ],
    [
      'canonical authority errors',
      () => mockGetCanonicalSubscriptionTier.mockRejectedValue(new Error('offline')),
    ],
  ])('fails closed when %s', async (_label, arrange) => {
    arrange()

    const response = (await GET({} as never)) as Response
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(body.error).toMatch(/verify subscription/i)
  })

  it.each([null, -1, 1.5, Number.NaN])(
    'rejects the invalid exact follow count %p',
    async (count) => {
      mockFollowsResult = { count, error: null }

      const response = (await GET({} as never)) as Response

      expect(response.status).toBe(503)
      expect(response.headers.get('Set-Cookie')).toBeNull()
    }
  )

  it.each([
    ['wrong owner', { user_id: '22222222-2222-4222-8222-222222222222' }],
    ['unknown tier', { tier: 'enterprise' }],
    ['unknown status', { status: 'past_due' }],
    ['invalid date', { current_period_end: 'not-a-date' }],
    ['negative usage', { api_calls_today: -1 }],
    ['fractional usage', { exports_this_month: 1.5 }],
    ['invalid renewal flag', { cancel_at_period_end: 'false' }],
    ['invalid Stripe identity', { stripe_subscription_id: 'cus_wrong' }],
    ['unexpected field', { unexpected: true }],
  ])('rejects a subscription row with %s', async (_label, overrides) => {
    mockSubscriptionResult = { data: validSubscription(overrides), error: null }

    const response = (await GET({} as never)) as Response

    expect(response.status).toBe(503)
    expect(response.headers.get('Set-Cookie')).toBeNull()
  })

  it('rejects a stale Pro projection when canonical authority says Free', async () => {
    mockGetCanonicalSubscriptionTier.mockResolvedValue('free')

    const response = (await GET({} as never)) as Response

    expect(response.status).toBe(503)
    expect(response.headers.get('Set-Cookie')).toBeNull()
  })

  it('normalizes a legacy elite row only when canonical authority confirms Pro', async () => {
    mockSubscriptionResult = { data: validSubscription({ tier: 'elite' }), error: null }

    const response = (await GET({} as never)) as Response
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.subscription.tier).toBe('pro')
  })
})
