/** @jest-environment node */

import type Stripe from 'stripe'
import type { Database } from '@/lib/supabase/database.types'
import {
  createStripeEntitlementEffectStore,
  drainStripeEntitlementEffects,
  type StripeEntitlementEffectDependencies,
  type StripeEntitlementEffectStore,
} from './entitlement-effect-worker'

type EntitlementEffect = Database['public']['Tables']['stripe_entitlement_effects']['Row']
type EntitlementPayment = Database['public']['Tables']['stripe_entitlement_payments']['Row']
type TrialEntitlement = Database['public']['Tables']['stripe_trial_entitlements']['Row']

const EFFECT_ID = '11111111-1111-4111-8111-111111111111'
const LEASE_TOKEN = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const GROUP_ID = '44444444-4444-4444-8444-444444444444'
const PAYMENT_ID = '55555555-5555-4555-8555-555555555555'
const TRIAL_ID = '66666666-6666-4666-8666-666666666666'
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
    dispatch_committed_at: null,
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

function trial(overrides: Partial<TrialEntitlement> = {}): TrialEntitlement {
  return {
    id: TRIAL_ID,
    user_id: USER_ID,
    stripe_customer_id: CUSTOMER_ID,
    stripe_subscription_id: SUBSCRIPTION_ID,
    plan: 'monthly',
    period_start: '2026-07-01T00:00:00.000Z',
    period_end: '2026-07-08T00:00:00.000Z',
    verified_at: '2026-07-01T00:00:00.000Z',
    revoked_at: '2026-07-01T00:00:01.000Z',
    revoke_reason: 'account_recovery_billing_blocked',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:01.000Z',
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
    loadTrial: jest.fn().mockResolvedValue(trial()),
    claimSubscriptionCancelDispatch: jest.fn().mockResolvedValue({ status: 'dispatch_committed' }),
    claimRecoveryPaymentRefundDispatch: jest
      .fn()
      .mockResolvedValue({ status: 'dispatch_committed' }),
    readLifetimeRestoreAuthority: jest.fn().mockResolvedValue({ status: 'not_found' }),
    restoreLifetimeAuthority: jest.fn().mockResolvedValue({ status: 'restored' }),
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
      refunds: { create: refundCreate },
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

  it('executes an exact subscription-state official-group restore effect', async () => {
    const restoreEffect = effect({
      effect_type: 'pro_official_group_restore',
      operation_key: 'state_restore:evt_state_restore_1',
      payload: { event_id: 'evt_state_restore_1' },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([restoreEffect]) })
    const { deps } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      count: 1,
      completed: 1,
    })
    expect(deps.joinProOfficialGroup).toHaveBeenCalledWith(USER_ID)
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: true,
        externalRef: `group:${GROUP_ID}`,
      })
    )
  })

  it('executes an exact inactive-to-active projection restore effect', async () => {
    const restoreEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'projection',
      source_key: USER_ID,
      effect_type: 'pro_official_group_restore',
      operation_key: 'unban_restore:2026-07-28 00:00:00+00',
      payload: {
        boundary_at: '2026-07-01T00:00:00+00:00',
        inactive_boundary_at: '2026-07-28T00:00:00+00:00',
        unban_transition_at: '2026-07-29T00:00:00+00:00',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([restoreEffect]) })
    const { deps } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      count: 1,
      completed: 1,
    })
    expect(deps.joinProOfficialGroup).toHaveBeenCalledWith(USER_ID)
  })

  it('rejects an unban restore whose inactive boundary differs from its operation key', async () => {
    const restoreEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'projection',
      source_key: USER_ID,
      effect_type: 'pro_official_group_restore',
      operation_key: 'unban_restore:2026-07-28 00:00:00+00',
      payload: {
        boundary_at: '2026-07-01T00:00:00+00:00',
        inactive_boundary_at: '2026-07-27T00:00:00+00:00',
        unban_transition_at: '2026-07-29T00:00:00+00:00',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([restoreEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow(
      'Stripe entitlement effects require retry'
    )
    expect(deps.joinProOfficialGroup).not.toHaveBeenCalled()
    expect(effectStore.recordDispatchReview).toHaveBeenCalledWith({
      effect: restoreEffect,
      error: 'official-group unban restore authority conflicted',
    })
  })

  it('executes an exact projection-boundary official-group join effect', async () => {
    const projectionEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'projection',
      source_key: USER_ID,
      operation_key: 'authority_started:2026-07-29 00:00:00+00',
      payload: { boundary_at: '2026-07-29T00:00:00+00:00' },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([projectionEffect]) })
    const { deps } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      count: 1,
      completed: 1,
    })
    expect(deps.joinProOfficialGroup).toHaveBeenCalledWith(USER_ID)
  })

  it('rejects a projection join whose durable source identity is not exact', async () => {
    const projectionEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'projection',
      source_key: 'not-the-user',
      operation_key: 'authority_started:2026-07-29 00:00:00+00',
      payload: { boundary_at: '2026-07-29T00:00:00+00:00' },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([projectionEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow(
      'Stripe entitlement effects require retry'
    )
    expect(deps.joinProOfficialGroup).not.toHaveBeenCalled()
    expect(effectStore.recordDispatchReview).toHaveBeenCalledWith({
      effect: projectionEffect,
      error: 'official-group projection authority conflicted',
    })
  })

  it('rejects a restore payload whose signed event differs from its operation key', async () => {
    const restoreEffect = effect({
      effect_type: 'pro_official_group_restore',
      operation_key: 'state_restore:evt_state_restore_1',
      payload: { event_id: 'evt_state_restore_2' },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([restoreEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow(
      'Stripe entitlement effects require retry'
    )
    expect(deps.joinProOfficialGroup).not.toHaveBeenCalled()
    expect(effectStore.recordDispatchReview).toHaveBeenCalledWith({
      effect: restoreEffect,
      error: 'official-group state restore identity conflicted',
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
        retryAfterSeconds: 30,
      })
    )
  })

  it('claims a recovery-blocked Tip refund before reading Stripe and refunds the exact remainder', async () => {
    const refundEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'tip_payment',
      source_key: PAYMENT_ID,
      effect_type: 'recovery_payment_auto_refund',
      operation_key: 'refund:account_recovery_billing_blocked',
      payload: {
        reason_key: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([refundEffect]),
      claimRecoveryPaymentRefundDispatch: jest.fn().mockResolvedValue({
        status: 'dispatch_committed',
        product_kind: 'tip',
        user_id: USER_ID,
        livemode: true,
        stripe_customer_id: CUSTOMER_ID,
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
        stripe_charge_id: CHARGE_ID,
        amount: 5000,
        currency: 'usd',
      }),
    })
    const { deps, chargeRetrieve, refundCreate } = dependencies({
      store: effectStore,
      charge: charge({ amount_refunded: 1000 }),
      refund: {
        amount: 4000,
        metadata: {
          arena_entitlement_effect_id: EFFECT_ID,
          arena_product_kind: 'tip',
          arena_product_ledger_id: PAYMENT_ID,
          arena_reason_key: 'account_recovery_billing_blocked',
        },
      },
    })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      count: 1,
      completed: 1,
    })
    expect(effectStore.claimRecoveryPaymentRefundDispatch).toHaveBeenCalledWith({
      effectId: EFFECT_ID,
      leaseToken: LEASE_TOKEN,
      livemode: true,
    })
    expect(effectStore.claimRecoveryPaymentRefundDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      chargeRetrieve.mock.invocationCallOrder[0]
    )
    expect(refundCreate).toHaveBeenCalledWith(
      {
        charge: CHARGE_ID,
        amount: 4000,
        reason: 'requested_by_customer',
        metadata: {
          arena_entitlement_effect_id: EFFECT_ID,
          arena_product_kind: 'tip',
          arena_product_ledger_id: PAYMENT_ID,
          arena_reason_key: 'account_recovery_billing_blocked',
        },
      },
      {
        idempotencyKey: `arena_recovery_payment_refund_${EFFECT_ID}_1000_4000`,
      }
    )
  })

  it('uses a new deterministic refund segment after external partial progress', async () => {
    const refundEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'tip_payment',
      source_key: PAYMENT_ID,
      effect_type: 'recovery_payment_auto_refund',
      operation_key: 'refund:account_recovery_billing_blocked',
      payload: {
        reason_key: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([refundEffect]),
      claimRecoveryPaymentRefundDispatch: jest.fn().mockResolvedValue({
        status: 'already_dispatch_committed',
        product_kind: 'tip',
        user_id: USER_ID,
        livemode: true,
        stripe_customer_id: CUSTOMER_ID,
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
        stripe_charge_id: CHARGE_ID,
        amount: 5000,
        currency: 'usd',
      }),
    })
    const { deps, refundCreate } = dependencies({
      store: effectStore,
      charge: charge({ amount_refunded: 2500 }),
      refund: {
        amount: 2500,
        metadata: {
          arena_entitlement_effect_id: EFFECT_ID,
          arena_product_kind: 'tip',
          arena_product_ledger_id: PAYMENT_ID,
          arena_reason_key: 'account_recovery_billing_blocked',
        },
      },
    })

    await drainStripeEntitlementEffects(deps)
    expect(refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ charge: CHARGE_ID, amount: 2500 }),
      {
        idempotencyKey: `arena_recovery_payment_refund_${EFFECT_ID}_2500_2500`,
      }
    )
  })

  it('never reads Stripe when the recovery refund database claim conflicts', async () => {
    const refundEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'group_payment',
      source_key: PAYMENT_ID,
      effect_type: 'recovery_payment_auto_refund',
      operation_key: 'refund:account_recovery_billing_blocked',
      payload: {
        reason_key: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([refundEffect]),
      claimRecoveryPaymentRefundDispatch: jest
        .fn()
        .mockResolvedValue({ status: 'identity_conflict' }),
      finish: jest.fn().mockResolvedValue({ status: 'retry_scheduled' }),
    })
    const { deps, chargeRetrieve, refundCreate } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(chargeRetrieve).not.toHaveBeenCalled()
    expect(refundCreate).not.toHaveBeenCalled()
  })

  it('never reads Stripe when a lifetime recovery refund mode fails its database claim', async () => {
    const refundEffect = effect({
      source_kind: 'payment',
      entitlement_payment_id: PAYMENT_ID,
      source_key: PAYMENT_ID,
      effect_type: 'recovery_payment_auto_refund',
      operation_key: 'refund:account_recovery_billing_blocked',
      payload: {
        reason_key: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([refundEffect]),
      claimRecoveryPaymentRefundDispatch: jest
        .fn()
        .mockResolvedValue({ status: 'identity_conflict' }),
      finish: jest.fn().mockResolvedValue({ status: 'retry_scheduled' }),
    })
    const { deps, chargeRetrieve, refundCreate } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(effectStore.claimRecoveryPaymentRefundDispatch).toHaveBeenCalledWith({
      effectId: EFFECT_ID,
      leaseToken: LEASE_TOKEN,
      livemode: true,
    })
    expect(chargeRetrieve).not.toHaveBeenCalled()
    expect(refundCreate).not.toHaveBeenCalled()
  })

  it('keeps a post-claim missing recovery Charge retryable', async () => {
    const refundEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'api_payment',
      source_key: PAYMENT_ID,
      effect_type: 'recovery_payment_auto_refund',
      operation_key: 'refund:account_recovery_billing_blocked',
      payload: {
        reason_key: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([refundEffect]),
      claimRecoveryPaymentRefundDispatch: jest.fn().mockResolvedValue({
        status: 'dispatch_committed',
        product_kind: 'api_tier',
        user_id: USER_ID,
        livemode: true,
        stripe_customer_id: CUSTOMER_ID,
        stripe_payment_intent_id: PAYMENT_INTENT_ID,
        stripe_charge_id: CHARGE_ID,
        amount: 5000,
        currency: 'usd',
      }),
      finish: jest.fn().mockResolvedValue({ status: 'retry_scheduled' }),
    })
    const { deps, chargeRetrieve, refundCreate } = dependencies({ store: effectStore })
    chargeRetrieve.mockRejectedValueOnce(
      Object.assign(new Error('No such charge'), {
        code: 'resource_missing',
        statusCode: 404,
      })
    )

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(refundCreate).not.toHaveBeenCalled()
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: false,
        externalRef: null,
        retryAfterSeconds: 30,
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
        protocol_version: 'dispatch_commit_v1',
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
    expect(effectStore.claimSubscriptionCancelDispatch).toHaveBeenCalledWith({
      effectId: EFFECT_ID,
      leaseToken: LEASE_TOKEN,
      livemode: true,
    })
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRef: `subscription:${SUBSCRIPTION_ID}:canceled`,
      })
    )
  })

  it('restores a superseded recurring authority only after a fresh exact Stripe read', async () => {
    const restoreEffect = effect({
      effect_type: 'stripe_lifetime_authority_restore',
      operation_key: 'restore:lifetime_refund:evt_refund1',
      payload: { snapshot_digest: 'a'.repeat(64) },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([restoreEffect]),
      readLifetimeRestoreAuthority: jest.fn().mockResolvedValue({
        status: 'authority_ready',
        user_id: USER_ID,
        livemode: true,
        stripe_customer_id: CUSTOMER_ID,
        stripe_subscription_id: SUBSCRIPTION_ID,
        period_start: '2026-07-01T00:00:00.000Z',
        period_end: '2026-08-01T00:00:00.000Z',
        cancel_at_period_end: false,
        snapshot_digest: 'a'.repeat(64),
      }),
      restoreLifetimeAuthority: jest.fn().mockResolvedValue({ status: 'restored' }),
    })
    const exactSubscription = subscription({
      status: 'active',
      cancel_at_period_end: false,
      items: {
        object: 'list',
        data: [
          {
            current_period_start: Date.parse('2026-07-01T00:00:00.000Z') / 1000,
            current_period_end: Date.parse('2026-08-01T00:00:00.000Z') / 1000,
          } as Stripe.SubscriptionItem,
        ],
        has_more: false,
        url: '/v1/subscription_items',
      },
    })
    const { deps, subscriptionRetrieve } = dependencies({
      store: effectStore,
      subscription: exactSubscription,
    })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      count: 1,
      completed: 1,
    })
    expect(subscriptionRetrieve).toHaveBeenCalledWith(SUBSCRIPTION_ID)
    expect(effectStore.restoreLifetimeAuthority).toHaveBeenCalledWith({
      effectId: EFFECT_ID,
      leaseToken: LEASE_TOKEN,
      livemode: true,
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscriptionStatus: 'active',
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    })
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: true,
        externalRef: `lifetime-authority-restored:${PAYMENT_ID}`,
      })
    )
  })

  it('does not restore local lifetime authority when the fresh Stripe period drifted', async () => {
    const restoreEffect = effect({
      effect_type: 'stripe_lifetime_authority_restore',
      operation_key: 'restore:lifetime_refund:evt_refund1',
      payload: { snapshot_digest: 'a'.repeat(64) },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([restoreEffect]),
      readLifetimeRestoreAuthority: jest.fn().mockResolvedValue({
        status: 'authority_ready',
        user_id: USER_ID,
        livemode: true,
        stripe_customer_id: CUSTOMER_ID,
        stripe_subscription_id: SUBSCRIPTION_ID,
        period_start: '2026-07-01T00:00:00.000Z',
        period_end: '2026-08-01T00:00:00.000Z',
        cancel_at_period_end: false,
        snapshot_digest: 'a'.repeat(64),
      }),
      finish: jest.fn().mockResolvedValue({ status: 'dead_lettered' }),
    })
    const { deps } = dependencies({
      store: effectStore,
      subscription: subscription({
        status: 'active',
        cancel_at_period_end: false,
        items: {
          object: 'list',
          data: [
            {
              current_period_start: Date.parse('2026-07-02T00:00:00.000Z') / 1000,
              current_period_end: Date.parse('2026-08-02T00:00:00.000Z') / 1000,
            } as Stripe.SubscriptionItem,
          ],
          has_more: false,
          url: '/v1/subscription_items',
        },
      }),
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow(
      'fresh Stripe Subscription period conflicted with snapshot'
    )
    expect(effectStore.restoreLifetimeAuthority).not.toHaveBeenCalled()
  })

  it('cancels an exact recurring payment charged during the recovery billing block', async () => {
    const cancelEffect = effect({
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([cancelEffect]) })
    const { deps, subscriptionRetrieve, subscriptionCancel } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      completed: 1,
    })
    expect(effectStore.claimSubscriptionCancelDispatch).toHaveBeenCalledTimes(1)
    expect(effectStore.claimSubscriptionCancelDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      subscriptionRetrieve.mock.invocationCallOrder[0]
    )
    expect(subscriptionCancel).toHaveBeenCalledTimes(1)
  })

  it('claims and cancels an exact recovery-blocked API subscription', async () => {
    const cancelEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'api_payment',
      source_key: PAYMENT_ID,
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([cancelEffect]),
      claimSubscriptionCancelDispatch: jest.fn().mockResolvedValue({
        status: 'dispatch_committed',
        product_kind: 'api_tier',
        user_id: USER_ID,
        livemode: true,
        stripe_customer_id: CUSTOMER_ID,
        stripe_subscription_id: SUBSCRIPTION_ID,
      }),
    })
    const { deps, subscriptionRetrieve, subscriptionCancel } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({ completed: 1 })
    expect(effectStore.loadPayment).not.toHaveBeenCalled()
    expect(effectStore.loadTrial).not.toHaveBeenCalled()
    expect(effectStore.claimSubscriptionCancelDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      subscriptionRetrieve.mock.invocationCallOrder[0]
    )
    expect(subscriptionCancel).toHaveBeenCalledWith(
      SUBSCRIPTION_ID,
      { invoice_now: false, prorate: false },
      { idempotencyKey: `arena_entitlement_cancel_${EFFECT_ID}` }
    )
  })

  it.each([
    ['product', { product_kind: 'group_pass' }],
    ['owner', { user_id: GROUP_ID }],
    ['mode', { livemode: false }],
    ['customer', { stripe_customer_id: 'cus_other' }],
    ['subscription', { stripe_subscription_id: 'sub_other' }],
    ['extra key', { unexpected: true }],
  ])('rejects API cancellation with mismatched %s claim authority', async (_label, drift) => {
    const cancelEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'api_payment',
      source_key: PAYMENT_ID,
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([cancelEffect]),
      claimSubscriptionCancelDispatch: jest.fn().mockResolvedValue({
        status: 'dispatch_committed',
        product_kind: 'api_tier',
        user_id: USER_ID,
        livemode: true,
        stripe_customer_id: CUSTOMER_ID,
        stripe_subscription_id: SUBSCRIPTION_ID,
        ...drift,
      }),
      finish: jest.fn().mockResolvedValue({ status: 'retry_scheduled' }),
    })
    const { deps, subscriptionRetrieve, subscriptionCancel } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(subscriptionRetrieve).not.toHaveBeenCalled()
    expect(subscriptionCancel).not.toHaveBeenCalled()
  })

  it('does not read Stripe when API cancellation authority was superseded', async () => {
    const cancelEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'api_payment',
      source_key: PAYMENT_ID,
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([cancelEffect]),
      claimSubscriptionCancelDispatch: jest
        .fn()
        .mockResolvedValue({ status: 'authority_superseded' }),
      finish: jest.fn().mockResolvedValue({ status: 'already_superseded' }),
    })
    const { deps, subscriptionRetrieve, subscriptionCancel } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({ superseded: 1 })
    expect(subscriptionRetrieve).not.toHaveBeenCalled()
    expect(subscriptionCancel).not.toHaveBeenCalled()
  })

  it('rejects a fresh API Subscription whose owner no longer matches the claimed payment', async () => {
    const cancelEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'api_payment',
      source_key: PAYMENT_ID,
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([cancelEffect]),
      claimSubscriptionCancelDispatch: jest.fn().mockResolvedValue({
        status: 'already_dispatch_committed',
        product_kind: 'api_tier',
        user_id: USER_ID,
        livemode: true,
        stripe_customer_id: CUSTOMER_ID,
        stripe_subscription_id: SUBSCRIPTION_ID,
      }),
      finish: jest.fn().mockResolvedValue({ status: 'retry_scheduled' }),
    })
    const { deps, subscriptionCancel } = dependencies({
      store: effectStore,
      subscription: subscription({ metadata: { userId: GROUP_ID } }),
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(subscriptionCancel).not.toHaveBeenCalled()
  })

  it.each([
    ['subscription', { stripe_subscription_id: 'sub_wrong' }, payment(), subscription()],
    ['customer', { stripe_customer_id: 'cus_wrong' }, payment(), subscription()],
    ['payment kind', {}, payment({ payment_kind: 'lifetime', plan: 'lifetime' }), subscription()],
    ['owner metadata', {}, payment(), subscription({ metadata: { userId: GROUP_ID } })],
    ['mode', {}, payment(), subscription({ livemode: false })],
  ])(
    'rejects blocked recurring cancellation with wrong %s authority',
    async (_label, payloadOverride, localPayment, remoteSubscription) => {
      const cancelEffect = effect({
        effect_type: 'stripe_subscription_cancel',
        operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
        payload: {
          stripe_subscription_id: SUBSCRIPTION_ID,
          stripe_customer_id: CUSTOMER_ID,
          reason: 'account_recovery_billing_blocked',
          protocol_version: 'dispatch_commit_v1',
          ...payloadOverride,
        },
      })
      const effectStore = store({
        lease: jest.fn().mockResolvedValue([cancelEffect]),
        loadPayment: jest.fn().mockResolvedValue(localPayment),
        finish: jest.fn().mockResolvedValue({ status: 'retry_scheduled' }),
      })
      const { deps, subscriptionCancel } = dependencies({
        store: effectStore,
        subscription: remoteSubscription,
      })

      await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
      expect(subscriptionCancel).not.toHaveBeenCalled()
    }
  )

  it('cancels an exact blocked trial through the same dispatch-commit protocol', async () => {
    const cancelEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'trial',
      source_key: `trial:${TRIAL_ID}`,
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([cancelEffect]) })
    const { deps, subscriptionCancel } = dependencies({ store: effectStore })

    await drainStripeEntitlementEffects(deps)
    expect(effectStore.loadTrial).toHaveBeenCalledWith(TRIAL_ID)
    expect(effectStore.loadPayment).not.toHaveBeenCalled()
    expect(effectStore.claimSubscriptionCancelDispatch).toHaveBeenCalledTimes(1)
    expect(subscriptionCancel).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['owner', trial({ user_id: GROUP_ID })],
    ['customer', trial({ stripe_customer_id: 'cus_wrong' })],
    ['subscription', trial({ stripe_subscription_id: 'sub_wrong' })],
    ['revoke reason', trial({ revoke_reason: 'stripe_terminal_state' })],
  ])('rejects blocked trial cancellation with wrong %s identity', async (_label, localTrial) => {
    const cancelEffect = effect({
      entitlement_payment_id: null,
      source_kind: 'trial',
      source_key: `trial:${TRIAL_ID}`,
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([cancelEffect]),
      loadTrial: jest.fn().mockResolvedValue(localTrial),
      finish: jest.fn().mockResolvedValue({ status: 'retry_scheduled' }),
    })
    const { deps, subscriptionCancel } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(effectStore.claimSubscriptionCancelDispatch).not.toHaveBeenCalled()
    expect(subscriptionCancel).not.toHaveBeenCalled()
  })

  it('does not cancel an already canceled Stripe subscription twice', async () => {
    const cancelEffect = effect({
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'lifetime_membership_activated',
        protocol_version: 'dispatch_commit_v1',
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
    expect(effectStore.claimSubscriptionCancelDispatch).toHaveBeenCalledTimes(1)
  })

  it('accepts an exact post-claim Stripe resource_missing as terminal', async () => {
    const cancelEffect = effect({
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'account_recovery_billing_blocked',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([cancelEffect]) })
    const { deps, subscriptionRetrieve, subscriptionCancel } = dependencies({
      store: effectStore,
    })
    subscriptionRetrieve.mockRejectedValue({
      code: 'resource_missing',
      statusCode: 404,
    })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      completed: 1,
    })
    expect(effectStore.claimSubscriptionCancelDispatch).toHaveBeenCalledWith({
      effectId: EFFECT_ID,
      leaseToken: LEASE_TOKEN,
      livemode: true,
    })
    expect(subscriptionCancel).not.toHaveBeenCalled()
    expect(effectStore.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRef: `subscription:${SUBSCRIPTION_ID}:resource_missing`,
      })
    )
  })

  it('keeps a migrated DB fail-closed for a legacy worker payload contract', async () => {
    const legacyCancelEffect = effect({
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'lifetime_membership_activated',
      },
    })
    const effectStore = store({ lease: jest.fn().mockResolvedValue([legacyCancelEffect]) })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps, subscriptionRetrieve, subscriptionCancel } = dependencies({
      store: effectStore,
    })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
    expect(subscriptionRetrieve).not.toHaveBeenCalled()
    expect(effectStore.claimSubscriptionCancelDispatch).not.toHaveBeenCalled()
    expect(subscriptionCancel).not.toHaveBeenCalled()
  })

  it('does not call Stripe when refund authority wins before dispatch commit', async () => {
    const cancelEffect = effect({
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'lifetime_membership_activated',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([cancelEffect]),
      loadPayment: jest
        .fn()
        .mockResolvedValue(payment({ payment_kind: 'lifetime', plan: 'lifetime' })),
      claimSubscriptionCancelDispatch: jest
        .fn()
        .mockResolvedValue({ status: 'authority_superseded' }),
      finish: jest.fn().mockResolvedValue({ status: 'already_superseded' }),
    })
    const { deps, subscriptionCancel } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).resolves.toMatchObject({
      superseded: 1,
      completed: 0,
    })
    expect(subscriptionCancel).not.toHaveBeenCalled()
  })

  it('does not call Stripe when the dispatch-claim RPC is absent during worker-first deploy', async () => {
    const cancelEffect = effect({
      effect_type: 'stripe_subscription_cancel',
      operation_key: `cancel:subscription:${SUBSCRIPTION_ID}`,
      payload: {
        stripe_subscription_id: SUBSCRIPTION_ID,
        stripe_customer_id: CUSTOMER_ID,
        reason: 'lifetime_membership_activated',
        protocol_version: 'dispatch_commit_v1',
      },
    })
    const effectStore = store({
      lease: jest.fn().mockResolvedValue([cancelEffect]),
      loadPayment: jest
        .fn()
        .mockResolvedValue(payment({ payment_kind: 'lifetime', plan: 'lifetime' })),
      claimSubscriptionCancelDispatch: jest
        .fn()
        .mockRejectedValue(new Error('claim RPC is missing')),
    })
    effectStore.finish.mockResolvedValue({ status: 'retry_scheduled' })
    const { deps, subscriptionCancel } = dependencies({ store: effectStore })

    await expect(drainStripeEntitlementEffects(deps)).rejects.toThrow('require retry')
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
