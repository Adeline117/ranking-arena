/** @jest-environment node */

const mockUser = {
  id: 'user-1',
  email: 'user@example.com',
  app_metadata: { provider: 'email', providers: ['email'] } as Record<string, unknown>,
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
const mockDiscoverStripeSubscriptionBilling = jest.fn()
const mockPersistOneTimeSettlementScan = jest.fn()
const mockStripeClient = { marker: 'stripe-client' }
const DEFAULT_RECOVERY_TOKEN = 'Q'.repeat(43)
const CURRENT_ACCESS_TOKEN = 'header.payload.signature'
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
  discoverStripeSubscriptionBilling: (...args: unknown[]) =>
    mockDiscoverStripeSubscriptionBilling(...args),
  stopStripeSubscriptionRenewals: (...args: unknown[]) =>
    mockStopStripeSubscriptionRenewals(...args),
  expireOpenSubscriptionCheckouts: (...args: unknown[]) =>
    mockExpireOpenSubscriptionCheckouts(...args),
}))

jest.mock('@/lib/stripe/account-deletion-settlement', () => ({
  persistAccountDeletionOneTimeSettlementScan: (...args: unknown[]) =>
    mockPersistOneTimeSettlementScan(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}))

import { createHash } from 'node:crypto'
import { POST } from '../route'

function request(body: Record<string, unknown>, includeRecoveryToken = true): Request {
  return new Request('https://www.arenafi.org/api/account/delete', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CURRENT_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(
      includeRecoveryToken ? { recovery_token: DEFAULT_RECOVERY_TOKEN, ...body } : body
    ),
  })
}

