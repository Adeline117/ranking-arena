/**
 * 2FA Setup API
 * POST: Generate TOTP secret and QR code for user to scan
 */

import { NextResponse } from 'next/server'
import { toDataURL } from 'qrcode'
import { generateTotpSecret } from '@/lib/services/totp'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { twoFactorEnrollmentStageResultSchema } from '@/lib/security/two-factor-credentials'
import { hasActiveTwoFactorProfile } from '@/lib/security/two-factor-active-profile'
import { createLogger } from '@/lib/utils/logger'
import {
  hasExactEmptyTwoFactorBody,
  TWO_FACTOR_SECRET_RESPONSE_HEADERS,
} from '@/lib/security/two-factor-http-contract'

const logger = createLogger('2fa-setup')

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    if (!(await hasExactEmptyTwoFactorBody(request))) {
      return badRequest('2FA setup request body must be empty')
    }

    const userEmail = user.email ?? user.id
    const { secret, uri } = generateTotpSecret(userEmail)

    const qrCode = await toDataURL(uri)

    const { data, error } = await supabase.rpc('stage_two_factor_enrollment_secret_atomic', {
      p_user_id: user.id,
      p_totp_secret: secret,
    })

    if (error) {
      logger.error('[2FA Setup] Enrollment staging RPC failed:', error)
      return serverError('Failed to store TOTP secret')
    }

    const parsed = twoFactorEnrollmentStageResultSchema.safeParse(data)
    if (!parsed.success) {
      logger.error('[2FA Setup] Enrollment staging RPC returned an invalid response')
      return serverError('Failed to store TOTP secret')
    }

    if (parsed.data.status === 'suspended') {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }
    if (parsed.data.status === 'already_enabled') {
      return badRequest('2FA is already enabled. Disable it first to reconfigure.')
    }
    if (parsed.data.status === 'profile_not_found') {
      return badRequest('User profile not found. Complete your profile before enabling 2FA.')
    }
    if (parsed.data.status !== 'staged') {
      logger.error('[2FA Setup] Enrollment staging was rejected', {
        status: parsed.data.status,
      })
      return serverError('Failed to store TOTP secret')
    }

    // The lifecycle can change after the staging transaction commits. Check
    // again immediately before releasing the enrollment secret and QR code.
    if (!(await hasActiveTwoFactorProfile(user))) {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }

    return NextResponse.json(
      {
        success: true,
        viewerId: user.id,
        status: 'staged',
        qrCode,
        secret,
      },
      { headers: TWO_FACTOR_SECRET_RESPONSE_HEADERS }
    )
  },
  {
    name: '2fa-setup',
    rateLimit: 'sensitive',
  }
)
