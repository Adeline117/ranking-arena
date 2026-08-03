import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Authority =
  | { state: 'active' }
  | { state: 'banned'; ban_duration: string; minimum_banned_until: string }
  | { state: 'delete_absent'; hard_delete_takeover_required: boolean }
  | { state: 'ignore' | 'manual' }

function parseAuthority(value: unknown): Authority | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const authority = value as Record<string, unknown>
  if (
    authority.state === 'active' ||
    authority.state === 'ignore' ||
    authority.state === 'manual'
  ) {
    return Object.keys(authority).length === 1 ? (authority as Authority) : null
  }
  if (
    authority.state === 'delete_absent' &&
    typeof authority.hard_delete_takeover_required === 'boolean' &&
    Object.keys(authority).length === 2
  ) {
    return authority as Authority
  }
  if (
    authority.state === 'banned' &&
    typeof authority.ban_duration === 'string' &&
    authority.ban_duration.length > 0 &&
    authority.ban_duration.length <= 32 &&
    typeof authority.minimum_banned_until === 'string' &&
    Number.isFinite(Date.parse(authority.minimum_banned_until)) &&
    Object.keys(authority).length === 3
  ) {
    return authority as Authority
  }
  return null
}

function isConfirmedMissingAuthUser(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const authError = error as { status?: unknown; code?: unknown; message?: unknown }
  return (
    authError.status === 404 &&
    (authError.code === 'user_not_found' ||
      (typeof authError.message === 'string' && /user\s+not\s+found/i.test(authError.message)))
  )
}

async function confirmAuthUserAbsent(
  admin: ReturnType<typeof getSupabaseAdmin>,
  userId: string
): Promise<boolean> {
  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error) {
    if (isConfirmedMissingAuthUser(error)) return true
    throw new Error(`Auth absence verification failed for ${userId}: ${error.message}`)
  }
  if (data?.user?.id === userId) return false
  throw new Error(`Auth absence verification returned an invalid acknowledgement for ${userId}`)
}

export const GET = withCron('reconcile-account-auth', async (_request: NextRequest) => {
  const admin = getSupabaseAdmin()
  const callRpc = async (name: string, args: Record<string, unknown>) =>
    (await Reflect.apply(admin.rpc, admin, [name, args])) as {
      data: unknown
      error: { message: string } | null
    }
  const { data, error } = await callRpc('list_account_auth_reconciliation_candidates_atomic', {
    p_limit: 100,
  })
  if (error || !Array.isArray(data)) {
    throw new Error(`Auth reconciliation discovery failed: ${error?.message ?? 'invalid response'}`)
  }
  const userIds = data
    .map((candidate) =>
      candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>).user_id
        : null
    )
    .filter(
      (userId): userId is string =>
        typeof userId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)
    )
  if (userIds.length !== data.length || new Set(userIds).size !== userIds.length) {
    throw new Error('Auth reconciliation discovery returned invalid candidates')
  }

  let reconciled = 0
  const failures: string[] = []
  for (const userId of userIds) {
    try {
      let settled = false
      for (let pass = 0; pass < 2 && !settled; pass++) {
        const resolved = await callRpc('resolve_account_auth_reconciliation_authority_atomic', {
          p_user_id: userId,
        })
        const authority = resolved.error ? null : parseAuthority(resolved.data)
        if (!authority) throw new Error(`Auth authority resolution failed for ${userId}`)
        if (authority.state === 'ignore') {
          settled = true
          break
        }
        if (authority.state === 'manual') {
          throw new Error(`Auth authority requires manual repair for ${userId}`)
        }
        if (authority.state === 'delete_absent') {
          if (!(await confirmAuthUserAbsent(admin, userId))) {
            let deletionError: { message?: unknown } | null = null
            try {
              const { error } = await admin.auth.admin.deleteUser(userId)
              deletionError = error
            } catch (error) {
              deletionError =
                error && typeof error === 'object' ? (error as { message?: unknown }) : null
            }
            if (!(await confirmAuthUserAbsent(admin, userId))) {
              throw new Error(
                `Orphan Auth deletion was not confirmed for ${userId}: ${String(deletionError?.message ?? 'user remains present')}`
              )
            }
          }
          if (authority.hard_delete_takeover_required) {
            const finalized = await callRpc('finalize_account_hard_deletion_takeover_atomic', {
              p_user_id: userId,
            })
            if (finalized.error || finalized.data !== 'completed') {
              throw new Error(
                `Hard deletion takeover finalization failed for ${userId}: ${
                  finalized.error?.message ?? String(finalized.data)
                }`
              )
            }
          }
          settled = true
          reconciled++
          break
        }

        const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
          ban_duration: authority.state === 'banned' ? authority.ban_duration : 'none',
        })
        if (updateError)
          throw new Error(`Auth reconciliation update failed: ${updateError.message}`)
        if (authority.state === 'banned') {
          const { error: signOutError } = await admin.auth.admin.signOut(userId, 'global')
          if (signOutError)
            throw new Error(`Auth reconciliation sign-out failed: ${signOutError.message}`)
        }

        const [{ data: freshAuth, error: freshAuthError }, postResolve] = await Promise.all([
          admin.auth.admin.getUserById(userId),
          callRpc('resolve_account_auth_reconciliation_authority_atomic', { p_user_id: userId }),
        ])
        const postAuthority = postResolve.error ? null : parseAuthority(postResolve.data)
        if (freshAuthError || !freshAuth.user || !postAuthority) {
          throw new Error(`Auth reconciliation verification failed for ${userId}`)
        }
        if (postAuthority.state !== authority.state) continue
        const bannedUntil = freshAuth.user.banned_until
          ? Date.parse(freshAuth.user.banned_until)
          : Number.NaN
        if (freshAuth.user.banned_until && !Number.isFinite(bannedUntil)) {
          throw new Error(`Auth reconciliation returned an invalid ban timestamp for ${userId}`)
        }
        const isBanned = Number.isFinite(bannedUntil) && bannedUntil > Date.now()
        const coversMinimumDeadline =
          postAuthority.state !== 'banned' ||
          (Number.isFinite(bannedUntil) &&
            bannedUntil >= Date.parse(postAuthority.minimum_banned_until))
        if (isBanned !== (postAuthority.state === 'banned') || !coversMinimumDeadline) {
          throw new Error(`Auth reconciliation post-write state drifted for ${userId}`)
        }
        settled = true
        reconciled++
      }
      if (!settled) throw new Error(`Auth reconciliation authority kept changing for ${userId}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${userId}: ${message}`)
      logger.error('[reconcile-account-auth] candidate failed', { userId, error: message })
    }
  }

  logger.info('[reconcile-account-auth] reconciliation complete', {
    candidates: userIds.length,
    reconciled,
    failures: failures.length,
  })
  if (failures.length > 0) {
    throw new Error(
      `Auth reconciliation failed for ${failures.length}/${userIds.length} candidate(s): ${failures[0]}`
    )
  }
  return { candidates: userIds.length, reconciled, failures: 0 }
})
