/**
 * 2FA Verify API
 * POST: Verify TOTP code and enable 2FA, generate backup codes
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyTotpCode, generateBackupCodes, hashBackupCode } from '@/lib/services/totp'
import { withAuth } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import {
  twoFactorEnableResultSchema,
  twoFactorEnrollmentReadResultSchema,
} from '@/lib/security/two-factor-credentials'
import { hasActiveTwoFactorProfile } from '@/lib/security/two-factor-active-profile'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('2fa-verify')

// Zod schema for POST /api/settings/2fa/verify
const Verify2FASchema = z.object({
  code: z
    .string()
    .min(1, 'Verification code is required')
    .max(10, 'Code too long')
    .regex(/^\d+$/, 'Code must be numeric'),
})

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const parsed = Verify2FASchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { code } = parsed.data

    const { data: enrollmentData, error: enrollmentError } = await supabase.rpc(
      'read_two_factor_enrollment_secret',
      { p_user_id: user.id }
    )

    if (enrollmentError) {
      logger.error('[2FA Verify] Enrollment read RPC failed:', enrollmentError)
      return NextResponse.json({ error: 'Failed to verify 2FA setup' }, { status: 500 })
    }

    const enrollment = twoFactorEnrollmentReadResultSchema.safeParse(enrollmentData)
    if (!enrollment.success) {
      logger.error('[2FA Verify] Enrollment read RPC returned an invalid response')
      return NextResponse.json({ error: 'Failed to verify 2FA setup' }, { status: 500 })
    }
    if (enrollment.data.status === 'suspended') {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }
    if (enrollment.data.status === 'already_enabled') {
      return badRequest('2FA is already enabled')
    }
    if (enrollment.data.status === 'profile_not_found') {
      return badRequest('User profile not found. Complete your profile before enabling 2FA.')
    }
    if (enrollment.data.status === 'secret_not_found') {
      return badRequest('No TOTP secret found. Please run setup first.')
    }
    if (enrollment.data.status !== 'ready') {
      logger.error('[2FA Verify] Enrollment read was rejected', {
        status: enrollment.data.status,
      })
      return NextResponse.json({ error: 'Failed to verify 2FA setup' }, { status: 500 })
    }

    const isValid = verifyTotpCode(enrollment.data.totp_secret, code)
    if (!isValid) {
      return badRequest('Invalid verification code')
    }

    const backupCodes = generateBackupCodes(8)
    const codeHashes = backupCodes.map((plainCode: string) => hashBackupCode(plainCode))
    const { data: enableData, error: enableError } = await supabase.rpc(
      'enable_two_factor_credentials_atomic',
      {
        p_user_id: user.id,
        p_expected_totp_secret: enrollment.data.totp_secret,
        p_code_hashes: codeHashes,
      }
    )

    if (enableError) {
      logger.error('[2FA Verify] Enablement RPC failed:', enableError)
      return NextResponse.json({ error: 'Failed to enable 2FA' }, { status: 500 })
    }

    const enablement = twoFactorEnableResultSchema.safeParse(enableData)
    if (!enablement.success) {
      logger.error('[2FA Verify] Enablement RPC returned an invalid response')
      return NextResponse.json({ error: 'Failed to enable 2FA' }, { status: 500 })
    }
    if (enablement.data.status === 'suspended') {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }
    if (enablement.data.status === 'already_enabled') {
      return badRequest('2FA is already enabled')
    }
    if (enablement.data.status === 'profile_not_found') {
      return badRequest('User profile not found. Complete your profile before enabling 2FA.')
    }
    if (enablement.data.status === 'secret_not_found') {
      return badRequest('No TOTP secret found. Please run setup first.')
    }
    if (enablement.data.status === 'secret_changed') {
      return NextResponse.json(
        { error: '2FA setup changed. Verify the latest QR code and try again.' },
        { status: 409 }
      )
    }
    if (enablement.data.status !== 'enabled') {
      logger.error('[2FA Verify] Enablement was rejected', {
        status: enablement.data.status,
      })
      return NextResponse.json({ error: 'Failed to enable 2FA' }, { status: 500 })
    }

    // Do not disclose freshly generated recovery credentials after a
    // suspension/deletion that commits just after database enablement.
    if (!(await hasActiveTwoFactorProfile(user))) {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }

    return NextResponse.json({
      success: true,
      backupCodes,
    })
  },
  {
    name: '2fa-verify',
    rateLimit: 'sensitive',
  }
)
