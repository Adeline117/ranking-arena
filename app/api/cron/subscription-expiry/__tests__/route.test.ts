/**
 * Cron: subscription-expiry route tests
 * Tests auth, expiry checks, downgrade logic, NFT validation, and error handling.
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFrom = jest.fn()
const mockSupabaseClient = { from: mockFrom }

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

jest.mock('@/lib/web3/nft', () => ({
  checkNFTMembership: jest.fn().mockResolvedValue(false),
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
    mockFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                lt: jest.fn().mockReturnValue({
                  gt: jest.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }),
              lt: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }
      }
      if (table === 'user_profiles') {
        return {
          select: jest.fn().mockReturnValue({
            not: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }
      }
      return chainable({ data: null, error: null })
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.expiringReminders).toBe(0)
    expect(body.downgraded).toBe(0)
  })

  // ---- Downgrade expired subscriptions -------------------------------------

  it('downgrades expired subscriptions', async () => {
    const expiredSubs = [
      { user_id: 'user1', stripe_subscription_id: 'sub_1' },
    ]

    mockFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockImplementation((_col: string, val: unknown) => {
              if (val === 'active') {
                return {
                  eq: jest.fn().mockReturnValue({
                    lt: jest.fn().mockReturnValue({
                      gt: jest.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                  }),
                  lt: jest.fn().mockResolvedValue({ data: expiredSubs, error: null }),
                  single: jest.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
                }
              }
              return chainable({ data: null, error: null })
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          }),
        }
      }
      if (table === 'user_profiles') {
        return {
          select: jest.fn().mockReturnValue({
            not: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
          update: jest.fn().mockReturnValue({
            eq: jest.fn().mockResolvedValue({ error: null }),
          }),
        }
      }
      if (table === 'notifications') {
        return {
          insert: jest.fn().mockResolvedValue({ error: null }),
          select: jest.fn().mockReturnValue({
            in: jest.fn().mockReturnValue({
              eq: jest.fn().mockReturnValue({
                gte: jest.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'group_members') {
        return {
          delete: jest.fn().mockReturnValue({
            eq: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ error: null }),
            }),
          }),
        }
      }
      return chainable({ data: null, error: null })
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.downgraded).toBe(1)
  })

  // ---- Error handling ------------------------------------------------------

  it('returns 500 when database throws', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('Connection lost')
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    expect(res.status).toBe(500)
  })

  it('catches thrown errors during downgrade and records them', async () => {
    // When supabase.from('subscriptions').update() throws, it is caught
    // and added to results.errors
    mockFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: jest.fn().mockReturnValue({
            eq: jest.fn().mockImplementation((_col: string, val: unknown) => {
              if (val === 'active') {
                return {
                  eq: jest.fn().mockReturnValue({
                    lt: jest.fn().mockReturnValue({
                      gt: jest.fn().mockResolvedValue({ data: [], error: null }),
                    }),
                  }),
                  lt: jest.fn().mockResolvedValue({
                    data: [{ user_id: 'user1', stripe_subscription_id: 'sub_1' }],
                    error: null,
                  }),
                }
              }
              return chainable({ data: null, error: null })
            }),
          }),
          // The update call throws, triggering the catch block
          update: jest.fn().mockImplementation(() => {
            throw new Error('Update failed')
          }),
        }
      }
      if (table === 'user_profiles') {
        return {
          select: jest.fn().mockReturnValue({
            not: jest.fn().mockReturnValue({
              eq: jest.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }
      }
      return chainable({ data: null, error: null })
    })

    const res = await GET(createCronRequest(CRON_SECRET))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.errors.length).toBeGreaterThan(0)
    expect(body.errors[0]).toContain('Downgrade error')
  })
})
