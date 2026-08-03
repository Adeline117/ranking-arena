import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/lib/supabase/database.types'
import { stripeMetadataUserId, stripeObjectId } from '@/lib/stripe/identity'

type EntitlementEffect = Database['public']['Tables']['stripe_entitlement_effects']['Row']
type EntitlementPayment = Database['public']['Tables']['stripe_entitlement_payments']['Row']
type TrialEntitlement = Database['public']['Tables']['stripe_trial_entitlements']['Row']

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EFFECT_TYPES = new Set([
  'payment_auto_refund',
  'payment_manual_review',
  'recovery_payment_auto_refund',
  'stripe_lifetime_authority_restore',
  'stripe_subscription_cancel',
  'pro_official_group_join',
  'pro_official_group_restore',
  'pro_purchase_alert',
])
const SUCCESS_FINISH_STATUSES = new Set([
  'completed',
  'already_completed',
  'superseded',
  'already_superseded',
  'authority_superseded',
])
const FAILURE_FINISH_STATUSES = new Set([
  'retry_scheduled',
  'dead_lettered',
  'already_dead_lettered',
  'superseded',
  'already_superseded',
  'authority_superseded',
])

export interface StripeEntitlementEffectStore {
  lease(limit: number, leaseSeconds: number): Promise<EntitlementEffect[]>
  loadPayment(paymentId: string): Promise<EntitlementPayment>
  loadTrial(trialId: string): Promise<TrialEntitlement>
  claimSubscriptionCancelDispatch(params: {
    effectId: string
    leaseToken: string
    livemode: boolean
  }): Promise<unknown>
  claimRecoveryPaymentRefundDispatch(params: {
    effectId: string
    leaseToken: string
    livemode: boolean
  }): Promise<unknown>
  readLifetimeRestoreAuthority(params: {
    effectId: string
    leaseToken: string
    livemode: boolean
  }): Promise<unknown>
  restoreLifetimeAuthority(params: {
    effectId: string
    leaseToken: string
    livemode: boolean
    stripeCustomerId: string
    stripeSubscriptionId: string
    subscriptionStatus: string
    periodStart: string
    periodEnd: string
    cancelAtPeriodEnd: boolean
  }): Promise<unknown>
  finish(params: {
    effectId: string
    leaseToken: string
    succeeded: boolean
    externalRef: string | null
    error: string | null
    retryAfterSeconds: number | null
  }): Promise<unknown>
  recordDispatchReview(params: { effect: EntitlementEffect; error: string }): Promise<void>
}

export interface StripeEntitlementEffectDependencies {
  store: StripeEntitlementEffectStore
  stripe: Stripe
  expectedLivemode: boolean
  joinProOfficialGroup(userId: string): Promise<{
    success: boolean
    message: string
    groupId?: string
  }>
  sendRateLimitedAlert(
    payload: {
      source: string
      title: string
      message: string
      level: 'info' | 'warning' | 'critical'
      details?: Record<string, unknown>
    },
    rateLimitKey: string,
    rateLimitMs?: number
  ): Promise<{ sent: boolean; rateLimited: boolean; channels: string[] }>
}

export interface StripeEntitlementEffectSummary {
  [key: string]: number
  count: number
  leased: number
  completed: number
  retryScheduled: number
  deadLettered: number
  superseded: number
}

class PermanentEffectError extends Error {
  readonly permanent = true
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PermanentEffectError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactStatus(value: unknown): string {
  const record = plainRecord(value, 'effect acknowledgement')
  if (
    Object.keys(record).length !== 1 ||
    typeof record.status !== 'string' ||
    record.status.length === 0
  ) {
    throw new Error('effect acknowledgement is malformed')
  }
  return record.status
}

function exactPayload(
  effect: EntitlementEffect,
  requiredKeys: string[],
  optionalKeys: string[] = []
): Record<string, unknown> {
  const payload = plainRecord(effect.payload, `${effect.effect_type} payload`)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  const keys = Object.keys(payload)
  if (requiredKeys.some((key) => !(key in payload)) || keys.some((key) => !allowed.has(key))) {
    throw new PermanentEffectError(`${effect.effect_type} payload contract drifted`)
  }
  return payload
}

function requiredString(record: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = record[key]
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    (pattern && !pattern.test(value))
  ) {
    throw new PermanentEffectError(`${key} is invalid`)
  }
  return value
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 1800) || 'unknown effect failure'
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attemptCount - 1))
}

function validateLeasedEffect(effect: EntitlementEffect): void {
  if (
    !UUID_PATTERN.test(effect.id) ||
    effect.status !== 'processing' ||
    !effect.lease_token ||
    !UUID_PATTERN.test(effect.lease_token) ||
    !effect.lease_expires_at ||
    !Number.isInteger(effect.attempt_count) ||
    effect.attempt_count < 1 ||
    effect.attempt_count > 10 ||
    !EFFECT_TYPES.has(effect.effect_type) ||
    !effect.operation_key ||
    effect.operation_key.length > 255
  ) {
    throw new PermanentEffectError('leased entitlement effect is malformed')
  }
  plainRecord(effect.payload, `${effect.effect_type} payload`)
}

function validatePaymentEffectIdentity(
  effect: EntitlementEffect,
  payment: EntitlementPayment
): void {
  if (
    effect.source_kind !== 'payment' ||
    !effect.entitlement_payment_id ||
    effect.entitlement_payment_id !== payment.id ||
    effect.source_key !== payment.id ||
    (effect.user_id !== null && payment.user_id !== effect.user_id) ||
    payment.amount_paid <= 0 ||
    !Number.isSafeInteger(payment.amount_paid) ||
    !['paid', 'succeeded'].includes(payment.payment_status) ||
    !Number.isSafeInteger(payment.refund_succeeded_amount) ||
    payment.refund_succeeded_amount < 0 ||
    payment.refund_succeeded_amount > payment.amount_paid ||
    !/^ch_[A-Za-z0-9]+$/.test(payment.stripe_charge_id) ||
    !/^cus_[A-Za-z0-9]+$/.test(payment.stripe_customer_id) ||
    !/^[a-z]{3}$/.test(payment.currency)
  ) {
    throw new PermanentEffectError('entitlement payment identity conflicted with its effect')
  }
}

