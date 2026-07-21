/**
 * 群组订阅 API
 * 处理付费群组的订阅操作
 */

import Stripe from 'stripe'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { success, error, badRequest, handleError } from '@/lib/api/response'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { assertStripePaymentRuntimeReady } from '@/lib/stripe'
import { STRIPE_API_VERSION } from '@/lib/stripe/version'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const stripePaymentIntentIdPattern = /^pi_[A-Za-z0-9_]+$/
const stripeCheckoutSessionIdPattern = /^cs_[A-Za-z0-9_]+$/
const normalizedUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const canonicalUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const timestampSchema = z.string().datetime({ offset: true })
const stripePaymentIntentIdSchema = z.string().min(4).max(255).regex(stripePaymentIntentIdPattern)
const stripeCheckoutSessionIdSchema = z
  .string()
  .min(4)
  .max(255)
  .regex(stripeCheckoutSessionIdPattern)

// Trials may carry legacy payment-shaped keys only when their values are null.
// Paid requests provide one canonical PaymentIntent and may additionally bind
// a Checkout Session. Provider, amount, currency and reference stay server-owned.
const trialActivationRequestSchema = z
  .object({
    group_id: normalizedUuidSchema,
    tier: z.literal('trial'),
    payment_intent_id: z.null().optional(),
    checkout_session_id: z.null().optional(),
    payment_provider: z.null().optional(),
    payment_reference: z.null().optional(),
    amount_cents: z.null().optional(),
    currency: z.null().optional(),
  })
  .strict()

const monthlyActivationRequestSchema = z
  .object({
    group_id: normalizedUuidSchema,
    tier: z.literal('monthly'),
    payment_intent_id: stripePaymentIntentIdSchema,
    checkout_session_id: stripeCheckoutSessionIdSchema.nullable().optional(),
  })
  .strict()

const yearlyActivationRequestSchema = z
  .object({
    group_id: normalizedUuidSchema,
    tier: z.literal('yearly'),
    payment_intent_id: stripePaymentIntentIdSchema,
    checkout_session_id: stripeCheckoutSessionIdSchema.nullable().optional(),
  })
  .strict()

const activationRequestSchema = z.discriminatedUnion('tier', [
  trialActivationRequestSchema,
  monthlyActivationRequestSchema,
  yearlyActivationRequestSchema,
])

const activationSuccessStatuses = ['subscribed', 'renewed', 'already_active'] as const
const activationFailureStatuses = [
  'not_found',
  'dissolved',
  'not_premium',
  'trial_unavailable',
  'trial_already_used',
  'payment_replayed',
  'amount_mismatch',
  'perpetual_entitlement',
  'account_inactive',
  'banned',
  'score_too_low',
  'verified_only',
  'official',
  'invalid',
  'invalid_payment',
] as const

const activationSuccessSchema = z
  .object({
    status: z.enum(activationSuccessStatuses),
    subscription_id: canonicalUuidSchema,
    tier: z.enum(['monthly', 'yearly', 'trial']),
    subscription_status: z.enum(['active', 'trialing']),
    expires_at: timestampSchema,
    price_paid: z.number().nonnegative(),
    membership_status: z.enum(['joined', 'already_member']),
    member_count: z.number().int().nonnegative(),
    idempotent_replay: z.boolean(),
  })
  .strict()

const activationResultSchema = z.discriminatedUnion('status', [
  activationSuccessSchema,
  ...activationFailureStatuses.map((status) => z.object({ status: z.literal(status) }).strict()),
])

const groupSubscriptionSchema = z
  .object({
    id: canonicalUuidSchema,
    tier: z.enum(['monthly', 'yearly', 'trial']),
    status: z.enum(['active', 'trialing']),
    expires_at: timestampSchema,
    price_paid: z.number().nonnegative(),
    cancel_at_period_end: z.boolean(),
  })
  .strict()

const readGroupSubscriptionResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      group: z
        .object({
          id: canonicalUuidSchema,
          name: z.string(),
          is_premium_only: z.boolean(),
          price_monthly: z.number().nonnegative().nullable(),
          price_yearly: z.number().nonnegative().nullable(),
          original_price_monthly: z.number().nonnegative().nullable(),
          original_price_yearly: z.number().nonnegative().nullable(),
          allow_trial: z.boolean(),
          trial_days: z.number().int().nonnegative().nullable(),
        })
        .strict(),
      subscription: groupSubscriptionSchema.nullable(),
      is_subscribed: z.boolean(),
    })
    .strict(),
  z.object({ status: z.literal('not_found') }).strict(),
  z.object({ status: z.literal('invalid') }).strict(),
])

const cancellationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.enum(['cancellation_scheduled', 'already_scheduled']),
      expires_at: timestampSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('already_inactive'),
      subscription_status: z.string().min(1),
    })
    .strict(),
  ...(['expired', 'not_found', 'forbidden', 'invalid'] as const).map((status) =>
    z.object({ status: z.literal(status) }).strict()
  ),
])

type PaidTier = 'monthly' | 'yearly'
type ActivationRequest = z.infer<typeof activationRequestSchema>
type ActivationSuccess = z.infer<typeof activationSuccessSchema>

type VerifiedStripePayment = {
  paymentIntentId: string
  checkoutSessionId: string | null
  amountCents: number
  currency: 'usd'
}

function metadataMatchesGroupPass(
  metadata: Stripe.Metadata | null | undefined,
  userId: string,
  groupId: string,
  tier: PaidTier
): boolean {
  return (
    metadata !== null &&
    metadata !== undefined &&
    metadata.user_id === userId &&
    metadata.group_id === groupId &&
    metadata.tier === tier &&
    (metadata.plan === undefined || metadata.plan === tier)
  )
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function activationSuccessMatchesRequest(
  result: ActivationSuccess,
  request: ActivationRequest
): boolean {
  if (request.tier === 'trial') {
    if (result.status === 'renewed') return false
    if (result.status === 'subscribed') {
      return (
        result.tier === 'trial' &&
        result.subscription_status === 'trialing' &&
        result.price_paid === 0 &&
        !result.idempotent_replay
      )
    }

    return (
      result.status === 'already_active' &&
      result.idempotent_replay &&
      ((result.tier === 'trial' && result.subscription_status === 'trialing') ||
        (result.tier !== 'trial' && result.subscription_status === 'active'))
    )
  }

  return (
    result.status !== 'already_active' &&
    result.tier === request.tier &&
    result.subscription_status === 'active' &&
    result.price_paid > 0
  )
}

async function verifyStripePayment(input: {
  stripe: Stripe
  checkoutSessionId?: string | null
  paymentIntentId: string
  userId: string
  groupId: string
  tier: PaidTier
}): Promise<VerifiedStripePayment | null> {
  let checkoutSessionId: string | null = null
  let checkoutAmountCents: number | null = null

  if (input.checkoutSessionId) {
    const session = await input.stripe.checkout.sessions.retrieve(input.checkoutSessionId, {
      expand: ['payment_intent'],
    })
    const sessionPaymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id

    if (
      session.id !== input.checkoutSessionId ||
      !stripeCheckoutSessionIdPattern.test(session.id) ||
      session.mode !== 'payment' ||
      session.status !== 'complete' ||
      session.payment_status !== 'paid' ||
      session.client_reference_id !== input.userId ||
      !metadataMatchesGroupPass(session.metadata, input.userId, input.groupId, input.tier) ||
      typeof session.currency !== 'string' ||
      session.currency.toLowerCase() !== 'usd' ||
      !isPositiveSafeInteger(session.amount_total) ||
      sessionPaymentIntentId !== input.paymentIntentId ||
      !stripePaymentIntentIdPattern.test(sessionPaymentIntentId)
    ) {
      return null
    }

    checkoutSessionId = session.id
    checkoutAmountCents = session.amount_total
  }

  // Always retrieve the canonical PaymentIntent, even when Checkout returned
  // an expanded object, so status and received amount come from one fresh proof.
  const paymentIntent = await input.stripe.paymentIntents.retrieve(input.paymentIntentId)
  if (
    paymentIntent.id !== input.paymentIntentId ||
    !stripePaymentIntentIdPattern.test(paymentIntent.id) ||
    paymentIntent.status !== 'succeeded' ||
    typeof paymentIntent.currency !== 'string' ||
    paymentIntent.currency.toLowerCase() !== 'usd' ||
    !metadataMatchesGroupPass(paymentIntent.metadata, input.userId, input.groupId, input.tier) ||
    !isPositiveSafeInteger(paymentIntent.amount) ||
    !isPositiveSafeInteger(paymentIntent.amount_received) ||
    paymentIntent.amount_received !== paymentIntent.amount ||
    (checkoutAmountCents !== null && paymentIntent.amount_received !== checkoutAmountCents)
  ) {
    return null
  }

  return {
    paymentIntentId: paymentIntent.id,
    checkoutSessionId,
    amountCents: paymentIntent.amount_received,
    currency: 'usd',
  }
}

/**
 * GET - 获取用户在指定群组的订阅状态
 */
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    try {
      const { searchParams } = new URL(request.url)
      const parsedGroupId = normalizedUuidSchema.safeParse(searchParams.get('group_id'))
      if (!parsedGroupId.success) {
        return badRequest('group_id must be a UUID')
      }
      const groupId = parsedGroupId.data

      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        'read_group_subscription_atomic',
        {
          p_actor_id: user.id,
          p_group_id: groupId,
        }
      )
      const parsedResult = readGroupSubscriptionResultSchema.safeParse(rpcResult)
      if (rpcError || !parsedResult.success) {
        logger.error('[group-subscribe] Atomic read failed', {
          code: rpcError?.code,
          groupId,
          userId: user.id,
        })
        return error('Failed to fetch group pass', 500)
      }

      const result = parsedResult.data
      if (result.status === 'not_found') return error('Group not found', 404)
      if (result.status === 'invalid') return badRequest('Invalid group id')
      if (result.group.id !== groupId || result.is_subscribed !== (result.subscription !== null)) {
        logger.error('[group-subscribe] Atomic read returned inconsistent authority', {
          groupId,
          userId: user.id,
        })
        return error('Failed to fetch group pass', 500)
      }

      return success({
        group: result.group,
        subscription: result.subscription,
        is_subscribed: result.is_subscribed,
      })
    } catch (caught: unknown) {
      return handleError(caught)
    }
  },
  { name: 'groups-subscribe-get', rateLimit: 'read' }
)

