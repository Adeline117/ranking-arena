/** @jest-environment node */

import type Stripe from 'stripe'
import { createHash } from 'node:crypto'
import type { Database } from '@/lib/supabase/database.types'
import {
  createStripeEntitlementEffectStore,
  drainStripeEntitlementEffects,
  type StripeEntitlementEffectDependencies,
  type StripeEntitlementEffectStore,
} from './entitlement-effect-worker'

type EntitlementEffect = Database['public']['Tables']['stripe_entitlement_effects']['Row']
type EntitlementPayment = Database['public']['Tables']['stripe_entitlement_payments']['Row']

const EFFECT_ID = '11111111-1111-4111-8111-111111111111'
const LEASE_TOKEN = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const GROUP_ID = '44444444-4444-4444-8444-444444444444'
const PAYMENT_ID = '55555555-5555-4555-8555-555555555555'
const CUSTOMER_ID = 'cus_customer1'
const CHARGE_ID = 'ch_charge1'
const PAYMENT_INTENT_ID = 'pi_payment1'
const SUBSCRIPTION_ID = 'sub_subscription1'

function effect(overrides: Partial<EntitlementEffect> = {}): EntitlementEffect {
  return {
    id: EFFECT_ID,
    entitlement_payment_id: PAYMENT_ID,
    user_id: USER_ID,
    source_kind: 'payment',
    source_key: PAYMENT_ID,
    operation_key: 'activation',
    effect_type: 'pro_official_group_join',
    status: 'processing',
    attempt_count: 1,
    available_at: '2026-07-29T00:00:00.000Z',
    lease_token: LEASE_TOKEN,
    lease_expires_at: '2026-07-29T00:02:00.000Z',
    external_ref: null,
    payload: { plan: 'monthly' },
    last_error: null,
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    completed_at: null,
    ...overrides,
  }
}

function payment(overrides: Partial<EntitlementPayment> = {}): EntitlementPayment {
  return {
    id: PAYMENT_ID,
    user_id: USER_ID,
    stripe_customer_id: CUSTOMER_ID,
    payment_kind: 'recurring',
    plan: 'monthly',
    stripe_subscription_id: SUBSCRIPTION_ID,
    stripe_invoice_id: 'in_invoice1',
    stripe_payment_intent_id: PAYMENT_INTENT_ID,
    stripe_charge_id: CHARGE_ID,
    checkout_session_id: null,
    amount_paid: 5000,
    currency: 'usd',
    period_start: '2026-07-01T00:00:00.000Z',
    period_end: '2026-08-01T00:00:00.000Z',
    payment_status: 'succeeded',
    refund_state: 'none',
    refund_succeeded_amount: 0,
    latest_refund_event_id: null,
    latest_refund_event_created_at: null,
    refund_snapshot_event_id: null,
    refund_snapshot_event_created_at: null,
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    ...overrides,
  }
}

function charge(overrides: Partial<Stripe.Charge> = {}): Stripe.Charge {
  return {
    id: CHARGE_ID,
    object: 'charge',
    customer: CUSTOMER_ID,
    payment_intent: PAYMENT_INTENT_ID,
    amount: 5000,
    amount_captured: 5000,
    amount_refunded: 0,
    currency: 'usd',
    livemode: true,
    status: 'succeeded',
    paid: true,
    captured: true,
    refunded: false,
    metadata: {},
    ...overrides,
  } as Stripe.Charge
}

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: SUBSCRIPTION_ID,
    object: 'subscription',
    customer: CUSTOMER_ID,
    livemode: true,
    status: 'active',
    metadata: { userId: USER_ID },
    ...overrides,
  } as Stripe.Subscription
}

