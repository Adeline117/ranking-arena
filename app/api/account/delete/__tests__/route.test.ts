/** @jest-environment node */

const mockUser = {
  id: 'user-1',
  email: 'user@example.com',
  identities: [{ provider: 'email' }],
}
const mockPasswordSignIn = jest.fn()
const mockRpc = jest.fn()
const mockAdminUpdateUser = jest.fn()
const mockAdminSignOut = jest.fn()
const mockLocalSubscriptionUpdate = jest.fn()
const mockLocalSubscriptionUpdateEq = jest.fn()
const mockStopStripeSubscriptionRenewals = jest.fn()
const mockExpireOpenSubscriptionCheckouts = jest.fn()
const mockStripeClient = { marker: 'stripe-client' }
let subscriptionResult: { data: Record<string, unknown> | null; error: unknown }
let billingProfileResult: { data: Record<string, unknown> | null; error: unknown }

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: Request) => handler({ user: mockUser, request }),
}))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { signInWithPassword: mockPasswordSignIn } })),
}))

jest.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' },
}))

const mockFrom = jest.fn((table: string) => {
  if (table === 'user_profiles') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn().mockImplementation(async () => billingProfileResult),
        })),
      })),
    }
  }
  if (table === 'subscriptions') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          in: jest.fn(() => ({
            limit: jest.fn(() => ({
              maybeSingle: jest.fn().mockImplementation(async () => subscriptionResult),
            })),
          })),
        })),
      })),
      update: (...args: unknown[]) => {
        mockLocalSubscriptionUpdate(...args)
        return {
          eq: (...firstEq: unknown[]) => {
            mockLocalSubscriptionUpdateEq(...firstEq)
            return {
              eq: (...secondEq: unknown[]) => {
                mockLocalSubscriptionUpdateEq(...secondEq)
                return Promise.resolve({ error: null })
              },
            }
          },
        }
      },
    }
  }
  throw new Error(`Unexpected table: ${table}`)
})

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: mockFrom,
    rpc: mockRpc,
    auth: {
      admin: { updateUserById: mockAdminUpdateUser, signOut: mockAdminSignOut },
    },
  })),
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: jest.fn(() => mockStripeClient),
}))

jest.mock('@/lib/stripe/account-deletion', () => ({
  stopStripeSubscriptionRenewals: (...args: unknown[]) =>
    mockStopStripeSubscriptionRenewals(...args),
  expireOpenSubscriptionCheckouts: (...args: unknown[]) =>
    mockExpireOpenSubscriptionCheckouts(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}))

import { createHash } from 'node:crypto'
import { POST } from '../route'

function request(body: Record<string, unknown>): Request {
  return new Request('https://www.arenafi.org/api/account/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('account deletion scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUser.email = 'user@example.com'
    mockUser.identities = [{ provider: 'email' }]
    subscriptionResult = {
      data: {
        stripe_subscription_id: 'sub_123',
        status: 'active',
        plan: 'monthly',
      },
      error: null,
    }
    billingProfileResult = {
      data: {
        stripe_customer_id: 'cus_owner',
        api_stripe_subscription_id: 'sub_api',
      },
      error: null,
    }
    mockPasswordSignIn.mockResolvedValue({ error: null })
    mockRpc.mockResolvedValue({ data: new Date().toISOString(), error: null })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_123', 'sub_api'],
    })
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: ['cs_api_open'],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
    })
    mockAdminUpdateUser.mockResolvedValue({ error: null })
    mockAdminSignOut.mockResolvedValue({ error: null })
  })

  it('retains account data and closes consumer, API, and open Checkout billing first', async () => {
    const response = await POST(request({ password: 'correct', reason: 'privacy' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.recovery_token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(mockRpc).toHaveBeenCalledWith(
      'schedule_account_deletion',
      expect.objectContaining({
        p_user_id: 'user-1',
        p_reason: 'privacy',
        p_recovery_token_hash: createHash('sha256').update(body.recovery_token).digest('hex'),
      })
    )
    expect(mockRpc.mock.calls[0][1].p_recovery_token_hash).not.toBe(body.recovery_token)
    expect(mockExpireOpenSubscriptionCheckouts).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      customerId: 'cus_owner',
    })
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      subscriptionIds: ['sub_123', 'sub_api'],
      expectedCustomerId: 'cus_owner',
      deletionMode: 'recoverable',
      pauseMarker: 'user-1',
    })
    expect(mockExpireOpenSubscriptionCheckouts.mock.invocationCallOrder[0]).toBeLessThan(
      mockStopStripeSubscriptionRenewals.mock.invocationCallOrder[0]
    )
    expect(mockStopStripeSubscriptionRenewals.mock.invocationCallOrder[0]).toBeLessThan(
      mockRpc.mock.invocationCallOrder[0]
    )
    expect(mockLocalSubscriptionUpdate).toHaveBeenCalledWith({
      status: 'canceled',
      cancel_at_period_end: false,
    })
    expect(mockLocalSubscriptionUpdateEq).toHaveBeenNthCalledWith(
      1,
      'stripe_subscription_id',
      'sub_123'
    )
    expect(mockLocalSubscriptionUpdateEq).toHaveBeenNthCalledWith(2, 'user_id', 'user-1')
    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-1', { ban_duration: '720h' })
    expect(mockAdminSignOut).toHaveBeenCalledWith('user-1', 'global')
    expect(mockFrom).toHaveBeenCalledTimes(3)
  })

  it('never revives canceled billing when database scheduling fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(500)
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalled()
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
  })

  it('fails closed before scheduling when an open Checkout cannot be expired', async () => {
    mockExpireOpenSubscriptionCheckouts.mockRejectedValue(new Error('Checkout remains payable'))

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(502)
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
  })

  it('feeds a just-completed Checkout subscription into immediate shutdown', async () => {
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: [],
      racedSubscriptionIds: ['sub_checkout_race'],
      racedOneTimeSessionIds: [],
    })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_123', 'sub_api', 'sub_checkout_race'],
    })

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(200)
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionIds: ['sub_123', 'sub_api', 'sub_checkout_race'],
        deletionMode: 'recoverable',
      })
    )
  })

  it('fails closed without reviving billing when remote Checkout shutdown later fails', async () => {
    billingProfileResult.data = {
      stripe_customer_id: null,
      api_stripe_subscription_id: 'sub_api',
    }
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_123', 'sub_api'],
    })
    mockExpireOpenSubscriptionCheckouts.mockRejectedValue(new Error('Stripe unavailable'))

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(502)
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when the API billing profile cannot be read', async () => {
    billingProfileResult = { data: null, error: { message: 'database unavailable' } }

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(502)
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('stops an API-only subscription even without a consumer Pro row', async () => {
    subscriptionResult = { data: null, error: null }
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      changedSubscriptionIds: ['sub_api'],
    })

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(200)
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionIds: [null, 'sub_api'],
        deletionMode: 'recoverable',
      })
    )
    expect(mockLocalSubscriptionUpdate).not.toHaveBeenCalled()
  })

  it('supports passwordless accounts with typed confirmation and skips lifetime billing calls', async () => {
    mockUser.email = 'wallet@wallet.arena'
    mockUser.identities = [{ provider: 'privy' }]
    subscriptionResult.data = {
      stripe_subscription_id: 'lifetime_user-1',
      status: 'active',
      plan: 'lifetime',
    }
    billingProfileResult.data = {
      stripe_customer_id: null,
      api_stripe_subscription_id: null,
    }

    const response = await POST(request({ confirm: 'DELETE' }))

    expect(response.status).toBe(200)
    expect(mockPasswordSignIn).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
  })
})
