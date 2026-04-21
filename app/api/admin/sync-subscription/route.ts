/**
 * POST /api/admin/sync-subscription?userId=xxx
 *
 * Admin endpoint to force-sync a user's subscription state from Stripe.
 * Looks up the user's stripe_customer_id, lists their Stripe subscriptions,
 * and reconciles the local `subscriptions` table accordingly.
 *
 * Auth: Admin role required (via verifyAdminAuth)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdminAuth } from '@/lib/auth/verify-service-auth'
import { getStripe, SUBSCRIPTION_STATUS_MAP } from '@/lib/stripe'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  // Admin sensitive write — failClose rate limiting
  const rateLimitResponse = await checkRateLimit(request, {
    ...RateLimitPresets.sensitive,
    prefix: 'admin-sync-subscription',
    failClose: true,
  })
  if (rateLimitResponse) return rateLimitResponse

  // Auth check
  if (!(await verifyAdminAuth(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const userId = searchParams.get('userId')

  if (!userId) {
    return NextResponse.json(
      { error: 'Missing required query param: userId' },
      { status: 400 }
    )
  }

  const supabase = getSupabaseAdmin()

  try {
    // 1. Look up user's stripe_customer_id from user_profiles
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, stripe_customer_id, subscription_tier')
      .eq('id', userId)
      .single()

    if (profileError || !profile) {
      logger.warn('sync-subscription: user not found', { userId })
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    const stripeCustomerId = (profile as unknown as Record<string, unknown>).stripe_customer_id as string | null

    if (!stripeCustomerId) {
      logger.warn('sync-subscription: user has no stripe_customer_id', { userId })
      return NextResponse.json(
        { error: 'User has no Stripe customer ID. Nothing to sync.' },
        { status: 400 }
      )
    }

    const customerId = stripeCustomerId

    // 2. List subscriptions from Stripe
    const stripe = getStripe()
    const stripeSubscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 10,
    })

    // 3. Find the active subscription (active or trialing)
    const activeSub = stripeSubscriptions.data.find(
      (s) => s.status === 'active' || s.status === 'trialing'
    )

    if (activeSub) {
      // Determine plan from price ID
      const priceId = activeSub.items.data[0]?.price.id
      const lifetimePriceId = process.env.STRIPE_PRO_LIFETIME_PRICE_ID
      const yearlyPriceId = process.env.STRIPE_PRO_YEARLY_PRICE_ID
      const plan = priceId === yearlyPriceId
        ? 'yearly'
        : (lifetimePriceId && priceId === lifetimePriceId)
          ? 'lifetime'
          : 'monthly'

      const status = SUBSCRIPTION_STATUS_MAP[activeSub.status] || activeSub.status
      const sub = activeSub as unknown as Record<string, unknown>
      const itemPeriod = activeSub.items?.data?.[0] as unknown as Record<string, unknown> | undefined
      const pStart = (sub.current_period_start ?? itemPeriod?.current_period_start) as number | undefined
      const pEnd = (sub.current_period_end ?? itemPeriod?.current_period_end) as number | undefined
      const periodStart = pStart
        ? new Date(pStart * 1000).toISOString()
        : new Date(activeSub.start_date * 1000).toISOString()
      const periodEnd = pEnd
        ? new Date(pEnd * 1000).toISOString()
        : null

      // Upsert the subscriptions table
      const { error: subError } = await supabase
        .from('subscriptions')
        .upsert(
          {
            user_id: userId,
            stripe_subscription_id: activeSub.id,
            stripe_customer_id: customerId,
            status,
            tier: 'pro',
            plan,
            current_period_start: periodStart,
            current_period_end: periodEnd,
            cancel_at_period_end: activeSub.cancel_at_period_end,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' }
        )

      if (subError) {
        logger.error('sync-subscription: failed to upsert subscription', {
          userId,
          error: subError.message,
        })
        return NextResponse.json(
          { error: `Failed to upsert subscription: ${subError.message}` },
          { status: 500 }
        )
      }

      // Update user_profiles to pro
      const { error: tierError } = await supabase
        .from('user_profiles')
        .update({
          subscription_tier: 'pro',
          pro_plan: plan,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)

      if (tierError) {
        logger.error('sync-subscription: failed to update user tier', {
          userId,
          error: tierError.message,
        })
      }

      logger.info('sync-subscription: synced active subscription', {
        userId,
        stripeSubscriptionId: activeSub.id,
        status,
        plan,
      })

      return NextResponse.json({
        success: true,
        action: 'synced_active',
        subscription: {
          stripeSubscriptionId: activeSub.id,
          status,
          plan,
          periodStart,
          periodEnd,
          cancelAtPeriodEnd: activeSub.cancel_at_period_end,
        },
      })
    } else {
      // 4. No active subscription — downgrade to free
      const { error: subError } = await supabase
        .from('subscriptions')
        .update({
          status: 'canceled',
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)

      if (subError) {
        logger.warn('sync-subscription: failed to update subscription to canceled', {
          userId,
          error: subError.message,
        })
      }

      const { error: tierError } = await supabase
        .from('user_profiles')
        .update({
          subscription_tier: 'free',
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)

      if (tierError) {
        logger.error('sync-subscription: failed to downgrade user tier', {
          userId,
          error: tierError.message,
        })
      }

      logger.info('sync-subscription: no active subscription, downgraded to free', {
        userId,
        totalStripeSubscriptions: stripeSubscriptions.data.length,
      })

      return NextResponse.json({
        success: true,
        action: 'downgraded_to_free',
        totalStripeSubscriptions: stripeSubscriptions.data.length,
      })
    }
  } catch (error) {
    logger.apiError('/api/admin/sync-subscription', error, { userId })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