function trialIdFromEffect(effect: EntitlementEffect): string {
  const prefix = 'trial:'
  const trialId = effect.source_key.startsWith(prefix) ? effect.source_key.slice(prefix.length) : ''
  if (!UUID_PATTERN.test(trialId)) {
    throw new PermanentEffectError('trial cancellation source identity is invalid')
  }
  return trialId
}

function validateTrialEffectIdentity(effect: EntitlementEffect, trial: TrialEntitlement): void {
  if (
    effect.source_kind !== 'trial' ||
    effect.entitlement_payment_id !== null ||
    effect.source_key !== `trial:${trial.id}` ||
    effect.user_id === null ||
    effect.user_id !== trial.user_id ||
    trial.revoked_at === null ||
    trial.revoke_reason !== 'account_recovery_billing_blocked' ||
    !/^cus_[A-Za-z0-9_]+$/.test(trial.stripe_customer_id) ||
    !/^sub_[A-Za-z0-9_]+$/.test(trial.stripe_subscription_id)
  ) {
    throw new PermanentEffectError('trial cancellation identity conflicted with its effect')
  }
}

function assertChargeIdentity(params: {
  charge: Stripe.Charge
  payment: EntitlementPayment
  expectedLivemode: boolean
}): void {
  const { charge, payment, expectedLivemode } = params
  const chargeCustomerId = stripeObjectId(charge.customer)
  const chargePaymentIntentId = stripeObjectId(charge.payment_intent)
  if (
    charge.id !== payment.stripe_charge_id ||
    charge.object !== 'charge' ||
    chargeCustomerId !== payment.stripe_customer_id ||
    chargePaymentIntentId !== payment.stripe_payment_intent_id ||
    charge.amount !== payment.amount_paid ||
    charge.amount_captured !== payment.amount_paid ||
    charge.currency !== payment.currency ||
    charge.livemode !== expectedLivemode ||
    charge.status !== 'succeeded' ||
    charge.paid !== true ||
    charge.captured !== true ||
    !Number.isSafeInteger(charge.amount_refunded) ||
    charge.amount_refunded < 0 ||
    charge.amount_refunded > charge.amount
  ) {
    throw new PermanentEffectError('Stripe Charge identity conflicted with payment authority')
  }
}

interface RecoveryPaymentRefundAuthority {
  status: 'dispatch_committed' | 'already_dispatch_committed'
  productKind: 'tip' | 'group_pass' | 'api_tier' | 'lifetime'
  userId: string
  livemode: boolean
  stripeCustomerId: string
  stripePaymentIntentId: string
  stripeChargeId: string
  amount: number
  currency: string
}

function exactRecoveryPaymentRefundAuthority(
  value: unknown,
  expectedLivemode: boolean
): RecoveryPaymentRefundAuthority | { status: string } {
  const record = plainRecord(value, 'recovery payment refund acknowledgement')
  const status = requiredString(record, 'status')
  if (!['dispatch_committed', 'already_dispatch_committed'].includes(status)) {
    if (Object.keys(record).length !== 1) {
      throw new Error('recovery payment refund acknowledgement is malformed')
    }
    return { status }
  }
  const exactKeys = new Set([
    'status',
    'product_kind',
    'user_id',
    'livemode',
    'stripe_customer_id',
    'stripe_payment_intent_id',
    'stripe_charge_id',
    'amount',
    'currency',
  ])
  if (
    Object.keys(record).length !== exactKeys.size ||
    Object.keys(record).some((key) => !exactKeys.has(key)) ||
    !['tip', 'group_pass', 'api_tier', 'lifetime'].includes(String(record.product_kind)) ||
    typeof record.user_id !== 'string' ||
    !UUID_PATTERN.test(record.user_id) ||
    record.livemode !== expectedLivemode ||
    typeof record.amount !== 'number' ||
    !Number.isSafeInteger(record.amount) ||
    record.amount <= 0
  ) {
    throw new PermanentEffectError('recovery payment refund authority is malformed')
  }
  return {
    status: status as RecoveryPaymentRefundAuthority['status'],
    productKind: record.product_kind as RecoveryPaymentRefundAuthority['productKind'],
    userId: record.user_id,
    livemode: record.livemode,
    stripeCustomerId: requiredString(record, 'stripe_customer_id', /^cus_[A-Za-z0-9_]+$/),
    stripePaymentIntentId: requiredString(record, 'stripe_payment_intent_id', /^pi_[A-Za-z0-9_]+$/),
    stripeChargeId: requiredString(record, 'stripe_charge_id', /^ch_[A-Za-z0-9_]+$/),
    amount: record.amount,
    currency: requiredString(record, 'currency', /^[a-z]{3}$/),
  }
}

