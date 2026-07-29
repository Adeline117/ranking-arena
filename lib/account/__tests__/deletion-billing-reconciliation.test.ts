/** @jest-environment node */

const mockExpireOpenSubscriptionCheckouts = jest.fn()
const mockStopStripeSubscriptionRenewals = jest.fn()
const mockPersistOneTimeSettlementScan = jest.fn()
const mockFrom = jest.fn()
const mockSelect = jest.fn()
const mockEq = jest.fn()
const mockOrder = jest.fn()
const mockLimit = jest.fn()
const mockRpc = jest.fn()
const mockUpdateUser = jest.fn()
const mockStripeClient = { marker: 'stripe-client' }

jest.mock('@/lib/stripe/account-deletion', () => ({
  expireOpenSubscriptionCheckouts: (...args: unknown[]) =>
    mockExpireOpenSubscriptionCheckouts(...args),
  stopStripeSubscriptionRenewals: (...args: unknown[]) =>
    mockStopStripeSubscriptionRenewals(...args),
}))

jest.mock('@/lib/stripe/account-deletion-settlement', () => ({
  persistAccountDeletionOneTimeSettlementScan: (...args: unknown[]) =>
    mockPersistOneTimeSettlementScan(...args),
}))

import { reconcilePreparedAccountDeletionBilling } from '../deletion-billing-reconciliation'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: OPERATION_ID,
    user_id: USER_ID,
    state: 'prepared',
    stripe_customer_id: 'cus_owner',
    stripe_subscription_ids: ['sub_initial'],
    prepared_at: '2026-07-29T08:00:00.000Z',
    ...overrides,
  }
}

function finishAck(args: Record<string, unknown>) {
  return {
    status: 'settled',
    operation_id: args.p_operation_id,
    user_id: args.p_user_id,
    stripe_customer_id: args.p_stripe_customer_id,
    stripe_subscription_ids: args.p_stripe_subscription_ids,
  }
}

const mockSupabase = {
  from: mockFrom,
  rpc: mockRpc,
  auth: { admin: { updateUserById: mockUpdateUser } },
}

