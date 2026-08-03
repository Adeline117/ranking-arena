/**
 * Cleanup Deleted Accounts Cron
 * GET /api/cron/cleanup-deleted-accounts
 *
 * Runs daily. Hard-deletes users whose 30-day grace period has passed.
 */

import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
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
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function requireStripeLivemode(): boolean {
  const key = env.STRIPE_SECRET_KEY?.trim()
  if (key?.startsWith('sk_live_')) return true
  if (key?.startsWith('sk_test_')) return false
  throw new Error('STRIPE_SECRET_KEY mode is unavailable')
}

interface GroupEdgePurgeResult {
  status: 'purged'
  memberships_removed: number
  bans_removed: number
  owner_memberships_removed: number
}

interface HardDeletionCandidate {
  id: string
  original_email: string | null
  stripe_customer_id: string | null
  api_stripe_subscription_id: string | null
}

function parseHardDeletionCandidates(value: unknown): HardDeletionCandidate[] | null {
  if (!Array.isArray(value)) return null
  const candidates: HardDeletionCandidate[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const row = candidate as Record<string, unknown>
    if (
      Object.keys(row).length !== 4 ||
      typeof row.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id) ||
      (row.original_email !== null && typeof row.original_email !== 'string') ||
      (row.stripe_customer_id !== null && typeof row.stripe_customer_id !== 'string') ||
      (row.api_stripe_subscription_id !== null &&
        typeof row.api_stripe_subscription_id !== 'string')
    ) {
      return null
    }
    candidates.push({
      id: row.id,
      original_email: row.original_email,
      stripe_customer_id: row.stripe_customer_id,
      api_stripe_subscription_id: row.api_stripe_subscription_id,
    } as HardDeletionCandidate)
  }
  return new Set(candidates.map((candidate) => candidate.id)).size === candidates.length
    ? candidates
    : null
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

function isConfirmedMissingAuthUser(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const authError = error as { status?: unknown; code?: unknown; message?: unknown }
  if (authError.status !== 404) return false
  return (
    authError.code === 'user_not_found' ||
    (typeof authError.message === 'string' && /user\s+not\s+found/i.test(authError.message))
  )
}

async function confirmAuthUserAbsent(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string
): Promise<boolean> {
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  if (error) {
    if (isConfirmedMissingAuthUser(error)) return true
    throw new Error(`Auth absence verification failed: ${error.message}`)
  }
  if (data?.user?.id === userId) return false
  throw new Error('Auth absence verification returned an invalid user acknowledgement')
}

export const GET = withCron('cleanup-deleted-accounts', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin()

  // PostgreSQL durably rotates this bounded batch. Permanently pending or
  // malformed early UUIDs therefore cannot starve later privacy deletions.
  const { data: rawExpiredAccounts, error } = (await Reflect.apply(supabase.rpc, supabase, [
    'list_account_hard_deletion_candidates_atomic',
    { p_limit: 100 },
  ])) as { data: unknown; error: { message: string } | null }
  const expiredAccounts = error ? null : parseHardDeletionCandidates(rawExpiredAccounts)

  if (error || !expiredAccounts) {
    logger.error('[cleanup-deleted-accounts] Query error:', error)
    throw error ?? new Error('Hard deletion discovery returned an invalid acknowledgement')
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
        const workerAttemptId = randomUUID()
        const hardDeletionRpc = async (functionName: string) =>
          (await Reflect.apply(supabase.rpc, supabase, [
            functionName,
            {
              p_user_id: account.id,
              p_worker_attempt_id: workerAttemptId,
            },
          ])) as { data: unknown; error: { message: string } | null }
        const { data: hardDeleteClaim, error: hardDeleteClaimError } = await hardDeletionRpc(
          'claim_account_hard_deletion_atomic'
        )
        if (hardDeleteClaimError) throw hardDeleteClaimError
        if (hardDeleteClaim === 'busy' || hardDeleteClaim === 'invalid') {
          return { id: account.id, deleted: false }
        }
        if (hardDeleteClaim === 'completed') return { id: account.id, deleted: true }
        if (hardDeleteClaim !== 'claimed' && hardDeleteClaim !== 'hard_delete_pending') {
          throw new Error('Hard deletion claim returned an invalid acknowledgement')
        }
        let hardDeleteArmed = hardDeleteClaim === 'hard_delete_pending'
        const releaseHardDeleteClaim = async () => {
          const { data, error: releaseError } = await hardDeletionRpc(
            'release_account_hard_deletion_atomic'
          )
          if (releaseError || data !== 'released') {
            logger.error('[cleanup-deleted-accounts] Failed to release pre-arm hard-delete claim', {
              userId: account.id,
              error: releaseError?.message ?? String(data),
            })
          }
        }
        try {
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
                livemode: requireStripeLivemode(),
                includeCustomerSubscriptions: true,
              })
              if (discovery.customerId) {
                throw new Error(
                  'Derived Stripe customer is not durably bound to the deleted profile'
                )
              }
            }
            if (account.stripe_customer_id) {
              const checkoutResult = await expireOpenSubscriptionCheckouts({
                stripeClient,
                customerId: account.stripe_customer_id,
                expectedUserId: account.id,
                livemode: requireStripeLivemode(),
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
                expectedCustomerId: account.stripe_customer_id,
                expectedUserId: account.id,
                livemode: requireStripeLivemode(),
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
            if (!hardDeleteArmed) await releaseHardDeleteClaim()
            return { id: account.id, deleted: false }
          }

          if (!hardDeleteArmed) {
            const { data: armAck, error: armError } = await hardDeletionRpc(
              'arm_account_hard_deletion_atomic'
            )
            if (armError || armAck !== 'armed') {
              throw new Error(`Hard deletion arm failed: ${armError?.message ?? String(armAck)}`)
            }
            hardDeleteArmed = true
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

          // A hard-delete retry may begin after Auth was already removed but
          // before the profile/completion acknowledgements committed. Treat a
          // confirmed missing Auth user as the target state. Otherwise, always
          // verify the remote state after deleteUser, even when its response is
          // successful or throws: an RPC response is not proof of deletion.
          const authAlreadyAbsent = await confirmAuthUserAbsent(supabase, account.id)
          if (!authAlreadyAbsent) {
            let authDeleteError: unknown = null
            try {
              const { error: deleteError } = await supabase.auth.admin.deleteUser(account.id)
              authDeleteError = deleteError
            } catch (deleteError) {
              authDeleteError = deleteError
            }

            const authAbsentAfterDelete = await confirmAuthUserAbsent(supabase, account.id)
            if (!authAbsentAfterDelete) {
              const detail =
                authDeleteError instanceof Error
                  ? authDeleteError.message
                  : authDeleteError && typeof authDeleteError === 'object'
                    ? String((authDeleteError as { message?: unknown }).message ?? authDeleteError)
                    : 'Auth user remains present'
              throw new Error(`Auth delete was not confirmed: ${detail}`)
            }
          }

          // Auth deletion normally cascades the profile. Finalize any residual
          // profile and the armed fence in one PostgreSQL transaction so an RPC
          // response loss cannot leave a split hard-delete acknowledgement.
          const { data: completionAck, error: completionError } = await hardDeletionRpc(
            'finalize_account_hard_deletion_worker_atomic'
          )
          if (completionError || completionAck !== 'completed') {
            throw new Error(
              `Hard deletion completion failed: ${completionError?.message ?? String(completionAck)}`
            )
          }

          return { id: account.id, deleted: true }
        } catch (cleanupError) {
          if (!hardDeleteArmed) await releaseHardDeleteClaim()
          throw cleanupError
        }
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
