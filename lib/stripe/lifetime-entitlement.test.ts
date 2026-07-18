const mockResolveCheckoutSessionAuthority = jest.fn()

jest.mock('@/lib/stripe', () => ({
  STRIPE_PRICE_IDS: {
    monthly: 'price_monthly',
    yearly: 'price_yearly',
    lifetime: 'price_lifetime',
  },
}))

jest.mock('@/lib/stripe/entitlement-authority', () => {
  const actual = jest.requireActual('@/lib/stripe/entitlement-authority')
  return {
    ...actual,
    resolveCheckoutSessionAuthority: (...args: unknown[]) =>
      mockResolveCheckoutSessionAuthority(...args),
  }
})

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { StripeAuthorityError } from '@/lib/stripe/entitlement-authority'
import {
  activateLifetimeCheckoutEntitlement,
  lifetimeActivationGranted,
  recordStripeCheckoutManualReview,
} from '@/lib/stripe/lifetime-entitlement'

const session = {
  id: 'cs_lifetime_123',
  metadata: {
    userId: 'user-123',
    plan: 'lifetime',
    lifetime_reservation_id: '9A8DF3E8-E908-4F27-9CB4-8B892D748CC7',
  },
} as unknown as Stripe.Checkout.Session

const authority = {
  kind: 'lifetime_payment' as const,
  userId: 'user-123',
  customerId: 'cus_lifetime_123',
  sessionId: 'cs_lifetime_123',
  paymentIntentId: 'pi_lifetime_123',
  chargeId: 'ch_lifetime_123',
  priceId: 'price_lifetime',
  plan: 'lifetime' as const,
  amount: 4_999,
  currency: 'usd',
  paidAt: 1_800_000_000,
  refundReference: {
    invoicePaymentId: null,
    invoiceId: null,
    paymentIntentId: 'pi_lifetime_123',
    chargeId: 'ch_lifetime_123',
    originalAmount: 4_999,
  },
}

