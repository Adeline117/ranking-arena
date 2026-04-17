/**
 * 2FA Disable API
 * POST: Disable 2FA with password confirmation
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('2fa-disable')

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: { password?: string }
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const { password } = body

    if (!password || typeof password !== 'string') {
      return badRequest('Password is required')
    }

    // Verify the user's password by attempting sign-in
    const userEmail = user.email
    if (!userEmail) {
      return badRequest('No email associated with this account')
    }

    const verifyClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
      { auth: { persistSession: false } }
    )

    const { error: signInError } = await verifyClient.auth.signInWithPassword({
      email: userEmail,
      password,
    })

    if (signInError) {
      return NextResponse.json({ error: 'Invalid password' }, { status: 403 })
    }

    // Check that 2FA is currently enabled
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('totp_enabled')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      logger.error('[2FA Disable] Profile fetch error:', profileError)
      return serverError('Failed to fetch user profile')
    }

    if (!profile.totp_enabled) {
      return badRequest('2FA is not enabled')
    }

    // Disable 2FA: set enabled to false and delete secret from secure table
    const [{ error: updateError }] = await Promise.all([
      supabase.from('user_profiles').update({ totp_enabled: false }).eq('id', user.id),
      supabase.from('user_2fa_secrets').delete().eq('user_id', user.id),
    ])

    if (updateError) {
      logger.error('[2FA Disable] Update error:', updateError)
      return serverError('Failed to disable 2FA')
    }

    // Delete all backup codes for this user
    const { error: deleteError } = await supabase
      .from('backup_codes')
      .delete()
      .eq('user_id', user.id)

    if (deleteError) {
      logger.error('[2FA Disable] Backup codes deletion error:', deleteError)
      // Non-critical: 2FA is already disabled
    }

    return NextResponse.json({ success: true })
  },
  {
    name: '2fa-disable',
    rateLimit: 'sensitive',
  }
)
