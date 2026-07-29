import 'server-only'

import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe'
import type { Database, Json } from '@/lib/supabase/database.types'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { StripeAuthorityError } from '@/lib/stripe/entitlement-authority'
import {
  recordApiTierInvoicePayment,
  resolveApiTierInvoicePaymentAuthority,
} from '@/lib/stripe/api-tier-payment'
import { currentStripeLivemode } from '@/lib/stripe/api-tier-reversal-actions'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/
const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/
const INVOICE_ID_PATTERN = /^in_[A-Za-z0-9_]+$/

type BackfillTarget = {
  livemode: boolean
  subscriptionId: string
  userId: string
  customerId: string
  lastInvoiceId: string | null
  leaseToken: string
}

export type ApiTierPaymentBackfillSummary = {
  claimed: number
  completed: number
  retryScheduled: number
  attention: number
  scannedInvoices: number
}

class BackfillAttentionError extends Error {}

function objectValue(value: Json): Record<string, Json | undefined> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, Json | undefined>)
    : null
}

function parseTarget(value: Json, workerToken: string): BackfillTarget {
  const row = objectValue(value)
  const livemode = row?.livemode
  const subscriptionId = row?.stripe_subscription_id
  const userId = row?.user_id
  const customerId = row?.stripe_customer_id
  const lastInvoiceId = row?.last_invoice_id
  const leaseToken = row?.lease_token
  if (
    typeof livemode !== 'boolean' ||
    typeof subscriptionId !== 'string' ||
    !SUBSCRIPTION_ID_PATTERN.test(subscriptionId) ||
    typeof userId !== 'string' ||
    !UUID_PATTERN.test(userId) ||
    typeof customerId !== 'string' ||
    !CUSTOMER_ID_PATTERN.test(customerId) ||
    (lastInvoiceId !== null &&
      (typeof lastInvoiceId !== 'string' || !INVOICE_ID_PATTERN.test(lastInvoiceId))) ||
    typeof leaseToken !== 'string' ||
    leaseToken !== workerToken
  ) {
    throw new Error(
      'claim_api_tier_payment_backfill_targets_atomic returned malformed target identity'
    )
  }
  return {
    livemode,
    subscriptionId,
    userId: userId.toLowerCase(),
    customerId,
    lastInvoiceId,
    leaseToken,
  }
}

async function checkpoint(params: {
  supabase: SupabaseClient<Database>
  target: BackfillTarget
  lastInvoiceId: string
  scannedDelta: number
}): Promise<void> {
  const { data, error } = await params.supabase.rpc(
    'checkpoint_api_tier_payment_backfill_target_atomic',
    {
      p_livemode: params.target.livemode,
      p_stripe_subscription_id: params.target.subscriptionId,
      p_lease_token: params.target.leaseToken,
      p_last_invoice_id: params.lastInvoiceId,
      p_scanned_delta: params.scannedDelta,
      p_lease_seconds: 300,
    }
  )
  if (error) {
    throw new Error(`Failed to checkpoint API tier invoice backfill: ${error.message}`)
  }
  if (data !== 'checkpointed') {
    throw new Error(
      `checkpoint_api_tier_payment_backfill_target_atomic returned ${String(data ?? 'missing')}`
    )
  }
}

async function finish(params: {
  supabase: SupabaseClient<Database>
  target: BackfillTarget
  succeeded: boolean
  requiresAttention: boolean
  error?: string
}): Promise<'completed' | 'retry_scheduled' | 'attention'> {
  const { data, error } = await params.supabase.rpc(
    'finish_api_tier_payment_backfill_target_atomic',
    {
      p_livemode: params.target.livemode,
      p_stripe_subscription_id: params.target.subscriptionId,
      p_lease_token: params.target.leaseToken,
      p_succeeded: params.succeeded,
      p_requires_attention: params.requiresAttention,
      p_error: params.error?.slice(0, 2_000) ?? null,
    }
  )
  if (error) {
    throw new Error(`Failed to finish API tier invoice backfill: ${error.message}`)
  }
  const accepted = new Set(['completed', 'already_completed', 'retry_scheduled', 'attention'])
  if (typeof data !== 'string' || !accepted.has(data)) {
    throw new Error(
      `finish_api_tier_payment_backfill_target_atomic returned ${String(data ?? 'missing')}`
    )
  }
  return data === 'already_completed'
    ? 'completed'
    : (data as 'completed' | 'retry_scheduled' | 'attention')
}