/**
 * POST - 创建群组订阅
 */
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    try {
      let rawBody: unknown
      try {
        rawBody = await request.json()
      } catch {
        return badRequest('Invalid JSON body')
      }

      const parsedRequest = activationRequestSchema.safeParse(rawBody)
      if (!parsedRequest.success) {
        return badRequest('Invalid group pass request')
      }
      const activationRequest = parsedRequest.data

      let verifiedPayment: VerifiedStripePayment | null = null
      if (activationRequest.tier !== 'trial') {
        try {
          assertStripePaymentRuntimeReady()
        } catch (runtimeError) {
          logger.error('[group-subscribe] Stripe payment runtime is not ready', {
            error: runtimeError instanceof Error ? runtimeError.message : String(runtimeError),
          })
          return error('Paid subscriptions are not available at this time', 503)
        }

        const stripeSecret = process.env.STRIPE_SECRET_KEY
        if (!stripeSecret) {
          logger.error('[group-subscribe] STRIPE_SECRET_KEY not set; refusing paid subscription')
          return error('Paid subscriptions are not available at this time', 503)
        }

        const stripe = new Stripe(stripeSecret, { apiVersion: STRIPE_API_VERSION })
        try {
          verifiedPayment = await verifyStripePayment({
            stripe,
            checkoutSessionId: activationRequest.checkout_session_id,
            paymentIntentId: activationRequest.payment_intent_id,
            userId: user.id,
            groupId: activationRequest.group_id,
            tier: activationRequest.tier,
          })
        } catch (stripeError: unknown) {
          logger.error('[group-subscribe] Stripe verification failed', {
            errorType:
              stripeError instanceof Error ? stripeError.constructor.name : typeof stripeError,
            groupId: activationRequest.group_id,
            userId: user.id,
          })
          return error('Failed to verify payment. Please try again.', 402)
        }
        if (!verifiedPayment) {
          return error('Stripe payment does not match this group pass', 402)
        }
      }

      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        'activate_group_subscription_atomic',
        {
          p_actor_id: user.id,
          p_group_id: activationRequest.group_id,
          p_tier: activationRequest.tier,
          p_payment_provider: verifiedPayment ? 'stripe' : null,
          p_payment_intent_id: verifiedPayment?.paymentIntentId ?? null,
          p_checkout_session_id: verifiedPayment?.checkoutSessionId ?? null,
          p_amount_cents: verifiedPayment?.amountCents ?? 0,
          p_currency: verifiedPayment?.currency ?? null,
        }
      )
      const parsedResult = activationResultSchema.safeParse(rpcResult)
      if (rpcError || !parsedResult.success) {
        logger.error('[group-subscribe] Atomic activation failed', {
          code: rpcError?.code,
          groupId: activationRequest.group_id,
          userId: user.id,
        })
        return error('Failed to activate group pass', 500)
      }

      const result = parsedResult.data
      if (
        result.status === 'subscribed' ||
        result.status === 'renewed' ||
        result.status === 'already_active'
      ) {
        if (!activationSuccessMatchesRequest(result, activationRequest)) {
          logger.error('[group-subscribe] Atomic activation ACK contradicted request', {
            groupId: activationRequest.group_id,
            status: result.status,
            userId: user.id,
          })
          return error('Failed to activate group pass', 500)
        }

        return success(
          {
            subscription: {
              id: result.subscription_id,
              tier: result.tier,
              status: result.subscription_status,
              expires_at: result.expires_at,
              price_paid: result.price_paid,
            },
            message:
              result.status === 'renewed'
                ? 'Group pass renewed!'
                : result.status === 'already_active'
                  ? 'An active group pass already exists.'
                  : result.tier === 'trial'
                    ? 'Trial started!'
                    : 'Group pass activated!',
          },
          result.status === 'subscribed' && !result.idempotent_replay ? 201 : 200
        )
      }

      const statusMap: Record<
        (typeof activationFailureStatuses)[number],
        { message: string; http: number }
      > = {
        not_found: { message: 'Group not found', http: 404 },
        dissolved: { message: 'This group has been dissolved', http: 409 },
        not_premium: { message: 'This group does not require a paid pass', http: 400 },
        trial_unavailable: { message: 'This group does not allow trials', http: 400 },
        trial_already_used: { message: 'You have already used this trial', http: 409 },
        payment_replayed: { message: 'This payment was already consumed', http: 409 },
        amount_mismatch: { message: 'Payment amount does not match the group price', http: 409 },
        perpetual_entitlement: { message: 'This group access is already perpetual', http: 409 },
        account_inactive: { message: 'Account is not eligible', http: 403 },
        banned: { message: 'You are banned from this group', http: 403 },
        score_too_low: { message: 'Arena score requirement not met', http: 403 },
        verified_only: { message: 'Verified trader status required', http: 403 },
        official: { message: 'Official groups do not accept group passes', http: 403 },
        invalid: { message: 'Invalid group pass request', http: 400 },
        invalid_payment: { message: 'Invalid payment proof', http: 400 },
      }
      const mapped = statusMap[result.status]
      return error(mapped.message, mapped.http)
    } catch (caught: unknown) {
      return handleError(caught)
    }
  },
  { name: 'groups-subscribe-post', rateLimit: 'write' }
)

