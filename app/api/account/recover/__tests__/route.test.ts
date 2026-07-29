/** @jest-environment node */

const mockRpc = jest.fn()
const mockAdminUpdateUser = jest.fn()
const mockPasswordSignIn = jest.fn()
const mockSubscriptionUpdate = jest.fn()
const mockSubscriptionUpdateEq = jest.fn()
const mockResumeStripeSubscriptionRenewals = jest.fn()
const mockStopStripeSubscriptionRenewals = jest.fn()
const mockStripeClient = { marker: 'stripe-client' }
let tokenResult: { data: Record<string, unknown> | null; error: unknown }
let profileResult: { data: Record<string, unknown> | null; error: unknown }
let billingProfileResult: { data: Record<string, unknown> | null; error: unknown }
let subscriptionResult: { data: Record<string, unknown> | null; error: unknown }

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: Function) => (request: Request) => handler({ request }),
}))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { signInWithPassword: mockPasswordSignIn } })),
}))

jest.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' },
}))

const mockFrom = jest.fn((table: string) => {
  if (table === 'account_recovery_tokens') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn().mockImplementation(async () => tokenResult),
        })),
      })),
    }
  }
  if (table === 'user_profiles') {
    return {
      select: jest.fn((columns: string) => {
        if (columns === 'stripe_customer_id, api_stripe_subscription_id') {
          return {
            eq: jest.fn(() => ({
              maybeSingle: jest.fn().mockImplementation(async () => billingProfileResult),
            })),
          }
        }
        return {
          eq: jest.fn(() => ({
            not: jest.fn(() => ({
              maybeSingle: jest.fn().mockImplementation(async () => profileResult),
            })),
          })),
        }
      }),
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
        mockSubscriptionUpdate(...args)
        return {
          eq: (...firstEq: unknown[]) => {
            mockSubscriptionUpdateEq(...firstEq)
            return {
              eq: (...secondEq: unknown[]) => {
                mockSubscriptionUpdateEq(...secondEq)
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
    auth: { admin: { updateUserById: mockAdminUpdateUser } },
  })),
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: jest.fn(() => mockStripeClient),
}))