describe('activateLifetimeCheckoutEntitlement', () => {
  const rpc = jest.fn()
  const supabase = { rpc } as unknown as SupabaseClient<Database>
  const stripe = {} as Stripe

  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveCheckoutSessionAuthority.mockResolvedValue(authority)
    rpc.mockResolvedValue({ data: { status: 'activated' }, error: null })
  })

  it('maps exact resolved Stripe identity into the ten-argument atomic activation', async () => {
    const outcome = await activateLifetimeCheckoutEntitlement({
      stripe,
      supabase,
      session,
      expectedUserId: 'user-123',
    })

    expect(mockResolveCheckoutSessionAuthority).toHaveBeenCalledWith(stripe, session, {
      expectedUserId: 'user-123',
      products: {
        prices: {
          monthly: ['price_monthly'],
          yearly: ['price_yearly'],
          lifetime: ['price_lifetime'],
        },
        expectedCurrency: 'usd',
      },
    })
    expect(rpc).toHaveBeenCalledWith('activate_lifetime_membership_with_identity_atomic', {
      p_user_id: 'user-123',
      p_stripe_customer_id: 'cus_lifetime_123',
      p_checkout_session_id: 'cs_lifetime_123',
      p_reservation_id: '9a8df3e8-e908-4f27-9cb4-8b892d748cc7',
      p_stripe_payment_intent_id: 'pi_lifetime_123',
      p_stripe_charge_id: 'ch_lifetime_123',
      p_amount_paid: 4_999,
      p_currency: 'usd',
      p_paid_at: '2027-01-15T08:00:00.000Z',
      p_payment_status: 'succeeded',
    })
    expect(outcome).toEqual({ status: 'activated', authority })
    expect(lifetimeActivationGranted(outcome.status)).toBe(true)
  })

  it('passes a missing reservation as null so the database queues a safe refund', async () => {
    rpc.mockResolvedValue({
      data: { status: 'reservation_refund_queued' },
      error: null,
    })

    const outcome = await activateLifetimeCheckoutEntitlement({
      stripe,
      supabase,
      session: { ...session, metadata: { userId: 'user-123', plan: 'lifetime' } },
      expectedUserId: 'user-123',
    })

    expect(rpc).toHaveBeenCalledWith(
      'activate_lifetime_membership_with_identity_atomic',
      expect.objectContaining({ p_reservation_id: null })
    )
    expect(outcome.status).toBe('reservation_refund_queued')
    expect(lifetimeActivationGranted(outcome.status)).toBe(false)
  })

  it('durably records deterministic authority failures without calling activation', async () => {
    mockResolveCheckoutSessionAuthority.mockRejectedValue(
      new StripeAuthorityError({
        code: 'amount_mismatch',
        stage: 'product',
        message: 'Payment amounts do not match',
        objectIds: { sessionId: 'cs_lifetime_123', paymentIntentId: 'pi_lifetime_123' },
        details: { expected: 4_999, actual: 1 },
      })
    )
    rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null })

    const outcome = await activateLifetimeCheckoutEntitlement({
      stripe,
      supabase,
      session,
      expectedUserId: 'user-123',
    })

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith(
      'record_stripe_manual_review_atomic',
      expect.objectContaining({
        p_object_type: 'checkout_session',
        p_object_id: 'cs_lifetime_123',
        p_user_id: null,
        p_reason_key: 'checkout_authority:amount_mismatch',
      })
    )
    expect(outcome).toEqual({
      status: 'authority_review_recorded',
      reviewCode: 'amount_mismatch',
    })
  })

  it.each([
    [
      'amount',
      { ...authority, amount: 1 },
      'amount_mismatch',
      'checkout_authority:amount_mismatch',
    ],
    [
      'currency',
      { ...authority, currency: 'eur' },
      'currency_mismatch',
      'checkout_authority:currency_mismatch',
    ],
  ])(
    'durably reviews an internally consistent lifetime authority with the wrong configured %s',
    async (_label, mismatchedAuthority, reviewCode, reasonKey) => {
      mockResolveCheckoutSessionAuthority.mockResolvedValue(mismatchedAuthority)
      rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null })

      const outcome = await activateLifetimeCheckoutEntitlement({
        stripe,
        supabase,
        session,
        expectedUserId: 'user-123',
      })

      expect(rpc).toHaveBeenCalledTimes(1)
      expect(rpc).toHaveBeenCalledWith(
        'record_stripe_manual_review_atomic',
        expect.objectContaining({
          p_object_id: 'cs_lifetime_123',
          p_reason_key: reasonKey,
        })
      )
      expect(outcome).toEqual({
        status: 'authority_review_recorded',
        reviewCode,
      })
    }
  )

  it('rejects an unknown database status instead of reporting a grant', async () => {
    rpc.mockResolvedValue({ data: { status: 'mystery' }, error: null })

    await expect(
      activateLifetimeCheckoutEntitlement({
        stripe,
        supabase,
        session,
        expectedUserId: 'user-123',
      })
    ).rejects.toThrow('unexpected status mystery')
  })

  it.each(['recorded', 'already_recorded'])(
    'accepts only the durable manual-review %s status',
    async (status) => {
      rpc.mockResolvedValue({ data: { status }, error: null })

      await expect(
        recordStripeCheckoutManualReview({
          supabase,
          sessionId: 'cs_lifetime_123',
          userId: '21e34ce2-43c1-4bcc-8f19-79b36d56605c',
          reasonKey: 'lifetime_expiry_release_conflict',
          reason: 'The exact reservation could not be released.',
          context: { release_status: 'identity_conflict' },
        })
      ).resolves.toBeUndefined()

      expect(rpc).toHaveBeenCalledWith('record_stripe_manual_review_atomic', {
        p_object_type: 'checkout_session',
        p_object_id: 'cs_lifetime_123',
        p_user_id: '21e34ce2-43c1-4bcc-8f19-79b36d56605c',
        p_reason_key: 'lifetime_expiry_release_conflict',
        p_reason: 'The exact reservation could not be released.',
        p_context: { release_status: 'identity_conflict' },
      })
    }
  )

  it('throws on an unknown manual-review status instead of acknowledging the event', async () => {
    rpc.mockResolvedValue({ data: { status: 'mystery' }, error: null })

    await expect(
      recordStripeCheckoutManualReview({
        supabase,
        sessionId: 'cs_lifetime_123',
        userId: '21e34ce2-43c1-4bcc-8f19-79b36d56605c',
        reasonKey: 'lifetime_expiry_release_conflict',
        reason: 'The exact reservation could not be released.',
        context: { release_status: 'identity_conflict' },
      })
    ).rejects.toThrow('unexpected status mystery')
  })

  it.each([
    ['missing', null],
    ['invalid', 'not-a-uuid'],
  ])('normalizes a %s manual-review user identity to null', async (_label, userId) => {
    rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null })

    await recordStripeCheckoutManualReview({
      supabase,
      sessionId: 'cs_lifetime_123',
      userId,
      reasonKey: 'paid_checkout_product_unsupported',
      reason: 'Unsupported paid checkout.',
      context: {},
    })

    expect(rpc).toHaveBeenCalledWith(
      'record_stripe_manual_review_atomic',
      expect.objectContaining({ p_user_id: null })
    )
  })

  it('canonicalizes an uppercase valid manual-review user identity', async () => {
    rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null })

    await recordStripeCheckoutManualReview({
      supabase,
      sessionId: 'cs_lifetime_123',
      userId: '21E34CE2-43C1-4BCC-8F19-79B36D56605C',
      reasonKey: 'paid_checkout_product_unsupported',
      reason: 'Unsupported paid checkout.',
      context: {},
    })

    expect(rpc).toHaveBeenCalledWith(
      'record_stripe_manual_review_atomic',
      expect.objectContaining({ p_user_id: '21e34ce2-43c1-4bcc-8f19-79b36d56605c' })
    )
  })
})