async function dispatchRecoveryPaymentRefund(
  effect: EntitlementEffect,
  dependencies: StripeEntitlementEffectDependencies
): Promise<string> {
  const payload = exactPayload(effect, ['reason_key', 'protocol_version'])
  if (
    !['tip_payment', 'group_payment', 'api_payment', 'payment'].includes(effect.source_kind) ||
    (effect.source_kind === 'payment'
      ? effect.entitlement_payment_id === null ||
        effect.source_key !== effect.entitlement_payment_id
      : effect.entitlement_payment_id !== null) ||
    !UUID_PATTERN.test(effect.source_key) ||
    effect.operation_key !== 'refund:account_recovery_billing_blocked' ||
    payload.reason_key !== 'account_recovery_billing_blocked' ||
    payload.protocol_version !== 'dispatch_commit_v1' ||
    !effect.user_id ||
    !UUID_PATTERN.test(effect.user_id) ||
    !effect.lease_token ||
    !UUID_PATTERN.test(effect.lease_token)
  ) {
    throw new PermanentEffectError('recovery payment refund effect authority is invalid')
  }

  const claim = exactRecoveryPaymentRefundAuthority(
    await dependencies.store.claimRecoveryPaymentRefundDispatch({
      effectId: effect.id,
      leaseToken: effect.lease_token,
      livemode: dependencies.expectedLivemode,
    }),
    dependencies.expectedLivemode
  )
  if (claim.status === 'authority_superseded') {
    return `recovery-payment:${effect.source_kind}:${effect.source_key}:refund_superseded`
  }
  if (!['dispatch_committed', 'already_dispatch_committed'].includes(claim.status)) {
    throw new Error(`recovery payment refund dispatch claim returned ${claim.status}`)
  }
  const authority = claim as RecoveryPaymentRefundAuthority
  const expectedProductKind = {
    tip_payment: 'tip',
    group_payment: 'group_pass',
    api_payment: 'api_tier',
    payment: 'lifetime',
  }[effect.source_kind]
  if (authority.productKind !== expectedProductKind || authority.userId !== effect.user_id) {
    throw new PermanentEffectError('recovery payment refund product authority conflicted')
  }

  const charge = await dependencies.stripe.charges.retrieve(authority.stripeChargeId, {
    expand: ['customer', 'payment_intent'],
  })
  if (
    charge.id !== authority.stripeChargeId ||
    charge.object !== 'charge' ||
    stripeObjectId(charge.customer) !== authority.stripeCustomerId ||
    stripeObjectId(charge.payment_intent) !== authority.stripePaymentIntentId ||
    charge.amount !== authority.amount ||
    charge.amount_captured !== authority.amount ||
    charge.currency !== authority.currency ||
    charge.livemode !== authority.livemode ||
    charge.status !== 'succeeded' ||
    charge.paid !== true ||
    charge.captured !== true ||
    !Number.isSafeInteger(charge.amount_refunded) ||
    charge.amount_refunded < 0 ||
    charge.amount_refunded > charge.amount
  ) {
    throw new PermanentEffectError('Stripe Charge conflicted with recovery refund authority')
  }
  if (charge.refunded === true && charge.amount_refunded === charge.amount) {
    return `charge:${charge.id}:fully_refunded`
  }
  if (charge.refunded === true || charge.amount_refunded === charge.amount) {
    throw new PermanentEffectError('Stripe Charge full-refund flags are inconsistent')
  }

  const amount = charge.amount - charge.amount_refunded
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new PermanentEffectError('Stripe Charge has no exact refundable remainder')
  }
  const refund = await dependencies.stripe.refunds.create(
    {
      charge: charge.id,
      amount,
      reason: 'requested_by_customer',
      metadata: {
        arena_entitlement_effect_id: effect.id,
        arena_product_kind: authority.productKind,
        arena_product_ledger_id: effect.source_key,
        arena_reason_key: 'account_recovery_billing_blocked',
      },
    },
    {
      idempotencyKey:
        `arena_recovery_payment_refund_${effect.id}_` + `${charge.amount_refunded}_${amount}`,
    }
  )
  if (
    !/^re_[A-Za-z0-9_]+$/.test(refund.id) ||
    refund.object !== 'refund' ||
    stripeObjectId(refund.charge) !== charge.id ||
    stripeObjectId(refund.payment_intent) !== authority.stripePaymentIntentId ||
    refund.amount !== amount ||
    refund.currency !== authority.currency ||
    refund.reason !== 'requested_by_customer' ||
    refund.metadata?.arena_entitlement_effect_id !== effect.id ||
    refund.metadata?.arena_product_kind !== authority.productKind ||
    refund.metadata?.arena_product_ledger_id !== effect.source_key ||
    refund.metadata?.arena_reason_key !== 'account_recovery_billing_blocked'
  ) {
    throw new PermanentEffectError('Stripe Refund conflicted with recovery refund authority')
  }
  if (refund.status !== 'succeeded') {
    throw new Error(`Stripe Refund is not terminally succeeded (${refund.status ?? 'unknown'})`)
  }
  return `refund:${refund.id}`
}

async function dispatchAutomaticRefund(
  effect: EntitlementEffect,
  dependencies: StripeEntitlementEffectDependencies
): Promise<string> {
  const payload = exactPayload(effect, ['reason_key'], ['invoice_id', 'checkout_session_id'])
  const reasonKey = requiredString(payload, 'reason_key', /^[a-z0-9_:-]{2,96}$/)
  const locatorKeys = ['invoice_id', 'checkout_session_id'].filter(
    (key) => payload[key] !== undefined
  )
  if (locatorKeys.length !== 1) {
    throw new PermanentEffectError('automatic refund must have one source locator')
  }
  if (
    locatorKeys[0] === 'invoice_id' &&
    !/^in_[A-Za-z0-9]+$/.test(requiredString(payload, 'invoice_id'))
  ) {
    throw new PermanentEffectError('automatic refund invoice identity is invalid')
  }
  if (
    locatorKeys[0] === 'checkout_session_id' &&
    !/^cs_[A-Za-z0-9_]+$/.test(requiredString(payload, 'checkout_session_id'))
  ) {
    throw new PermanentEffectError('automatic refund Checkout identity is invalid')
  }
  if (!effect.entitlement_payment_id) {
    throw new PermanentEffectError('automatic refund has no entitlement payment')
  }

  const payment = await dependencies.store.loadPayment(effect.entitlement_payment_id)
  validatePaymentEffectIdentity(effect, payment)
  const charge = await dependencies.stripe.charges.retrieve(payment.stripe_charge_id, {
    expand: ['customer', 'payment_intent'],
  })
  assertChargeIdentity({ charge, payment, expectedLivemode: dependencies.expectedLivemode })

  if (charge.refunded === true && charge.amount_refunded === charge.amount) {
    return `charge:${charge.id}:fully_refunded`
  }
  if (charge.refunded === true || charge.amount_refunded === charge.amount) {
    throw new PermanentEffectError('Stripe Charge full-refund flags are inconsistent')
  }

  const amount = charge.amount - charge.amount_refunded
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new PermanentEffectError('Stripe Charge has no exact refundable remainder')
  }
  const refundReason =
    reasonKey === 'duplicate_lifetime_purchase' ? 'duplicate' : 'requested_by_customer'
  const refund = await dependencies.stripe.refunds.create(
    {
      charge: charge.id,
      amount,
      reason: refundReason,
      metadata: {
        arena_entitlement_effect_id: effect.id,
        arena_entitlement_payment_id: payment.id,
        arena_reason_key: reasonKey,
      },
    },
    { idempotencyKey: `arena_entitlement_refund_${effect.id}` }
  )
  if (
    !/^re_[A-Za-z0-9]+$/.test(refund.id) ||
    refund.object !== 'refund' ||
    stripeObjectId(refund.charge) !== charge.id ||
    stripeObjectId(refund.payment_intent) !== payment.stripe_payment_intent_id ||
    refund.amount !== amount ||
    refund.currency !== payment.currency ||
    refund.reason !== refundReason ||
    refund.metadata?.arena_entitlement_effect_id !== effect.id ||
    refund.metadata?.arena_entitlement_payment_id !== payment.id ||
    refund.metadata?.arena_reason_key !== reasonKey
  ) {
    throw new PermanentEffectError('Stripe Refund identity conflicted with the requested refund')
  }
  if (refund.status !== 'succeeded') {
    throw new Error(`Stripe Refund is not terminally succeeded (${refund.status ?? 'unknown'})`)
  }
  return `refund:${refund.id}`
}