describe('account deletion scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUser.email = 'user@example.com'
    mockUser.app_metadata = { provider: 'email', providers: ['email'] }
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
    mockPasswordSignIn.mockResolvedValue({
      data: {
        user: { id: 'user-1' },
        session: { user: { id: 'user-1' } },
      },
      error: null,
    })
    mockRpc.mockImplementation(async (functionName: string, args: Record<string, unknown>) => {
      if (functionName === 'bind_stripe_customer_owner_atomic') {
        return { data: { status: 'bound' }, error: null }
      }
      if (functionName === 'prepare_account_deletion_billing_atomic') {
        return {
          data: {
            status: 'prepared',
            operation_id: args.p_operation_id,
            user_id: args.p_user_id,
            deleted_at: new Date(Date.parse(String(args.p_scheduled_at)) - 1_000).toISOString(),
            deletion_scheduled_at: args.p_scheduled_at,
            stripe_customer_id: args.p_stripe_customer_id,
            stripe_subscription_ids: args.p_stripe_subscription_ids,
          },
          error: null,
        }
      }
      if (functionName === 'finish_account_deletion_billing_atomic') {
        return {
          data: {
            status: 'settled',
            operation_id: args.p_operation_id,
            user_id: args.p_user_id,
            stripe_customer_id: args.p_stripe_customer_id,
            stripe_subscription_ids: args.p_stripe_subscription_ids,
          },
          error: null,
        }
      }
      throw new Error(`Unexpected RPC: ${functionName}`)
    })
    mockDiscoverStripeSubscriptionBilling.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_123', 'sub_api'],
    })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_123', 'sub_api'],
      changedSubscriptionIds: ['sub_123', 'sub_api'],
    })
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: ['cs_api_open'],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
      oneTimeSettlements: [],
    })
    mockPersistOneTimeSettlementScan.mockResolvedValue({
      scanToken: 'scan-1',
      observedSessionIds: [],
      pendingSessionIds: [],
      terminalSessionIds: [],
    })
    mockAdminUpdateUser.mockResolvedValue({ error: null })
    mockAdminSignOut.mockResolvedValue({ error: null })
  })

  it('persists the recoverable tombstone before closing every billing surface', async () => {
    const response = await POST(request({ password: 'correct', reason: 'privacy' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.user_id).toBe('user-1')
    expect(body.recovery_token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(body.billing_settlement_pending).toBe(false)
    expect(body.auth_invalidation_pending).toBe(false)
    expect(mockRpc).toHaveBeenCalledWith(
      'prepare_account_deletion_billing_atomic',
      expect.objectContaining({
        p_user_id: 'user-1',
        p_operation_id: expect.any(String),
        p_reason: 'privacy',
        p_recovery_token_hash: createHash('sha256').update(body.recovery_token).digest('hex'),
        p_stripe_customer_id: 'cus_owner',
        p_stripe_subscription_ids: ['sub_123', 'sub_api'],
      })
    )
    const prepareCall = mockRpc.mock.calls.find(
      ([name]) => name === 'prepare_account_deletion_billing_atomic'
    )!
    const finishCall = mockRpc.mock.calls.find(
      ([name]) => name === 'finish_account_deletion_billing_atomic'
    )!
    expect(prepareCall[1].p_recovery_token_hash).not.toBe(body.recovery_token)
    expect(finishCall[1]).toEqual(
      expect.objectContaining({
        p_user_id: 'user-1',
        p_operation_id: prepareCall[1].p_operation_id,
        p_stripe_customer_id: 'cus_owner',
        p_stripe_subscription_ids: ['sub_123', 'sub_api'],
      })
    )
    expect(mockDiscoverStripeSubscriptionBilling).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      subscriptionIds: ['sub_123', 'sub_api'],
      expectedUserId: 'user-1',
      expectedCustomerId: 'cus_owner',
      includeCustomerSubscriptions: true,
    })
    expect(mockExpireOpenSubscriptionCheckouts).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      customerId: 'cus_owner',
      expectedUserId: 'user-1',
    })
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      expectedUserId: 'user-1',
      subscriptionIds: ['sub_123', 'sub_api'],
      expectedCustomerId: 'cus_owner',
      deletionMode: 'recoverable',
      pauseMarker: 'user-1',
    })
    expect(mockExpireOpenSubscriptionCheckouts.mock.invocationCallOrder[0]).toBeLessThan(
      mockStopStripeSubscriptionRenewals.mock.invocationCallOrder[0]
    )
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockExpireOpenSubscriptionCheckouts.mock.invocationCallOrder[0]
    )
    expect(mockPersistOneTimeSettlementScan).toHaveBeenCalledWith({
      supabase: expect.any(Object),
      userId: 'user-1',
      stripeCustomerId: 'cus_owner',
      observations: [],
    })
    expect(mockPersistOneTimeSettlementScan.mock.invocationCallOrder[0]).toBeLessThan(
      mockRpc.mock.invocationCallOrder.at(-1)!
    )
    expect(mockLocalSubscriptionUpdate).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-1', { ban_duration: '876000h' })
    expect(mockAdminSignOut).toHaveBeenCalledWith(CURRENT_ACCESS_TOKEN, 'global')
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('commits the exact caller-staged recovery credential for response-loss safety', async () => {
    const recoveryToken = 'A'.repeat(43)

    const response = await POST(
      request({ password: 'correct', reason: 'privacy', recovery_token: recoveryToken })
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        user_id: 'user-1',
        recovery_token: recoveryToken,
      })
    )
    expect(mockRpc).toHaveBeenCalledWith(
      'prepare_account_deletion_billing_atomic',
      expect.objectContaining({
        p_user_id: 'user-1',
        p_recovery_token_hash: createHash('sha256').update(recoveryToken).digest('hex'),
      })
    )
  })

  it('rejects a malformed caller recovery credential before authentication or billing', async () => {
    const response = await POST(
      request({ password: 'correct', recovery_token: 'not-a-canonical-token' })
    )

    expect(response.status).toBe(400)
    expect(mockPasswordSignIn).not.toHaveBeenCalled()
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects credentials that authenticate a different Auth subject before every mutation', async () => {
    mockPasswordSignIn.mockResolvedValue({
      data: {
        user: { id: 'user-2' },
        session: { user: { id: 'user-2' } },
      },
      error: null,
    })

    const response = await POST(request({ password: 'user-2-password' }))

    expect(response.status).toBe(403)
    expect(mockPasswordSignIn).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'user-2-password',
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
    expect(mockAdminSignOut).not.toHaveBeenCalled()
  })

  it.each([{}, '', 'x'.repeat(4097)])(
    'rejects a malformed password proof before every mutation',
    async (password) => {
      const response = await POST(request({ password }))

      expect(response.status).toBe(400)
      expect(mockPasswordSignIn).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
      expect(mockRpc).not.toHaveBeenCalled()
    }
  )

  it('never downgrades missing Auth provider evidence to typed deletion', async () => {
    mockUser.app_metadata = {}
    mockUser.identities = []

    const response = await POST(request({ confirm: 'DELETE' }))

    expect(response.status).toBe(403)
    expect(mockPasswordSignIn).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
    expect(mockAdminSignOut).not.toHaveBeenCalled()
  })

  it('uses protected Auth metadata when the optional identities array is absent', async () => {
    mockUser.identities = []

    const response = await POST(request({ confirm: 'DELETE' }))

    expect(response.status).toBe(400)
    expect(mockPasswordSignIn).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('performs zero irreversible mutations when database preparation fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(503)
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
  })

  it('fails closed before Stripe when preparation does not acknowledge the exact billing set', async () => {
    mockRpc.mockImplementation(async (_functionName: string, args: Record<string, unknown>) => ({
      data: {
        status: 'prepared',
        operation_id: args.p_operation_id,
        user_id: args.p_user_id,
        deleted_at: new Date(Date.parse(String(args.p_scheduled_at)) - 1_000).toISOString(),
        deletion_scheduled_at: args.p_scheduled_at,
        stripe_customer_id: args.p_stripe_customer_id,
        stripe_subscription_ids: ['sub_123'],
      },
      error: null,
    }))

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(503)
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockLocalSubscriptionUpdate).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
    expect(mockAdminSignOut).not.toHaveBeenCalled()
  })

  it('returns a retryable scheduled result when Checkout shutdown fails after preparation', async () => {
    mockExpireOpenSubscriptionCheckouts.mockRejectedValue(new Error('Checkout remains payable'))

    const response = await POST(request({ password: 'correct' }))
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body).toEqual(
      expect.objectContaining({ success: true, billing_settlement_pending: true })
    )
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'prepare_account_deletion_billing_atomic',
      expect.any(Object)
    )
    expect(mockRpc).not.toHaveBeenCalledWith(
      'finish_account_deletion_billing_atomic',
      expect.any(Object)
    )
    expect(mockAdminUpdateUser).toHaveBeenCalled()
  })

  it('keeps the exact durable intent retryable when final DB acknowledgement is lost', async () => {
    const defaultImplementation = mockRpc.getMockImplementation()!
    mockRpc.mockImplementation(async (functionName: string, args: Record<string, unknown>) => {
      if (functionName === 'finish_account_deletion_billing_atomic') {
        return { data: null, error: { message: 'response lost after Stripe cancellation' } }
      }
      return defaultImplementation(functionName, args)
    })

    const response = await POST(request({ password: 'correct' }))
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        recovery_token: DEFAULT_RECOVERY_TOKEN,
        billing_settlement_pending: true,
      })
    )
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith(
      'prepare_account_deletion_billing_atomic',
      expect.any(Object)
    )
    expect(mockRpc).toHaveBeenCalledWith(
      'finish_account_deletion_billing_atomic',
      expect.any(Object)
    )
    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-1', { ban_duration: '876000h' })
    expect(mockAdminSignOut).toHaveBeenCalledWith(CURRENT_ACCESS_TOKEN, 'global')
  })

  it('keeps the operation prepared until a failed Auth ban can be retried', async () => {
    mockAdminUpdateUser.mockResolvedValueOnce({ error: { message: 'GoTrue unavailable' } })

    const response = await POST(request({ password: 'correct' }))
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        billing_settlement_pending: true,
        auth_invalidation_pending: true,
      })
    )
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledTimes(1)
    expect(mockPersistOneTimeSettlementScan).toHaveBeenCalledTimes(1)
    expect(mockRpc).not.toHaveBeenCalledWith(
      'finish_account_deletion_billing_atomic',
      expect.any(Object)
    )
    expect(mockAdminSignOut).toHaveBeenCalledWith(CURRENT_ACCESS_TOKEN, 'global')
  })

  it('does not crash after preparation when Auth APIs throw', async () => {
    mockAdminUpdateUser.mockRejectedValueOnce(new Error('ban response lost'))
    mockAdminSignOut.mockRejectedValueOnce(new Error('logout response lost'))

    const response = await POST(request({ password: 'correct' }))
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body.auth_invalidation_pending).toBe(true)
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledTimes(1)
    expect(mockRpc).not.toHaveBeenCalledWith(
      'finish_account_deletion_billing_atomic',
      expect.any(Object)
    )
  })

  it('uses the verified JWT for global revocation and reports a lost logout response', async () => {
    mockAdminSignOut.mockRejectedValueOnce(new Error('logout response lost'))

    const response = await POST(request({ password: 'correct' }))
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body).toEqual(
      expect.objectContaining({
        billing_settlement_pending: false,
        auth_invalidation_pending: true,
      })
    )
    expect(mockAdminSignOut).toHaveBeenCalledWith(CURRENT_ACCESS_TOKEN, 'global')
    expect(mockAdminSignOut).not.toHaveBeenCalledWith('user-1', 'global')
    expect(mockRpc).toHaveBeenCalledWith(
      'finish_account_deletion_billing_atomic',
      expect.any(Object)
    )
  })

  it('feeds a just-completed Checkout subscription into immediate shutdown', async () => {
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: [],
      racedSubscriptionIds: ['sub_checkout_race'],
      racedOneTimeSessionIds: [],
      oneTimeSettlements: [],
    })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_123', 'sub_api', 'sub_checkout_race'],
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
    expect(mockRpc).toHaveBeenCalledWith(
      'finish_account_deletion_billing_atomic',
      expect.objectContaining({
        p_stripe_subscription_ids: ['sub_123', 'sub_api', 'sub_checkout_race'],
      })
    )
  })

  it('durably records a pre-existing complete one-time Checkout before scheduling', async () => {
    const completeTip = {
      checkoutSessionId: 'cs_tip_complete',
      livemode: true,
      stripeCustomerId: 'cus_owner',
      productKind: 'tip',
      stripeStatus: 'complete',
      paymentStatus: 'paid',
      ownershipStatus: 'exact',
    }
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: [],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
      oneTimeSettlements: [completeTip],
    })
    mockPersistOneTimeSettlementScan.mockResolvedValue({
      scanToken: 'scan-tip',
      observedSessionIds: ['cs_tip_complete'],
      pendingSessionIds: ['cs_tip_complete'],
      terminalSessionIds: [],
    })

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(200)
    expect(mockPersistOneTimeSettlementScan).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        stripeCustomerId: 'cus_owner',
        observations: [completeTip],
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
      observedSubscriptionIds: ['sub_123', 'sub_api'],
      changedSubscriptionIds: ['sub_123', 'sub_api'],
    })
    mockExpireOpenSubscriptionCheckouts.mockRejectedValue(new Error('Stripe unavailable'))

    const response = await POST(request({ password: 'correct' }))
    const body = await response.json()

    expect(response.status).toBe(202)
    expect(body).toEqual(
      expect.objectContaining({ success: true, billing_settlement_pending: true })
    )
    expect(mockDiscoverStripeSubscriptionBilling).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      subscriptionIds: ['sub_123', 'sub_api'],
      expectedUserId: 'user-1',
      expectedCustomerId: null,
      includeCustomerSubscriptions: true,
    })
    expect(mockRpc).toHaveBeenCalledWith('bind_stripe_customer_owner_atomic', {
      p_user_id: 'user-1',
      p_new_stripe_customer_id: 'cus_owner',
      p_expected_previous_stripe_customer_id: null,
    })
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).not.toHaveBeenCalled()
    expect(
      mockRpc.mock.calls.some(
        ([functionName]) => functionName === 'prepare_account_deletion_billing_atomic'
      )
    ).toBe(true)
    expect(
      mockRpc.mock.calls.some(
        ([functionName]) => functionName === 'finish_account_deletion_billing_atomic'
      )
    ).toBe(false)
    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-1', { ban_duration: '876000h' })
    expect(mockAdminSignOut).toHaveBeenCalledWith(CURRENT_ACCESS_TOKEN, 'global')
  })

  it('performs zero Stripe mutations when another profile owns a derived customer', async () => {
    billingProfileResult.data = {
      stripe_customer_id: null,
      api_stripe_subscription_id: 'sub_api',
    }
    mockRpc.mockImplementation(async (functionName: string) => {
      if (functionName === 'bind_stripe_customer_owner_atomic') {
        return { data: { status: 'identity_conflict' }, error: null }
      }
      throw new Error(`Unexpected RPC: ${functionName}`)
    })

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(502)
    expect(mockDiscoverStripeSubscriptionBilling).toHaveBeenCalled()
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the API billing profile cannot be read', async () => {
    billingProfileResult = { data: null, error: { message: 'database unavailable' } }

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(502)
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('stops an API-only subscription even without a consumer Pro row', async () => {
    subscriptionResult = { data: null, error: null }
    mockDiscoverStripeSubscriptionBilling.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_api'],
    })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_api'],
      changedSubscriptionIds: ['sub_api'],
    })

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(200)
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionIds: ['sub_api'],
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

    const recoveryToken = 'A'.repeat(43)
    const response = await POST(request({ confirm: 'DELETE', recovery_token: recoveryToken }))

    expect(response.status).toBe(200)
    expect(mockPasswordSignIn).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).toHaveBeenCalledWith({
      supabase: expect.any(Object),
      userId: 'user-1',
      stripeCustomerId: null,
      observations: [],
    })
    expect(mockRpc).toHaveBeenCalledWith(
      'prepare_account_deletion_billing_atomic',
      expect.objectContaining({
        p_recovery_token_hash: createHash('sha256').update(recoveryToken).digest('hex'),
        p_stripe_customer_id: null,
        p_stripe_subscription_ids: [],
      })
    )
    expect(mockRpc).toHaveBeenCalledWith(
      'finish_account_deletion_billing_atomic',
      expect.objectContaining({
        p_stripe_customer_id: null,
        p_stripe_subscription_ids: [],
      })
    )
  })

  it('blocks legacy passwordless deletion before mutations when no token was staged', async () => {
    mockUser.email = 'wallet@wallet.arena'
    mockUser.identities = [{ provider: 'privy' }]

    const response = await POST(request({ confirm: 'DELETE' }, false))

    expect(response.status).toBe(400)
    expect(mockPasswordSignIn).not.toHaveBeenCalled()
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
