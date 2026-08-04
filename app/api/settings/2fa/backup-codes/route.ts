/**
 * 2FA Backup Codes API
 * POST: Regenerate backup codes for the authenticated user
 * (Changed from GET to POST — regenerating security credentials is a mutation)
 */

import { NextResponse } from 'next/server'
import { generateBackupCodes, hashBackupCode } from '@/lib/services/totp'
import { withAuth } from '@/lib/api/middleware'
import { serverError } from '@/lib/api/response'
import { twoFactorBackupCodeRotationResultSchema } from '@/lib/security/two-factor-credentials'
import { hasActiveTwoFactorProfile } from '@/lib/security/two-factor-active-profile'
import { createLogger } from '@/lib/utils/logger'
import { isValidTwoFactorBackupCodeSet } from '@/lib/security/two-factor-client-contract'
import {
  hasExactEmptyTwoFactorBody,
  TWO_FACTOR_SECRET_RESPONSE_HEADERS,
} from '@/lib/security/two-factor-http-contract'

const logger = createLogger('2fa-backup-codes')

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    if (!(await hasExactEmptyTwoFactorBody(request))) {
      return NextResponse.json({ error: 'Backup-code request body must be empty' }, { status: 400 })
    }

    const backupCodes = generateBackupCodes(8)
    if (!isValidTwoFactorBackupCodeSet(backupCodes)) {
      logger.error('[2FA Backup Codes] Generator returned an invalid set')
      return serverError('Failed to regenerate backup codes')
    }
    const codeHashes = backupCodes.map((plainCode: string) => hashBackupCode(plainCode))

    const { data, error } = await supabase.rpc('rotate_two_factor_backup_codes_atomic', {
      p_user_id: user.id,
      p_code_hashes: codeHashes,
    })

    if (error) {
      logger.error('[2FA Backup Codes] Rotation RPC failed:', error)
      return serverError('Failed to regenerate backup codes')
    }

    const parsed = twoFactorBackupCodeRotationResultSchema.safeParse(data)
    if (!parsed.success) {
      logger.error('[2FA Backup Codes] Rotation RPC returned an invalid response')
      return serverError('Failed to regenerate backup codes')
    }

    if (parsed.data.status === 'suspended') {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }
    if (parsed.data.status === 'not_enabled') {
      return NextResponse.json({ error: '2FA is not enabled. Enable 2FA first.' }, { status: 400 })
    }
    if (parsed.data.status !== 'rotated') {
      logger.error('[2FA Backup Codes] Rotation was rejected', {
        status: parsed.data.status,
      })
      return serverError('Failed to regenerate backup codes')
    }

    // A backup-code set is a bearer credential. Recheck immediately before
    // returning any plaintext code to the browser.
    if (!(await hasActiveTwoFactorProfile(user))) {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }

    return NextResponse.json(
      {
        success: true,
        viewerId: user.id,
        status: 'rotated',
        backupCodes,
      },
      { headers: TWO_FACTOR_SECRET_RESPONSE_HEADERS }
    )
  },
  {
    name: '2fa-backup-codes',
    rateLimit: 'sensitive',
  }
)