interface ApiSubscriptionCancelAuthority {
  status: 'dispatch_committed' | 'already_dispatch_committed'
  userId: string
  livemode: boolean
  stripeCustomerId: string
  stripeSubscriptionId: string
}

function exactApiSubscriptionCancelAuthority(
  value: unknown,
  expectedLivemode: boolean
): ApiSubscriptionCancelAuthority | { status: string } {
  const record = plainRecord(value, 'API subscription cancellation acknowledgement')
  const status = requiredString(record, 'status')
  if (!['dispatch_committed', 'already_dispatch_committed'].includes(status)) {
    if (Object.keys(record).length !== 1) {
      throw new Error('API subscription cancellation acknowledgement is malformed')
    }
    return { status }
  }
  const exactKeys = new Set([
    'status',
    'product_kind',
    'user_id',
    'livemode',
    'stripe_customer_id',
    'stripe_subscription_id',
  ])
  if (
    Object.keys(record).length !== exactKeys.size ||
    Object.keys(record).some((key) => !exactKeys.has(key)) ||
    record.product_kind !== 'api_tier' ||
    typeof record.user_id !== 'string' ||
    record.user_id !== record.user_id.toLowerCase() ||
    !UUID_PATTERN.test(record.user_id) ||
    record.livemode !== expectedLivemode
  ) {
    throw new PermanentEffectError('API subscription cancellation authority is malformed')
  }
  return {
    status: status as ApiSubscriptionCancelAuthority['status'],
    userId: record.user_id,
    livemode: record.livemode,
    stripeCustomerId: requiredString(record, 'stripe_customer_id', /^cus_[A-Za-z0-9_]+$/),
    stripeSubscriptionId: requiredString(record, 'stripe_subscription_id', /^sub_[A-Za-z0-9_]+$/),
  }
}

