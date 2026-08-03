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
      data: [
        {
          id: 'key-1',
          name: 'Primary',
          key: 'arena_sk_1234567890abcdef',
          tier: 'pro',
          active: true,
        },
      ],
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
    expect(JSON.stringify(body)).not.toContain('1234567890abcdef')
  })

  it('fails closed if either the keys or entitlement authority cannot be read', async () => {
    mockProfileResult = { data: null, error: { message: 'database unavailable' } }

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch API keys' })
  })
})