async function processTarget(params: {
  stripe: Stripe
  supabase: SupabaseClient<Database>
  target: BackfillTarget
}): Promise<number> {
  let startingAfter = params.target.lastInvoiceId ?? undefined
  const seenCursors = new Set<string>()
  let scanned = 0

  for (;;) {
    const page = await params.stripe.invoices.list({
      subscription: params.target.subscriptionId,
      status: 'paid',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (
      !Array.isArray(page.data) ||
      typeof page.has_more !== 'boolean' ||
      (page.has_more && page.data.length === 0)
    ) {
      throw new Error('Stripe Invoice backfill pagination response is malformed')
    }

    for (const invoice of page.data) {
      if (invoice.amount_paid <= 0) continue
      const observation = {
        type: 'historical_backfill' as const,
        id: `backfill:${String(params.target.livemode)}:${invoice.id}`,
        created: Math.floor(Date.now() / 1000),
        livemode: params.target.livemode,
      }
      const authority = await resolveApiTierInvoicePaymentAuthority({
        stripe: params.stripe,
        invoice,
        observation,
      })
      if (
        authority.userId !== params.target.userId ||
        authority.customerId !== params.target.customerId ||
        authority.subscriptionId !== params.target.subscriptionId ||
        authority.livemode !== params.target.livemode
      ) {
        throw new BackfillAttentionError(
          `Invoice ${invoice.id} does not match frozen API tier backfill identity`
        )
      }
      const outcome = await recordApiTierInvoicePayment({
        supabase: params.supabase,
        authority,
        observation,
      })
      if (outcome.status === 'identity_conflict' || outcome.status === 'manual_review') {
        throw new BackfillAttentionError(`Invoice ${invoice.id} persisted ${outcome.status}`)
      }
    }

    scanned += page.data.length
    if (page.data.length > 0) {
      const cursor = page.data.at(-1)?.id
      if (!cursor || seenCursors.has(cursor)) {
        throw new Error('Stripe Invoice backfill pagination did not advance')
      }
      seenCursors.add(cursor)
      await checkpoint({
        supabase: params.supabase,
        target: params.target,
        lastInvoiceId: cursor,
        scannedDelta: page.data.length,
      })
      startingAfter = cursor
    }
    if (!page.has_more) return scanned
  }
}

export async function drainApiTierPaymentBackfill(
  params: {
    stripe?: Stripe
    supabase?: SupabaseClient<Database>
    limit?: number
  } = {}
): Promise<ApiTierPaymentBackfillSummary> {
  const stripe = params.stripe ?? getStripe()
  const supabase = params.supabase ?? (getSupabaseAdmin() as SupabaseClient<Database>)
  const limit = params.limit ?? 1
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    throw new Error('API tier payment backfill limit is invalid')
  }
  const livemode = currentStripeLivemode()
  const workerToken = randomUUID()
  const { data, error } = await supabase.rpc('claim_api_tier_payment_backfill_targets_atomic', {
    p_worker_token: workerToken,
    p_limit: limit,
    p_lease_seconds: 300,
    p_livemode: livemode,
  })
  if (error) {
    throw new Error(`Failed to claim API tier invoice backfill: ${error.message}`)
  }
  if (!Array.isArray(data)) {
    throw new Error('claim_api_tier_payment_backfill_targets_atomic returned an invalid result')
  }
  const targets = data.map((value) => parseTarget(value, workerToken))
  const summary: ApiTierPaymentBackfillSummary = {
    claimed: targets.length,
    completed: 0,
    retryScheduled: 0,
    attention: 0,
    scannedInvoices: 0,
  }

  for (const target of targets) {
    try {
      summary.scannedInvoices += await processTarget({ stripe, supabase, target })
      const outcome = await finish({
        supabase,
        target,
        succeeded: true,
        requiresAttention: false,
      })
      if (outcome === 'completed') summary.completed += 1
    } catch (error) {
      const requiresAttention =
        error instanceof StripeAuthorityError || error instanceof BackfillAttentionError
      const message = error instanceof Error ? error.message : String(error)
      const outcome = await finish({
        supabase,
        target,
        succeeded: false,
        requiresAttention,
        error: message,
      })
      if (outcome === 'attention') summary.attention += 1
      else summary.retryScheduled += 1
    }
  }
  return summary
}