async function dispatchSubscriptionCancellation(
  effect: EntitlementEffect,
  dependencies: StripeEntitlementEffectDependencies
): Promise<string> {
  const payload = exactPayload(effect, [
    'stripe_subscription_id',
    'stripe_customer_id',
    'reason',
    'protocol_version',
  ])
  const subscriptionId = requiredString(payload, 'stripe_subscription_id', /^sub_[A-Za-z0-9_]+$/)
  const customerId = requiredString(payload, 'stripe_customer_id', /^cus_[A-Za-z0-9_]+$/)
  const reason = requiredString(payload, 'reason')
  const protocolVersion = requiredString(payload, 'protocol_version')
  if (
    !['lifetime_membership_activated', 'account_recovery_billing_blocked'].includes(reason) ||
    protocolVersion !== 'dispatch_commit_v1' ||
    effect.operation_key !== `cancel:subscription:${subscriptionId}`
  ) {
    throw new PermanentEffectError('subscription cancellation authority is invalid')
  }

  const isApiPayment =
    effect.source_kind === 'api_payment' &&
    effect.entitlement_payment_id === null &&
    UUID_PATTERN.test(effect.source_key) &&
    reason === 'account_recovery_billing_blocked' &&
    effect.user_id !== null &&
    UUID_PATTERN.test(effect.user_id)

  if (effect.source_kind === 'payment' && effect.entitlement_payment_id) {
    const payment = await dependencies.store.loadPayment(effect.entitlement_payment_id)
    validatePaymentEffectIdentity(effect, payment)
    const exactLifetime =
      reason === 'lifetime_membership_activated' &&
      payment.payment_kind === 'lifetime' &&
      payment.plan === 'lifetime' &&
      payment.payment_status === 'succeeded' &&
      payment.stripe_customer_id === customerId
    const exactBlockedRecurring =
      reason === 'account_recovery_billing_blocked' &&
      payment.payment_kind === 'recurring' &&
      ['monthly', 'yearly'].includes(payment.plan) &&
      ['paid', 'succeeded'].includes(payment.payment_status) &&
      payment.stripe_customer_id === customerId &&
      payment.stripe_subscription_id === subscriptionId &&
      effect.user_id !== null &&
      payment.user_id === effect.user_id
    if (!exactLifetime && !exactBlockedRecurring) {
      throw new PermanentEffectError('subscription cancellation payment authority conflicted')
    }
  } else if (
    effect.source_kind === 'trial' &&
    effect.entitlement_payment_id === null &&
    reason === 'account_recovery_billing_blocked'
  ) {
    const trial = await dependencies.store.loadTrial(trialIdFromEffect(effect))
    validateTrialEffectIdentity(effect, trial)
    if (
      trial.stripe_customer_id !== customerId ||
      trial.stripe_subscription_id !== subscriptionId
    ) {
      throw new PermanentEffectError('subscription cancellation trial authority conflicted')
    }
  } else if (!isApiPayment) {
    throw new PermanentEffectError('subscription cancellation source authority is invalid')
  }

  if (!effect.lease_token || !UUID_PATTERN.test(effect.lease_token)) {
    throw new PermanentEffectError('subscription cancellation has no valid lease token')
  }
  // The database claim is the irreversible linearization point.  It re-locks
  // and re-attests the exact lifetime/recurring/trial authority before any
  // Stripe read or cancellation can occur.
  const claimValue = await dependencies.store.claimSubscriptionCancelDispatch({
    effectId: effect.id,
    leaseToken: effect.lease_token,
    livemode: dependencies.expectedLivemode,
  })
  const apiClaim = isApiPayment
    ? exactApiSubscriptionCancelAuthority(claimValue, dependencies.expectedLivemode)
    : null
  const claimStatus = apiClaim?.status ?? exactStatus(claimValue)
  if (claimStatus === 'authority_superseded') {
    return `subscription:${subscriptionId}:cancel_superseded`
  }
  if (!['dispatch_committed', 'already_dispatch_committed'].includes(claimStatus)) {
    throw new Error(`subscription cancellation dispatch claim returned ${claimStatus}`)
  }
  if (isApiPayment) {
    const authority = apiClaim as ApiSubscriptionCancelAuthority
    if (
      authority.userId !== effect.user_id ||
      authority.stripeCustomerId !== customerId ||
      authority.stripeSubscriptionId !== subscriptionId
    ) {
      throw new PermanentEffectError('API subscription cancellation product authority conflicted')
    }
  }

  let subscription: Stripe.Subscription
  try {
    subscription = await dependencies.stripe.subscriptions.retrieve(subscriptionId)
  } catch (error) {
    const stripeError = error as { code?: unknown; statusCode?: unknown }
    if (stripeError.code === 'resource_missing' && stripeError.statusCode === 404) {
      return `subscription:${subscriptionId}:resource_missing`
    }
    throw error
  }
  const actualCustomerId = stripeObjectId(subscription.customer)
  const metadataUserId = stripeMetadataUserId(
    subscription.metadata,
    `Stripe subscription ${subscription.id}`
  )
  const strictOwnerRequired = reason === 'account_recovery_billing_blocked'
  if (
    subscription.id !== subscriptionId ||
    subscription.object !== 'subscription' ||
    actualCustomerId !== customerId ||
    subscription.livemode !== dependencies.expectedLivemode ||
    (strictOwnerRequired
      ? effect.user_id === null || metadataUserId !== effect.user_id
      : metadataUserId !== null && effect.user_id !== null && metadataUserId !== effect.user_id)
  ) {
    throw new PermanentEffectError('Stripe Subscription cancellation identity conflicted')
  }
  if (['canceled', 'incomplete_expired'].includes(subscription.status)) {
    return `subscription:${subscription.id}:${subscription.status}`
  }

  const canceled = await dependencies.stripe.subscriptions.cancel(
    subscriptionId,
    {
      invoice_now: false,
      prorate: false,
    },
    { idempotencyKey: `arena_entitlement_cancel_${effect.id}` }
  )
  if (
    canceled.id !== subscriptionId ||
    stripeObjectId(canceled.customer) !== customerId ||
    canceled.livemode !== dependencies.expectedLivemode ||
    canceled.status !== 'canceled'
  ) {
    throw new PermanentEffectError('Stripe Subscription cancellation was not exact')
  }
  return `subscription:${canceled.id}:canceled`
}

interface LifetimeRestoreAuthority {
  userId: string
  livemode: boolean
  stripeCustomerId: string
  stripeSubscriptionId: string
  periodStart: string
  periodEnd: string
  cancelAtPeriodEnd: boolean
  snapshotDigest: string
}

function exactLifetimeRestoreAuthority(
  value: unknown,
  expectedLivemode: boolean
): LifetimeRestoreAuthority {
  const record = plainRecord(value, 'lifetime restore authority acknowledgement')
  const keys = new Set([
    'status',
    'user_id',
    'livemode',
    'stripe_customer_id',
    'stripe_subscription_id',
    'period_start',
    'period_end',
    'cancel_at_period_end',
    'snapshot_digest',
  ])
  if (
    Object.keys(record).length !== keys.size ||
    Object.keys(record).some((key) => !keys.has(key)) ||
    record.status !== 'authority_ready' ||
    typeof record.user_id !== 'string' ||
    !UUID_PATTERN.test(record.user_id) ||
    record.livemode !== expectedLivemode ||
    typeof record.cancel_at_period_end !== 'boolean' ||
    typeof record.snapshot_digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.snapshot_digest)
  ) {
    throw new PermanentEffectError('lifetime restore authority is malformed')
  }
  const periodStart = requiredString(record, 'period_start')
  const periodEnd = requiredString(record, 'period_end')
  if (
    !Number.isFinite(Date.parse(periodStart)) ||
    !Number.isFinite(Date.parse(periodEnd)) ||
    Date.parse(periodEnd) <= Date.parse(periodStart)
  ) {
    throw new PermanentEffectError('lifetime restore period is invalid')
  }
  return {
    userId: record.user_id,
    livemode: record.livemode,
    stripeCustomerId: requiredString(record, 'stripe_customer_id', /^cus_[A-Za-z0-9_]+$/),
    stripeSubscriptionId: requiredString(record, 'stripe_subscription_id', /^sub_[A-Za-z0-9_]+$/),
    periodStart,
    periodEnd,
    cancelAtPeriodEnd: record.cancel_at_period_end,
    snapshotDigest: record.snapshot_digest,
  }
}

