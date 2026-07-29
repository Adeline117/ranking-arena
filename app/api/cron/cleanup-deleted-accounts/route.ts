/**
 * Cleanup Deleted Accounts Cron
 * GET /api/cron/cleanup-deleted-accounts
 *
 * Runs daily. Hard-deletes users whose 30-day grace period has passed.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { withCron } from '@/lib/api/with-cron'
import { getStripe } from '@/lib/stripe'
import {
  expireOpenSubscriptionCheckouts,
  stopStripeSubscriptionRenewals,
} from '@/lib/stripe/account-deletion'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface GroupEdgePurgeResult {
  status: 'purged'
  memberships_removed: number
  bans_removed: number
  owner_memberships_removed: number
}

function isGroupEdgePurgeResult(value: unknown): value is GroupEdgePurgeResult {
  if (!value || typeof value !== 'object') return false

  const result = value as Record<string, unknown>
  return (
    result.status === 'purged' &&
    Number.isSafeInteger(result.memberships_removed) &&
    (result.memberships_removed as number) >= 0 &&
    Number.isSafeInteger(result.bans_removed) &&
    (result.bans_removed as number) >= 0 &&
    Number.isSafeInteger(result.owner_memberships_removed) &&
    (result.owner_memberships_removed as number) >= 0 &&
    (result.owner_memberships_removed as number) <= (result.memberships_removed as number)
  )
}

export const GET = withCron('cleanup-deleted-accounts', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin()

  // Find users whose deletion grace period has passed
  const { data: expiredAccounts, error } = await supabase
    .from('user_profiles')
    .select('id, original_email, stripe_customer_id, api_stripe_subscription_id')
    .not('deleted_at', 'is', null)
    .lt('deletion_scheduled_at', new Date().toISOString())
    .limit(100)

  if (error) {
    logger.error('[cleanup-deleted-accounts] Query error:', error)
    throw error
  }

  if (!expiredAccounts || expiredAccounts.length === 0) {
    return { count: 0, message: 'No accounts to cleanup' }
  }

  const errors: string[] = []

  // Process deletion in batches to avoid overload
  const BATCH_SIZE = 10
  let deleted = 0

  for (let i = 0; i < expiredAccounts.length; i += BATCH_SIZE) {
    const batch = expiredAccounts.slice(i, i + BATCH_SIZE)

    const results = await Promise.allSettled(
      batch.map(async (account) => {
        // Never erase the user while a recurring charge may still exist. A
        // failed Stripe cancellation leaves the account pending for retry.
        const { data: subscription, error: subscriptionError } = await supabase
          .from('subscriptions')
          .select('stripe_subscription_id, status, plan')
          .eq('user_id', account.id)
          .in('status', ['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'])
          .limit(1)
          .maybeSingle()
        if (subscriptionError) throw subscriptionError

        const subscriptionId = subscription?.stripe_subscription_id ?? null
        const isLifetime =
          subscription?.plan === 'lifetime' || subscriptionId?.startsWith('lifetime_')
        const recurringSubscriptionId = subscriptionId && !isLifetime ? subscriptionId : null
        const subscriptionIds = [recurringSubscriptionId, account.api_stripe_subscription_id]
        const hasStripeBillingSurface =
          !!account.stripe_customer_id || subscriptionIds.some(Boolean)
        let closedCheckoutCount = 0
        const changedRemoteSubscriptionIds = new Set<string>()

        if (hasStripeBillingSurface) {
          const stripeClient = getStripe()
          if (account.stripe_customer_id) {
            const checkoutResult = await expireOpenSubscriptionCheckouts({
              stripeClient,
              customerId: account.stripe_customer_id,
            })
            closedCheckoutCount =
              checkoutResult.expiredSessionIds.length +
              checkoutResult.racedSubscriptionIds.length +
              checkoutResult.racedOneTimeSessionIds.length
            subscriptionIds.push(...checkoutResult.racedSubscriptionIds)
          }

          const stopped = await stopStripeSubscriptionRenewals({
            stripeClient,
            subscriptionIds,
            expectedCustomerId: account.stripe_customer_id,
            deletionMode: 'permanent',
          })
          stopped.changedSubscriptionIds.forEach((id) => changedRemoteSubscriptionIds.add(id))
          if (!account.stripe_customer_id && stopped.customerId) {
            const checkoutResult = await expireOpenSubscriptionCheckouts({
              stripeClient,
              customerId: stopped.customerId,
            })
            closedCheckoutCount =
              checkoutResult.expiredSessionIds.length +
              checkoutResult.racedSubscriptionIds.length +
              checkoutResult.racedOneTimeSessionIds.length
            if (checkoutResult.racedSubscriptionIds.length > 0) {
              const racedStopped = await stopStripeSubscriptionRenewals({
                stripeClient,
                subscriptionIds: checkoutResult.racedSubscriptionIds,
                expectedCustomerId: stopped.customerId,
                deletionMode: 'permanent',
              })
              racedStopped.changedSubscriptionIds.forEach((id) =>
                changedRemoteSubscriptionIds.add(id)
              )
            }
          }
          if (changedRemoteSubscriptionIds.size > 0) {
            logger.info(
              `[cleanup-deleted-accounts] Cancelled ${changedRemoteSubscriptionIds.size} Stripe subscription(s) for user ${account.id}`
            )
          }
        }

        // Cancellation and Checkout-expiry webhooks update the local ledgers
        // asynchronously. Keep the profile tombstone for another cron pass
        // whenever this pass observed a linked subscription or closed a remote
        // billing surface. The next pass may hard-delete only after those
        // local links have converged, so a late signed event never loses its
        // owner row halfway through processing.
        if (
          recurringSubscriptionId ||
          account.api_stripe_subscription_id ||
          changedRemoteSubscriptionIds.size > 0 ||
          closedCheckoutCount > 0
        ) {
          logger.info(
            `[cleanup-deleted-accounts] Billing settlement pending for user ${account.id}; hard deletion deferred`
          )
          return { id: account.id, deleted: false }
        }

        // Auth deletes the parent row first and then cascades group edges. The
        // edge triggers acquire the same advisory locks used by join/moderation,
        // so purge those edges in canonical lock order before touching Auth.
        const { data: groupPurgeResult, error: groupPurgeError } = await supabase.rpc(
          'purge_deleted_account_group_edges',
          { p_user_id: account.id }
        )
        if (groupPurgeError) {
          throw new Error(`Group edge purge failed: ${groupPurgeError.message}`)
        }
        if (!isGroupEdgePurgeResult(groupPurgeResult)) {
          throw new Error('Group edge purge returned an invalid or incomplete result')
        }

        // Hard delete from auth
        const { error: deleteError } = await supabase.auth.admin.deleteUser(account.id)
        if (deleteError) {
          throw new Error(`Auth delete failed: ${deleteError.message}`)
        }

        // Delete profile data
        const { error: profileError } = await supabase
          .from('user_profiles')
          .delete()
          .eq('id', account.id)

        if (profileError) {
          throw new Error(`Profile delete failed: ${profileError.message}`)
        }

        return { id: account.id, deleted: true }
      })
    )

    for (let j = 0; j < results.length; j++) {
      const result = results[j]
      if (result.status === 'fulfilled') {
        if (result.value.deleted) deleted++
      } else {
        errors.push(`Failed to delete ${batch[j].id}: ${result.reason}`)
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Failed to permanently delete ${errors.length}/${expiredAccounts.length} account(s): ${errors[0]}`
    )
  }

  return {
    count: deleted,
    total: expiredAccounts.length,
  }
})
