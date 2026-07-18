/**
 * Cron: Reconcile recurring Pro status against Stripe
 * Schedule: Daily at 03:00 UTC
 *
 * Local subscription rows are repair hints, never proof of payment. Every
 * upgrade is verified by retrieving the Stripe Subscription first. Every
 * downgrade is verified by successfully listing the customer's Stripe state.
 * Stripe/network/config uncertainty always preserves access for manual review.
 */

import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { withCron } from '@/lib/api/with-cron'
import { createLogger } from '@/lib/utils/logger'
import { getStripe, STRIPE_API_PRICE_IDS, STRIPE_PRICE_IDS } from '@/lib/stripe'
import { updateUserSubscription } from '@/app/api/stripe/webhook/handlers/subscription'
import { classifyActiveProSubscription } from '@/lib/stripe/reconciliation'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const logger = createLogger('reconcile-subscriptions')

export const GET = withCron(
  'reconcile-subscriptions',
  async (_request: NextRequest, { supabase }) => {
    const sb: SupabaseClient<Database> = supabase
    let upgradedCount = 0
    let downgradedCount = 0
    let repairedCount = 0
    let skippedCount = 0
    const errors: string[] = []
    const stripe = getStripe()
    const configuredPrices = {
      monthly: STRIPE_PRICE_IDS.monthly,
      yearly: STRIPE_PRICE_IDS.yearly,
      apiStarter: STRIPE_API_PRICE_IDS.starter,
      apiPro: STRIPE_API_PRICE_IDS.pro,
    }

    // Case 1: Active subscription but profile says free
    // A local active row is only a hint. Retrieve Stripe before granting Pro.
    const { data: needUpgrade, error: upgradeQueryErr } = await sb
      .from('subscriptions')
      .select('user_id, stripe_subscription_id, stripe_customer_id')
      .in('status', ['active', 'trialing'])

    if (upgradeQueryErr) {
      logger.error('Failed to query active subscriptions', { error: upgradeQueryErr.message })
    } else if (needUpgrade && needUpgrade.length > 0) {
      const activeUserIds = needUpgrade.map((s) => s.user_id)

      // Find which of these users have profile != 'pro'
      const { data: desyncedProfiles } = await sb
        .from('user_profiles')
        .select('id, stripe_customer_id')
        .in('id', activeUserIds)
        .or('subscription_tier.is.null,subscription_tier.neq.pro')

      if (desyncedProfiles && desyncedProfiles.length > 0) {
        const localByUser = new Map(
          needUpgrade.map((subscription) => [subscription.user_id, subscription])
        )

        for (const profile of desyncedProfiles) {
          const local = localByUser.get(profile.id)
          if (!local?.stripe_subscription_id) {
            skippedCount++
            errors.push(`Missing Stripe subscription ID for ${profile.id}`)
            continue
          }

          try {
            const subscription = await stripe.subscriptions.retrieve(local.stripe_subscription_id)
            const stripeCustomerId =
              typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer.id
            const expectedCustomerId = profile.stripe_customer_id || local.stripe_customer_id
            if (expectedCustomerId && stripeCustomerId !== expectedCustomerId) {
              skippedCount++
              errors.push(`Stripe customer ownership mismatch for ${profile.id}`)
              continue
            }

            const classification = classifyActiveProSubscription([subscription], configuredPrices)
            if (classification.kind !== 'active') {
              skippedCount++
              if (classification.kind === 'unknown-active-price') {
                errors.push(`Unknown active Stripe price for ${profile.id}`)
              }
              continue
            }

            await updateUserSubscription(profile.id, subscription, classification.plan)
            upgradedCount++
          } catch (error) {
            skippedCount++
            errors.push(`Stripe upgrade verification failed for ${profile.id}: ${String(error)}`)
          }
        }
      }
    }

    // Case 2: Profile says pro but no active subscription
    // A missing local row is not proof of cancellation. Ask Stripe before any
    // downgrade, and preserve access on all external or mapping uncertainty.
    const { data: proProfiles, error: proQueryErr } = await sb
      .from('user_profiles')
      .select('id, pro_plan, stripe_customer_id')
      .eq('subscription_tier', 'pro')

    if (proQueryErr) {
      logger.error('Failed to query pro profiles', { error: proQueryErr.message })
    } else if (proProfiles && proProfiles.length > 0) {
      // Skip lifetime plan holders — they may not have an active subscription record
      const nonLifetimeProfiles = proProfiles.filter((p) => p.pro_plan !== 'lifetime')
      const proUserIds = nonLifetimeProfiles.map((p) => p.id)

      if (proUserIds.length > 0) {
        // Find which have NO active subscription
        const { data: activeSubs, error: activeSubsError } = await sb
          .from('subscriptions')
          .select('user_id')
          .in('user_id', proUserIds)
          .in('status', ['active', 'trialing'])

        if (activeSubsError) {
          logger.error('Failed to query local active subscriptions; refusing downgrades', {
            error: activeSubsError.message,
          })
          return {
            count: upgradedCount,
            upgraded: upgradedCount,
            repaired: repairedCount,
            downgraded: 0,
            skipped: skippedCount + proUserIds.length,
            errors: [...errors, activeSubsError.message],
          }
        }

        const usersWithActiveSub = new Set(activeSubs?.map((s) => s.user_id) || [])
        const idsToDowngrade = proUserIds.filter((id) => !usersWithActiveSub.has(id))

        if (idsToDowngrade.length > 0) {
          const candidates = nonLifetimeProfiles.filter((profile) =>
            idsToDowngrade.includes(profile.id)
          )
          const finalDowngradeIds: string[] = []

          for (const profile of candidates) {
            if (!profile.stripe_customer_id) {
              skippedCount++
              errors.push(`Missing Stripe customer ID for ${profile.id}`)
              continue
            }

            try {
              const stripeSubscriptions = await stripe.subscriptions.list({
                customer: profile.stripe_customer_id,
                status: 'all',
                limit: 100,
              })
              const classification = classifyActiveProSubscription(
                stripeSubscriptions.data,
                configuredPrices
              )

              if (classification.kind === 'active') {
                await updateUserSubscription(
                  profile.id,
                  classification.subscription,
                  classification.plan
                )
                repairedCount++
                continue
              }
              if (classification.kind === 'unknown-active-price') {
                skippedCount++
                errors.push(`Unknown active Stripe price for ${profile.id}`)
                continue
              }
              finalDowngradeIds.push(profile.id)
            } catch (error) {
              skippedCount++
              errors.push(
                `Stripe downgrade verification failed for ${profile.id}: ${String(error)}`
              )
            }
          }

          if (finalDowngradeIds.length > 0) {
            const { error: downgradeErr } = await sb
              .from('user_profiles')
              .update({
                subscription_tier: 'free',
                updated_at: new Date().toISOString(),
              })
              .in('id', finalDowngradeIds)

            if (downgradeErr) {
              logger.error('Failed to downgrade desynced profiles', {
                error: downgradeErr.message,
                count: finalDowngradeIds.length,
              })
            } else {
              downgradedCount = finalDowngradeIds.length
              logger.info(
                `Downgraded ${downgradedCount} profiles to free (had pro profile but no active subscription)`
              )
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      logger.error('Subscription reconciliation completed with preserved-access skips', {
        errorCount: errors.length,
        skippedCount,
      })
      await sendRateLimitedAlert(
        {
          title: 'Stripe subscription reconciliation needs review',
          message: errors.slice(0, 10).join('\n'),
          level: 'critical',
          details: { errorCount: errors.length, skippedCount },
        },
        'reconcile-subscriptions:verification-errors'
      )
    }

    const count = upgradedCount + repairedCount + downgradedCount
    return {
      count,
      upgraded: upgradedCount,
      repaired: repairedCount,
      downgraded: downgradedCount,
      skipped: skippedCount,
      errors,
    }
  }
)
