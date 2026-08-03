const mockRpc = jest.fn()
const mockAssertRuntime = jest.fn()
const mockAssertPrice = jest.fn()
const mockCreateCheckout = jest.fn()
const mockGetStripe = jest.fn()
const mockRetrieveCustomer = jest.fn()
const mockExpireSession = jest.fn()
const mockStripeCustomerOwned = jest.fn()
const mockListProSubscriptions = jest.fn()
const mockVerifySession = jest.fn()
const mockRecoverExpired = jest.fn()

jest.mock('@/lib/env', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_recovery',
    NEXT_PUBLIC_APP_URL: 'https://app.test.com',
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}))

jest.mock('@/lib/stripe', () => ({
  STRIPE_PRICE_IDS: {
    monthly: 'price_monthly123',
    yearly: 'price_yearly123',
  },
  STRIPE_API_PRICE_IDS: {
    starter: 'price_api_starter',
    pro: 'price_api_pro',
  },
  assertStripePaymentRuntimeReady: () => mockAssertRuntime(),
  assertProPriceReady: (...args: unknown[]) => mockAssertPrice(...args),
  createCheckoutSession: (...args: unknown[]) => mockCreateCheckout(...args),
  getStripe: () => mockGetStripe(),
}))

jest.mock('@/lib/stripe/pro-checkout-recovery', () => ({
  PRO_CHECKOUT_METADATA_KEYS: [
    'currency',
    'plan',
    'pro_membership_reservation_id',
    'pro_price_id',
    'supabase_user_id',
    'trial_days',
    'type',
    'unit_amount',
    'userId',
  ],
  stripeCustomerIsExactlyOwned: (...args: unknown[]) => mockStripeCustomerOwned(...args),
  listCompleteCustomerProSubscriptions: (...args: unknown[]) => mockListProSubscriptions(...args),
  verifyFreshProCheckoutSession: (...args: unknown[]) => mockVerifySession(...args),
  recoverExpiredProCheckoutReservation: (...args: unknown[]) => mockRecoverExpired(...args),
}))

import { runProCheckoutRecoveryInline } from './pro-checkout-reconciler'

const userId = '11111111-1111-4111-8111-111111111111'
const reservationId = '22222222-2222-4222-8222-222222222222'

function candidate(
  status: 'reserved' | 'bound' | 'converted',
  checkoutExpiresAt: number,
  checkoutSessionId: string | null = status === 'reserved' ? null : 'cs_recovery123'
) {
  const converted = status === 'converted'
  return {
    reservation_id: reservationId,
    status,
    user_id: userId,
    livemode: false,
    stripe_customer_id: 'cus_recovery123',
    pro_plan: 'monthly',
    stripe_price_id: 'price_monthly123',
    unit_amount: 499,
    currency: 'usd',
    trial_days: 0,
    success_url: 'https://app.test.com/pricing/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://app.test.com/pricing',
    checkout_expires_at: checkoutExpiresAt,
    checkout_session_id: checkoutSessionId,
    stripe_subscription_id: converted ? 'sub_recovery123' : null,
    completion_payment_status: converted ? 'paid' : null,
    subscription_status: converted ? 'active' : null,
    trial_start: null,
    trial_end: null,
    terminal_event_id: converted ? 'evt_recovery123' : null,
    terminal_event_created: converted ? checkoutExpiresAt - 60 : null,
    created_at: new Date((checkoutExpiresAt - 2700) * 1000).toISOString(),
    claimed_at: new Date().toISOString(),
  }
}

