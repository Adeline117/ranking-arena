import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import type { Database, Json } from '@/lib/supabase/database.types'
import { stripeMetadataUserId, stripeObjectId } from '@/lib/stripe/identity'

type EntitlementEffect = Database['public']['Tables']['stripe_entitlement_effects']['Row']
type EntitlementPayment = Database['public']['Tables']['stripe_entitlement_payments']['Row']

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EFFECT_TYPES = new Set([
  'payment_auto_refund',
  'payment_manual_review',
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

class RetryableEffectError extends Error {
  readonly externalRef: string | null

  constructor(message: string, externalRef: string | null = null) {
    super(message)
    this.name = 'RetryableEffectError'
    this.externalRef = externalRef
  }
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
    effect.operation_key.length > 255 ||
    (effect.external_ref !== null &&
      (effect.effect_type !== 'payment_auto_refund' ||
        !/^refund:re_[A-Za-z0-9]+$/.test(effect.external_ref)))
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

function assertRefundIdentity(params: {
  refund: Stripe.Refund
  effect: EntitlementEffect
  payment: EntitlementPayment
  charge: Stripe.Charge
  reasonKey: string
  refundReason: Stripe.RefundCreateParams.Reason
  expectedRefundId?: string
  expectedAmount?: number
}): void {
  const {
    refund,
    effect,
    payment,
    charge,
    reasonKey,
    refundReason,
    expectedRefundId,
    expectedAmount,
  } = params
  if (
    !/^re_[A-Za-z0-9]+$/.test(refund.id) ||
    refund.id.length > 255 ||
    (expectedRefundId !== undefined && refund.id !== expectedRefundId) ||
    refund.object !== 'refund' ||
    stripeObjectId(refund.charge) !== charge.id ||
    stripeObjectId(refund.payment_intent) !== payment.stripe_payment_intent_id ||
    !Number.isSafeInteger(refund.amount) ||
    refund.amount <= 0 ||
    refund.amount > charge.amount ||
    (expectedAmount !== undefined && refund.amount !== expectedAmount) ||
    refund.currency !== payment.currency ||
    refund.reason !== refundReason ||
    refund.metadata?.arena_entitlement_effect_id !== effect.id ||
    refund.metadata?.arena_entitlement_payment_id !== payment.id ||
    refund.metadata?.arena_reason_key !== reasonKey ||
    !['pending', 'requires_action', 'succeeded', 'failed', 'canceled'].includes(refund.status ?? '')
  ) {
    throw new PermanentEffectError('Stripe Refund identity conflicted with the requested refund')
  }
}

function refundIdFromExternalRef(effect: EntitlementEffect): string | null {
  if (effect.external_ref === null) return null
  const match = /^refund:(re_[A-Za-z0-9]+)$/.exec(effect.external_ref)
  if (!match) {
    throw new PermanentEffectError('automatic refund provider reference is invalid')
  }
  return match[1]
}

function retryableRefundStatus(refund: Stripe.Refund): never {
  throw new RetryableEffectError(
    `Stripe Refund ${refund.id} is not terminally succeeded (${refund.status ?? 'unknown'})`,
    `refund:${refund.id}`
  )
}

function successorRefundIdempotencyKey(effectId: string, predecessorRefundId: string): string {
  const predecessorDigest = createHash('sha256').update(predecessorRefundId, 'utf8').digest('hex')
  return `arena_entitlement_refund_${effectId}_${predecessorDigest}`
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

  const refundReason: Stripe.RefundCreateParams.Reason =
    reasonKey === 'duplicate_lifetime_purchase' ? 'duplicate' : 'requested_by_customer'
  const persistedRefundId = refundIdFromExternalRef(effect)
  if (persistedRefundId) {
    const persistedRefund = await dependencies.stripe.refunds.retrieve(persistedRefundId)
    assertRefundIdentity({
      refund: persistedRefund,
      effect,
      payment,
      charge,
      reasonKey,
      refundReason,
      expectedRefundId: persistedRefundId,
    })
    if (persistedRefund.status === 'succeeded') {
      return `refund:${persistedRefund.id}`
    }
    if (persistedRefund.status === 'pending' || persistedRefund.status === 'requires_action') {
      if (charge.refunded === true && charge.amount_refunded === charge.amount) {
        return `charge:${charge.id}:fully_refunded`
      }
      retryableRefundStatus(persistedRefund)
    }
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
      reason: refundReason,
      metadata: {
        arena_entitlement_effect_id: effect.id,
        arena_entitlement_payment_id: payment.id,
        arena_reason_key: reasonKey,
      },
    },
    {
      idempotencyKey: persistedRefundId
        ? successorRefundIdempotencyKey(effect.id, persistedRefundId)
        : `arena_entitlement_refund_${effect.id}`,
    }
  )
  assertRefundIdentity({
    refund,
    effect,
    payment,
    charge,
    reasonKey,
    refundReason,
    expectedAmount: amount,
  })
  if (refund.status !== 'succeeded') retryableRefundStatus(refund)
  return `refund:${refund.id}`
}

async function dispatchSubscriptionCancellation(
  effect: EntitlementEffect,
  dependencies: StripeEntitlementEffectDependencies
): Promise<string> {
  const payload = exactPayload(effect, ['stripe_subscription_id', 'stripe_customer_id', 'reason'])
  const subscriptionId = requiredString(payload, 'stripe_subscription_id', /^sub_[A-Za-z0-9]+$/)
  const customerId = requiredString(payload, 'stripe_customer_id', /^cus_[A-Za-z0-9]+$/)
  const reason = requiredString(payload, 'reason')
  if (
    reason !== 'lifetime_membership_activated' ||
    effect.operation_key !== `cancel:subscription:${subscriptionId}` ||
    !effect.entitlement_payment_id
  ) {
    throw new PermanentEffectError('subscription cancellation authority is invalid')
  }

  const payment = await dependencies.store.loadPayment(effect.entitlement_payment_id)
  validatePaymentEffectIdentity(effect, payment)
  if (
    payment.payment_kind !== 'lifetime' ||
    payment.plan !== 'lifetime' ||
    payment.payment_status !== 'succeeded' ||
    payment.stripe_customer_id !== customerId
  ) {
    throw new PermanentEffectError('subscription cancellation payment is not lifetime authority')
  }

  const subscription = await dependencies.stripe.subscriptions.retrieve(subscriptionId)
  const actualCustomerId = stripeObjectId(subscription.customer)
  const metadataUserId = stripeMetadataUserId(
    subscription.metadata,
    `Stripe subscription ${subscription.id}`
  )
  if (
    subscription.id !== subscriptionId ||
    subscription.object !== 'subscription' ||
    actualCustomerId !== customerId ||
    subscription.livemode !== dependencies.expectedLivemode ||
    (metadataUserId !== null && effect.user_id !== null && metadataUserId !== effect.user_id)
  ) {
    throw new PermanentEffectError('Stripe Subscription cancellation identity conflicted')
  }
  if (subscription.status === 'canceled') {
    return `subscription:${subscription.id}:canceled`
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

async function dispatchOfficialGroupJoin(
  effect: EntitlementEffect,
  dependencies: StripeEntitlementEffectDependencies
): Promise<string> {
  if (!effect.user_id || !UUID_PATTERN.test(effect.user_id)) {
    throw new PermanentEffectError('official-group effect has no active user')
  }
  if (effect.effect_type === 'pro_official_group_restore') {
    const payload = exactPayload(effect, ['refund_event_id'])
    requiredString(payload, 'refund_event_id', /^evt_[A-Za-z0-9]+$/)
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
    case 'stripe_subscription_cancel':
      return dispatchSubscriptionCancellation(effect, dependencies)
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
      const externalRef = error instanceof RetryableEffectError ? error.externalRef : null
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
            externalRef,
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
