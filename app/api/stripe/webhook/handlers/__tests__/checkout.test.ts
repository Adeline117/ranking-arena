const mockRetrieveSubscription = jest.fn()
const mockCancelSubscription = jest.fn()
const mockGetStripeClient = {}
jest.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args),
      cancel: (...args: unknown[]) => mockCancelSubscription(...args),
    },
  },
  getStripe: () => mockGetStripeClient,
  API_TIER_LIMITS: { free: 100, starter: 10_000, pro: 0 },
}))

const mockActivateLifetimeCheckoutEntitlement = jest.fn()
const mockRecordStripeCheckoutManualReview = jest.fn()
jest.mock('@/lib/stripe/lifetime-entitlement', () => ({
  activateLifetimeCheckoutEntitlement: (...args: unknown[]) =>
    mockActivateLifetimeCheckoutEntitlement(...args),
  recordStripeCheckoutManualReview: (...args: unknown[]) =>
    mockRecordStripeCheckoutManualReview(...args),
  lifetimeActivationGranted: (status: string) =>
    status === 'activated' || status === 'already_activated',
  LIFETIME_RESERVATION_ID_METADATA_KEY: 'lifetime_reservation_id',
  LIFETIME_RESERVATION_NONCE_METADATA_KEY: 'lifetime_reservation_nonce',
}))

