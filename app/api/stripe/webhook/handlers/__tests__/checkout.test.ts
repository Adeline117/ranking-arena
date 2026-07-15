const mockRetrieveSubscription = jest.fn()
const mockCancelSubscription = jest.fn()
jest.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args),
      cancel: (...args: unknown[]) => mockCancelSubscription(...args),
    },
  },
  API_TIER_LIMITS: { free: 100, starter: 10_000, pro: 0 },
}))

const mockUpdateUserSubscription = jest.fn()
jest.mock('../subscription', () => ({
  updateUserSubscription: (...args: unknown[]) => mockUpdateUserSubscription(...args),
}))

const mockRpc = jest.fn()
const mockFrom = jest.fn()
jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  withRetry: (operation: () => unknown) => operation(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/app/api/pro-official-group/route', () => ({
  joinProOfficialGroup: jest.fn().mockResolvedValue({ success: true }),
}))
jest.mock('../nft', () => ({ mintNFTForUser: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/lib/alerts/send-alert', () => ({ sendAlert: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/lib/utils/logger', () => ({ fireAndForget: jest.fn() }))
jest.mock('@/lib/data/notifications', () => ({ sendNotification: jest.fn() }))

import type Stripe from 'stripe'
import { handleCheckoutComplete } from '../checkout'

function checkoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return {
    id: 'cs_test_123',
    mode: 'subscription',
    payment_status: 'paid',
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    metadata: { userId: 'user-123', plan: 'monthly' },
    ...overrides,
  } as Stripe.Checkout.Session
}

function noExistingSubscriptionQuery() {
  return {
    select: () => ({
      eq: () => ({
        in: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  }
}

describe('handleCheckoutComplete entitlement safety', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReturnValue(noExistingSubscriptionQuery())
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_test_123',
      status: 'active',
    })
    mockUpdateUserSubscription.mockResolvedValue(undefined)
    mockRpc.mockResolvedValue({ error: null })
  })

  it('rethrows a Stripe lookup failure so the webhook remains retryable', async () => {
    mockRetrieveSubscription.mockRejectedValue(new Error('temporary Stripe outage'))

    await expect(handleCheckoutComplete(checkoutSession())).rejects.toThrow(
      'temporary Stripe outage'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('provisions a no-payment-required trial only after Stripe confirms trialing', async () => {
    const trial = { id: 'sub_test_123', status: 'trialing' }
    mockRetrieveSubscription.mockResolvedValue(trial)

    await handleCheckoutComplete(checkoutSession({ payment_status: 'no_payment_required' }))

    expect(mockUpdateUserSubscription).toHaveBeenCalledWith('user-123', trial, 'monthly')
  })

  it('does not activate an unpaid API subscription', async () => {
    await handleCheckoutComplete(
      checkoutSession({
        payment_status: 'unpaid',
        metadata: { userId: 'user-123', type: 'api_tier', api_plan: 'pro' },
      })
    )

    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('does not grant lifetime access before the one-time payment is paid', async () => {
    await handleCheckoutComplete(
      checkoutSession({
        mode: 'payment',
        payment_status: 'unpaid',
        subscription: null,
        metadata: { userId: 'user-123', plan: 'lifetime' },
      })
    )

    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('activates a paid lifetime membership through one atomic RPC', async () => {
    await handleCheckoutComplete(
      checkoutSession({
        mode: 'payment',
        payment_status: 'paid',
        subscription: null,
        metadata: { userId: 'user-123', plan: 'lifetime' },
      })
    )

    expect(mockRpc).toHaveBeenCalledWith('activate_lifetime_membership', {
      p_user_id: 'user-123',
      p_stripe_customer_id: 'cus_test_123',
    })
  })
})
