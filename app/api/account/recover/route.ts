/** Recover an account during its 30-day deletion grace period. */

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { withPublic } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { getStripe } from '@/lib/stripe'

const logger = createLogger('account-recover')
const INVALID_RECOVERY = 'Invalid credentials or no pending deletion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function reban(userId: string): Promise<void> {
  const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
    ban_duration: '720h',
  })
  if (error)
    logger.error('Failed to restore deletion ban after recovery failure', { userId, error })
}

async function resumeSubscription(userId: string): Promise<boolean> {
  const admin = getSupabaseAdmin()
  try {
    const { data: subscription, error } = await admin
      .from('subscriptions')
      .select('stripe_subscription_id, status, plan, cancel_at_period_end')
      .eq('user_id', userId)
      .in('status', ['active', 'trialing'])
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

    const admin = getSupabaseAdmin()
    const recoveryToken = body.recovery_token?.trim()
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

      const { data: profile, error } = await admin
        .from('user_profiles')
        .select('id, deletion_scheduled_at')
        .eq('email', email)
        .not('deleted_at', 'is', null)
        .maybeSingle()

      if (error || !profile) {
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
      }
      if (
        profile.deletion_scheduled_at &&
        new Date(profile.deletion_scheduled_at).getTime() <= Date.now()
      ) {
        return NextResponse.json(
          { success: false, error: 'Recovery period has expired.' },
          { status: 410 }
        )
      }

      userId = profile.id
      const { error: unbanError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
      })
      if (unbanError) {
        logger.error('Failed to open credential verification window', { userId, unbanError })
        return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
      }

      let valid = false
      try {
        const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
        const { error: signInError } = await anon.auth.signInWithPassword({ email, password })
        valid = !signInError
      } finally {
        if (!valid) await reban(userId)
      }
      if (!valid) {
        return NextResponse.json({ success: false, error: INVALID_RECOVERY }, { status: 401 })
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
      await reban(userId)
      logger.error('Failed to restore pending account', {
        userId,
        error: restoreError?.message ?? 'expired or invalid recovery',
      })
      return NextResponse.json({ success: false, error: 'Recovery failed.' }, { status: 500 })
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
