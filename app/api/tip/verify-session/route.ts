import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('tip-verify-session')
const NO_STORE = 'private, no-store'

export const dynamic = 'force-dynamic'

const UUID = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const STRIPE_SESSION = z.string().regex(/^cs_[A-Za-z0-9_]{1,252}$/)
const STRIPE_PAYMENT_INTENT = z.string().regex(/^pi_[A-Za-z0-9_]{1,252}$/)
const STRIPE_CHARGE = z.string().regex(/^ch_[A-Za-z0-9_]{1,252}$/)
const STRIPE_CUSTOMER = z.string().regex(/^cus_[A-Za-z0-9_]{1,251}$/)
const TIMESTAMP = z.string().datetime({ offset: true })

const VerifyBodySchema = z.object({ session_id: STRIPE_SESSION }).strict()

const TipAuthoritySchema = z
  .object({
    id: UUID,
    from_user_id: UUID,
    checkout_post_id: UUID.nullable(),
    checkout_to_user_id: UUID.nullable(),
    amount_cents: z.number().int().min(100).max(50_000),
    status: z.enum(['pending', 'completed', 'failed', 'refunded', 'identity_conflict']),
    stripe_checkout_session_id: STRIPE_SESSION.nullable(),
    stripe_payment_intent_id: STRIPE_PAYMENT_INTENT.nullable(),
    stripe_charge_id: STRIPE_CHARGE.nullable(),
    stripe_customer_id: STRIPE_CUSTOMER.nullable(),
    currency: z.string().nullable(),
    completed_at: TIMESTAMP.nullable(),
    checkout_expires_at: TIMESTAMP.nullable(),
  })
  .strict()

const OwnershipSchema = z
  .object({
    product_kind: z.literal('tip'),
    ledger_id: UUID,
    owner_user_id: UUID,
    amount_paid: z.number().int().min(100).max(50_000),
    currency: z.literal('usd'),
    livemode: z.literal(true),
    checkout_session_id: STRIPE_SESSION,
    stripe_payment_intent_id: STRIPE_PAYMENT_INTENT,
    stripe_charge_id: STRIPE_CHARGE,
    stripe_customer_id: STRIPE_CUSTOMER,
  })
  .strict()

type TipAuthority = z.infer<typeof TipAuthoritySchema>

type TipFailureCode =
  | 'TIP_PAYMENT_PENDING'
  | 'TIP_PAYMENT_FAILED'
  | 'TIP_PAYMENT_REFUNDED'
  | 'TIP_PAYMENT_IDENTITY_CONFLICT'
  | 'TIP_PAYMENT_NOT_FOUND'
  | 'TIP_PAYMENT_AUTHORITY_UNAVAILABLE'

function failure(status: number, code: TipFailureCode, error: string, retryAfter?: number) {
  return NextResponse.json(
    { success: false as const, code, error },
    {
      status,
      headers: {
        'Cache-Control': NO_STORE,
        ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
      },
    }
  )
}

function nonCompletedTipFailure(tip: TipAuthority) {
  if (tip.status === 'pending') {
    return failure(409, 'TIP_PAYMENT_PENDING', 'Tip payment confirmation is still processing.', 2)
  }
  if (tip.status === 'failed') {
    return failure(410, 'TIP_PAYMENT_FAILED', 'Tip payment did not complete.')
  }
  if (tip.status === 'refunded') {
    return failure(410, 'TIP_PAYMENT_REFUNDED', 'Tip payment has been refunded.')
  }
  if (tip.status === 'identity_conflict') {
    return failure(409, 'TIP_PAYMENT_IDENTITY_CONFLICT', 'Tip payment identity requires review.')
  }
  return null
}