async function dispatchLifetimeAuthorityRestore(
  effect: EntitlementEffect,
  dependencies: StripeEntitlementEffectDependencies
): Promise<string> {
  const payload = exactPayload(effect, ['snapshot_digest'])
  const snapshotDigest = requiredString(payload, 'snapshot_digest', /^[0-9a-f]{64}$/)
  if (
    effect.source_kind !== 'payment' ||
    !effect.entitlement_payment_id ||
    effect.source_key !== effect.entitlement_payment_id ||
    !effect.user_id ||
    !effect.lease_token ||
    !UUID_PATTERN.test(effect.lease_token) ||
    !effect.operation_key.startsWith('restore:lifetime_refund:evt_')
  ) {
    throw new PermanentEffectError('lifetime restore effect identity is invalid')
  }

  const authority = exactLifetimeRestoreAuthority(
    await dependencies.store.readLifetimeRestoreAuthority({
      effectId: effect.id,
      leaseToken: effect.lease_token,
      livemode: dependencies.expectedLivemode,
    }),
    dependencies.expectedLivemode
  )
  if (authority.userId !== effect.user_id || authority.snapshotDigest !== snapshotDigest) {
    throw new PermanentEffectError('lifetime restore effect conflicted with its snapshot')
  }

  const subscription = await dependencies.stripe.subscriptions.retrieve(
    authority.stripeSubscriptionId
  )
  const item = subscription.items?.data?.length === 1 ? subscription.items.data[0] : null
  const periodStart = item?.current_period_start
  const periodEnd = item?.current_period_end
  if (
    subscription.id !== authority.stripeSubscriptionId ||
    subscription.object !== 'subscription' ||
    stripeObjectId(subscription.customer) !== authority.stripeCustomerId ||
    subscription.livemode !== authority.livemode ||
    !['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'].includes(
      subscription.status
    ) ||
    !Number.isSafeInteger(periodStart) ||
    !Number.isSafeInteger(periodEnd) ||
    periodEnd! <= periodStart!
  ) {
    throw new PermanentEffectError('fresh Stripe Subscription cannot restore lifetime authority')
  }
  const observedStart = new Date(periodStart! * 1000).toISOString()
  const observedEnd = new Date(periodEnd! * 1000).toISOString()
  if (
    Date.parse(observedStart) !== Date.parse(authority.periodStart) ||
    Date.parse(observedEnd) !== Date.parse(authority.periodEnd) ||
    subscription.cancel_at_period_end !== authority.cancelAtPeriodEnd
  ) {
    throw new PermanentEffectError('fresh Stripe Subscription period conflicted with snapshot')
  }

  const restoreStatus = exactStatus(
    await dependencies.store.restoreLifetimeAuthority({
      effectId: effect.id,
      leaseToken: effect.lease_token,
      livemode: dependencies.expectedLivemode,
      stripeCustomerId: authority.stripeCustomerId,
      stripeSubscriptionId: authority.stripeSubscriptionId,
      subscriptionStatus: subscription.status,
      periodStart: observedStart,
      periodEnd: observedEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    })
  )
  if (restoreStatus === 'newer_authority') {
    return `lifetime-authority:${effect.entitlement_payment_id}:superseded`
  }
  if (restoreStatus !== 'restored') {
    throw new Error(`lifetime authority restore returned ${restoreStatus}`)
  }
  return `lifetime-authority-restored:${effect.entitlement_payment_id}`
}

async function dispatchOfficialGroupJoin(
  effect: EntitlementEffect,
  dependencies: StripeEntitlementEffectDependencies
): Promise<string> {
  if (!effect.user_id || !UUID_PATTERN.test(effect.user_id)) {
    throw new PermanentEffectError('official-group effect has no active user')
  }
  if (effect.effect_type === 'pro_official_group_restore') {
    if (effect.operation_key.startsWith('unban_restore:')) {
      const payload = exactPayload(effect, [
        'boundary_at',
        'inactive_boundary_at',
        'unban_transition_at',
      ])
      const boundaryAt = Date.parse(requiredString(payload, 'boundary_at'))
      const inactiveBoundaryAt = Date.parse(requiredString(payload, 'inactive_boundary_at'))
      const unbanTransitionAt = Date.parse(requiredString(payload, 'unban_transition_at'))
      const operationBoundaryAt = Date.parse(effect.operation_key.slice('unban_restore:'.length))
      if (
        effect.source_kind !== 'projection' ||
        effect.source_key !== effect.user_id ||
        effect.entitlement_payment_id !== null ||
        !Number.isFinite(boundaryAt) ||
        !Number.isFinite(inactiveBoundaryAt) ||
        !Number.isFinite(unbanTransitionAt) ||
        !Number.isFinite(operationBoundaryAt) ||
        inactiveBoundaryAt !== operationBoundaryAt ||
        inactiveBoundaryAt > unbanTransitionAt ||
        boundaryAt > unbanTransitionAt
      ) {
        throw new PermanentEffectError('official-group unban restore authority conflicted')
      }
    } else if (effect.operation_key.startsWith('state_restore:')) {
      const payload = exactPayload(effect, ['event_id'])
      const eventId = requiredString(payload, 'event_id', /^evt_[A-Za-z0-9_]+$/)
      if (effect.operation_key !== `state_restore:${eventId}`) {
        throw new PermanentEffectError('official-group state restore identity conflicted')
      }
    } else if (effect.operation_key.startsWith('restore:')) {
      const payload = exactPayload(effect, ['refund_event_id'])
      const refundEventId = requiredString(payload, 'refund_event_id', /^evt_[A-Za-z0-9_]+$/)
      if (effect.operation_key !== `restore:${refundEventId}`) {
        throw new PermanentEffectError('official-group refund restore identity conflicted')
      }
    } else {
      throw new PermanentEffectError('official-group restore operation is invalid')
    }
  } else if (effect.operation_key.startsWith('authority_started:')) {
    const payload = exactPayload(effect, ['boundary_at'])
    const boundaryAt = requiredString(payload, 'boundary_at')
    const operationBoundary = effect.operation_key.slice('authority_started:'.length)
    const boundaryTime = Date.parse(boundaryAt)
    const operationTime = Date.parse(operationBoundary)
    if (
      effect.source_kind !== 'projection' ||
      effect.source_key !== effect.user_id ||
      effect.entitlement_payment_id !== null ||
      !Number.isFinite(boundaryTime) ||
      !Number.isFinite(operationTime) ||
      boundaryTime !== operationTime
    ) {
      throw new PermanentEffectError('official-group projection authority conflicted')
    }
  } else {
    const payload = exactPayload(effect, ['plan'], ['period_start', 'period_end'])
    const plan = requiredString(payload, 'plan')
    if (!['monthly', 'yearly', 'lifetime'].includes(plan)) {
      throw new PermanentEffectError('official-group effect plan is invalid')
    }
    const hasStart = payload.period_start !== undefined
    const hasEnd = payload.period_end !== undefined
    if (hasStart !== hasEnd) {
      throw new PermanentEffectError('official-group trial period is incomplete')
    }
    if (hasStart) {
      const start = Date.parse(requiredString(payload, 'period_start'))
      const end = Date.parse(requiredString(payload, 'period_end'))
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new PermanentEffectError('official-group trial period is invalid')
      }
    }
  }

  const result = await dependencies.joinProOfficialGroup(effect.user_id)
  if (
    !result.success ||
    !['joined', 'already_member'].includes(result.message) ||
    !result.groupId ||
    !UUID_PATTERN.test(result.groupId)
  ) {
    throw new Error(`official-group join failed (${result.message || 'unknown'})`)
  }
  return `group:${result.groupId}`
}