const mockCompleteTipCheckout = jest.fn()
jest.mock('@/lib/stripe/tip-completion', () => ({
  completeTipCheckout: (...args: unknown[]) => mockCompleteTipCheckout(...args),
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
const mockMintNFTForUser = jest.fn()
const mockSendAlert = jest.fn()
jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  withRetry: (operation: () => unknown) => operation(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}))

jest.mock('@/app/api/pro-official-group/route', () => ({
  joinProOfficialGroup: (...args: unknown[]) => mockJoinProOfficialGroup(...args),
}))
jest.mock('../nft', () => ({
  mintNFTForUser: (...args: unknown[]) => mockMintNFTForUser(...args),
}))
jest.mock('@/lib/alerts/send-alert', () => ({
  sendAlert: (...args: unknown[]) => mockSendAlert(...args),
}))
jest.mock('@/lib/utils/logger', () => ({ fireAndForget: jest.fn() }))

import type Stripe from 'stripe'
import {
  handleCheckoutComplete,
  handleCheckoutExpired,
  handleTipPaymentCompleted,
} from '../checkout'

function checkoutSession(
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return {
    id: 'cs_test_123',
    mode: 'subscription',
    payment_status: 'paid',
    livemode: true,
    customer: 'cus_test_123',
    subscription: 'sub_test_123',
    metadata: { userId: 'user-123', plan: 'monthly' },
    ...overrides,
  } as Stripe.Checkout.Session
}

const lifetimeUserId = '21e34ce2-43c1-4bcc-8f19-79b36d56605c'
const lifetimeReservationId = '9a8df3e8-e908-4f27-9cb4-8b892d748cc7'
const lifetimeRequestNonce = `lifetime:${lifetimeUserId}:123`
const expiredEvent = { id: 'evt_expired_123', created: 1_800_000_000, livemode: true }
const tipEvent = { id: 'evt_tip_123', created: 1_800_000_000, livemode: true }
const tipCheckoutId = '31e34ce2-43c1-4bcc-8f19-79b36d56605c'
const tipPostId = '41e34ce2-43c1-4bcc-8f19-79b36d56605c'
const tipRecipientId = '51e34ce2-43c1-4bcc-8f19-79b36d56605c'
const tipCheckoutExpiresAt = 1_900_000_000

function expiredTipSession(
  metadataOverrides: Record<string, string> = {},
  sessionOverrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return checkoutSession({
    id: 'cs_tip_expired_123',
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'unpaid',
    status: 'expired',
    subscription: null,
    client_reference_id: tipCheckoutId,
    expires_at: tipCheckoutExpiresAt,
    livemode: true,
    metadata: {
      type: 'tip',
      tip_id: tipCheckoutId,
      user_id: lifetimeUserId,
      from_user_id: lifetimeUserId,
      post_id: tipPostId,
      to_user_id: tipRecipientId,
      amount_cents: '500',
      ...metadataOverrides,
    },
    ...sessionOverrides,
  })
}

function expiredLifetimeSession(
  metadataOverrides: Record<string, string> = {}
): Stripe.Checkout.Session {
  return checkoutSession({
    mode: 'payment',
    payment_status: 'unpaid',
    subscription: null,
    metadata: {
      userId: lifetimeUserId,
      supabase_user_id: lifetimeUserId,
      plan: 'lifetime',
      lifetime_reservation_id: lifetimeReservationId,
      lifetime_reservation_nonce: lifetimeRequestNonce,
      ...metadataOverrides,
    },
  })
}

function paidLifetimeSession(
  metadataOverrides: Record<string, string> = {}
): Stripe.Checkout.Session {
  return checkoutSession({
    mode: 'payment',
    payment_status: 'paid',
    subscription: null,
    metadata: {
      userId: lifetimeUserId,
      supabase_user_id: lifetimeUserId,
      plan: 'lifetime',
      lifetime_reservation_id: lifetimeReservationId,
      lifetime_reservation_nonce: lifetimeRequestNonce,
      ...metadataOverrides,
    },
  })
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
    mockMintNFTForUser.mockResolvedValue(undefined)
    mockSendAlert.mockResolvedValue(undefined)
    mockActivateLifetimeCheckoutEntitlement.mockResolvedValue({ status: 'activated' })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
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

  it('durably reviews and acknowledges an unsupported paid one-time checkout', async () => {
    await expect(
      handleCheckoutComplete(
        checkoutSession({
          mode: 'payment',
          payment_status: 'paid',
          subscription: null,
          metadata: { userId: 'not-a-uuid', plan: 'unknown' },
        })
      )
    ).resolves.toBeUndefined()

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cs_test_123',
        userId: null,
        reasonKey: 'paid_checkout_product_unsupported',
      })
    )
  })

  it('activates a paid lifetime membership through one atomic RPC', async () => {
    const session = paidLifetimeSession()

    await handleCheckoutComplete(session)

    expect(mockActivateLifetimeCheckoutEntitlement).toHaveBeenCalledWith({
      stripe: mockGetStripeClient,
      supabase: expect.anything(),
      session,
      expectedUserId: lifetimeUserId,
    })
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
    expect(mockMintNFTForUser).not.toHaveBeenCalled()
    expect(mockSendAlert).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('acknowledges a durable non-grant lifetime terminal state without direct side effects', async () => {
    mockActivateLifetimeCheckoutEntitlement.mockResolvedValue({
      status: 'reservation_refund_queued',
    })

    await expect(handleCheckoutComplete(paidLifetimeSession())).resolves.toBeUndefined()
    expect(mockJoinProOfficialGroup).not.toHaveBeenCalled()
  })

  it.each([
    [
      'missing alias',
      {
        supabase_user_id: '',
      },
    ],
    [
      'invalid alias',
      {
        userId: 'not-a-uuid',
      },
    ],
    [
      'conflicting aliases',
      {
        supabase_user_id: 'd77f7404-6045-48be-a78e-49a0e18f9db2',
      },
    ],
  ])(
    'durably reviews and acknowledges paid lifetime metadata with a %s',
    async (_label, metadata) => {
      await expect(handleCheckoutComplete(paidLifetimeSession(metadata))).resolves.toBeUndefined()

      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'cs_test_123',
          userId: null,
          reasonKey: 'lifetime_checkout_metadata_invalid',
        })
      )
      expect(mockActivateLifetimeCheckoutEntitlement).not.toHaveBeenCalled()
    }
  )

  it('keeps malformed paid lifetime completion retryable until manual review is durable', async () => {
    mockRecordStripeCheckoutManualReview.mockRejectedValue(
      new Error('manual review persistence unavailable')
    )

    await expect(
      handleCheckoutComplete(paidLifetimeSession({ userId: 'not-a-uuid' }))
    ).rejects.toThrow('manual review persistence unavailable')
    expect(mockActivateLifetimeCheckoutEntitlement).not.toHaveBeenCalled()
  })

  it.each([
    [
      'corrupted plan carried by the reservation marker',
      {
        plan: 'monthly',
      },
    ],
    [
      'invalid reservation id',
      {
        lifetime_reservation_id: 'not-a-uuid',
      },
    ],
    [
      'invalid reservation nonce',
      {
        lifetime_reservation_nonce: 'bad nonce',
      },
    ],
  ])(
    'durably reviews and acknowledges a paid lifetime Session with %s',
    async (_label, metadata) => {
      await expect(handleCheckoutComplete(paidLifetimeSession(metadata))).resolves.toBeUndefined()

      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'cs_test_123',
          userId: lifetimeUserId,
          reasonKey: 'lifetime_checkout_metadata_invalid',
        })
      )
      expect(mockActivateLifetimeCheckoutEntitlement).not.toHaveBeenCalled()
    }
  )
})

