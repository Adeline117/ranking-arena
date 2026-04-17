/**
 * 2FA Backup Codes API
 * POST: Regenerate backup codes for the authenticated user
 * (Changed from GET to POST — regenerating security credentials is a mutation)
 */

import { NextResponse } from 'next/server'
import { generateBackupCodes, hashBackupCode } from '@/lib/services/totp'
import { withAuth } from '@/lib/api/middleware'
import { serverError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('2fa-backup-codes')

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase }) => {
    // Check that 2FA is enabled
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('totp_enabled')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      logger.error('[2FA Backup Codes] Profile fetch error:', profileError)
      return serverError('Failed to fetch user profile')
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
      return serverError('Failed to regenerate backup codes')
    }

    // Insert new hashed codes
    const { error: insertError } = await supabase
      .from('backup_codes')
      .insert(hashedCodes)

    if (insertError) {
      logger.error('[2FA Backup Codes] Insert error:', insertError)
      return serverError('Failed to store new backup codes')
    }

    return NextResponse.json({
      success: true,
      backupCodes,
    })
  },
  {
    name: '2fa-backup-codes',
    rateLimit: 'sensitive',
  }
)