function hasSameTipAuthority(left: TipAuthority, right: TipAuthority): boolean {
  return (
    left.id === right.id &&
    left.from_user_id === right.from_user_id &&
    left.checkout_post_id === right.checkout_post_id &&
    left.checkout_to_user_id === right.checkout_to_user_id &&
    left.amount_cents === right.amount_cents &&
    left.status === right.status &&
    left.stripe_checkout_session_id === right.stripe_checkout_session_id &&
    left.stripe_payment_intent_id === right.stripe_payment_intent_id &&
    left.stripe_charge_id === right.stripe_charge_id &&
    left.stripe_customer_id === right.stripe_customer_id &&
    left.currency === right.currency &&
    left.completed_at === right.completed_at &&
    left.checkout_expires_at === right.checkout_expires_at
  )
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return failure(400, 'TIP_PAYMENT_NOT_FOUND', 'Invalid JSON body')
    }

    const parsedBody = VerifyBodySchema.safeParse(body)
    if (!parsedBody.success) {
      return failure(400, 'TIP_PAYMENT_NOT_FOUND', 'Invalid tip session identity')
    }
    const sessionId = parsedBody.data.session_id
    const viewerId = user.id.toLowerCase()

    const { data: tipData, error: tipError } = await supabase
      .from('tips')
      .select(
        'id, from_user_id, checkout_post_id, checkout_to_user_id, amount_cents, status, stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id, stripe_customer_id, currency, completed_at, checkout_expires_at'
      )
      .eq('stripe_checkout_session_id', sessionId)
      .eq('from_user_id', viewerId)
      .maybeSingle()

    if (tipError) {
      logger.error('[Tip Verify] Durable Tip lookup failed', {
        viewerId,
        error: tipError.message,
      })
      return failure(
        503,
        'TIP_PAYMENT_AUTHORITY_UNAVAILABLE',
        'Tip payment authority is unavailable. Please retry.',
        3
      )
    }
    if (!tipData) {
      return failure(404, 'TIP_PAYMENT_NOT_FOUND', 'Tip payment was not found for this account.')
    }

    const parsedTip = TipAuthoritySchema.safeParse(tipData)
    if (!parsedTip.success || parsedTip.data.stripe_checkout_session_id !== sessionId) {
      logger.error('[Tip Verify] Durable Tip identity is malformed', { viewerId })
      return failure(
        503,
        'TIP_PAYMENT_AUTHORITY_UNAVAILABLE',
        'Tip payment authority is unavailable. Please retry.',
        3
      )
    }
    const tip = parsedTip.data

    const initialNonCompleted = nonCompletedTipFailure(tip)
    if (initialNonCompleted) return initialNonCompleted

    if (
      !tip.checkout_post_id ||
      !tip.checkout_to_user_id ||
      !tip.stripe_payment_intent_id ||
      !tip.stripe_charge_id ||
      !tip.stripe_customer_id ||
      tip.currency !== 'usd' ||
      !tip.completed_at ||
      !tip.checkout_expires_at
    ) {
      logger.error('[Tip Verify] Completed Tip has incomplete payment identity', {
        viewerId,
        tipId: tip.id,
      })
      return failure(
        503,
        'TIP_PAYMENT_AUTHORITY_UNAVAILABLE',
        'Tip payment authority is unavailable. Please retry.',
        3
      )
    }

    const { data: ownershipData, error: ownershipError } = await supabase
      .from('stripe_payment_ownerships')
      .select(
        'product_kind, ledger_id, owner_user_id, amount_paid, currency, livemode, checkout_session_id, stripe_payment_intent_id, stripe_charge_id, stripe_customer_id'
      )
      .eq('product_kind', 'tip')
      .eq('ledger_id', tip.id)
      .maybeSingle()

    const parsedOwnership = OwnershipSchema.safeParse(ownershipData)
    if (
      ownershipError ||
      !parsedOwnership.success ||
      parsedOwnership.data.ledger_id !== tip.id ||
      parsedOwnership.data.owner_user_id !== viewerId ||
      parsedOwnership.data.amount_paid !== tip.amount_cents ||
      parsedOwnership.data.currency !== tip.currency ||
      parsedOwnership.data.checkout_session_id !== sessionId ||
      parsedOwnership.data.stripe_payment_intent_id !== tip.stripe_payment_intent_id ||
      parsedOwnership.data.stripe_charge_id !== tip.stripe_charge_id ||
      parsedOwnership.data.stripe_customer_id !== tip.stripe_customer_id
    ) {
      logger.error('[Tip Verify] Exact Stripe ownership is unavailable or mismatched', {
        viewerId,
        tipId: tip.id,
        error: ownershipError?.message,
      })
      return failure(
        503,
        'TIP_PAYMENT_AUTHORITY_UNAVAILABLE',
        'Tip payment authority is unavailable. Please retry.',
        3
      )
    }

    // There is no deployed atomic read RPC spanning Tips and payment
    // ownership. Re-read the viewer-bound Tip after ownership validation so a
    // refund or identity-conflict transition that won between the first two
    // statements cannot be projected from the older snapshot as success.
    const { data: finalTipData, error: finalTipError } = await supabase
      .from('tips')
      .select(
        'id, from_user_id, checkout_post_id, checkout_to_user_id, amount_cents, status, stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id, stripe_customer_id, currency, completed_at, checkout_expires_at'
      )
      .eq('stripe_checkout_session_id', sessionId)
      .eq('from_user_id', viewerId)
      .maybeSingle()
    const finalTipResult = TipAuthoritySchema.safeParse(finalTipData)
    if (
      finalTipError ||
      !finalTipResult.success ||
      finalTipResult.data.stripe_checkout_session_id !== sessionId ||
      finalTipResult.data.from_user_id !== viewerId
    ) {
      logger.error('[Tip Verify] Final durable Tip confirmation is unavailable', {
        viewerId,
        tipId: tip.id,
        error: finalTipError?.message,
      })
      return failure(
        503,
        'TIP_PAYMENT_AUTHORITY_UNAVAILABLE',
        'Tip payment authority is unavailable. Please retry.',
        3
      )
    }

    const finalTip = finalTipResult.data
    const finalNonCompleted = nonCompletedTipFailure(finalTip)
    if (finalNonCompleted) return finalNonCompleted
    if (!hasSameTipAuthority(tip, finalTip)) {
      logger.error('[Tip Verify] Durable Tip authority changed during verification', {
        viewerId,
        tipId: tip.id,
      })
      return failure(
        503,
        'TIP_PAYMENT_AUTHORITY_UNAVAILABLE',
        'Tip payment authority is unavailable. Please retry.',
        3
      )
    }

    const response = NextResponse.json({
      success: true as const,
      data: {
        tip: {
          tip_id: finalTip.id,
          session_id: sessionId,
          from_user_id: viewerId,
          post_id: finalTip.checkout_post_id,
          to_user_id: finalTip.checkout_to_user_id,
          amount_cents: finalTip.amount_cents,
          currency: 'usd' as const,
          status: 'completed' as const,
          completed_at: finalTip.completed_at,
        },
      },
      meta: { timestamp: new Date().toISOString() },
    })
    response.headers.set('Cache-Control', NO_STORE)
    return response
  },
  { name: 'tip-verify-session', rateLimit: 'sensitive' }
)