/**
 * DELETE - 取消群组订阅
 */
export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    try {
      const { searchParams } = new URL(request.url)
      const parsedSubscriptionId = normalizedUuidSchema.safeParse(searchParams.get('id'))
      if (!parsedSubscriptionId.success) {
        return badRequest('id must be a UUID')
      }
      const subscriptionId = parsedSubscriptionId.data

      const { data: rpcResult, error: rpcError } = await supabase.rpc(
        'cancel_group_subscription_atomic',
        {
          p_actor_id: user.id,
          p_subscription_id: subscriptionId,
        }
      )
      const parsedResult = cancellationResultSchema.safeParse(rpcResult)
      if (rpcError || !parsedResult.success) {
        logger.error('[group-subscribe] Atomic cancellation failed', {
          code: rpcError?.code,
          subscriptionId,
          userId: user.id,
        })
        return error('Failed to cancel subscription', 500)
      }

      const result = parsedResult.data
      if (result.status === 'not_found') return error('Subscription not found', 404)
      if (result.status === 'forbidden') {
        return error('You can only cancel your own group pass', 403)
      }
      if (result.status === 'invalid') return badRequest('Invalid subscription id')

      return success({
        status: result.status,
        expires_at: 'expires_at' in result ? result.expires_at : null,
        message:
          result.status === 'cancellation_scheduled'
            ? 'Auto-renewal is off. Your prepaid group pass remains active until it expires.'
            : result.status === 'already_scheduled'
              ? 'This group pass is already scheduled to end.'
              : result.status === 'expired'
                ? 'This group pass has expired.'
                : 'This group pass is already inactive.',
      })
    } catch (caught: unknown) {
      return handleError(caught)
    }
  },
  { name: 'groups-subscribe-delete', rateLimit: 'write' }
)
