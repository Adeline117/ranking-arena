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
const mockGetProPlanFromPriceId = jest.fn()
jest.mock('../subscription', () => ({
  updateUserSubscription: (...args: unknown[]) => mockUpdateUserSubscription(...args),
  getProPlanFromPriceId: (...args: unknown[]) => mockGetProPlanFromPriceId(...args),
}))

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockJoinProOfficialGroup = jest.fn()
jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  withRetry: (operation: () => unknown) => operation(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/app/api/pro-official-group/route', () => ({
  joinProOfficialGroup: (...args: unknown[]) => mockJoinProOfficialGroup(...args),
}))
jest.mock('../nft', () => ({ mintNFTForUser: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/lib/alerts/send-alert', () => ({ sendAlert: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/lib/utils/logger', () => ({ fireAndForget: jest.fn() }))
jest.mock('@/lib/data/notifications', () => ({ sendNotification: jest.fn() }))

import type Stripe from 'stripe'
import { handleCheckoutComplete, handleTipPaymentCompleted } from '../checkout'

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

function tipUpdateQuery(
  error: { message: string } | null,
  data: { id: string } | null = { id: 'tip-123' }
) {
  return {
    update: () => ({
      eq: () => ({
        select: () => ({
          maybeSingle: async () => ({ data, error }),
        }),
      }),
    }),
  }
}

describe('handleCheckoutComplete entitlement safety', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockFrom.mockReturnValue(noExistingSubscriptionQuery())
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_test_123',
      status: 'active',
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
    })
    mockUpdateUserSubscription.mockResolvedValue(undefined)
    mockGetProPlanFromPriceId.mockReturnValue('monthly')
    mockJoinProOfficialGroup.mockResolvedValue({ success: true, groupId: 'pro-group' })
    mockRpc.mockResolvedValue({ error: null })
  })

  it('keeps a paid checkout retryable when user metadata is missing', async () => {
    await expect(
      handleCheckoutComplete(checkoutSession({ metadata: { plan: 'monthly' } }))
    ).rejects.toThrow('Checkout cs_test_123 cannot be mapped to a user')
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('keeps a subscription checkout retryable when its subscription id is missing', async () => {
    await expect(handleCheckoutComplete(checkoutSession({ subscription: null }))).rejects.toThrow(
      'Checkout cs_test_123 is missing its subscription ID'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('rejects invalid API entitlement metadata instead of acknowledging it', async () => {
    await expect(
      handleCheckoutComplete(
        checkoutSession({
          metadata: { userId: 'user-123', type: 'api_tier', api_plan: 'enterprise' },
        })
      )
    ).rejects.toThrow('Checkout cs_test_123 has invalid API plan metadata')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rethrows a Stripe lookup failure so the webhook remains retryable', async () => {
    mockRetrieveSubscription.mockRejectedValue(new Error('temporary Stripe outage'))

    await expect(handleCheckoutComplete(checkoutSession())).rejects.toThrow(
      'temporary Stripe outage'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('rethrows an existing-subscription lookup failure before provisioning', async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          in: () => ({
            maybeSingle: async () => ({
              data: null,
              error: { message: 'temporary subscriptions read failure' },
            }),
          }),
        }),
      }),
    })

    await expect(handleCheckoutComplete(checkoutSession())).rejects.toThrow(
      'Failed to check existing subscription: temporary subscriptions read failure'
    )
    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('provisions a no-payment-required trial only after Stripe confirms trialing', async () => {
    const trial = {
      id: 'sub_test_123',
      status: 'trialing',
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
    }
    mockRetrieveSubscription.mockResolvedValue(trial)

    await handleCheckoutComplete(checkoutSession({ payment_status: 'no_payment_required' }))

    expect(mockUpdateUserSubscription).toHaveBeenCalledWith('user-123', trial, 'monthly')
  })

  it('does not grant Pro for an unrecognized subscription price', async () => {
    mockGetProPlanFromPriceId.mockReturnValue(null)

    await expect(handleCheckoutComplete(checkoutSession())).rejects.toThrow(
      'Cannot map Stripe price price_pro_monthly to a subscription plan'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('does not trust plan metadata that disagrees with the Stripe price', async () => {
    mockGetProPlanFromPriceId.mockReturnValue('yearly')

    await expect(handleCheckoutComplete(checkoutSession())).rejects.toThrow(
      'Checkout plan metadata monthly does not match Stripe price plan yearly'
    )
    expect(mockUpdateUserSubscription).not.toHaveBeenCalled()
  })

  it('retries a paid subscription when official-group entitlement persistence fails', async () => {
    mockJoinProOfficialGroup.mockResolvedValue({
      success: false,
      message: 'group write unavailable',
    })

    await expect(handleCheckoutComplete(checkoutSession())).rejects.toThrow(
      'Failed to join Pro official group: group write unavailable'
    )
    expect(mockUpdateUserSubscription).toHaveBeenCalledTimes(1)
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

  it('does not acknowledge an unsupported paid one-time checkout', async () => {
    await expect(
      handleCheckoutComplete(
        checkoutSession({
          mode: 'payment',
          payment_status: 'paid',
          subscription: null,
          metadata: { userId: 'user-123', plan: 'unknown' },
        })
      )
    ).rejects.toThrow('Paid checkout cs_test_123 has no supported product mapping')
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

  it('retries a paid lifetime checkout when official-group entitlement persistence fails', async () => {
    mockJoinProOfficialGroup.mockResolvedValue({
      success: false,
      message: 'group write unavailable',
    })

    await expect(
      handleCheckoutComplete(
        checkoutSession({
          mode: 'payment',
          payment_status: 'paid',
          subscription: null,
          metadata: { userId: 'user-123', plan: 'lifetime' },
        })
      )
    ).rejects.toThrow('Failed to join Pro official group: group write unavailable')
    expect(mockRpc).toHaveBeenCalledWith('activate_lifetime_membership', {
      p_user_id: 'user-123',
      p_stripe_customer_id: 'cus_test_123',
    })
  })
})

describe('handleTipPaymentCompleted persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
  })

  it('rejects a paid tip event without its persisted tip identity', async () => {
    await expect(
      handleTipPaymentCompleted(
        checkoutSession({
          mode: 'payment',
          subscription: null,
          payment_intent: 'pi_tip_123',
          metadata: { type: 'tip' },
        })
      )
    ).rejects.toThrow('Paid tip checkout cs_test_123 is missing tip_id')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('throws when the paid tip cannot be marked completed', async () => {
    mockFrom.mockReturnValue(tipUpdateQuery({ message: 'tips update unavailable' }))

    await expect(
      handleTipPaymentCompleted(
        checkoutSession({
          mode: 'payment',
          subscription: null,
          payment_intent: 'pi_tip_123',
          metadata: { type: 'tip', tip_id: 'tip-123' },
        })
      )
    ).rejects.toThrow('Failed to mark tip completed: tips update unavailable')
  })

  it('throws when the paid tip update matched no persisted row', async () => {
    mockFrom.mockReturnValue(tipUpdateQuery(null, null))

    await expect(
      handleTipPaymentCompleted(
        checkoutSession({
          mode: 'payment',
          subscription: null,
          payment_intent: 'pi_tip_123',
          metadata: { type: 'tip', tip_id: 'tip-missing' },
        })
      )
    ).rejects.toThrow('Failed to mark tip completed: tip tip-missing was not found')
  })

  it('completes normally after the paid tip is persisted', async () => {
    mockFrom.mockReturnValue(tipUpdateQuery(null))

    await expect(
      handleTipPaymentCompleted(
        checkoutSession({
          mode: 'payment',
          subscription: null,
          payment_intent: 'pi_tip_123',
          metadata: { type: 'tip', tip_id: 'tip-123' },
        })
      )
    ).resolves.toBeUndefined()
  })
})
