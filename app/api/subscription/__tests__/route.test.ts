/** @jest-environment node */

type QueryResult = {
  data: Record<string, unknown> | null
  error: Record<string, unknown> | null
  count?: number | null
}

const USER_ID = '11111111-1111-4111-8111-111111111111'
let subscriptionResult: QueryResult
let followsResult: QueryResult
let profileResult: QueryResult
const mockFrom = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Headers()

    constructor(
      private readonly body: unknown,
      init: { status?: number } = {}
    ) {
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: USER_ID },
        supabase: { from: mockFrom },
        request,
      }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  }),
}))

import { GET } from '../route'

function subscriptionQuery() {
  return {
    select: jest.fn(() => ({
      eq: jest.fn(() => ({
        in: jest.fn(() => ({
          maybeSingle: jest.fn().mockImplementation(async () => subscriptionResult),
        })),
      })),
    })),
  }
}

function followsQuery() {
  return {
    select: jest.fn(() => ({
      eq: jest.fn().mockImplementation(async () => followsResult),
    })),
  }
}

function profileQuery() {
  return {
    select: jest.fn(() => ({
      eq: jest.fn(() => ({
        maybeSingle: jest.fn().mockImplementation(async () => profileResult),
      })),
    })),
  }
}

async function callRoute() {
  return GET({} as never)
}

describe('GET /api/subscription authoritative reads', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    subscriptionResult = { data: null, error: null }
    followsResult = { data: null, error: null, count: 4 }
    profileResult = { data: { subscription_tier: 'free' }, error: null }
    mockFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') return subscriptionQuery()
      if (table === 'trader_follows') return followsQuery()
      if (table === 'user_profiles') return profileQuery()
      throw new Error(`Unexpected table: ${table}`)
    })
  })

  it('returns the exact active subscription and usage with a private tier hint', async () => {
    subscriptionResult = {
      data: {
        user_id: USER_ID,
        tier: 'pro',
        status: 'active',
        plan: 'monthly',
        created_at: '2026-07-01T00:00:00.000Z',
        current_period_start: '2026-07-01T00:00:00.000Z',
        current_period_end: '2026-08-01T00:00:00.000Z',
        cancel_at_period_end: false,
        stripe_subscription_id: 'sub_exact',
        api_calls_today: 3,
        comparison_reports_this_month: 2,
        exports_this_month: 1,
      },
      error: null,
    }

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.subscription).toMatchObject({
      tier: 'pro',
      plan: 'monthly',
      usage: { currentFollows: 4 },
    })
    expect(response.headers.get('Set-Cookie')).toContain('arena_tier=pro')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockFrom).not.toHaveBeenCalledWith('user_profiles')
  })

  it.each([
    [
      'subscription query error',
      () => {
        subscriptionResult = { data: null, error: { message: 'subscription read failed' } }
      },
    ],
    [
      'follow count query error',
      () => {
        followsResult = { data: null, error: { message: 'count failed' }, count: null }
      },
    ],
    [
      'missing exact follow count',
      () => {
        followsResult = { data: null, error: null, count: null }
      },
    ],
    [
      'profile fallback query error',
      () => {
        profileResult = { data: null, error: { message: 'profile read failed' } }
      },
    ],
  ])('returns 503 without poisoning the tier cookie on a %s', async (_label, arrange) => {
    arrange()

    const response = await callRoute()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'Subscription status is temporarily unavailable. Please retry.',
      code: 'SUBSCRIPTION_STATUS_UNAVAILABLE',
    })
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('preserves an authoritative profile Pro fallback in both body and cookie', async () => {
    profileResult = { data: { subscription_tier: 'pro' }, error: null }

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.subscription).toMatchObject({
      userId: USER_ID,
      tier: 'pro',
      status: 'active',
      usage: { currentFollows: 4 },
    })
    expect(response.headers.get('Set-Cookie')).toContain('arena_tier=pro')
  })

  it('normalizes a legacy active elite row to the current Pro product tier', async () => {
    subscriptionResult = {
      data: {
        user_id: USER_ID,
        tier: 'elite',
        status: 'trialing',
        current_period_end: '2026-08-01T00:00:00.000Z',
      },
      error: null,
    }

    const response = await callRoute()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.subscription).toMatchObject({ tier: 'pro', status: 'trialing' })
    expect(response.headers.get('Set-Cookie')).toContain('arena_tier=pro')
  })

  it('fails closed on a malformed active subscription tier', async () => {
    subscriptionResult = {
      data: {
        user_id: USER_ID,
        tier: 'enterprise',
        status: 'active',
      },
      error: null,
    }

    const response = await callRoute()

    expect(response.status).toBe(503)
    expect(response.headers.get('Set-Cookie')).toBeNull()
  })
})