describe('autonomous Pro Checkout reservation recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAssertRuntime.mockReturnValue(undefined)
    mockAssertPrice.mockResolvedValue(undefined)
    mockGetStripe.mockReturnValue({
      customers: { retrieve: (...args: unknown[]) => mockRetrieveCustomer(...args) },
      checkout: {
        sessions: { expire: (...args: unknown[]) => mockExpireSession(...args) },
      },
    })
    mockRetrieveCustomer.mockResolvedValue({ id: 'cus_recovery123' })
    mockStripeCustomerOwned.mockReturnValue(true)
    mockListProSubscriptions.mockResolvedValue([])
    mockCreateCheckout.mockResolvedValue({ id: 'cs_recovery123' })
    mockVerifySession.mockResolvedValue({
      ok: true,
      state: 'open',
      session: { id: 'cs_recovery123' },
    })
    mockRecoverExpired.mockResolvedValue('released')
    mockRpc.mockImplementation((name: string) => {
      if (name === 'bind_pro_membership_checkout_session_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null, status: 200 })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
  })

  it.each([
    ['an expired bound Session after the user never returns', 'bound', 'released'],
    ['an expired unbound create-response orphan', 'reserved', 'released'],
    [
      'a converted Session whose downstream webhook retries were exhausted',
      'converted',
      'converted',
    ],
  ] as const)('autonomously reconciles %s', async (_label, status, recoveryOutcome) => {
    const expiresAt = Math.floor(Date.now() / 1000) - 3600
    mockRpc.mockImplementation((name: string) => {
      if (name === 'claim_pro_membership_checkout_recovery_candidates') {
        return Promise.resolve({
          data: { status: 'claimed', candidates: [candidate(status, expiresAt)] },
          error: null,
        })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })
    mockRecoverExpired.mockResolvedValue(recoveryOutcome)

    const result = await runProCheckoutRecoveryInline()

    expect(result).toMatchObject({
      name: 'pro-checkout-recovery',
      status: 'success',
      detail: {
        attempted: 1,
        released: recoveryOutcome === 'released' ? 1 : 0,
        converted: recoveryOutcome === 'converted' ? 1 : 0,
      },
    })
    expect(mockRecoverExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        customerId: 'cus_recovery123',
        reservation: expect.objectContaining({ status, checkoutExpiresAtSeconds: expiresAt }),
        ...(status === 'converted'
          ? {
              expectedCompletion: {
                eventId: 'evt_recovery123',
                eventCreated: expiresAt - 60,
                subscriptionId: 'sub_recovery123',
              },
            }
          : {}),
      })
    )
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it('replays downstream activation for an unexpired converted Session after the claim cooldown', async () => {
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + 30 * 60
    const eventCreated = now - 5 * 60
    mockRpc.mockResolvedValue({
      data: {
        status: 'claimed',
        candidates: [
          {
            ...candidate('converted', expiresAt),
            terminal_event_created: eventCreated,
          },
        ],
      },
      error: null,
    })
    mockRecoverExpired.mockResolvedValue('converted')

    const result = await runProCheckoutRecoveryInline()

    expect(result).toMatchObject({
      status: 'success',
      detail: { attempted: 1, converted: 1, preserved: 0 },
    })
    expect(mockRecoverExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        reservation: expect.objectContaining({
          status: 'converted',
          checkoutExpiresAtSeconds: expiresAt,
        }),
        expectedCompletion: {
          eventId: 'evt_recovery123',
          eventCreated,
          subscriptionId: 'sub_recovery123',
        },
      })
    )
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it('replays and binds an old unbound reservation before TTL using the stable UUID key', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60
    mockRpc.mockImplementation((name: string) => {
      if (name === 'claim_pro_membership_checkout_recovery_candidates') {
        return Promise.resolve({
          data: { status: 'claimed', candidates: [candidate('reserved', expiresAt)] },
          error: null,
        })
      }
      if (name === 'bind_pro_membership_checkout_session_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null, status: 200 })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })

    const result = await runProCheckoutRecoveryInline()

    expect(result).toMatchObject({ status: 'success', detail: { attempted: 1, bound: 1 } })
    expect(mockCreateCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `pro_membership_checkout_test_${reservationId}`,
        expiresAt,
        clientReferenceId: reservationId,
      })
    )
    expect(mockVerifySession).toHaveBeenCalledTimes(1)
    expect(mockListProSubscriptions).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenCalledWith(
      'bind_pro_membership_checkout_session_atomic',
      expect.objectContaining({ p_reservation_id: reservationId })
    )
  })

  it('fails closed when the service RPC returns an uncertain candidate identity', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'claimed',
        candidates: [
          {
            ...candidate('bound', Math.floor(Date.now() / 1000) - 3600),
            stripe_customer_id: ' cus_recovery123',
          },
        ],
      },
      error: null,
    })

    const result = await runProCheckoutRecoveryInline()

    expect(result).toMatchObject({ status: 'error' })
    expect(mockRecoverExpired).not.toHaveBeenCalled()
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })

  it('keeps an uncertain expired recovery eligible for the next globally leased batch', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 3600
    mockRpc.mockResolvedValue({
      data: { status: 'claimed', candidates: [candidate('bound', expiresAt)] },
      error: null,
    })
    mockRecoverExpired.mockResolvedValue('uncertain')

    const result = await runProCheckoutRecoveryInline()

    expect(result).toMatchObject({
      status: 'success',
      detail: { attempted: 1, preserved: 1, released: 0, converted: 0 },
    })
  })

  it('recovers an expired terminal reservation after both Price and application origin rotate', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 3600
    const rotated = {
      ...candidate('bound', expiresAt),
      stripe_price_id: 'price_retired_monthly',
      success_url: 'https://old.example.com/pricing/success',
      cancel_url: 'https://old.example.com/pricing',
    }
    mockRpc.mockResolvedValue({
      data: { status: 'claimed', candidates: [rotated] },
      error: null,
    })

    const result = await runProCheckoutRecoveryInline()

    expect(result).toMatchObject({ status: 'success', detail: { released: 1 } })
    expect(mockRecoverExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        reservation: expect.objectContaining({ priceId: 'price_retired_monthly' }),
      })
    )
    expect(mockAssertPrice).not.toHaveBeenCalled()
  })

  it('allows an exact terminal historical subscription while pre-TTL binding', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60
    const historicalSubscription = {
      id: 'sub_historical123',
      status: 'canceled',
      trial_start: null,
      trial_end: null,
    }
    mockListProSubscriptions.mockImplementation(async (params: Record<string, unknown>) => {
      const resolve = params.resolveHistoricalAuthority as (
        subscription: typeof historicalSubscription,
        price: { priceId: string; unitAmount: number; currency: string }
      ) => Promise<void>
      await resolve(historicalSubscription, {
        priceId: 'price_retired_monthly',
        unitAmount: 499,
        currency: 'usd',
      })
      return [{ subscription: historicalSubscription, priceIds: ['price_retired_monthly'] }]
    })
    mockRpc.mockImplementation((name: string) => {
      if (name === 'claim_pro_membership_checkout_recovery_candidates') {
        return Promise.resolve({
          data: { status: 'claimed', candidates: [candidate('reserved', expiresAt)] },
          error: null,
        })
      }
      if (name === 'resolve_b2c_recurring_price_authority') {
        return Promise.resolve({
          data: {
            status: 'resolved',
            user_id: userId,
            stripe_customer_id: 'cus_recovery123',
            stripe_price_id: 'price_retired_monthly',
            plan: 'monthly',
            expected_amount: 499,
            currency: 'usd',
            source_kind: 'verified_invoice_event',
          },
          error: null,
        })
      }
      if (name === 'bind_pro_membership_checkout_session_atomic') {
        return Promise.resolve({ data: { status: 'bound' }, error: null, status: 200 })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })

    const result = await runProCheckoutRecoveryInline()

    expect(result).toMatchObject({ status: 'success', detail: { bound: 1 } })
    expect(mockRpc).toHaveBeenCalledWith('resolve_b2c_recurring_price_authority', {
      p_stripe_subscription_id: 'sub_historical123',
      p_stripe_price_id: 'price_retired_monthly',
      p_livemode: false,
    })
  })

  it('preserves pre-TTL checkout when an active unknown historical product appears', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60
    const activeSubscription = {
      id: 'sub_unknown_active',
      status: 'active',
      trial_start: null,
      trial_end: null,
    }
    mockListProSubscriptions.mockImplementation(async (params: Record<string, unknown>) => {
      const resolve = params.resolveHistoricalAuthority as (
        subscription: typeof activeSubscription,
        price: { priceId: string; unitAmount: number; currency: string }
      ) => Promise<void>
      await resolve(activeSubscription, {
        priceId: 'price_unknown_active',
        unitAmount: 499,
        currency: 'usd',
      })
      return [{ subscription: activeSubscription, priceIds: ['price_unknown_active'] }]
    })
    mockRpc.mockImplementation((name: string) => {
      if (name === 'claim_pro_membership_checkout_recovery_candidates') {
        return Promise.resolve({
          data: { status: 'claimed', candidates: [candidate('reserved', expiresAt)] },
          error: null,
        })
      }
      if (name === 'resolve_b2c_recurring_price_authority') {
        return Promise.resolve({ data: { status: 'not_found' }, error: null })
      }
      throw new Error(`Unexpected RPC ${name}`)
    })

    const result = await runProCheckoutRecoveryInline()

    expect(result).toMatchObject({ status: 'success', detail: { preserved: 1, bound: 0 } })
    expect(mockCreateCheckout).not.toHaveBeenCalled()
  })
})