describe('handleCheckoutExpired Tip lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: { status: 'expired' }, error: null })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
  })

  it('uses exact signed Session identity to expire the pending Tip before generic abandonment', async () => {
    await handleCheckoutExpired(expiredTipSession(), expiredEvent)

    expect(mockRpc).toHaveBeenCalledWith('expire_pending_tip_checkout_atomic', {
      p_tip_id: tipCheckoutId,
      p_from_user_id: lifetimeUserId,
      p_post_id: tipPostId,
      p_to_user_id: tipRecipientId,
      p_amount_cents: 500,
      p_checkout_session_id: 'cs_tip_expired_123',
      p_checkout_expires_at: new Date(tipCheckoutExpiresAt * 1000).toISOString(),
      p_event_id: 'evt_expired_123',
      p_event_created_at: '2027-01-15T08:00:00.000Z',
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each(['already_expired', 'identity_conflict', 'already_terminal', 'not_found'])(
    'acknowledges durable Tip expiry status %s because the DB records conflicts',
    async (status) => {
      mockRpc.mockResolvedValue({ data: { status }, error: null })

      await expect(
        handleCheckoutExpired(expiredTipSession(), expiredEvent)
      ).resolves.toBeUndefined()

      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['metadata user conflict', { user_id: tipRecipientId }, {}],
    ['invalid amount', { amount_cents: '500.5' }, {}],
    ['snapshot drift', { post_id: 'not-a-uuid' }, {}],
    ['uppercase UUID', { tip_id: tipCheckoutId.toUpperCase() }, {}],
    ['whitespace-padded UUID', { tip_id: ` ${tipCheckoutId}` }, {}],
    ['client reference drift', {}, { client_reference_id: tipPostId }],
  ])('records %s durably and never falls through to analytics', async (_, metadataDrift, drift) => {
    await expect(
      handleCheckoutExpired(expiredTipSession(metadataDrift, drift), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cs_tip_expired_123',
        reasonKey: 'tip_checkout_expiry_metadata_invalid',
      })
    )
  })

  it.each([
    ['test-mode Session', expiredTipSession({}, { livemode: false }), expiredEvent],
    ['test-mode event', expiredTipSession(), { ...expiredEvent, livemode: false }],
    ['wrong Session mode', expiredTipSession({}, { mode: 'subscription' }), expiredEvent],
    ['wrong Session status', expiredTipSession({}, { status: 'open' }), expiredEvent],
    ['paid Session', expiredTipSession({}, { payment_status: 'paid' }), expiredEvent],
    ['subscription Session', expiredTipSession({}, { subscription: 'sub_wrong' }), expiredEvent],
  ])('durably reviews a %s and never expires the Tip', async (_, session, event) => {
    await expect(handleCheckoutExpired(session, event)).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cs_tip_expired_123',
        reasonKey: 'tip_checkout_expiry_metadata_invalid',
        context: expect.objectContaining({
          event_livemode: event.livemode,
          session_livemode: session.livemode,
        }),
      })
    )
  })

  it('throws so Stripe retries when the signed Tip expiry DB transition fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    await expect(handleCheckoutExpired(expiredTipSession(), expiredEvent)).rejects.toThrow(
      'Failed to expire pending Tip checkout: database unavailable'
    )
  })

  it('fails closed on an unknown Tip expiry result', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'unexpected' }, error: null })

    await expect(handleCheckoutExpired(expiredTipSession(), expiredEvent)).rejects.toThrow(
      'Tip checkout expiry returned unexpected status unexpected'
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })
})

