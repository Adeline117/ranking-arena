/**
 * WebAuthn Registration Verify
 * POST: verify the attestation response from the browser and, on success,
 * persist the new passkey credential for the authenticated user.
 */

import { z } from 'zod'
import { verifyRegistrationResponse } from '@simplewebauthn/server'
import type { RegistrationResponseJSON } from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { NextResponse } from 'next/server'
import { getWebAuthnConfig, consumeRegistrationChallenge } from '@/lib/auth/webauthn'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('webauthn-registration-verify')

export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  assertion: z.custom<RegistrationResponseJSON>((v) => typeof v === 'object' && v !== null),
  deviceName: z.string().trim().max(60).optional(),
})

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const parsed = BodySchema.safeParse(body)
    if (!parsed.success) {
      return badRequest('Invalid request body')
    }
    const { assertion, deviceName } = parsed.data

    const expectedChallenge = await consumeRegistrationChallenge(user.id)
    if (!expectedChallenge) {
      return badRequest('Challenge expired. Please try again.')
    }

    const { rpID, origin } = getWebAuthnConfig(request)

    let verification
    try {
      verification = await verifyRegistrationResponse({
        response: assertion,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      })
    } catch (err) {
      logger.warn('[registration-verify] Verification threw:', err)
      return badRequest('Passkey verification failed')
    }

    if (!verification.verified || !verification.registrationInfo) {
      return badRequest('Passkey could not be verified')
    }

    const { credential } = verification.registrationInfo
    const publicKeyBase64 = isoBase64URL.fromBuffer(credential.publicKey, 'base64')

    const { error: insertError } = await supabase.from('user_passkeys').insert({
      user_id: user.id,
      credential_id: credential.id,
      public_key: publicKeyBase64,
      counter: credential.counter,
      transports: credential.transports ?? null,
      device_name: deviceName || null,
    })

    if (insertError) {
      // 23505 = credential already enrolled (unique credential_id)
      if ((insertError as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'This passkey is already registered' }, { status: 409 })
      }
      logger.error('[registration-verify] Insert failed:', insertError)
      return serverError('Failed to save passkey')
    }

    return NextResponse.json({ verified: true })
  },
  {
    name: 'webauthn-registration-verify',
    rateLimit: 'sensitive',
    skipCsrf: true,
  }
)
