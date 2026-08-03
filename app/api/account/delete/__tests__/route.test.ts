/** @jest-environment node */

const user = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
  identities: [{ provider: 'email' }],
}
const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockPasswordSignIn = jest.fn()
const mockUpdateUser = jest.fn()
const mockSignOut = jest.fn()
const mockGetUser = jest.fn()
const mockStop = jest.fn()
const mockExpire = jest.fn()
const mockPersist = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: Request) => handler({ user, request }),
  withPublic: (handler: Function) => (request: Request) => handler({ request }),
}))
jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { signInWithPassword: mockPasswordSignIn } }),
}))
jest.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    NEXT_PUBLIC_APP_URL: 'https://www.arenafi.org',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-secret',
    STRIPE_SECRET_KEY: 'sk_test_deletion',
  },
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: mockRpc,
    from: mockFrom,
    auth: {
      admin: { updateUserById: mockUpdateUser, signOut: mockSignOut, getUserById: mockGetUser },
    },
  }),
}))
jest.mock('@/lib/stripe', () => ({ getStripe: () => ({ test: true }) }))
jest.mock('@/lib/stripe/account-deletion', () => ({
  discoverStripeSubscriptionBilling: jest.fn(),
  stopStripeSubscriptionRenewals: (...args: unknown[]) => mockStop(...args),
  expireOpenSubscriptionCheckouts: (...args: unknown[]) => mockExpire(...args),
}))
jest.mock('@/lib/stripe/account-deletion-settlement', () => ({
  persistAccountDeletionOneTimeSettlementScan: (...args: unknown[]) => mockPersist(...args),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { env } from '@/lib/env'
import { POST } from '../route'

const mutableEnv = env as { NEXT_PUBLIC_APP_URL?: string }

const OPERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function request(path: string, body: Record<string, unknown>, cookie?: string): Request {
  return new Request(`https://www.arenafi.org${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.arenafi.org',
      'sec-fetch-site': 'same-origin',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

function cookiePair(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  const match = header.match(new RegExp(`arena_deletion_${OPERATION}=[^;]+`))
  expect(header).toContain(`arena_account_recovery_${OPERATION}=`)
  expect(header).toContain('Max-Age=2678400')
  if (!match) throw new Error('missing deletion operation cookie')
  return match[0]
}

describe('account deletion two-phase saga', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mutableEnv.NEXT_PUBLIC_APP_URL = 'https://www.arenafi.org'
    mockPasswordSignIn.mockResolvedValue({ error: null })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { stripe_customer_id: 'cus_owner', api_stripe_subscription_id: null },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'subscriptions') {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              }),
            }),
          }),
          update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    })
    mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'prepare_account_deletion_auth_fence_atomic')
        return { data: 'prepared', error: null }
      if (name === 'claim_account_deletion_auth_fence_atomic')
        return { data: 'billing_pending', error: null }
      if (name === 'schedule_account_deletion_with_billing_blocks_fenced') {
        return {
          data: {
            status: 'scheduled',
            user_id: args.p_user_id,
            deleted_at: new Date().toISOString(),
            deletion_scheduled_at: args.p_scheduled_at,
            stripe_customer_id: args.p_stripe_customer_id,
            stripe_subscription_ids: args.p_stripe_subscription_ids,
          },
          error: null,
        }
      }
      if (name === 'complete_account_deletion_auth_fence_atomic')
        return { data: 'completed', error: null }
      return { data: 'invalid', error: null }
    })
    mockStop.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: [],
      changedSubscriptionIds: [],
    })
    mockExpire.mockResolvedValue({
      expiredSessionIds: [],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
      oneTimeSettlements: [],
    })
    mockPersist.mockResolvedValue({ scanToken: 'scan' })
    mockUpdateUser.mockResolvedValue({ error: null })
    mockSignOut.mockResolvedValue({ error: null })
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
        },
      },
      error: null,
    })
  })

  it('prepares credentials before billing and commits through durable billing_pending', async () => {
    const prepared = await POST(
      request('/api/account/delete', {
        password: 'correct',
        reason: 'privacy',
        operation_id: OPERATION,
      })
    )
    expect(prepared.status).toBe(202)
    expect(mockStop).not.toHaveBeenCalled()
    const cookie = cookiePair(prepared)

    const committed = await POST(
      request('/api/account/delete?phase=commit', { operation_id: OPERATION }, cookie)
    )
    expect(committed.status).toBe(200)
    expect(await committed.json()).toMatchObject({
      success: true,
      recovery_token: expect.any(String),
    })
    const claimArgs = mockRpc.mock.calls.find(
      ([name]) => name === 'claim_account_deletion_auth_fence_atomic'
    )?.[1]
    expect(claimArgs).toMatchObject({
      p_operation_id: OPERATION,
      p_worker_attempt_id: expect.any(String),
    })
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'schedule_account_deletion_with_billing_blocks_fenced',
        'complete_account_deletion_auth_fence_atomic',
      ])
    )
    expect(committed.headers.get('set-cookie')).toContain(`arena_account_recovery_${OPERATION}=`)
    expect(mockUpdateUser).toHaveBeenCalledWith(user.id, { ban_duration: '876000h' })
  })

  it('does not complete the deletion fence when the fresh Auth ban ends before the DB deadline', async () => {
    const prepared = await POST(
      request('/api/account/delete', { password: 'correct', operation_id: OPERATION })
    )
    mockGetUser.mockResolvedValue({
      data: { user: { banned_until: new Date(Date.now() + 60_000).toISOString() } },
      error: null,
    })

    const response = await POST(
      request('/api/account/delete?phase=commit', { operation_id: OPERATION }, cookiePair(prepared))
    )

    expect(response.status).toBe(503)
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'complete_account_deletion_auth_fence_atomic'
    )
  })

  it.each([123, {}, '界'.repeat(86)])(
    'rejects an invalid or oversized reason before prepare: %p',
    async (reason) => {
      const response = await POST(
        request('/api/account/delete', { password: 'correct', reason, operation_id: OPERATION })
      )
      expect(response.status).toBe(400)
      expect(mockRpc).not.toHaveBeenCalled()
    }
  )

  it('returns busy without a second Stripe worker', async () => {
    const prepared = await POST(
      request('/api/account/delete', { password: 'correct', operation_id: OPERATION })
    )
    mockRpc.mockImplementation(async (name: string) =>
      name === 'claim_account_deletion_auth_fence_atomic'
        ? { data: 'busy', error: null }
        : { data: 'invalid', error: null }
    )
    const response = await POST(
      request('/api/account/delete?phase=commit', { operation_id: OPERATION }, cookiePair(prepared))
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('rejects a Host-self-consistent origin outside the canonical app origin', async () => {
    const prepared = await POST(
      request('/api/account/delete', { password: 'correct', operation_id: OPERATION })
    )
    const response = await POST(
      new Request('https://attacker.example/api/account/delete?phase=commit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://attacker.example',
          'sec-fetch-site': 'same-origin',
          cookie: cookiePair(prepared),
        },
        body: JSON.stringify({ operation_id: OPERATION }),
      })
    )

    expect(response.status).toBe(409)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('fails closed when the canonical app origin is missing', async () => {
    const prepared = await POST(
      request('/api/account/delete', { password: 'correct', operation_id: OPERATION })
    )
    mutableEnv.NEXT_PUBLIC_APP_URL = undefined

    const response = await POST(
      request('/api/account/delete?phase=commit', { operation_id: OPERATION }, cookiePair(prepared))
    )

    expect(response.status).toBe(409)
    expect(mockStop).not.toHaveBeenCalled()
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('rejects an expired durable capability before any billing or Auth side effect', async () => {
    const prepared = await POST(
      request('/api/account/delete', { password: 'correct', operation_id: OPERATION })
    )
    mockRpc.mockImplementation(async (name: string) =>
      name === 'claim_account_deletion_auth_fence_atomic'
        ? { data: 'invalid', error: null }
        : { data: 'invalid', error: null }
    )
    const response = await POST(
      request('/api/account/delete?phase=commit', { operation_id: OPERATION }, cookiePair(prepared))
    )
    expect(response.status).toBe(410)
    expect(mockStop).not.toHaveBeenCalled()
    expect(mockExpire).not.toHaveBeenCalled()
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('fails status authority errors closed', async () => {
    const prepared = await POST(
      request('/api/account/delete', { password: 'correct', operation_id: OPERATION })
    )
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db unavailable' } })
    const response = await POST(
      request('/api/account/delete?phase=status', {}, cookiePair(prepared))
    )
    expect(response.status).toBe(503)
  })
})
