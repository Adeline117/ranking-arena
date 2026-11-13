/**
 * @jest-environment node
 */
type QueryResult = { data?: unknown; error?: { message: string } | null; count?: number | null }

const mockUser = { id: 'user-1' }
let subscriptionResult: QueryResult = { data: null, error: null }
let profileResult: QueryResult = { data: null, error: null }
let followsResult: QueryResult = { count: 3, error: null }
const subscriptionStatusFilter = jest.fn()

function chain(result: QueryResult, onIn?: (column: string, values: unknown) => void) {
  const query: Record<string, unknown> = {}
  query.select = jest.fn(() => query)
  query.eq = jest.fn(() => query)
  query.in = jest.fn((column: string, values: unknown) => {
    onIn?.(column, values)
    return query
  })
  query.maybeSingle = jest.fn(async () => result)
  query.then = (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve)
  return query
}

const mockSupabase = {
  from: jest.fn((table: string) => {
    if (table === 'subscriptions') return chain(subscriptionResult, subscriptionStatusFilter)
    if (table === 'trader_follows') return chain(followsResult)
    if (table === 'user_profiles') return chain(profileResult)
    throw new Error(`unexpected table ${table}`)
  }),
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: (ctx: unknown) => unknown) => (request: Request) =>
    handler({ user: mockUser, supabase: mockSupabase, request }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }),
}))

import { GET } from '../route'

async function call() {
  const response = (await (GET as unknown as (request: Request) => Promise<Response>)(
    new Request('https://arena.test/api/subscription')
  )) as Response
  return { response, body: await response.json() }
}

describe('GET /api/subscription', () => {
  beforeEach(() => {
    subscriptionResult = { data: null, error: null }
    profileResult = { data: null, error: null }
    followsResult = { count: 3, error: null }
    subscriptionStatusFilter.mockClear()
  })

  it('reads only a live subscription and reports it as Pro', async () => {
    subscriptionResult = {
      data: {
        user_id: 'user-1',
        tier: 'pro',
        status: 'active',
        plan: 'monthly',
        created_at: '2026-11-01T00:00:00.000Z',
        current_period_end: '2026-12-01T00:00:00.000Z',
        cancel_at_period_end: false,
        stripe_subscription_id: 'sub_1',
      },
      error: null,
    }

    const { response, body } = await call()

    expect(subscriptionStatusFilter).toHaveBeenCalledWith('status', ['active', 'trialing'])
    expect(response.status).toBe(200)
    expect(body.subscription.tier).toBe('pro')
    expect(body.subscription.autoRenew).toBe(true)
    expect(body.subscription.usage.currentFollows).toBe(3)
    expect(response.headers.get('Set-Cookie')).toContain('arena_tier=pro')
  })

  it('returns free with a free cookie when there is no subscription or Pro profile', async () => {
    profileResult = { data: { subscription_tier: 'free' }, error: null }

    const { response, body } = await call()

    expect(body.subscription.tier).toBe('free')
    expect(response.headers.get('Set-Cookie')).toContain('arena_tier=free')
  })

  it('keeps the body tier consistent with the cookie for a profile-only Pro grant', async () => {
    profileResult = { data: { subscription_tier: 'pro' }, error: null }

    const { response, body } = await call()

    expect(response.headers.get('Set-Cookie')).toContain('arena_tier=pro')
    expect(body.subscription.tier).toBe('pro')
  })

  it('fails with 503 instead of downgrading a user when the subscription read errors', async () => {
    subscriptionResult = { data: null, error: { message: 'connection reset' } }

    const { response, body } = await call()

    expect(response.status).toBe(503)
    expect(body.subscription).toBeUndefined()
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
