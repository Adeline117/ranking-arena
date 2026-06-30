/**
 * WebAuthn Registration Options
 * POST: generate passkey registration (attestation) options for the
 * authenticated user, and store the challenge for later verification.
 */

import type { AuthenticatorTransportFuture } from '@simplewebauthn/server'
import { generateRegistrationOptions } from '@simplewebauthn/server'
import { withAuth } from '@/lib/api/middleware'
import { serverError } from '@/lib/api/response'
import { NextResponse } from 'next/server'
import { getWebAuthnConfig, storeRegistrationChallenge } from '@/lib/auth/webauthn'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('webauthn-registration-options')

export const dynamic = 'force-dynamic'

interface PasskeyRow {
  credential_id: string
  transports: string[] | null
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    try {
      const { rpID, rpName } = getWebAuthnConfig(request)

      // Existing credentials so the authenticator won't enroll a dupe.
      const { data: existing, error: existingError } = await supabase
        .from('user_passkeys')
        .select('credential_id, transports')
        .eq('user_id', user.id)

      if (existingError) {
        logger.error('[registration-options] Failed to load existing passkeys:', existingError)
        return serverError('Failed to load existing passkeys')
      }

      const rows = (existing ?? []) as PasskeyRow[]

      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: user.email || user.id,
        userID: isoBase64URL.toBuffer(isoBase64URL.fromUTF8String(user.id)),
        attestationType: 'none',
        excludeCredentials: rows.map((row) => ({
          id: row.credential_id,
          transports: (row.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
        })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
      })

      await storeRegistrationChallenge(user.id, options.challenge)

      return NextResponse.json({ optionsJSON: options })
    } catch (err) {
      logger.error('[registration-options] Error:', err)
      return serverError('Failed to generate registration options')
    }
  },
  {
    name: 'webauthn-registration-options',
    rateLimit: 'sensitive',
    skipCsrf: true,
  }
)
