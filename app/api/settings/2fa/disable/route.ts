/**
 * 2FA Disable API
 * POST: Disable 2FA with password confirmation
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

interface DisableRequestBody {
  password: string
}

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.auth)
    if (rateLimitResponse) return rateLimitResponse

    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // CSRF validation
    const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    const supabase = getSupabaseAdmin()

    const body = (await request.json()) as DisableRequestBody
    const { password } = body

    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Password is required' }, { status: 400 })
    }

    // Verify the user's password by attempting sign-in
    const userEmail = user.email
    if (!userEmail) {
      return NextResponse.json(
        { error: 'No email associated with this account' },
        { status: 400 }
      )
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
      return NextResponse.json({ error: 'Failed to fetch user profile' }, { status: 500 })
    }

    if (!profile.totp_enabled) {
      return NextResponse.json({ error: '2FA is not enabled' }, { status: 400 })
    }

    // Disable 2FA: set enabled to false and delete secret from secure table
    const [{ error: updateError }] = await Promise.all([
      supabase.from('user_profiles').update({ totp_enabled: false }).eq('id', user.id),
      supabase.from('user_2fa_secrets').delete().eq('user_id', user.id),
    ])

    if (updateError) {
      logger.error('[2FA Disable] Update error:', updateError)
      return NextResponse.json({ error: 'Failed to disable 2FA' }, { status: 500 })
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
  } catch (error: unknown) {
    logger.error('[2FA Disable] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