describe('handleCheckoutExpired lifetime reservation release', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: { status: 'released' }, error: null })
    mockRecordStripeCheckoutManualReview.mockResolvedValue(undefined)
    mockFrom.mockReturnValue({
      insert: () => Promise.resolve({ error: null }),
    })
  })

  it('releases a bound lifetime seat from exact signed early-expiry identity', async () => {
    await handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)

    expect(mockRpc).toHaveBeenCalledWith('release_lifetime_membership_reservation_atomic', {
      p_user_id: lifetimeUserId,
      p_reservation_id: lifetimeReservationId,
      p_request_nonce: lifetimeRequestNonce,
      p_checkout_session_id: 'cs_test_123',
      p_release_reason: 'stripe_checkout_session_expired',
      p_event_id: 'evt_expired_123',
      p_event_created_at: '2027-01-15T08:00:00.000Z',
    })
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each(['already_released', 'already_expired'])(
    'acknowledges the idempotent %s release state',
    async (status) => {
      mockRpc.mockResolvedValue({ data: { status }, error: null })

      await expect(
        handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
      ).resolves.toBeUndefined()

      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
    }
  )

  it('records malformed lifetime expiry metadata for review and acknowledges it', async () => {
    await expect(
      handleCheckoutExpired(
        expiredLifetimeSession({ lifetime_reservation_id: 'not-a-uuid' }),
        expiredEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cs_test_123',
        userId: lifetimeUserId,
        reasonKey: 'lifetime_expiry_metadata_invalid',
      })
    )
  })

  it('records a partial lifetime identity even when its plan marker is corrupted', async () => {
    await expect(
      handleCheckoutExpired(expiredLifetimeSession({ plan: 'monthly' }), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'lifetime_expiry_metadata_invalid',
        context: expect.objectContaining({ plan: 'monthly' }),
      })
    )
  })

  it('does not attribute an invalid expiry review from only one canonical user alias', async () => {
    await expect(
      handleCheckoutExpired(
        expiredLifetimeSession({ supabase_user_id: 'not-a-uuid' }),
        expiredEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        reasonKey: 'lifetime_expiry_metadata_invalid',
      })
    )
  })

  it('reviews an empty lifetime reservation marker even when the plan marker is corrupted', async () => {
    await expect(
      handleCheckoutExpired(
        expiredLifetimeSession({
          plan: 'monthly',
          lifetime_reservation_id: '',
          lifetime_reservation_nonce: '',
        }),
        expiredEvent
      )
    ).resolves.toBeUndefined()

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'lifetime_expiry_metadata_invalid',
      })
    )
  })

  it('uses signed expiry to release the reserved seat preserved by route-side expiration', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'released' }, error: null })

    await expect(
      handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenNthCalledWith(2, 'release_lifetime_membership_reservation_atomic', {
      p_user_id: lifetimeUserId,
      p_reservation_id: lifetimeReservationId,
      p_request_nonce: lifetimeRequestNonce,
      p_checkout_session_id: null,
      p_release_reason: 'stripe_checkout_abandoned',
      p_event_id: null,
      p_event_created_at: null,
    })
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('retries exact signed release after a reserved-to-bound remediation race', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'released' }, error: null })

    await expect(
      handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRpc).toHaveBeenNthCalledWith(3, 'release_lifetime_membership_reservation_atomic', {
      p_user_id: lifetimeUserId,
      p_reservation_id: lifetimeReservationId,
      p_request_nonce: lifetimeRequestNonce,
      p_checkout_session_id: 'cs_test_123',
      p_release_reason: 'stripe_checkout_session_expired',
      p_event_id: 'evt_expired_123',
      p_event_created_at: '2027-01-15T08:00:00.000Z',
    })
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it.each(['not_found', 'identity_conflict', 'already_converted'])(
    'records the terminal %s release conflict for durable review and acknowledges it',
    async (status) => {
      mockRpc.mockResolvedValue({ data: { status }, error: null })

      await expect(
        handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
      ).resolves.toBeUndefined()

      expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'cs_test_123',
          userId: lifetimeUserId,
          reasonKey: 'lifetime_expiry_release_conflict',
          context: expect.objectContaining({
            release_status: status,
            remediation_status: null,
          }),
        })
      )
    }
  )

  it('records a remaining release_not_verified result after remediation', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })

    await expect(
      handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)
    ).resolves.toBeUndefined()

    expect(mockRecordStripeCheckoutManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'lifetime_expiry_release_conflict',
        context: expect.objectContaining({
          release_status: 'release_not_verified',
          remediation_status: 'release_not_verified',
          retry_exact_status: 'release_not_verified',
        }),
      })
    )
  })

  it('throws when the abandoned-release remediation database write fails', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'remediation database unavailable' },
      })

    await expect(handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)).rejects.toThrow(
      'Failed to remediate an unbound expired lifetime reservation: remediation database unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('throws when the post-race exact release retry database write fails', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'release_not_verified' }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'exact retry database unavailable' },
      })

    await expect(handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)).rejects.toThrow(
      'Failed to retry exact expired lifetime reservation release: exact retry database unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('throws when the exact release database write fails', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'reservation database unavailable' },
    })

    await expect(handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)).rejects.toThrow(
      'Failed to release expired lifetime reservation: reservation database unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('throws when the exact release network call fails', async () => {
    mockRpc.mockRejectedValue(new Error('reservation network unavailable'))

    await expect(handleCheckoutExpired(expiredLifetimeSession(), expiredEvent)).rejects.toThrow(
      'reservation network unavailable'
    )
    expect(mockRecordStripeCheckoutManualReview).not.toHaveBeenCalled()
  })

  it('throws when malformed metadata cannot be durably recorded for review', async () => {
    mockRecordStripeCheckoutManualReview.mockRejectedValue(
      new Error('manual review database unavailable')
    )

    await expect(
      handleCheckoutExpired(
        expiredLifetimeSession({ lifetime_reservation_nonce: 'bad nonce' }),
        expiredEvent
      )
    ).rejects.toThrow('manual review database unavailable')
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('handleTipPaymentCompleted persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockCompleteTipCheckout.mockResolvedValue({ status: 'completed' })
  })

  it('passes only the signed snapshot session id into fresh tip completion', async () => {
    const untrustedSnapshot = checkoutSession({
      mode: 'payment',
      subscription: null,
      customer: 'cus_untrusted',
      payment_intent: 'pi_untrusted',
      metadata: {
        type: 'tip',
        tip_id: 'untrusted-tip-id',
        from_user_id: 'untrusted-user-id',
        amount_cents: '999999',
      },
    })

    await expect(handleTipPaymentCompleted(untrustedSnapshot, tipEvent)).resolves.toEqual({
      status: 'completed',
    })

    expect(mockCompleteTipCheckout).toHaveBeenCalledWith({
      stripe: mockGetStripeClient,
      supabase: { rpc: mockRpc },
      sessionId: 'cs_test_123',
      eventId: 'evt_tip_123',
      eventLivemode: true,
      snapshotLivemode: true,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps technical completion failures retryable', async () => {
    mockCompleteTipCheckout.mockRejectedValue(new Error('tip authority unavailable'))

    await expect(handleTipPaymentCompleted(checkoutSession(), tipEvent)).rejects.toThrow(
      'tip authority unavailable'
    )
  })

  it('contains no direct tip-table or notification side effect', () => {
    const source = require('node:fs').readFileSync(require.resolve('../checkout'), 'utf8')
    const start = source.indexOf('export async function handleTipPaymentCompleted')
    const end = source.indexOf('export async function handleCheckoutExpired', start)
    const handler = source.slice(start, end)

    expect(handler).not.toMatch(/\.from\(['"]tips['"]\)/)
    expect(handler).not.toContain('sendNotification')
  })
})