function store(overrides: Partial<StripeEntitlementEffectStore> = {}) {
  return {
    lease: jest.fn().mockResolvedValue([effect()]),
    loadPayment: jest.fn().mockResolvedValue(payment()),
    finish: jest.fn().mockResolvedValue({ status: 'completed' }),
    recordDispatchReview: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as jest.Mocked<StripeEntitlementEffectStore>
}

function dependencies(
  params: {
    store?: jest.Mocked<StripeEntitlementEffectStore>
    charge?: Stripe.Charge
    subscription?: Stripe.Subscription
    refund?: Partial<Stripe.Refund>
  } = {}
) {
  const chargeRetrieve = jest.fn().mockResolvedValue(params.charge ?? charge())
  const refundCreate = jest.fn().mockResolvedValue({
    id: 're_refund1',
    object: 'refund',
    charge: CHARGE_ID,
    payment_intent: PAYMENT_INTENT_ID,
    amount: 5000,
    currency: 'usd',
    status: 'succeeded',
    reason: 'requested_by_customer',
    metadata: {
      arena_entitlement_effect_id: EFFECT_ID,
      arena_entitlement_payment_id: PAYMENT_ID,
      arena_reason_key: 'paid_recurring_subject_deleted',
    },
    ...params.refund,
  })
  const refundRetrieve = jest.fn().mockResolvedValue({
    id: 're_refund1',
    object: 'refund',
    charge: CHARGE_ID,
    payment_intent: PAYMENT_INTENT_ID,
    amount: 5000,
    currency: 'usd',
    status: 'succeeded',
    reason: 'requested_by_customer',
    metadata: {
      arena_entitlement_effect_id: EFFECT_ID,
      arena_entitlement_payment_id: PAYMENT_ID,
      arena_reason_key: 'paid_recurring_subject_deleted',
    },
    ...params.refund,
  })
  const subscriptionRetrieve = jest.fn().mockResolvedValue(params.subscription ?? subscription())
  const subscriptionCancel = jest.fn().mockResolvedValue(
    subscription({
      status: 'canceled',
      canceled_at: 1_775_000_000,
    })
  )
  const deps: StripeEntitlementEffectDependencies = {
    store: params.store ?? store(),
    stripe: {
      charges: { retrieve: chargeRetrieve },
      refunds: { create: refundCreate, retrieve: refundRetrieve },
      subscriptions: {
        retrieve: subscriptionRetrieve,
        cancel: subscriptionCancel,
      },
    } as unknown as Stripe,
    expectedLivemode: true,
    joinProOfficialGroup: jest.fn().mockResolvedValue({
      success: true,
      message: 'joined',
      groupId: GROUP_ID,
    }),
    sendRateLimitedAlert: jest.fn().mockResolvedValue({
      sent: true,
      rateLimited: false,
      channels: ['telegram'],
    }),
  }
  return {
    deps,
    chargeRetrieve,
    refundCreate,
    refundRetrieve,
    subscriptionRetrieve,
    subscriptionCancel,
  }
}

describe('Stripe entitlement effect worker', () => {
  it('does not touch Stripe when no durable effects are leased', async () => {
    const emptyStore = store({ lease: jest.fn().mockResolvedValue([]) })
    const { deps, chargeRetrieve, refundCreate, subscriptionRetrieve } = dependencies({
      store: emptyStore,
    })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toEqual({
      count: 0,
      leased: 0,
      completed: 0,
      retryScheduled: 0,
      deadLettered: 0,
      superseded: 0,
    })
    expect(chargeRetrieve).not.toHaveBeenCalled()
    expect(refundCreate).not.toHaveBeenCalled()
    expect(subscriptionRetrieve).not.toHaveBeenCalled()
  })

  it('joins the official group idempotently and finishes the exact lease', async () => {
    const effectStore = store()
    const { deps } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      count: 1,
      completed: 1,
    })
    expect(deps.joinProOfficialGroup).toHaveBeenCalledWith(USER_ID)
    expect(effectStore.finish).toHaveBeenCalledWith({
      effectId: EFFECT_ID,
      leaseToken: LEASE_TOKEN,
      succeeded: true,
      externalRef: `group:${GROUP_ID}`,
      error: null,
      retryAfterSeconds: null,
    })
  })

  it('records permanent payload drift before scheduling a fenced retry', async () => {
    const malformed = effect({ payload: { plan: 'monthly', unexpected: true } })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([malformed]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow(
      'Stripe entitlement effects require retry'
    )
    expect(deps.joinProOfficialGroup).not.toHaveBeenCalled()
    expect(effectStore.recordDispatchReview).toHaveBeenCalledWith({
      effect: malformed,
      error: 'pro_official_group_join payload contract drifted',
    })
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: false,
        externalRef: null,
        retryAfterSeconds: 3600,
      })
    )
  })

  it('refunds only the fresh Stripe Charge remainder with a stable idempotency key', async () => {
    const refundEffect = effect({
      effect_type: 'payment_auto_refund',
      operation_key: 'refund:subject_deleted',
      payload: {
        reason_key: 'paid_recurring_subject_deleted',
        invoice_id: 'in_invoice1',
      },
      user_id: null,
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([refundEffect]),
      loadPayment: jest
        .fn()
        .mockResolvedValue(payment({ user_id: null, refund_succeeded_amount: 1000 })),
    })
    const { deps, refundCreate, chargeRetrieve } = dependencies({
      store: effectStore,
      charge: charge({ amount_refunded: 1000 }),
      refund: { amount: 4000 },
    })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      count: 1,
      completed: 1,
    })
    expect(chargeRetrieve).toHaveBeenCalledWith(CHARGE_ID, {
      expand: ['customer', 'payment_intent'],
    })
    expect(refundCreate).toHaveBeenCalledWith(
      {
        charge: CHARGE_ID,
        amount: 4000,
        reason: 'requested_by_customer',
        metadata: {
          arena_entitlement_effect_id: EFFECT_ID,
          arena_entitlement_payment_id: PAYMENT_ID,
          arena_reason_key: 'paid_recurring_subject_deleted',
        },
      },
      { idempotencyKey: `arena_entitlement_refund_${EFFECT_ID}` }
    )
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: true,
        externalRef: 'refund:re_refund1',
      })
    )
  })

  it('acknowledges a charge already fully refunded without creating another refund', async () => {
    const refundEffect = effect({
      effect_type: 'payment_auto_refund',
      operation_key: 'refund:duplicate_lifetime_purchase',
      payload: {
        reason_key: 'duplicate_lifetime_purchase',
        checkout_session_id: 'cs_checkout1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([refundEffect]) })
    const { deps, refundCreate } = dependencies({
      store: effectStore,
      charge: charge({ refunded: true, amount_refunded: 5000 }),
    })

    await drainStripeEntitlementEffects(deps)
    expect(refundCreate).not.toHaveBeenCalled()
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: true,
        externalRef: `charge:${CHARGE_ID}:fully_refunded`,
      })
    )
  })

  it('never refunds a Charge whose customer identity conflicts with the ledger', async () => {
    const refundEffect = effect({
      effect_type: 'payment_auto_refund',
      operation_key: 'refund:subject_deleted',
      payload: {
        reason_key: 'paid_lifetime_subject_deleted',
        checkout_session_id: 'cs_checkout1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([refundEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps, refundCreate } = dependencies({
      store: effectStore,
      charge: charge({ customer: 'cus_wrong' }),
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow()
    expect(refundCreate).not.toHaveBeenCalled()
    expect(effectStore.recordDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: refundEffect,
        error: 'Stripe Charge identity conflicted with payment authority',
      })
    )
  })

  it('keeps a pending Stripe Refund retryable instead of falsely completing it', async () => {
    const refundEffect = effect({
      effect_type: 'payment_auto_refund',
      operation_key: 'refund:subject_deleted',
      payload: {
        reason_key: 'paid_recurring_subject_deleted',
        invoice_id: 'in_invoice1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([refundEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps } = dependencies({
      store: effectStore,
      refund: { status: 'pending' },
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(effectStore.recordDispatchReview).not.toHaveBeenCalled()
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: false,
        externalRef: 'refund:re_refund1',
        retryAfterSeconds: 30,
      })
    )
  })

  it('retrieves a persisted pending Refund instead of replaying its create request', async () => {
    const refundEffect = effect({
      effect_type: 'payment_auto_refund',
      operation_key: 'refund:subject_deleted',
      external_ref: 'refund:re_refund1',
      payload: {
        reason_key: 'paid_recurring_subject_deleted',
        invoice_id: 'in_invoice1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([refundEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps, refundCreate, refundRetrieve } = dependencies({
      store: effectStore,
      refund: { status: 'pending' },
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(refundRetrieve).toHaveBeenCalledWith('re_refund1')
    expect(refundCreate).not.toHaveBeenCalled()
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: false,
        externalRef: 'refund:re_refund1',
      })
    )
  })

  it('completes from the fresh terminal state of a persisted Refund', async () => {
    const refundEffect = effect({
      effect_type: 'payment_auto_refund',
      operation_key: 'refund:subject_deleted',
      external_ref: 'refund:re_refund1',
      payload: {
        reason_key: 'paid_recurring_subject_deleted',
        invoice_id: 'in_invoice1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([refundEffect]) })
    const { deps, refundCreate, refundRetrieve } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      count: 1,
      completed: 1,
    })
    expect(refundRetrieve).toHaveBeenCalledWith('re_refund1')
    expect(refundCreate).not.toHaveBeenCalled()
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: true,
        externalRef: 'refund:re_refund1',
      })
    )
  })

  it.each(['failed', 'canceled'] as const)(
    'uses a stable successor key after a persisted Refund becomes %s',
    async (status) => {
      const refundEffect = effect({
        effect_type: 'payment_auto_refund',
        operation_key: 'refund:subject_deleted',
        external_ref: 'refund:re_refund1',
        payload: {
          reason_key: 'paid_recurring_subject_deleted',
          invoice_id: 'in_invoice1',
        },
      })
      const effectStore = store({ lease: jest.fn().mockResolvedValue([refundEffect]) })
      const { deps, refundCreate, refundRetrieve } = dependencies({
        store: effectStore,
        refund: { id: 're_refund2', status: 'succeeded' },
      })
      refundRetrieve.mockResolvedValueOnce({
        id: 're_refund1',
        object: 'refund',
        charge: CHARGE_ID,
        payment_intent: PAYMENT_INTENT_ID,
        amount: 5000,
        currency: 'usd',
        status,
        reason: 'requested_by_customer',
        metadata: {
          arena_entitlement_effect_id: EFFECT_ID,
          arena_entitlement_payment_id: PAYMENT_ID,
          arena_reason_key: 'paid_recurring_subject_deleted',
        },
      })

      await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
        count: 1,
        completed: 1,
      })
      expect(refundCreate).toHaveBeenCalledWith(expect.any(Object), {
        idempotencyKey: `arena_entitlement_refund_${EFFECT_ID}_${createHash('sha256')
          .update('re_refund1', 'utf8')
          .digest('hex')}`,
      })
      expect(effectStore.finish).toHaveBeenCalledWith(
        expect.objectContaining({
          succeeded: true,
          externalRef: 'refund:re_refund2',
        })
      )
    }
  )

  it('persists the successor identity before retrying another pending Refund', async () => {
    const refundEffect = effect({
      effect_type: 'payment_auto_refund',
      operation_key: 'refund:subject_deleted',
      external_ref: 'refund:re_refund1',
      payload: {
        reason_key: 'paid_recurring_subject_deleted',
        invoice_id: 'in_invoice1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([refundEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps, refundRetrieve } = dependencies({
      store: effectStore,
      refund: { id: 're_refund2', status: 'pending' },
    })
    refundRetrieve.mockResolvedValueOnce({
      id: 're_refund1',
      object: 'refund',
      charge: CHARGE_ID,
      payment_intent: PAYMENT_INTENT_ID,
      amount: 5000,
      currency: 'usd',
      status: 'failed',
      reason: 'requested_by_customer',
      metadata: {
        arena_entitlement_effect_id: EFFECT_ID,
        arena_entitlement_payment_id: PAYMENT_ID,
        arena_reason_key: 'paid_recurring_subject_deleted',
      },
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: false,
        externalRef: 'refund:re_refund2',
      })
    )
  })

  it('rejects a malformed persisted Refund reference before touching Stripe', async () => {
    const refundEffect = effect({
      effect_type: 'payment_auto_refund',
      operation_key: 'refund:subject_deleted',
      external_ref: 'refund:../../wrong',
      payload: {
        reason_key: 'paid_recurring_subject_deleted',
        invoice_id: 'in_invoice1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([refundEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps, chargeRetrieve, refundCreate, refundRetrieve } = dependencies({
      store: effectStore,
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(chargeRetrieve).not.toHaveBeenCalled()
    expect(refundRetrieve).not.toHaveBeenCalled()
    expect(refundCreate).not.toHaveBeenCalled()
    expect(effectStore.recordDispatchReview).toHaveBeenCalledWith(
      expect.objectContaining({
        effect: refundEffect,
        error: 'leased entitlement effect is malformed',
      })
    )
  })

  it('cancels only the exact superseded subscription without proration', async () => {
    const cancelEffect = effect({
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'lifetime_membership_activated',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([cancelEffect]),
      loadPayment: jest.fn().mockResolvedValue(
        payment({
          payment_kind: 'lifetime',
          plan: 'lifetime',
          stripe_subscription_id: null,
        })
      ),
    })
    const { deps, subscriptionCancel } = dependencies({ store: effectStore })

    await drainStripeEntitlementEffects(deps)
    expect(subscriptionCancel).toHaveBeenCalledWith(
      SUBSCRIPTION_ID,
      { invoice_now: false, prorate: false },
      { idempotencyKey: `arena_entitlement_cancel_${EFFECT_ID}` }
    )
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRef: `subscription:${SUBSCRIPTION_ID}:canceled`,
      })
    )
  })

  it('does not cancel an already canceled Stripe subscription twice', async () => {
    const cancelEffect = effect({
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'lifetime_membership_activated',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([cancelEffect]),
      loadPayment: jest
        .fn()
        .mockResolvedValue(payment({ payment_kind: 'lifetime', plan: 'lifetime' })),
    })
    const { deps, subscriptionCancel } = dependencies({
      store: effectStore,
      subscription: subscription({ status: 'canceled' }),
    })

    await drainStripeEntitlementEffects(deps)
    expect(subscriptionCancel).not.toHaveBeenCalled()
  })

  it('delivers manual-review alerts with an effect-scoped dedup key', async () => {
    const reviewEffect = effect({
      effect_type: 'payment_manual_review',
      operation_key: 'review:parallel_recurring_subscription',
      payload: { reason_key: 'parallel_recurring_subscription' },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([reviewEffect]) })
    const { deps } = dependencies({ store: effectStore })

    await drainStripeEntitlementEffects(deps)
    expect(deps.sendRateLimitedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'critical',
        details: expect.objectContaining({
          effect_id: EFFECT_ID,
          reason_key: 'parallel_recurring_subscription',
        }),
      }),
      `stripe-entitlement-effect:${EFFECT_ID}`,
      15 * 60_000
    )
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({ externalRef: `alert:${EFFECT_ID}` })
    )
  })

  it('retries an alert that was neither delivered nor deduplicated', async () => {
    const reviewEffect = effect({
      effect_type: 'payment_manual_review',
      operation_key: 'review:parallel_recurring_subscription',
      payload: { reason_key: 'parallel_recurring_subscription' },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([reviewEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps } = dependencies({ store: effectStore })
    ;(deps.sendRateLimitedAlert as jest.Mock).mockResolvedValue({
      sent: false,
      rateLimited: false,
      channels: [],
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({ succeeded: false, retryAfterSeconds: 30 })
    )
  })

  it('does not accept an identity-conflict finish after an external success', async () => {
    const effectStore = store()
    effectStore.finish
      .mockResolvedValueOnce({ status: 'identity_conflict' })
      .mockResolvedValueOnce({ status: 'retry_scheduled' })
    const { deps } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(effectStore.finish).toHaveBeenCalledTimes(2)
    expect(effectStore.finish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ succeeded: false })
    )
  })

  it('records a review before a tenth failed attempt becomes dead-lettered', async () => {
    const exhausted = effect({ attempt_count: 10 })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([exhausted]) })
    effectStore.finish.mockResolvedValue({ status: 'dead_lettered' })
    const { deps } = dependencies({ store: effectStore })
    ;(deps.joinProOfficialGroup as jest.Mock).mockResolvedValue({
      success: false,
      message: 'owner_not_found',
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(effectStore.recordDispatchReview).toHaveBeenCalledTimes(1)
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({ succeeded: false, retryAfterSeconds: 3600 })
    )
  })
})

