jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers = new Headers()

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
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

let mockKeysResult: { data: Record<string, unknown>[] | null; error: unknown }
let mockProfileResult: { data: Record<string, unknown> | null; error: unknown }
const mockFrom = jest.fn((table: string) => {
  if (table === 'api_keys') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          order: jest.fn(async () => mockKeysResult),
        })),
      })),
    }
  }
  if (table === 'user_profiles') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn(async () => mockProfileResult),
        })),
      })),
    }
  }
  throw new Error(`Unexpected table ${table}`)
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: unknown) =>
    handler({
      user: { id: 'user-123' },
      supabase: { from: mockFrom },
      request,
    }),
}))

import { GET } from '../route'

const STORED_KEY = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: 'user-123',
  name: 'Primary',
  key: 'arena_sk_1234567890abcdef1234567890abcdef',
  tier: 'pro',
  daily_limit: 0,
  request_count_today: 2,
  active: true,
  last_used_at: null,
  created_at: '2026-07-29T00:00:00.000Z',
  revoked_at: null,
}

describe('GET /api/user/api-keys billing entitlement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockKeysResult = { data: [], error: null }
    mockProfileResult = {
      data: {
        api_tier: 'starter',
        api_stripe_subscription_id: 'sub_api_current',
      },
      error: null,
    }
  })

  it('returns profile authority even when the paid user has no active API key', async () => {
    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      data: [],
      entitlement: {
        tier: 'starter',
        hasStripeSubscription: true,
      },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('masks keys and never treats a malformed subscription identity as manageable', async () => {
    mockKeysResult = {
      data: [{ ...STORED_KEY }],
      error: null,
    }
    mockProfileResult = {
      data: {
        api_tier: 'pro',
        api_stripe_subscription_id: 'sub_',
      },
      error: null,
    }

    const response = await GET({} as never)
    const body = await response.json()

    expect(body.entitlement).toEqual({
      tier: 'pro',
      hasStripeSubscription: false,
    })
    expect(body.data[0].key).toBe('arena_s...cdef')
    expect(body.data[0]).not.toHaveProperty('user_id')
    expect(JSON.stringify(body)).not.toContain(STORED_KEY.key)
  })

  it.each([
    ['missing owner identity', { user_id: undefined }],
    ['different owner identity', { user_id: 'user-attacker' }],
    ['malformed secret', { key: null }],
    ['unknown tier', { tier: 'enterprise' }],
    ['tier and limit drift', { daily_limit: 100 }],
    ['negative usage', { request_count_today: -1 }],
    ['malformed creation time', { created_at: 'not-a-date' }],
  ])('withholds the whole list for a %s row', async (_label, drift) => {
    mockKeysResult = { data: [{ ...STORED_KEY, ...drift }], error: null }

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch API keys' })
  })

  it.each([
    ['missing result array', null],
    ['unknown profile tier', { api_tier: 'enterprise', api_stripe_subscription_id: null }],
    ['non-string subscription identity', { api_tier: 'pro', api_stripe_subscription_id: 123 }],
  ])('fails closed for %s', async (_label, value) => {
    if (value === null) mockKeysResult = { data: null, error: null }
    else mockProfileResult = { data: value, error: null }

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch API keys' })
  })

  it('fails closed if either the keys or entitlement authority cannot be read', async () => {
    mockProfileResult = { data: null, error: { message: 'database unavailable' } }

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch API keys' })
  })
})