describe('prepared account deletion billing reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReturnValue({ select: mockSelect })
    mockSelect.mockReturnValue({ eq: mockEq })
    mockEq.mockReturnValue({ order: mockOrder })
    mockOrder.mockReturnValue({ limit: mockLimit })
    mockLimit.mockResolvedValue({ data: [operation()], error: null })
    mockUpdateUser.mockResolvedValue({ error: null })
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: ['cs_open'],
      racedSubscriptionIds: ['sub_checkout_race'],
      racedOneTimeSessionIds: [],
      oneTimeSettlements: [
        {
          checkoutSessionId: 'cs_tip',
          livemode: true,
          stripeCustomerId: 'cus_owner',
          productKind: 'tip',
          stripeStatus: 'complete',
          paymentStatus: 'paid',
          ownershipStatus: 'exact',
        },
      ],
    })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_checkout_race', 'sub_customer', 'sub_initial'],
      changedSubscriptionIds: ['sub_customer'],
    })
    mockPersistOneTimeSettlementScan.mockResolvedValue({
      scanToken: 'scan-1',
      observedSessionIds: ['cs_tip'],
      pendingSessionIds: [],
      terminalSessionIds: ['cs_tip'],
    })
    mockRpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => ({
      data: finishAck(args),
      error: null,
    }))
  })

  it('replays the durable intent and seals the exact fully discovered billing set', async () => {
    await expect(
      reconcilePreparedAccountDeletionBilling({
        supabase: mockSupabase as never,
        stripeClient: mockStripeClient as never,
        limit: 5,
      })
    ).resolves.toEqual({ count: 1, examined: 1, settled: 1 })

    expect(mockFrom).toHaveBeenCalledWith('account_deletion_billing_operations')
    expect(mockSelect).toHaveBeenCalledWith(
      'operation_id,user_id,state,stripe_customer_id,stripe_subscription_ids,prepared_at'
    )
    expect(mockEq).toHaveBeenCalledWith('state', 'prepared')
    expect(mockOrder).toHaveBeenCalledWith('prepared_at', { ascending: true })
    expect(mockLimit).toHaveBeenCalledWith(5)
    expect(mockExpireOpenSubscriptionCheckouts).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      customerId: 'cus_owner',
      expectedUserId: USER_ID,
    })
    expect(mockUpdateUser).toHaveBeenCalledWith(USER_ID, { ban_duration: '876000h' })
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      subscriptionIds: ['sub_checkout_race', 'sub_initial'],
      expectedUserId: USER_ID,
      expectedCustomerId: 'cus_owner',
      deletionMode: 'recoverable',
      pauseMarker: USER_ID,
      includeCustomerSubscriptions: true,
    })
    expect(mockPersistOneTimeSettlementScan).toHaveBeenCalledWith({
      supabase: mockSupabase,
      userId: USER_ID,
      stripeCustomerId: 'cus_owner',
      observations: [expect.objectContaining({ checkoutSessionId: 'cs_tip' })],
    })
    expect(mockRpc).toHaveBeenCalledWith('finish_account_deletion_billing_atomic', {
      p_user_id: USER_ID,
      p_operation_id: OPERATION_ID,
      p_stripe_customer_id: 'cus_owner',
      p_stripe_subscription_ids: ['sub_checkout_race', 'sub_customer', 'sub_initial'],
    })
    expect(mockExpireOpenSubscriptionCheckouts.mock.invocationCallOrder[0]).toBeLessThan(
      mockStopStripeSubscriptionRenewals.mock.invocationCallOrder[0]
    )
    expect(mockStopStripeSubscriptionRenewals.mock.invocationCallOrder[0]).toBeLessThan(
      mockPersistOneTimeSettlementScan.mock.invocationCallOrder[0]
    )
    expect(mockPersistOneTimeSettlementScan.mock.invocationCallOrder[0]).toBeLessThan(
      mockRpc.mock.invocationCallOrder[0]
    )
  })

  it('leaves the prepared operation unsealed after a remote crash and retries it next run', async () => {
    mockStopStripeSubscriptionRenewals.mockRejectedValueOnce(
      new Error('response lost during Stripe cancellation')
    )

    await expect(
      reconcilePreparedAccountDeletionBilling({
        supabase: mockSupabase as never,
        stripeClient: mockStripeClient as never,
      })
    ).rejects.toThrow('response lost during Stripe cancellation')
    expect(mockPersistOneTimeSettlementScan).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()

    await expect(
      reconcilePreparedAccountDeletionBilling({
        supabase: mockSupabase as never,
        stripeClient: mockStripeClient as never,
      })
    ).resolves.toEqual({ count: 1, examined: 1, settled: 1 })
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('settles billing but keeps the durable operation prepared until Auth ban retry succeeds', async () => {
    mockUpdateUser.mockResolvedValueOnce({ error: { message: 'GoTrue unavailable' } })

    await expect(
      reconcilePreparedAccountDeletionBilling({
        supabase: mockSupabase as never,
        stripeClient: mockStripeClient as never,
      })
    ).rejects.toThrow('Account deletion Auth ban failed: GoTrue unavailable')

    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledTimes(1)
    expect(mockPersistOneTimeSettlementScan).toHaveBeenCalledTimes(1)
    expect(mockRpc).not.toHaveBeenCalled()

    await expect(
      reconcilePreparedAccountDeletionBilling({
        supabase: mockSupabase as never,
        stripeClient: mockStripeClient as never,
      })
    ).resolves.toEqual({ count: 1, examined: 1, settled: 1 })
    expect(mockUpdateUser).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('settles a deletion with no Stripe identity without making remote calls', async () => {
    mockLimit.mockResolvedValue({
      data: [operation({ stripe_customer_id: null, stripe_subscription_ids: [] })],
      error: null,
    })

    await expect(
      reconcilePreparedAccountDeletionBilling({
        supabase: mockSupabase as never,
        stripeClient: mockStripeClient as never,
      })
    ).resolves.toEqual({ count: 1, examined: 1, settled: 1 })

    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).toHaveBeenCalledWith(
      expect.objectContaining({ stripeCustomerId: null, observations: [] })
    )
    expect(mockRpc).toHaveBeenCalledWith(
      'finish_account_deletion_billing_atomic',
      expect.objectContaining({
        p_stripe_customer_id: null,
        p_stripe_subscription_ids: [],
      })
    )
  })

  it.each([
    operation({ state: 'settled' }),
    operation({ operation_id: 'not-a-uuid' }),
    operation({ stripe_subscription_ids: ['sub_z', 'sub_a'] }),
    operation({ stripe_customer_id: null, stripe_subscription_ids: ['sub_initial'] }),
    { ...operation(), unexpected: true },
  ])('rejects malformed prepared operation rows before every side effect', async (row) => {
    mockLimit.mockResolvedValue({ data: [row], error: null })

    await expect(
      reconcilePreparedAccountDeletionBilling({
        supabase: mockSupabase as never,
        stripeClient: mockStripeClient as never,
      })
    ).rejects.toThrow('invalid operation')

    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockPersistOneTimeSettlementScan).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('keeps the prepared row retryable when finish does not acknowledge the exact set', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'settled',
        operation_id: OPERATION_ID,
        user_id: USER_ID,
        stripe_customer_id: 'cus_owner',
        stripe_subscription_ids: ['sub_initial'],
      },
      error: null,
    })

    await expect(
      reconcilePreparedAccountDeletionBilling({
        supabase: mockSupabase as never,
        stripeClient: mockStripeClient as never,
      })
    ).rejects.toThrow('invalid acknowledgement')
  })
})