describe('Supabase Stripe entitlement effect store', () => {
  it('uses the exact lease, finish, payment, and review RPC contracts', async () => {
    const leased = [effect()]
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({ data: leased, error: null })
      .mockResolvedValueOnce({ data: { status: 'completed' }, error: null })
      .mockResolvedValueOnce({ data: { status: 'recorded' }, error: null })
    const maybeSingle = jest.fn().mockResolvedValue({ data: payment(), error: null })
    const eq = jest.fn().mockReturnValue({ maybeSingle })
    const select = jest.fn().mockReturnValue({ eq })
    const from = jest.fn().mockReturnValue({ select })
    const effectStore = createStripeEntitlementEffectStore({
      rpc,
      from,
    } as never)

    await expect(effectStore.lease(10, 120)).resolves.toEqual(leased)
    await expect(effectStore.loadPayment(PAYMENT_ID)).resolves.toMatchObject({
      id: PAYMENT_ID,
    })
    await expect(
      effectStore.finish({
        effectId: EFFECT_ID,
        leaseToken: LEASE_TOKEN,
        succeeded: true,
        externalRef: `group:${GROUP_ID}`,
        error: null,
        retryAfterSeconds: null,
      })
    ).resolves.toEqual({ status: 'completed' })
    await expect(
      effectStore.recordDispatchReview({
        effect: effect(),
        error: 'identity conflict',
      })
    ).resolves.toBeUndefined()

    expect(rpc).toHaveBeenNthCalledWith(1, 'lease_stripe_entitlement_effects_atomic', {
      p_limit: 10,
      p_lease_seconds: 120,
    })
    expect(from).toHaveBeenCalledWith('stripe_entitlement_payments')
    expect(eq).toHaveBeenCalledWith('id', PAYMENT_ID)
    expect(rpc).toHaveBeenNthCalledWith(2, 'finish_stripe_entitlement_effect_atomic', {
      p_effect_id: EFFECT_ID,
      p_lease_token: LEASE_TOKEN,
      p_succeeded: true,
      p_external_ref: `group:${GROUP_ID}`,
      p_error: null,
      p_retry_after_seconds: null,
    })
    expect(rpc).toHaveBeenNthCalledWith(
      3,
      'record_stripe_manual_review_atomic',
      expect.objectContaining({
        p_object_type: 'entitlement_effect',
        p_object_id: EFFECT_ID,
        p_reason_key: 'entitlement_effect_dispatch_failed',
      })
    )
  })
})
