/** Recover an account during its 30-day deletion grace period. */

import { escapeLikePattern } from '@/lib/sanitize'
import {
  PENDING_DELETION_BAN_DURATION,
  RENEWABLE_SUBSCRIPTION_STATUSES,
} from '@/lib/auth/deletion-ban'
import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { withPublic } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import { isAccountRecoveryToken } from '@/lib/auth/account-recovery-token'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { getStripe } from '@/lib/stripe'
import { checkRateLimit } from '@/lib/utils/rate-limit'

const logger = createLogger('account-recover')
const INVALID_RECOVERY = 'Invalid credentials or no pending deletion'
// Email+password lane: unknown email, wrong password and an expired grace
// period all get this SAME 401 so the endpoint is not an account/deletion-state
// oracle. (The token lane keeps its explicit 410: the token is the secret.)
const INVALID_PASSWORD_RECOVERY =
  'Invalid credentials, no pending deletion, or the recovery period has expired'

// Per-email brute-force budget on top of the per-IP `sensitive` preset. Each
// password attempt briefly lifts the deletion ban (GoTrue rejects banned users
// before checking the password, so there is no ban-preserving way to verify),
// so the number of attempts per account must be tightly bounded.
const PER_EMAIL_RATE_LIMIT = {
  requests: 5,
  window: 15 * 60,
  prefix: 'account-recover-email',
  failClose: true,
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function banOnce(userId: string): Promise<boolean> {
  const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
    ban_duration: PENDING_DELETION_BAN_DURATION,
  })
  if (error) {
    logger.error('Failed to restore deletion ban', { userId, error: error.message })
    return false
  }
  return true
}

/** Restore the deletion ban (one retry). Returns false if the account is left unbanned. */
async function reban(userId: string): Promise<boolean> {
  if (await banOnce(userId)) return true
  return banOnce(userId)
}

/**
 * Re-ban after a failed credential check — unless a concurrent, legitimate
 * recovery already restored the account (otherwise a wrong-password request
 * racing a correct one would lock the recovered user out for 30 days).
 * A failed state lookup fails closed (re-bans).
 */
async function rebanIfStillPending(userId: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from('user_profiles')
    .select('deleted_at')
    .eq('id', userId)
    .maybeSingle()
  if (error) {
    logger.error('Could not read deletion state before re-ban; re-banning', {
      userId,
      error: error.message,
    })
  } else if (data && data.deleted_at === null) {
    logger.warn('Skipping re-ban: account was concurrently recovered', { userId })
    return true
  }
  return reban(userId)
}

