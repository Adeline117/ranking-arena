/**
 * 2FA Setup API
 * POST: Generate TOTP secret and QR code for user to scan
 */

import { NextResponse } from 'next/server'
import { toDataURL } from 'qrcode'
import { generateTotpSecret } from '@/lib/services/totp'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('2fa-setup')

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase }) => {
    // Check if 2FA is already enabled
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('totp_enabled')
      .eq('id', user.id)
      .single()

    if (profileError) {
      logger.error('[2FA Setup] Profile fetch error:', profileError)
      return serverError('Failed to fetch user profile')
    }

    if (profile?.totp_enabled) {
      return badRequest('2FA is already enabled. Disable it first to reconfigure.')
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
      return serverError('Failed to store TOTP secret')
    }

    return NextResponse.json({ qrCode, secret, uri })
  },
  {
    name: '2fa-setup',
    rateLimit: 'sensitive',
  }
)