async function dispatchAlert(
  effect: EntitlementEffect,
  dependencies: StripeEntitlementEffectDependencies
): Promise<string> {
  const isManualReview = effect.effect_type === 'payment_manual_review'
  let details: Record<string, unknown>
  if (isManualReview) {
    const payload = exactPayload(effect, ['reason_key'])
    details = {
      effect_id: effect.id,
      reason_key: requiredString(payload, 'reason_key', /^[a-z0-9_:-]{2,96}$/),
      source_kind: effect.source_kind,
      source_key: effect.source_key,
      user_id: effect.user_id,
    }
  } else {
    const payload = exactPayload(effect, ['plan'])
    const plan = requiredString(payload, 'plan')
    if (!['monthly', 'yearly', 'lifetime'].includes(plan)) {
      throw new PermanentEffectError('purchase alert plan is invalid')
    }
    details = {
      effect_id: effect.id,
      plan,
      payment_id: effect.entitlement_payment_id,
      user_id: effect.user_id,
    }
  }

  const delivery = await dependencies.sendRateLimitedAlert(
    {
      source: 'Stripe entitlement worker',
      title: isManualReview ? 'Stripe payment requires manual review' : 'Pro purchase completed',
      message: isManualReview
        ? 'A durable Stripe payment review is waiting for an operator.'
        : 'A verified Pro entitlement payment was activated.',
      level: isManualReview ? 'critical' : 'info',
      details,
    },
    `stripe-entitlement-effect:${effect.id}`,
    isManualReview ? 15 * 60_000 : 24 * 60 * 60_000
  )
  if (!delivery.sent && !delivery.rateLimited) {
    throw new Error('entitlement effect alert was not delivered')
  }
  return `alert:${effect.id}`
}

async function dispatchEffect(
  effect: EntitlementEffect,
  dependencies: StripeEntitlementEffectDependencies
): Promise<string> {
  switch (effect.effect_type) {
    case 'payment_auto_refund':
      return dispatchAutomaticRefund(effect, dependencies)
    case 'recovery_payment_auto_refund':
      return dispatchRecoveryPaymentRefund(effect, dependencies)
    case 'stripe_subscription_cancel':
      return dispatchSubscriptionCancellation(effect, dependencies)
    case 'stripe_lifetime_authority_restore':
      return dispatchLifetimeAuthorityRestore(effect, dependencies)
    case 'pro_official_group_join':
    case 'pro_official_group_restore':
      return dispatchOfficialGroupJoin(effect, dependencies)
    case 'payment_manual_review':
    case 'pro_purchase_alert':
      return dispatchAlert(effect, dependencies)
    default:
      throw new PermanentEffectError('unsupported entitlement effect type')
  }
}

