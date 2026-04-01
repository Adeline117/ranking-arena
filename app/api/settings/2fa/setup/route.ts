/**
 * 2FA Setup API
 * POST: Generate TOTP secret and QR code for user to scan
 */

import { NextRequest, NextResponse } from 'next/server'
import { toDataURL } from 'qrcode'
import { generateTotpSecret } from '@/lib/services/totp'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

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

    // Check if 2FA is already enabled
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('totp_enabled')
      .eq('id', user.id)
      .single()

    if (profileError) {
      logger.error('[2FA Setup] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Failed to fetch user profile' }, { status: 500 })
    }

    if (profile?.totp_enabled) {
      return NextResponse.json(
        { error: '2FA is already enabled. Disable it first to reconfigure.' },
        { status: 400 }
      )
    }

    // Generate TOTP secret
    const userEmail = user.email ?? user.id
    const { secret, uri } = generateTotpSecret(userEmail)

    // Generate QR code as data URL
    const qrCode = await toDataURL(uri)

    // Store the secret in secure table (service_role only, not accessible by client)
    const { error: updateError } = await supabase
      .from('user_2fa_secrets')
      .upsert({ user_id: user.id, totp_secret: secret, updated_at: new Date().toISOString() })

    if (updateError) {
      logger.error('[2FA Setup] Secret storage error:', updateError)
      return NextResponse.json({ error: 'Failed to store TOTP secret' }, { status: 500 })
    }

    return NextResponse.json({ qrCode, secret, uri })
  } catch (error: unknown) {
    logger.error('[2FA Setup] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
