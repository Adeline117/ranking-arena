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
        requireUserVerification: true,
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
    if (!Number.isSafeInteger(credential.counter) || credential.counter < 0) {
      logger.error('[registration-verify] Verified credential counter is invalid')
      return serverError('Failed to save passkey')
    }

    // The database serializes account suspension/deletion with credential
    // registration and persists only the fields verified by the server above.
    const { data: registrationData, error: registrationError } = await supabase.rpc(
      'register_webauthn_credential_for_active_profile_atomic',
      {
        p_user_id: user.id,
        p_credential_id: credential.id,
        p_public_key: publicKeyBase64,
        p_counter: credential.counter,
        p_transports: credential.transports ?? null,
        p_device_name: deviceName || null,
      }
    )
    const registration =
      Array.isArray(registrationData) && registrationData.length === 1 ? registrationData[0] : null

    if (registrationError || !registration) {
      logger.error('[registration-verify] Atomic registration failed:', registrationError)
      return serverError('Failed to save passkey')
    }
    const emptyResult =
      registration.result_user_id === null &&
      registration.result_passkey_id === null &&
      registration.result_credential_id === null
    if (registration.status === 'suspended' && emptyResult) {
      return NextResponse.json({ error: 'Account unavailable' }, { status: 403 })
    }
    if (registration.status === 'conflict' && emptyResult) {
      return NextResponse.json({ error: 'This passkey is already registered' }, { status: 409 })
    }
    if (
      registration.status !== 'registered' ||
      registration.result_user_id !== user.id ||
      registration.result_credential_id !== credential.id ||
      !z.string().uuid().safeParse(registration.result_passkey_id).success
    ) {
      logger.error('[registration-verify] Atomic registration returned an invalid acknowledgement')
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