jest.mock('@/lib/stripe/account-deletion', () => ({
  resumeStripeSubscriptionRenewals: (...args: unknown[]) =>
    mockResumeStripeSubscriptionRenewals(...args),
  stopStripeSubscriptionRenewals: (...args: unknown[]) =>
    mockStopStripeSubscriptionRenewals(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}))

import { createHash } from 'node:crypto'
import { POST } from '../route'

const RECOVERY_TOKEN = 'A'.repeat(43)

function request(body: Record<string, unknown>): Request {
  return new Request('https://www.arenafi.org/api/account/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('account recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    tokenResult = {
      data: {
        user_id: 'user-1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        used_at: null,
      },
      error: null,
    }
    profileResult = {
      data: {
        id: 'user-1',
        deletion_scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
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
    subscriptionResult = {
      data: {
        stripe_subscription_id: 'sub_123',
        status: 'active',
        plan: 'monthly',
        cancel_at_period_end: true,
      },
      error: null,
    }
    mockRpc.mockResolvedValue({ data: 'user-1', error: null })
    mockAdminUpdateUser.mockResolvedValue({ error: null })
    mockPasswordSignIn.mockResolvedValue({ error: null })
    mockResumeStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_123', 'sub_api'],
      changedSubscriptionIds: ['sub_123', 'sub_api'],
      terminalMarkedSubscriptionIds: [],
    })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_123', 'sub_api'],
      changedSubscriptionIds: ['sub_123', 'sub_api'],
    })
  })

  it('restores a passwordless account with its one-time token and resumes renewal', async () => {
    const response = await POST(request({ recovery_token: RECOVERY_TOKEN }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, subscription_resumed: true })
    expect(mockRpc).toHaveBeenCalledWith('restore_pending_account', {
      p_user_id: 'user-1',
      p_recovery_token_hash: createHash('sha256').update(RECOVERY_TOKEN).digest('hex'),
    })
    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-1', { ban_duration: 'none' })
    expect(mockResumeStripeSubscriptionRenewals).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      subscriptionIds: ['sub_123', 'sub_api'],
      expectedCustomerId: 'cus_owner',
      includeCustomerSubscriptions: true,
      pauseMarker: 'user-1',
    })
    expect(mockSubscriptionUpdate).toHaveBeenCalledWith({ cancel_at_period_end: false })
    expect(mockSubscriptionUpdateEq).toHaveBeenNthCalledWith(1, 'stripe_subscription_id', 'sub_123')
    expect(mockSubscriptionUpdateEq).toHaveBeenNthCalledWith(2, 'user_id', 'user-1')
    expect(mockResumeStripeSubscriptionRenewals.mock.invocationCallOrder[0]).toBeLessThan(
      mockRpc.mock.invocationCallOrder[0]
    )
  })

  it('does not unban or reveal account details for an invalid token', async () => {
    tokenResult = { data: null, error: null }

    const response = await POST(request({ recovery_token: 'Q'.repeat(43) }))

    expect(response.status).toBe(401)
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['too short', 'A'.repeat(39)],
    ['impossible encoded length', 'A'.repeat(41)],
    ['too long', 'A'.repeat(129)],
    ['padding', `${'A'.repeat(42)}=`],
    ['non-canonical trailing bits', `${'A'.repeat(42)}B`],
    ['surrounding whitespace', ` ${RECOVERY_TOKEN}`],
  ])('fails malformed token input closed before querying storage: %s', async (_label, token) => {
    const response = await POST(request({ recovery_token: token }))

    expect(response.status).toBe(401)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('re-bans a password account when credential verification fails', async () => {
    mockPasswordSignIn.mockResolvedValue({ error: { message: 'invalid' } })

    const response = await POST(request({ email: 'user@example.com', password: 'wrong' }))

    expect(response.status).toBe(401)
    expect(mockAdminUpdateUser).toHaveBeenNthCalledWith(1, 'user-1', {
      ban_duration: 'none',
    })
    expect(mockAdminUpdateUser).toHaveBeenNthCalledWith(2, 'user-1', {
      ban_duration: '720h',
    })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('re-bans the account if the atomic restore fails after verification', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await POST(
      request({ email: 'user@example.com', password: 'correct-password' })
    )

    expect(response.status).toBe(500)
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      subscriptionIds: ['sub_123', 'sub_api'],
      expectedCustomerId: 'cus_owner',
      deletionMode: 'permanent',
      includeCustomerSubscriptions: true,
    })
    expect(mockSubscriptionUpdate).toHaveBeenNthCalledWith(1, {
      cancel_at_period_end: false,
    })
    expect(mockSubscriptionUpdate).toHaveBeenNthCalledWith(2, {
      status: 'canceled',
      cancel_at_period_end: false,
    })
    expect(mockAdminUpdateUser).toHaveBeenLastCalledWith('user-1', {
      ban_duration: '720h',
    })
  })

  it('keeps the deletion tombstone and re-bans when API renewal recovery fails', async () => {
    mockResumeStripeSubscriptionRenewals.mockRejectedValue(new Error('Stripe unavailable'))

    const response = await POST(request({ recovery_token: RECOVERY_TOKEN }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ success: false })
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockSubscriptionUpdate).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).toHaveBeenLastCalledWith('user-1', {
      ban_duration: '720h',
    })
  })

  it('restores an API-only deletion pause without mutating the consumer table', async () => {
    subscriptionResult = { data: null, error: null }
    mockResumeStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_api'],
      changedSubscriptionIds: ['sub_api'],
      terminalMarkedSubscriptionIds: [],
    })

    const response = await POST(request({ recovery_token: RECOVERY_TOKEN }))

    expect(response.status).toBe(200)
    expect(mockResumeStripeSubscriptionRenewals).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionIds: ['sub_api'],
        includeCustomerSubscriptions: true,
        pauseMarker: 'user-1',
      })
    )
    expect(mockSubscriptionUpdate).not.toHaveBeenCalled()
  })

  it('explicitly reports when a deletion-paused subscription ended before recovery', async () => {
    subscriptionResult = { data: null, error: null }
    mockResumeStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_api_ended'],
      changedSubscriptionIds: [],
      terminalMarkedSubscriptionIds: ['sub_api_ended'],
    })

    const response = await POST(request({ recovery_token: RECOVERY_TOKEN }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      subscription_resumed: false,
      billing_reactivation_required: true,
    })
  })
})