export function createStripeEntitlementEffectStore(
  supabase: SupabaseClient<Database>
): StripeEntitlementEffectStore {
  return {
    async lease(limit, leaseSeconds) {
      const { data, error } = await supabase.rpc('lease_stripe_entitlement_effects_atomic', {
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      })
      if (error) throw new Error(`failed to lease Stripe entitlement effects: ${error.message}`)
      if (!Array.isArray(data)) {
        throw new Error('Stripe entitlement effect lease returned a malformed result')
      }
      return data
    },

    async loadPayment(paymentId) {
      const { data, error } = await supabase
        .from('stripe_entitlement_payments')
        .select('*')
        .eq('id', paymentId)
        .maybeSingle()
      if (error) throw new Error(`failed to load entitlement payment: ${error.message}`)
      if (!data) throw new PermanentEffectError('entitlement payment was not found')
      return data
    },

    async loadTrial(trialId) {
      const { data, error } = await supabase
        .from('stripe_trial_entitlements')
        .select('*')
        .eq('id', trialId)
        .maybeSingle()
      if (error) throw new Error(`failed to load Stripe trial entitlement: ${error.message}`)
      if (!data) throw new PermanentEffectError('Stripe trial entitlement was not found')
      return data
    },

    async claimSubscriptionCancelDispatch(params) {
      const { data, error } = await supabase.rpc(
        'claim_stripe_subscription_cancel_dispatch_atomic',
        {
          p_effect_id: params.effectId,
          p_lease_token: params.leaseToken,
          p_livemode: params.livemode,
        }
      )
      if (error) {
        throw new Error(`failed to claim Stripe cancellation dispatch: ${error.message}`)
      }
      return data
    },

    async claimRecoveryPaymentRefundDispatch(params) {
      const { data, error } = await supabase.rpc('claim_recovery_payment_refund_dispatch_atomic', {
        p_effect_id: params.effectId,
        p_lease_token: params.leaseToken,
        p_livemode: params.livemode,
      })
      if (error) {
        throw new Error(`failed to claim recovery payment refund dispatch: ${error.message}`)
      }
      return data
    },

    async readLifetimeRestoreAuthority(params) {
      const { data, error } = await supabase.rpc('read_lifetime_restore_authority_atomic', {
        p_effect_id: params.effectId,
        p_lease_token: params.leaseToken,
        p_livemode: params.livemode,
      })
      if (error) throw new Error(`failed to read lifetime restore authority: ${error.message}`)
      return data
    },

    async restoreLifetimeAuthority(params) {
      const { data, error } = await supabase.rpc('restore_lifetime_superseded_authority_atomic', {
        p_effect_id: params.effectId,
        p_lease_token: params.leaseToken,
        p_livemode: params.livemode,
        p_stripe_customer_id: params.stripeCustomerId,
        p_stripe_subscription_id: params.stripeSubscriptionId,
        p_subscription_status: params.subscriptionStatus,
        p_period_start: params.periodStart,
        p_period_end: params.periodEnd,
        p_cancel_at_period_end: params.cancelAtPeriodEnd,
      })
      if (error) throw new Error(`failed to restore lifetime authority: ${error.message}`)
      return data
    },

    async finish(params) {
      const { data, error } = await supabase.rpc('finish_stripe_entitlement_effect_atomic', {
        p_effect_id: params.effectId,
        p_lease_token: params.leaseToken,
        p_succeeded: params.succeeded,
        p_external_ref: params.externalRef,
        p_error: params.error,
        p_retry_after_seconds: params.retryAfterSeconds,
      })
      if (error) throw new Error(`failed to finish Stripe entitlement effect: ${error.message}`)
      return data
    },

    async recordDispatchReview({ effect, error: dispatchError }) {
      const { data, error } = await supabase.rpc('record_stripe_manual_review_atomic', {
        p_object_type: 'entitlement_effect',
        p_object_id: effect.id,
        p_user_id: effect.user_id,
        p_reason_key: 'entitlement_effect_dispatch_failed',
        p_reason: 'A Stripe entitlement side effect could not be dispatched safely.',
        p_context: {
          effect_type: effect.effect_type,
          source_kind: effect.source_kind,
          source_key: effect.source_key,
          operation_key: effect.operation_key,
          attempt_count: effect.attempt_count,
          error: dispatchError,
        } satisfies Json,
      })
      if (error) {
        throw new Error(`failed to record entitlement effect review: ${error.message}`)
      }
      const status = exactStatus(data)
      if (status !== 'recorded' && status !== 'already_recorded') {
        throw new Error(`entitlement effect review returned ${status}`)
      }
    },
  }
}

export async function drainStripeEntitlementEffects(
  dependencies: StripeEntitlementEffectDependencies,
  options: { limit?: number; leaseSeconds?: number } = {}
): Promise<StripeEntitlementEffectSummary> {
  const limit = options.limit ?? 10
  const leaseSeconds = options.leaseSeconds ?? 120
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 25 ||
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 30 ||
    leaseSeconds > 300
  ) {
    throw new Error('Stripe entitlement worker options are invalid')
  }

  const effects = await dependencies.store.lease(limit, leaseSeconds)
  const summary: StripeEntitlementEffectSummary = {
    count: 0,
    leased: effects.length,
    completed: 0,
    retryScheduled: 0,
    deadLettered: 0,
    superseded: 0,
  }
  const failures: string[] = []

  for (const effect of effects) {
    try {
      validateLeasedEffect(effect)
      const externalRef = await dispatchEffect(effect, dependencies)
      const status = exactStatus(
        await dependencies.store.finish({
          effectId: effect.id,
          leaseToken: effect.lease_token!,
          succeeded: true,
          externalRef,
          error: null,
          retryAfterSeconds: null,
        })
      )
      if (!SUCCESS_FINISH_STATUSES.has(status)) {
        throw new Error(`successful entitlement effect finish returned ${status}`)
      }
      if (status === 'completed' || status === 'already_completed') {
        summary.completed += 1
        summary.count += 1
      } else {
        summary.superseded += 1
      }
    } catch (error) {
      const message = compactError(error)
      const permanent = error instanceof PermanentEffectError
      try {
        if (permanent || effect.attempt_count >= 10) {
          await dependencies.store.recordDispatchReview({ effect, error: message })
        }
        if (!effect.lease_token || !UUID_PATTERN.test(effect.lease_token)) {
          throw new Error('failed entitlement effect has no valid lease token')
        }
        const status = exactStatus(
          await dependencies.store.finish({
            effectId: effect.id,
            leaseToken: effect.lease_token,
            succeeded: false,
            externalRef: null,
            error: message,
            retryAfterSeconds: permanent ? 3600 : retryDelaySeconds(effect.attempt_count),
          })
        )
        if (!FAILURE_FINISH_STATUSES.has(status)) {
          throw new Error(`failed entitlement effect finish returned ${status}`)
        }
        if (status === 'retry_scheduled') summary.retryScheduled += 1
        else if (status === 'dead_lettered' || status === 'already_dead_lettered') {
          summary.deadLettered += 1
        } else {
          summary.superseded += 1
        }
      } catch (finishError) {
        failures.push(`${effect.id}: ${message}; finish=${compactError(finishError)}`)
        continue
      }
      failures.push(`${effect.id}: ${message}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Stripe entitlement effects require retry (${failures.length}/${effects.length}): ` +
        failures.join(' | ').slice(0, 1800)
    )
  }
  return summary
}
