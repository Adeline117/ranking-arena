/**
 * Account Recovery Endpoint
 * POST /api/account/recover
 *
 * Allows users who soft-deleted their account to recover it within
 * the 30-day grace period. Since the user is banned during the grace
 * period they cannot use normal auth — this endpoint verifies
 * credentials directly via Supabase Admin and unbans the user.
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('account-recover')

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withPublic(
  async ({ request }) => {
    let body: { email?: string; password?: string }
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const { email, password } = body

    if (!email || !password) {
      return badRequest('Email and password are required')
    }

    const adminSupabase = getSupabaseAdmin()

    // 1. Look up the user by email to check if they have a deleted_at timestamp
    const { data: profile, error: profileError } = await adminSupabase
      .from('user_profiles')
      .select('id, deleted_at, deletion_scheduled_at')
      .eq('email', email)
      .not('deleted_at', 'is', null)
      .maybeSingle()

    if (profileError || !profile) {
      // Don't reveal whether the account exists — generic error
      return NextResponse.json(
        { success: false, error: 'Invalid credentials or no pending deletion' },
        { status: 401 }
      )
    }

    // 2. Check that the grace period hasn't expired
    const scheduledDeletion = profile.deletion_scheduled_at
      ? new Date(profile.deletion_scheduled_at)
      : null
    if (scheduledDeletion && scheduledDeletion.getTime() < Date.now()) {
      return NextResponse.json(
        {
          success: false,
          error: 'Recovery period has expired. Account has been permanently deleted.',
        },
        { status: 410 }
      )
    }

    // 3. Temporarily unban → verify credentials → re-ban on failure.
    // Wrapped in try-finally to guarantee re-ban even if an unexpected error occurs,
    // minimizing the window where a banned account is accessible.
    const userId = profile.id
    let credentialsValid = false

    try {
      await adminSupabase.auth.admin.updateUserById(userId, {
        ban_duration: 'none',
      })

      // 4. Verify credentials by attempting sign-in with an anon client
      const anonClient = createClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      )
      const { error: signInError } = await anonClient.auth.signInWithPassword({
        email,
        password,
      })

      credentialsValid = !signInError
    } finally {
      // Always re-ban unless credentials were verified
      if (!credentialsValid) {
        await adminSupabase.auth.admin.updateUserById(userId, {
          ban_duration: '720h',
        })
      }
    }

    if (!credentialsValid) {
      return NextResponse.json(
        { success: false, error: 'Invalid credentials or no pending deletion' },
        { status: 401 }
      )
    }

    // 5. Credentials valid — clear deletion markers to recover the account
    const { error: updateError } = await adminSupabase
      .from('user_profiles')
      .update({
        deleted_at: null,
        deletion_scheduled_at: null,
        deletion_reason: null,
      })
      .eq('id', userId)

    if (updateError) {
      logger.error('Failed to clear deletion markers during recovery', {
        userId,
        error: updateError.message,
      })
      return NextResponse.json(
        { success: false, error: 'Recovery failed. Please try again.' },
        { status: 500 }
      )
    }

    logger.info('Account recovered successfully', { userId })

    return NextResponse.json({
      success: true,
      message: 'Account recovered successfully. You can now log in normally.',
    })
  },
  { name: 'account-recover', rateLimit: 'sensitive', skipCsrf: true }
)
