/**
 * 2FA Verify API
 * POST: Verify TOTP code and enable 2FA, generate backup codes
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyTotpCode, generateBackupCodes, hashBackupCode } from '@/lib/services/totp'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import logger from '@/lib/logger'

// Zod schema for POST /api/settings/2fa/verify
const Verify2FASchema = z.object({
  code: z.string().min(1, 'Verification code is required').max(10, 'Code too long').regex(/^\d+$/, 'Code must be numeric'),
})

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

    const body = await request.json()
    const parsed = Verify2FASchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { code } = parsed.data

    // Check if already enabled
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('totp_enabled')
      .eq('id', user.id)
      .single()

    if (profile?.totp_enabled) {
      return NextResponse.json({ error: '2FA is already enabled' }, { status: 400 })
    }

    // Get the stored TOTP secret from secure table
    const { data: secretRow, error: secretError } = await supabase
      .from('user_2fa_secrets')
      .select('totp_secret')
      .eq('user_id', user.id)
      .single()

    if (secretError || !secretRow?.totp_secret) {
      return NextResponse.json(
        { error: 'No TOTP secret found. Please run setup first.' },
        { status: 400 }
      )
    }

    // Verify the code
    const isValid = verifyTotpCode(secretRow.totp_secret, code)
    if (!isValid) {
      return NextResponse.json({ error: 'Invalid verification code' }, { status: 400 })
    }

    // Enable 2FA
    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({ totp_enabled: true })
      .eq('id', user.id)

    if (updateError) {
      logger.error('[2FA Verify] Enable error:', updateError)
      return NextResponse.json({ error: 'Failed to enable 2FA' }, { status: 500 })
    }

    // Generate backup codes
    const backupCodes = generateBackupCodes(8)
    const hashedCodes = backupCodes.map((plainCode: string) => ({
      user_id: user.id,
      code_hash: hashBackupCode(plainCode),
      used: false,
    }))

    // Delete any existing backup codes for this user
    await supabase
      .from('backup_codes')
      .delete()
      .eq('user_id', user.id)

    // Store hashed backup codes
    const { error: insertError } = await supabase
      .from('backup_codes')
      .insert(hashedCodes)

    if (insertError) {
      logger.error('[2FA Verify] Backup codes insert error:', insertError)
      // 2FA is already enabled, but backup codes failed - log but don't fail
      return NextResponse.json({
        success: true,
        backupCodes: [],
        warning: 'Backup codes could not be generated. Please regenerate them.',
      })
    }

    return NextResponse.json({
      success: true,
      backupCodes,
    })
  } catch (error: unknown) {
    logger.error('[2FA Verify] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
