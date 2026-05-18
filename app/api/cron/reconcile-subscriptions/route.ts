/**
 * Cron: Reconcile subscription status between subscriptions table and user_profiles
 * Schedule: Daily at 03:00 UTC
 *
 * Fixes two types of desync:
 * 1. user_profiles.subscription_tier = 'pro' but no active subscription record
 *    → Downgrade profile to 'free' (subscription table is source of truth)
 * 2. Active subscription exists but user_profiles.subscription_tier != 'pro'
 *    → Upgrade profile to 'pro'
 *
 * Root cause of desync: the RPC update_subscription_and_profile can fail, falling
 * back to two separate updates that may partially succeed.
 */

import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withCron } from '@/lib/api/with-cron'
import { createLogger } from '@/lib/utils/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const logger = createLogger('reconcile-subscriptions')

export const GET = withCron(
  'reconcile-subscriptions',
  async (_request: NextRequest, { supabase }) => {
    const sb = supabase as SupabaseClient
    let upgradedCount = 0
    let downgradedCount = 0

    // Case 1: Active subscription but profile says free
    // subscriptions table is source of truth → upgrade profile
    const { data: needUpgrade, error: upgradeQueryErr } = await sb
      .from('subscriptions')
      .select('user_id')
      .in('status', ['active', 'trialing'])

    if (upgradeQueryErr) {
      logger.error('Failed to query active subscriptions', { error: upgradeQueryErr.message })
    } else if (needUpgrade && needUpgrade.length > 0) {
      const activeUserIds = needUpgrade.map((s) => s.user_id)

      // Find which of these users have profile != 'pro'
      const { data: desyncedProfiles } = await sb
        .from('user_profiles')
        .select('id')
        .in('id', activeUserIds)
        .or('subscription_tier.is.null,subscription_tier.neq.pro')

      if (desyncedProfiles && desyncedProfiles.length > 0) {
        const idsToUpgrade = desyncedProfiles.map((p) => p.id)
        const { error: upgradeErr } = await sb
          .from('user_profiles')
          .update({
            subscription_tier: 'pro',
            updated_at: new Date().toISOString(),
          })
          .in('id', idsToUpgrade)

        if (upgradeErr) {
          logger.error('Failed to upgrade desynced profiles', {
            error: upgradeErr.message,
            count: idsToUpgrade.length,
          })
        } else {
          upgradedCount = idsToUpgrade.length
          logger.info(
            `Upgraded ${upgradedCount} profiles to pro (had active subscription but profile said free)`
          )
        }
      }
    }

    // Case 2: Profile says pro but no active subscription
    // subscriptions table is source of truth → downgrade profile
    // Exclude NFT/lifetime users who may not have a subscriptions record
    const { data: proProfiles, error: proQueryErr } = await sb
      .from('user_profiles')
      .select('id, pro_plan')
      .eq('subscription_tier', 'pro')

    if (proQueryErr) {
      logger.error('Failed to query pro profiles', { error: proQueryErr.message })
    } else if (proProfiles && proProfiles.length > 0) {
      // Skip lifetime plan holders — they may not have an active subscription record
      const nonLifetimeProfiles = proProfiles.filter((p) => p.pro_plan !== 'lifetime')
      const proUserIds = nonLifetimeProfiles.map((p) => p.id)

      if (proUserIds.length > 0) {
        // Find which have NO active subscription
        const { data: activeSubs } = await sb
          .from('subscriptions')
          .select('user_id')
          .in('user_id', proUserIds)
          .in('status', ['active', 'trialing'])

        const usersWithActiveSub = new Set(activeSubs?.map((s) => s.user_id) || [])
        const idsToDowngrade = proUserIds.filter((id) => !usersWithActiveSub.has(id))

        // Also check NFT membership — don't downgrade users with valid NFT
        // (NFT users have wallet_address set and are checked by subscription-expiry cron)
        if (idsToDowngrade.length > 0) {
          const { data: nftUsers } = await sb
            .from('user_profiles')
            .select('id')
            .in('id', idsToDowngrade)
            .not('wallet_address', 'is', null)

          const nftUserIds = new Set(nftUsers?.map((u) => u.id) || [])
          const finalDowngradeIds = idsToDowngrade.filter((id) => !nftUserIds.has(id))

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

    const count = upgradedCount + downgradedCount
    return { count, upgraded: upgradedCount, downgraded: downgradedCount }
  }
)
