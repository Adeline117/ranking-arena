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
  discoverStripeSubscriptionBilling,
  expireOpenSubscriptionCheckouts,
  stopStripeSubscriptionRenewals,
  type AccountDeletionOneTimeSettlementObservation,
} from '@/lib/stripe/account-deletion'
import {
  checkAccountDeletionOneTimeSettlementsReady,
  persistAccountDeletionOneTimeSettlementScan,
} from '@/lib/stripe/account-deletion-settlement'

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
        const stripeCustomerId = account.stripe_customer_id
        const oneTimeSettlements = new Map<string, AccountDeletionOneTimeSettlementObservation>()
        const mergeOneTimeSettlements = (
          observations: AccountDeletionOneTimeSettlementObservation[]
        ): void => {
          for (const observation of observations) {
            const existing = oneTimeSettlements.get(observation.checkoutSessionId)
            if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
              throw new Error('Stripe one-time Checkout settlement changed during cleanup')
            }
            oneTimeSettlements.set(observation.checkoutSessionId, observation)
          }
        }

        if (hasStripeBillingSurface) {
          const stripeClient = getStripe()
          if (!account.stripe_customer_id && subscriptionIds.some(Boolean)) {
            const discovery = await discoverStripeSubscriptionBilling({
              stripeClient,
              subscriptionIds,
              expectedUserId: account.id,
              includeCustomerSubscriptions: true,
            })
            if (discovery.customerId) {
              throw new Error('Derived Stripe customer is not durably bound to the deleted profile')
            }
          }
          if (account.stripe_customer_id) {
            const checkoutResult = await expireOpenSubscriptionCheckouts({
              stripeClient,
              customerId: account.stripe_customer_id,
              expectedUserId: account.id,
            })
            closedCheckoutCount =
              checkoutResult.expiredSessionIds.length +
              checkoutResult.racedSubscriptionIds.length +
              checkoutResult.racedOneTimeSessionIds.length
            subscriptionIds.push(...checkoutResult.racedSubscriptionIds)
            mergeOneTimeSettlements(checkoutResult.oneTimeSettlements)
          }

          if (account.stripe_customer_id) {
            const stopped = await stopStripeSubscriptionRenewals({
              stripeClient,
              subscriptionIds,
              expectedUserId: account.id,
              expectedCustomerId: account.stripe_customer_id,
              deletionMode: 'permanent',
            })
            stopped.changedSubscriptionIds.forEach((id) => changedRemoteSubscriptionIds.add(id))
            if (changedRemoteSubscriptionIds.size > 0) {
              logger.info(
                `[cleanup-deleted-accounts] Cancelled ${changedRemoteSubscriptionIds.size} Stripe subscription(s) for user ${account.id}`
              )
            }
          }
        }

        const settlementScan = await persistAccountDeletionOneTimeSettlementScan({
          supabase,
          userId: account.id,
          stripeCustomerId,
          observations: [...oneTimeSettlements.values()],
        })
        const settlementReady = await checkAccountDeletionOneTimeSettlementsReady({
          supabase,
          userId: account.id,
          scanToken: settlementScan.scanToken,
        })

        // Cancellation and Checkout-expiry webhooks update local ledgers
        // asynchronously. The durable one-time barrier additionally requires
        // every complete lifetime, Tip, and group Checkout from this fresh,
        // fully paginated scan to be fulfilled, refunded, or retained in
        // terminal manual review before Auth deletion.
        if (
          recurringSubscriptionId ||
          account.api_stripe_subscription_id ||
          changedRemoteSubscriptionIds.size > 0 ||
          closedCheckoutCount > 0 ||
          !settlementReady.ready
        ) {
          logger.info(
            `[cleanup-deleted-accounts] Billing settlement pending for user ${account.id}; hard deletion deferred`,
            {
              pendingOneTimeSessions: settlementReady.pendingSessionIds.length,
              pendingLifetimeReservations: settlementReady.pendingLifetimeReservations,
              pendingTips: settlementReady.pendingTips,
            }
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
