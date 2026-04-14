/**
 * 2FA Backup Codes API
 * POST: Regenerate backup codes for the authenticated user
 * (Changed from GET to POST — regenerating security credentials is a mutation)
 */

import { NextRequest, NextResponse } from 'next/server'
import { generateBackupCodes, hashBackupCode } from '@/lib/services/totp'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
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

    const supabase = getSupabaseAdmin()

    // Check that 2FA is enabled
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('totp_enabled')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      logger.error('[2FA Backup Codes] Profile fetch error:', profileError)
      return NextResponse.json({ error: 'Failed to fetch user profile' }, { status: 500 })
    }

    if (!profile.totp_enabled) {
      return NextResponse.json(
        { error: '2FA is not enabled. Enable 2FA first.' },
        { status: 400 }
      )
    }

    // Generate new backup codes
    const backupCodes = generateBackupCodes(8)
    const hashedCodes = backupCodes.map((plainCode: string) => ({
      user_id: user.id,
      code_hash: hashBackupCode(plainCode),
      used: false,
    }))

    // Delete old backup codes for this user
    const { error: deleteError } = await supabase
      .from('backup_codes')
      .delete()
      .eq('user_id', user.id)

    if (deleteError) {
      logger.error('[2FA Backup Codes] Delete old codes error:', deleteError)
      return NextResponse.json({ error: 'Failed to regenerate backup codes' }, { status: 500 })
    }

    // Insert new hashed codes
    const { error: insertError } = await supabase
      .from('backup_codes')
      .insert(hashedCodes)

    if (insertError) {
      logger.error('[2FA Backup Codes] Insert error:', insertError)
      return NextResponse.json({ error: 'Failed to store new backup codes' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      backupCodes,
    })
  } catch (error: unknown) {
    logger.error('[2FA Backup Codes] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