async function resumeSubscription(userId: string): Promise<boolean> {
  const admin = getSupabaseAdmin()
  try {
    const { data: subscription, error } = await admin
      .from('subscriptions')
      .select('stripe_subscription_id, status, plan, cancel_at_period_end')
      .eq('user_id', userId)
      .in('status', [...RENEWABLE_SUBSCRIPTION_STATUSES])
      .limit(1)
      .maybeSingle()
    if (error) throw error

    const subscriptionId = subscription?.stripe_subscription_id ?? null
    const isLifetime = subscription?.plan === 'lifetime' || subscriptionId?.startsWith('lifetime_')
    if (!subscription?.cancel_at_period_end || !subscriptionId || isLifetime) return true

    await getStripe().subscriptions.update(subscriptionId, { cancel_at_period_end: false })
    const { error: updateError } = await admin
      .from('subscriptions')
      .update({ cancel_at_period_end: false })
      .eq('user_id', userId)
    if (updateError) throw updateError
    return true
  } catch (error) {
    logger.error('Account restored but subscription renewal could not be resumed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export const POST = withPublic(
  async ({ request }) => {
    let body: { email?: string; password?: string; recovery_token?: string }
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const hasRecoveryToken = Object.prototype.hasOwnProperty.call(body, 'recovery_token')
    let recoveryToken: string | null = null
    if (hasRecoveryToken) {
      if (!isAccountRecoveryToken(body.recovery_token)) {
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      }
      recoveryToken = body.recovery_token
    }

    const admin = getSupabaseAdmin()
    let userId: string | null = null
    let recoveryTokenHash: string | undefined

    if (recoveryToken) {
      recoveryTokenHash = createHash('sha256').update(recoveryToken).digest('hex')
      const { data: tokenRow, error } = await admin
        .from('account_recovery_tokens')
        .select('user_id, expires_at, used_at')
        .eq('token_hash', recoveryTokenHash)
        .maybeSingle()

      if (error || !tokenRow || tokenRow.used_at) {
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      }
      if (new Date(tokenRow.expires_at).getTime() <= Date.now()) {
        return NextResponse.json(
          { success: false, error: 'Recovery period has expired.' },
          { status: 410 }
        )
      }
      userId = tokenRow.user_id
    } else {
      const { email, password } = body
      if (!email || !password) return badRequest('Email and password are required')
      if (typeof email !== 'string' || typeof password !== 'string') {
        return badRequest('Email and password are required')
      }

      const emailKey = createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
      const emailLimited = await checkRateLimit(
        request,
        PER_EMAIL_RATE_LIMIT,
        `recover-email:${emailKey}`
      )
      if (emailLimited) return emailLimited

      // ILIKE wildcards: `_` is escaped; `%`, `\` and PostgREST's `*` alias
      // have no place in a recoverable address and must never widen the match.
      const normalizedEmail = email.trim()
      if (/[*%\\]/.test(normalizedEmail)) {
        return NextResponse.json(
          { success: false, error: INVALID_PASSWORD_RECOVERY },
          { status: 401 }
        )
      }
      const emailPattern = escapeLikePattern(normalizedEmail, 320, { direct: true })

      const { data: profile, error } = await admin
        .from('user_profiles')
        .select('id, deletion_scheduled_at')
        // GoTrue matches sign-in emails case-insensitively, so the lookup must
        // too; an exact match answered 401 to anyone who typed a different case.
        .ilike('email', emailPattern)
        .not('deleted_at', 'is', null)
        .maybeSingle()

      if (error) {
        logger.error('Failed to look up pending-deletion profile', { error: error.message })
      }
      // Expired grace period answers exactly like an unknown email (no oracle,
      // and the ban is never lifted for an account that can't be recovered).
      if (
        error ||
        !profile ||
        (profile.deletion_scheduled_at &&
          new Date(profile.deletion_scheduled_at).getTime() <= Date.now())
      ) {
        return NextResponse.json(
          { success: false, error: INVALID_PASSWORD_RECOVERY },
          { status: 401 }
        )
      }

      userId = profile.id
      const { error: unbanError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
      })
      if (unbanError) {
        logger.error('Failed to open credential verification window', {
          userId,
          error: unbanError.message,
        })
        return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
      }

      let valid = false
      try {
        const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
        const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
          email,
          password,
        })
        valid = !signInError
        // The session was only a credential probe; revoke it.
        if (valid && signIn?.session) {
          const { error: signOutError } = await anon.auth.signOut({ scope: 'local' })
          if (signOutError) {
            logger.warn('Failed to revoke credential-probe session', {
              userId,
              error: signOutError.message,
            })
          }
        }
      } catch (verifyError) {
        valid = false
        logger.error('Credential verification threw', {
          userId,
          error: verifyError instanceof Error ? verifyError.message : String(verifyError),
        })
      }
      if (!valid) {
        if (!(await rebanIfStillPending(userId))) {
          // Fail closed: the account is pending deletion but is now unbanned.
          logger.error('SECURITY: pending-deletion account left unbanned after failed recovery', {
            userId,
          })
          return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
        }
        return NextResponse.json(
          { success: false, error: INVALID_PASSWORD_RECOVERY },
          { status: 401 }
        )
      }
    }

    // Token holders also need the auth ban lifted before the account becomes
    // usable again. A failed DB restore is compensated by re-banning below.
    if (recoveryTokenHash) {
      const { error: unbanError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
      })
      if (unbanError) {
        logger.error('Failed to unban token recovery', { userId, unbanError })
        return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
      }
    }

    const { data: restoredUserId, error: restoreError } = await admin.rpc(
      'restore_pending_account',
      {
        p_user_id: userId,
        ...(recoveryTokenHash ? { p_recovery_token_hash: recoveryTokenHash } : {}),
      }
    )

    if (restoreError || !restoredUserId) {
      if (!(await reban(userId))) {
        logger.error('SECURITY: account left unbanned after failed restore', { userId })
      }
      logger.error('Failed to restore pending account', {
        userId,
        error: restoreError?.message ?? 'expired or invalid recovery',
      })
      return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
    }

    // A concurrent wrong-password attempt may have re-banned between our
    // unban and the restore (its "still pending" check is not locked). The
    // account is restored now, so lifting the ban again is always correct.
    const { error: finalUnbanError } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: 'none',
    })
    if (finalUnbanError) {
      logger.error('SECURITY: restored account may still be banned', {
        userId,
        finalUnbanError,
      })
    }

    const subscriptionResumed = await resumeSubscription(userId)
    logger.info('Account recovered successfully', { userId })

    return NextResponse.json({
      success: true,
      subscription_resumed: subscriptionResumed,
      message: 'Account and retained data recovered successfully. You can now log in.',
    })
  },
  { name: 'account-recover', rateLimit: 'sensitive', skipCsrf: true }
)
