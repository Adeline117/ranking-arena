/**
 * WebAuthn Authentication Verify (PUBLIC — passwordless login finish)
 *
 * POST: verify the assertion against the stored challenge, then mint a real
 * Supabase session the same way app/api/auth/siwe/verify does — via
 * `admin.generateLink` → `verifyOtp` — and return the session tokens so the
 * browser can call `supabase.auth.setSession(tokens)`.
 */

import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { withPublic } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { NextResponse } from 'next/server'
import { getWebAuthnConfig, consumeAuthenticationChallenge } from '@/lib/auth/webauthn'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('webauthn-authentication-verify')

export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  assertion: z.custom<AuthenticationResponseJSON>((v) => typeof v === 'object' && v !== null),
  challengeKey: z.string().min(1).max(128),
})

interface PasskeyRow {
  id: string
  user_id: string
  public_key: string
  counter: number | string
  transports: string[] | null
}

export const POST = withPublic(
  async ({ supabase, request }) => {
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
    const { assertion, challengeKey } = parsed.data

    const credentialId = assertion.id
    if (!credentialId) {
      return badRequest('Malformed assertion')
    }

    const expectedChallenge = await consumeAuthenticationChallenge(challengeKey)
    if (!expectedChallenge) {
      return badRequest('Challenge expired. Please try again.')
    }

    // Look up the credential (admin client bypasses owner-only RLS — there is
    // no authenticated user yet during passwordless login).
    const { data: rowData, error: lookupError } = await supabase
      .from('user_passkeys')
      .select('id, user_id, public_key, counter, transports')
      .eq('credential_id', credentialId)
      .maybeSingle()

    if (lookupError) {
      logger.error('[authentication-verify] Credential lookup failed:', lookupError)
      return serverError('Login failed')
    }

    const row = rowData as PasskeyRow | null
    if (!row) {
      return badRequest('Passkey not recognized')
    }

    let rpID: string
    let origin: string
    try {
      ;({ rpID, origin } = getWebAuthnConfig(request))
    } catch {
      return badRequest('Unrecognized origin')
    }

    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
        credential: {
          id: credentialId,
          publicKey: isoBase64URL.toBuffer(row.public_key, 'base64'),
          counter: Number(row.counter) || 0,
          transports: (row.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
        },
      })
    } catch (err) {
      logger.warn('[authentication-verify] Verification threw:', err)
      return badRequest('Passkey verification failed')
    }

    if (!verification.verified) {
      return badRequest('Passkey could not be verified')
    }

    // The auth trigger is the sole profile provisioner. Never mint a session
    // for an auth identity whose required application profile is missing.
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('id', row.user_id)
      .maybeSingle()

    if (profileError || !profile) {
      logger.error('[authentication-verify] Provisioned profile unavailable:', profileError)
      return serverError('Login failed')
    }

    // Update the signature counter + last used timestamp (replay protection).
    // A failed or zero-row counter write must block login; otherwise the same
    // authenticator response can remain reusable against the stale counter.
    const { data: updatedCredential, error: updateError } = await supabase
      .from('user_passkeys')
      .update({
        counter: verification.authenticationInfo.newCounter,
        last_used_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .select('id')
      .maybeSingle()

    if (updateError || !updatedCredential) {
      logger.error('[authentication-verify] Counter update failed:', updateError)
      return serverError('Login failed')
    }

    // Resolve the owning user's email so we can mint a session.
    const { data: userResult, error: getUserError } = await supabase.auth.admin.getUserById(
      row.user_id
    )
    const email = userResult?.user?.email
    if (getUserError || !email) {
      logger.error('[authentication-verify] Could not resolve user email:', getUserError)
      return serverError('Login failed')
    }

    // Mint a Supabase session exactly like siwe/verify: generate a magic-link
    // hashed token, then exchange it via verifyOtp to obtain real session
    // tokens. We do the exchange server-side so the client just calls
    // supabase.auth.setSession(tokens).
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
    })

    const hashedToken = linkData?.properties?.hashed_token
    if (linkError || !hashedToken) {
      logger.error('[authentication-verify] generateLink failed:', linkError)
      return serverError('Failed to create session')
    }

    // Use a non-admin (anon) client to exchange the token for a session, the
    // same call the SIWE client makes — but performed here so we can hand back
    // access/refresh tokens directly.
    const anon = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    )

    const { data: otpData, error: otpError } = await anon.auth.verifyOtp({
      email,
      token: hashedToken,
      type: 'email',
    })

    if (otpError || !otpData.session || otpData.session.user.id !== row.user_id) {
      logger.error('[authentication-verify] verifyOtp failed:', otpError)
      return serverError('Failed to establish session')
    }

    return NextResponse.json({
      verified: true,
      session: {
        access_token: otpData.session.access_token,
        refresh_token: otpData.session.refresh_token,
      },
    })
  },
  {
    name: 'webauthn-authentication-verify',
    rateLimit: 'auth',
    skipCsrf: true,
  }
)
