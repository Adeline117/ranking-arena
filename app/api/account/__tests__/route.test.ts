/** @jest-environment node */

const mockFrom = jest.fn()
let mockProfileResult: { data: Record<string, unknown> | null; error: unknown }
let mockSubscriptionResult: { data: Record<string, unknown> | null; error: unknown }

const USER_ID = '11111111-1111-4111-8111-111111111111'

function builder(result: () => unknown) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    in: jest.fn(),
    order: jest.fn(),
    limit: jest.fn(),
    maybeSingle: jest.fn(async () => result()),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  query.in.mockReturnValue(query)
  query.order.mockReturnValue(query)
  query.limit.mockReturnValue(query)
  return query
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) =>
    async (): Promise<unknown> =>
      handler({
        user: { id: USER_ID, email: 'owner@example.test' },
        supabase: { from: (...args: unknown[]) => mockFrom(...args) },
      }),
}))

import { GET } from '../route'

describe('GET /api/account', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockProfileResult = {
      data: {
        id: USER_ID,
        handle: 'owner',
        avatar_url: null,
        bio: null,
        created_at: '2026-07-01T00:00:00.000Z',
      },
      error: null,
    }
    mockSubscriptionResult = {
      data: {
        user_id: USER_ID,
        tier: 'pro',
        status: 'active',
        current_period_end: '2026-08-01T00:00:00.000Z',
      },
      error: null,
    }
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return builder(() => mockProfileResult)
      if (table === 'subscriptions') return builder(() => mockSubscriptionResult)
      throw new Error(`Unexpected table: ${table}`)
    })
  })

  it('returns an exact active entitlement without cache reuse', async () => {
    const response = (await GET({} as never)) as Response
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body.data.user).toMatchObject({
      id: USER_ID,
      subscription: {
        tier: 'pro',
        expires_at: '2026-08-01T00:00:00.000Z',
      },
    })
  })

  it('returns free only after proving there is no active subscription row', async () => {
    mockSubscriptionResult = { data: null, error: null }

    const response = (await GET({} as never)) as Response
    const body = await response.json()

    expect(body.data.user.subscription).toEqual({ tier: 'free', expires_at: null })
  })

  it.each([
    ['profile read', () => (mockProfileResult = { data: null, error: { message: 'offline' } })],
    [
      'subscription read',
      () => (mockSubscriptionResult = { data: null, error: { message: 'offline' } }),
    ],
    [
      'mismatched subscription owner',
      () => {
        mockSubscriptionResult.data = {
          ...mockSubscriptionResult.data,
          user_id: '22222222-2222-4222-8222-222222222222',
        }
      },
    ],
    [
      'invalid subscription deadline',
      () => {
        mockSubscriptionResult.data = {
          ...mockSubscriptionResult.data,
          current_period_end: 'not-a-date',
        }
      },
    ],
  ])('fails closed on %s instead of fabricating a free account', async (_label, arrange) => {
    arrange()
    await expect(GET({} as never)).rejects.toThrow()
  })
})
